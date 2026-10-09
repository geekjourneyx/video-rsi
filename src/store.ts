import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { mkdir, open, readdir, rename, unlink, truncate, rmdir, rm } from 'node:fs/promises';
import { z } from 'zod';
import {
  candidateBatchSchema, completionRequestSchema, completionSchema, evaluatedBatchSchema,
  runEventSchema, runManifestSchema,
  type CandidateBatch, type Completion, type CompletionRequest, type EvaluatedBatch,
  type RunEvent, type RunManifest, type RunRecord,
} from './contracts.js';
import { AppError } from './errors.js';

/** Internal evidence/document or single journal-record ceiling; public input files retain their 1 MiB limit. */
export const MAX_INTERNAL_BYTES = 8_388_608;
const safeId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const resultSchema = z.union([evaluatedBatchSchema, candidateBatchSchema]);
const callSchema = z.strictObject({
  schemaVersion: z.literal(1), runId: z.string(), callId: z.string(),
  request: completionRequestSchema, result: completionSchema, hash: hashSchema,
});
const resultFileSchema = z.strictObject({
  schemaVersion: z.literal(1), runId: z.string(), result: resultSchema, hash: hashSchema,
});
const manifestHashSchema = z.strictObject({schemaVersion:z.literal(1),runId:z.string(),hash:hashSchema});
const lockSchema = z.strictObject({
  pid: z.number().int().positive(), hostname: z.string().min(1), token: z.string().min(1),
});
type EventInput = Omit<RunEvent, 'seq' | 'runId' | 'at' | 'schemaVersion'>;
export type StoredCall = { request: CompletionRequest; result: Completion; hash: string };
export type RunStore = {
  path: string;
  append(event: EventInput): Promise<void>;
  saveCall(callId: string, request: CompletionRequest, result: Completion): Promise<void>;
  complete(result: CandidateBatch | EvaluatedBatch): Promise<void>;
  close(): Promise<void>;
};
function conflict(message: string): never { throw new AppError(5, message); }
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }
function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) conflict(`Invalid run evidence: ${parsed.error.message}`);
  return parsed.data;
}
function id(value: string): string {
  if (!safeId.test(value)) conflict('Unsafe run or call ID');
  return value;
}
async function evidence<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof AppError) throw error;
    // Do not include persisted raw data or secret-bearing error text in diagnostics.
    conflict(`Run evidence I/O failed (${(error as NodeJS.ErrnoException)?.code ?? 'invalid data'})`);
  }
}
function serialized(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json) > MAX_INTERNAL_BYTES) conflict('Run evidence exceeds 8 MiB or is not JSON');
  return json;
}
/** Hash the exact JSON serialization stored in an atomic evidence file. */
export function hashJson(value: unknown): string {
  return createHash('sha256').update(serialized(value)).digest('hex');
}
function scrub(value: unknown, secrets: string[] = []): unknown {
  if (typeof value === 'string') return secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), value);
  if (Array.isArray(value)) return value.map(item => scrub(item, secrets));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (/^(api[-_]?key|authorization|proxy[-_]?authorization|access[-_]?token|refresh[-_]?token|password|secret)$/i.test(key)) continue;
      result[key] = scrub(item, secrets);
    }
    return result;
  }
  return value;
}
function manifestSecrets(manifest: RunManifest): string[] {
  return [manifest.config.models.writer, manifest.config.models.judge]
    .map(model => process.env[model.apiKeyEnv]).filter((value): value is string => !!value);
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
/** Same-directory rename makes each document visible all at once; directory fsync makes the rename durable. */
async function atomicJson(path: string, value: unknown): Promise<void> {
  const data = serialized(value);
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally { await unlink(temporary).catch(error => { if (!isMissing(error)) throw error; }); }
}
async function readLimited(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_INTERNAL_BYTES) conflict('Evidence is not a regular file of at most 8 MiB');
    const data = await handle.readFile('utf8');
    if (Buffer.byteLength(data) > MAX_INTERNAL_BYTES) conflict('Run evidence exceeds 8 MiB');
    return data;
  } finally { await handle.close(); }
}
async function readJson(path: string): Promise<unknown> { return JSON.parse(await readLimited(path)); }
async function optionalJson(path: string): Promise<unknown | undefined> {
  try { return await readJson(path); } catch (error) { if (isMissing(error)) return undefined; throw error; }
}
function validateManifest(value: unknown): RunManifest {
  const manifest = checked(runManifestSchema, value);
  id(manifest.runId);
  if (manifest.operation.kind === 'judge') {
    if (!manifest.inputBatch || manifest.inputBatchHash !== hashJson(manifest.inputBatch)) conflict('Judge input batch/hash mismatch');
    if (hashJson(manifest.brief) !== hashJson(manifest.inputBatch.brief)) conflict('Judge input brief mismatch');
  } else if (manifest.inputBatch !== undefined || manifest.inputBatchHash !== undefined) conflict('Create run cannot have a judge input batch');
  return manifest;
}
async function readManifest(path: string): Promise<RunManifest> {
  const value = await readJson(join(path, 'manifest.json'));
  const proof = checked(manifestHashSchema, await readJson(join(path, 'manifest.hash.json')));
  const manifest = validateManifest(value);
  if (proof.runId !== manifest.runId || proof.hash !== hashJson(value)) conflict('Manifest hash mismatch');
  return manifest;
}
function payload(event: RunEvent | EventInput): Record<string, unknown> {
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) conflict(`Invalid ${event.type} payload`);
  return event.payload as Record<string, unknown>;
}
function callId(event: RunEvent | EventInput): string {
  const value = payload(event).callId;
  if (typeof value !== 'string') conflict('Call event requires callId');
  return id(value);
}
function validateLedger(events: RunEvent[], runId: string): void {
  const calls = new Map<string, 'started' | 'finished' | 'unknown'>();
  const retries = new Map<string, string>();
  let completed = false;
  for (const [index, event] of events.entries()) {
    if (event.seq !== index + 1 || event.runId !== runId || completed) conflict('Invalid ledger sequence/run ID or event after completion');
    if ((index === 0) !== (event.type === 'started')) conflict('Ledger requires exactly one initial started event');
    if (event.type === 'call_started') {
      const key = callId(event);
      if (calls.has(key)) conflict('Call ID already attempted');
      const request = payload(event).request;
      if (request !== undefined && checked(completionRequestSchema, request).callId !== key) conflict('Started request call ID mismatch');
      const retryOf = payload(event).retryOf;
      if (retryOf !== undefined) {
        if (typeof retryOf !== 'string' || calls.get(retryOf) !== 'unknown' || retries.has(retryOf)) conflict('Retry requires a prior unknown attempt with no existing child');
        retries.set(retryOf, key);
      }
      calls.set(key, 'started');
    } else if (event.type === 'call_finished') {
      const key = callId(event);
      if (!calls.has(key) || calls.get(key) === 'finished') conflict('Call finish lacks a unique prior start');
      checked(hashSchema, payload(event).hash);
      calls.set(key, 'finished');
    } else if (event.type === 'call_unknown') {
      const key = callId(event);
      if (calls.get(key) !== 'started') conflict('Unknown call lacks an outstanding start');
      calls.set(key, 'unknown');
    } else if (event.type === 'completed') {
      if (unresolvedCalls(events.slice(0, index)).length) conflict('Cannot complete with unresolved paid attempts');
      checked(hashSchema, payload(event).hash);
      completed = true;
    }
  }
  if (events.length === 0) conflict('Missing initial started event');
}
function unresolvedCalls(events: RunEvent[]): string[] {
  const started = events.filter(event => event.type === 'call_started');
  const finished = new Set(events.filter(event => event.type === 'call_finished').map(callId));
  const retries = new Map<string, string>();
  for (const event of started) {
    const parent = payload(event).retryOf;
    if (typeof parent === 'string') retries.set(parent, callId(event));
  }
  return started.map(callId).filter(key => {
    // Ledger validation only accepts backward references to prior attempts, so cycles cannot occur.
    while (!finished.has(key) && retries.has(key)) key = retries.get(key)!;
    return !finished.has(key);
  });
}
async function readLedger(path: string, runId: string): Promise<{ events: RunEvent[]; bytes: number; tail: boolean }> {
  const handle = await open(join(path, 'events.jsonl'), 'r');
  const events: RunEvent[] = [];
  let pending = Buffer.alloc(0);
  let bytes = 0;
  try {
    if (!(await handle.stat()).isFile()) conflict('Journal is not a regular file');
    const chunk = Buffer.alloc(64 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      let beginning = 0;
      let newline: number;
      while ((newline = pending.indexOf(10, beginning)) !== -1) {
        if (newline - beginning > MAX_INTERNAL_BYTES) conflict('Journal record exceeds 8 MiB');
        const line = pending.subarray(beginning, newline).toString('utf8');
        events.push(checked(runEventSchema, JSON.parse(line)));
        bytes += newline - beginning + 1;
        beginning = newline + 1;
      }
      pending = Buffer.from(pending.subarray(beginning));
      if (pending.length > MAX_INTERNAL_BYTES) conflict('Journal record exceeds 8 MiB');
    }
  } finally { await handle.close(); }
  validateLedger(events, runId);
  return { events, bytes, tail: pending.length > 0 };
}
function requireDeadLocal(owner: z.infer<typeof lockSchema>): void {
  if (owner.hostname !== hostname()) conflict('Cannot recover foreign-host lock ownership');
  try { process.kill(owner.pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; }
  conflict('Cannot recover live PID lock ownership');
}
/** Publish a fully initialized guard directory. Owner-specific unlink plus nonempty directory rename
 * prevents stale contenders from deleting a replacement guard belonging to a live process. */
async function recoveryGuard(path: string, owner: z.infer<typeof lockSchema>): Promise<() => Promise<void>> {
  const guard = join(path, 'lock.recovery');
  const privateGuard = join(path, `.lock-recovery-${owner.token}`);
  const ownerFile = `owner-${owner.token}.json`;
  await mkdir(privateGuard, { mode: 0o700 });
  let published = false;
  async function removeEmptyGuard(): Promise<void> {
    try { await rmdir(guard); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
    }
    await syncDirectory(path);
  }
  try {
    await atomicJson(join(privateGuard, ownerFile), owner);
    try { await rename(privateGuard, guard); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
      try {
        const names = await readdir(guard);
        if (names.length > 0) {
          if (names.length !== 1) conflict('Invalid recovery guard ownership');
          const previous = checked(lockSchema, await readJson(join(guard, names[0])));
          if (names[0] !== `owner-${previous.token}.json`) conflict('Invalid recovery guard owner file');
          requireDeadLocal(previous);
          await unlink(join(guard, names[0]));
          await syncDirectory(guard);
        }
        // An empty published guard means an interrupted cleanup; acquiring guards are never published empty.
        await removeEmptyGuard();
      } catch (error) { if (!isMissing(error)) throw error; }
      await rename(privateGuard, guard);
    }
    published = true;
    await syncDirectory(path);
    return async () => {
      await unlink(join(guard, ownerFile));
      await syncDirectory(guard);
      await removeEmptyGuard();
    };
  } finally {
    if (!published) await rm(privateGuard, { recursive: true, force: true });
  }
}
/** Only a locally dead PID is recoverable; a recovery mutex prevents two contenders unlinking each other's lock. */
export async function lockRun(path: string, recoverDead: boolean): Promise<() => Promise<void>> {
  return evidence(async () => {
    const file = join(path, 'lock');
    const owner = { pid: process.pid, hostname: hostname(), token: randomUUID() };
    async function acquire(): Promise<void> {
      const handle = await open(file, 'wx', 0o600);
      try { await handle.writeFile(serialized(owner)); await handle.sync(); } finally { await handle.close(); }
      await syncDirectory(path);
    }
    try { await acquire(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !recoverDead) conflict('Run is locked');
      const releaseGuard = await recoveryGuard(path, owner);
      try {
        const previous = checked(lockSchema, await readJson(file));
        requireDeadLocal(previous);
        await unlink(file);
        await syncDirectory(path);
        await acquire();
      } finally { await releaseGuard(); }
    }
    let released = false;
    return async () => evidence(async () => {
      if (released) return;
      const current = checked(lockSchema, await readJson(file));
      if (current.token !== owner.token) conflict('Lock ownership changed');
      await unlink(file);
      await syncDirectory(path);
      released = true;
    });
  });
}
async function readCall(path: string, key: string, runId: string): Promise<StoredCall | undefined> {
  id(key);
  const value = await optionalJson(join(path, 'calls', `${key}.json`));
  if (value === undefined) return undefined;
  const call = checked(callSchema, value);
  if (call.runId !== runId || call.callId !== key || call.request.callId !== key || call.hash !== hashJson({ request: call.request, result: call.result })) conflict('Call evidence hash or identity mismatch');
  return { request: call.request, result: call.result, hash: call.hash };
}
export async function loadCall(path: string, key: string): Promise<StoredCall | undefined> {
  return evidence(async () => {
    const manifest = await readManifest(path);
    return readCall(path, key, manifest.runId);
  });
}
async function readResult(path: string, runId: string): Promise<z.infer<typeof resultFileSchema> | undefined> {
  const value = await optionalJson(join(path, 'result.json'));
  if (value === undefined) return undefined;
  const file = checked(resultFileSchema, value);
  if (file.runId !== runId || file.result.runId !== runId || file.hash !== hashJson(file.result)) conflict('Result hash or identity mismatch');
  try { (await import('./report.js')).parseBatch(file.result); } catch { conflict('Result has invalid batch semantics'); }
  return file;
}
async function inspect(path: string) {
  const manifest = await readManifest(path);
  const ledger = await readLedger(path, manifest.runId);
  const calls = new Map<string, StoredCall>();
  const started = ledger.events.filter(event => event.type === 'call_started');
  for (const event of started) {
    const key = callId(event);
    const call = await readCall(path, key, manifest.runId);
    if (call) {
      if (payload(event).request !== undefined && hashJson(payload(event).request) !== hashJson(call.request)) conflict('Saved response request differs from started request');
      calls.set(key, call);
    }
  }
  for (const name of await readdir(join(path, 'calls'))) {
    if (name.endsWith('.tmp')) continue;
    if (!name.endsWith('.json') || !started.some(event => `${callId(event)}.json` === name)) conflict('Orphan or unknown call file');
  }
  for (const event of ledger.events.filter(event => event.type === 'call_finished')) {
    if (calls.get(callId(event))?.hash !== payload(event).hash) conflict('Finished call hash differs or response is missing');
  }
  const result = await readResult(path, manifest.runId);
  if (result && hashJson(result.result.brief) !== hashJson(manifest.brief)) conflict('Result brief differs from manifest');
  const completed = ledger.events.find(event => event.type === 'completed');
  if (completed && (!result || payload(completed).hash !== result.hash)) conflict('Completed result hash differs or result is missing');
  return { manifest, ledger, calls, result };
}
function recordStatus(events: RunEvent[]): RunRecord['status'] {
  let status: RunRecord['status'] = 'running';
  for (const event of events) {
    if (event.type === 'completed') status = 'completed';
    else if (event.type === 'call_unknown') status = 'interrupted';
    else if (event.type === 'call_started') status = 'running';
    else if (event.type === 'stopped') {
      const value = payload(event);
      status = value.code === 4 || value.status === 'limited' ? 'limited' : value.code === 130 || value.code === 143 || value.status === 'interrupted' ? 'interrupted' : 'failed';
    }
  }
  if (status === 'running' && unresolvedCalls(events).length) status = 'interrupted';
  return status;
}
/** Read-only: verifies all durable hashes; ignores an unterminated log tail without modifying files. */
export async function loadRun(path: string): Promise<RunRecord> {
  return evidence(async () => {
    const { manifest, ledger, result } = await inspect(path);
    return { schemaVersion: 1, runId: manifest.runId, manifest, events: ledger.events, status: recordStatus(ledger.events), ...(result ? { result: result.result } : {}) };
  });
}
function makeStore(path: string, manifest: RunManifest, initial: RunEvent[], release: () => Promise<void>): RunStore {
  let events = initial;
  let queue: Promise<void> = Promise.resolve();
  let closing = false;
  let poisoned = false;
  let closePromise: Promise<void> | undefined;
  function enqueue(operation: () => Promise<void>): Promise<void> {
    if (closing) return Promise.reject(new AppError(5, 'Run store is closed'));
    const next = queue.then(() => { if (poisoned) conflict('Ledger write failed; close and reopen before further writes'); return evidence(operation); });
    queue = next.catch(() => {});
    return next;
  }
  const secrets = manifestSecrets(manifest);
  async function append(event: EventInput): Promise<void> {
    const clean = checked(runEventSchema, {
      ...scrub(event, secrets) as EventInput, schemaVersion: 1, seq: events.length + 1,
      runId: manifest.runId, at: new Date().toISOString(),
    });
    if (clean.type === 'call_finished') {
      const call = await readCall(path, callId(clean), manifest.runId);
      if (!call) conflict('Cannot finish a call without durable response');
      if (payload(clean).hash !== undefined && payload(clean).hash !== call.hash) conflict('Call finished hash mismatch');
      clean.payload = { ...payload(clean), hash: call.hash };
    } else if (clean.type === 'completed') {
      const result = await readResult(path, manifest.runId);
      if (!result || payload(clean).hash !== result.hash) conflict('Completion requires durable result and hash');
    }
    validateLedger([...events, clean], manifest.runId);
    const line = serialized(clean) + '\n';
    try {
      const handle = await open(join(path, 'events.jsonl'), constants.O_WRONLY | constants.O_APPEND);
      try {
        await handle.writeFile(line); await handle.sync();
      } finally { await handle.close(); }
    } catch (error) { poisoned = true; throw error; }
    events = [...events, clean];
  }
  return {
    path,
    append: event => enqueue(() => append(event)),
    saveCall: (key, request, result) => enqueue(async () => {
      id(key);
      const cleanRequest = checked(completionRequestSchema, scrub(request, secrets));
      const cleanResult = checked(completionSchema, scrub(result, secrets));
      if (cleanRequest.callId !== key) conflict('Call ID differs from request');
      const started = events.find(event => event.type === 'call_started' && callId(event) === key);
      if (!started || events.some(event => event.type === 'call_finished' && callId(event) === key)) conflict('Call response requires an unfinished started attempt');
      if (payload(started).request !== undefined && hashJson(payload(started).request) !== hashJson(cleanRequest)) conflict('Request differs from started attempt');
      if (await readCall(path, key, manifest.runId)) conflict('Call response already committed');
      const body = { request: cleanRequest, result: cleanResult };
      await atomicJson(join(path, 'calls', `${key}.json`), { schemaVersion: 1, runId: manifest.runId, callId: key, ...body, hash: hashJson(body) });
    }),
    complete: result => enqueue(async () => {
      const clean = checked(resultSchema, scrub(result, secrets));
      if (clean.runId !== manifest.runId || hashJson(clean.brief) !== hashJson(manifest.brief)) conflict('Result run ID/brief mismatch');
      if (events.some(event => event.type === 'completed')) conflict('Run already completed');
      if (unresolvedCalls(events).length) conflict('Cannot complete unresolved paid attempts');
      const hash = hashJson(clean);
      if (await readResult(path, manifest.runId)) conflict('Result already committed; reopen to repair completion');
      await atomicJson(join(path, 'result.json'), { schemaVersion: 1, runId: manifest.runId, result: clean, hash });
      await append({ type: 'completed', payload: { hash } });
    }),
    close() {
      if (!closePromise) {
        closing = true;
        closePromise = queue.then(release);
      }
      return closePromise;
    },
  };
}
/** root is the runs directory. New runs never overwrite an existing directory. */
export async function openRun(root: string, input: RunManifest): Promise<RunStore> {
  return evidence(async () => {
    const manifest = validateManifest(scrub(input, manifestSecrets(input)));
    const path = join(root, id(manifest.runId));
    await mkdir(root, { recursive: true });
    await mkdir(path, { mode: 0o700 });
    await syncDirectory(root);
    const release = await lockRun(path, false);
    try {
      await mkdir(join(path, 'calls'), { mode: 0o700 });
      await atomicJson(join(path, 'manifest.json'), manifest);
      await atomicJson(join(path, 'manifest.hash.json'), {schemaVersion:1,runId:manifest.runId,hash:hashJson(manifest)});
      const started: RunEvent = { schemaVersion: 1, seq: 1, runId: manifest.runId, type: 'started', at: new Date().toISOString(), payload: {} };
      const handle = await open(join(path, 'events.jsonl'), 'wx', 0o600);
      try { await handle.writeFile(serialized(started) + '\n'); await handle.sync(); } finally { await handle.close(); }
      await syncDirectory(path);
      return makeStore(path, manifest, [started], release);
    } catch (error) { await release(); throw error; }
  });
}
/** Reacquire ownership, truncate only an incomplete tail, and repair events from verified atomic files. No Provider is called. */
export async function reopenRun(path: string, recoverDead = false): Promise<RunStore> {
  return evidence(async () => {
    const release = await lockRun(path, recoverDead);
    let store: RunStore | undefined;
    try {
      const { manifest, ledger, calls, result } = await inspect(path);
      if (ledger.tail) {
        await truncate(join(path, 'events.jsonl'), ledger.bytes);
        const handle = await open(join(path, 'events.jsonl'), 'r+');
        try { await handle.sync(); } finally { await handle.close(); }
      }
      store = makeStore(path, manifest, ledger.events, release);
      const finished = new Set(ledger.events.filter(event => event.type === 'call_finished').map(callId));
      const unknown = new Set(ledger.events.filter(event => event.type === 'call_unknown').map(callId));
      for (const event of ledger.events.filter(event => event.type === 'call_started')) {
        const key = callId(event);
        if (finished.has(key)) continue;
        const call = calls.get(key);
        if (call) await store.append({ type: 'call_finished', payload: { callId: key, hash: call.hash, usage: call.result.usage, recovered: true } });
        else if (!unknown.has(key)) await store.append({ type: 'call_unknown', payload: { callId: key, reason: 'Started attempt has no durable response; it may have been charged' } });
      }
      if (result && !ledger.events.some(event => event.type === 'completed')) await store.append({ type: 'completed', payload: { hash: result.hash, recovered: true } });
      return store;
    } catch (error) { if (store) await store.close(); else await release(); throw error; }
  });
}
