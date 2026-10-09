import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { resumeRun, replayRun } from '../src/replay.js';
import { generate } from '../src/create.js';
import { runPipeline } from '../src/pipeline.js';
import { loadRun, loadCall, openRun, hashJson } from '../src/store.js';
import { summarizeCost } from '../src/report.js';
import { reserve } from '../src/limits.js';
import { main } from '../src/cli.js';
import { AppError } from '../src/errors.js';
import * as storeApi from '../src/store.js';
import type { Config, Completion, CompletionRequest, ModelClient, RunManifest } from '../src/contracts.js';
import { brief, config, candidates, evaluated } from './fixtures.js';
const factory = vi.hoisted(() => ({ count: 0 }));
vi.mock('../src/model.js', () => ({ createModelClient: () => { factory.count++; throw new Error('Must stay offline'); }, resolvePrice: () => { throw new Error('Must use frozen price'); } }));
const roots: string[] = [];
afterEach(async () => { factory.count = 0; vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const signal = () => new AbortController().signal;
const options = { recoverLock: false, retryUnknown: false };
const response = (text: string): Completion => ({ text, stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, estimatedCostMicrousd: 7 }, raw: {} });
function fake() {
  const requests: CompletionRequest[] = [];
  const model: ModelClient = { async complete(request) {
    requests.push(structuredClone(request));
    const input = JSON.parse(request.input);
    const { id: _id, round: _round, ...candidate } = candidates.candidates[0]!;
    return response(JSON.stringify(request.role === 'writer' ? { candidates: [{ ...candidate, title: `Title ${input.previous ? 2 : 1}` }] } : {
      verdicts: input.candidates.map((item: { id: string }) => ({ ...evaluated.evaluation.verdicts[0], candidateId: item.id })) }));
  } };
  return { model, requests };
}
async function setup(changes: { budget?: number; maxCalls?: number; review?: boolean; rounds?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'resume-')); roots.push(root);
  const cfg: Config = { ...config, candidatesPerRound: 1, rounds: changes.rounds ?? 1,
    limits: { ...config.limits, maxCalls: changes.maxCalls ?? 8, maxEstimatedCostMicrousd: changes.budget ?? null } };
  const manifest: RunManifest = { schemaVersion: 1, runId: 'resume-test', brief, config: cfg,
    prompts: { writer: '\nFrozen writer\n', judge: '\nFrozen judge\n' }, softwareVersion: '0.1.0', seed: 42,
    operation: { kind: 'create', review: changes.review ?? true }, priceSnapshots: Object.values(cfg.models).map(model => ({
      provider: model.provider, model: model.model, inputPerMillionMicrousd: 1_000_000, outputPerMillionMicrousd: 1_000_000,
      contextWindow: 10, observedAt: '2026-10-09T00:00:00Z', source: 'Frozen fixture' })) };
  return { root, manifest, store: await openRun(root, manifest) };
}
async function startWriter(fixture: Awaited<ReturnType<typeof setup>>, durable: boolean, text?: string) {
  const { store, manifest } = fixture;
  const { model } = fake();
  let request!: CompletionRequest;
  const reservation = reserve({ attempts: 0, settledMicrousd: 0, reservedMicrousd: 0, uncertain: false }, manifest.config.limits, manifest.priceSnapshots[0]!);
  await generate(brief, 1, null, async (role, system, input) => {
    request = { callId: 'call-1', role, model: manifest.config.models[role], system, input, maxOutputTokens: manifest.config.limits.maxOutputTokens, timeoutMs: manifest.config.limits.timeoutMs };
    await store.append({ type: 'call_started', payload: { callId: request.callId, request, reservationMicrousd: reservation.reservationMicrousd, limitState: reservation.next } });
    const result = await model.complete(request, signal());
    if (durable) await store.saveCall(request.callId, request, text === undefined ? result : response(text));
    return result;
  }, manifest.prompts.writer, 1);
  await store.close();
  return request;
}
it('repairs cached exact writer response without repayment and uses manifest snapshots', async () => {
  const fixture = await setup(); const request = await startWriter(fixture, true);
  await writeFile(join(fixture.root, 'video-rsi.json'), 'bad changed config');
  const { model, requests } = fake();
  const result = await resumeRun(fixture.store.path, model, signal(), options);
  expect(result.candidates).toHaveLength(1);
  expect(requests.map(request => request.role)).toEqual(['judge']);
  expect(requests[0]!.system).toBe(fixture.manifest.prompts.judge);
  expect((await loadCall(fixture.store.path, 'call-1'))!.request).toEqual(request);
  expect(JSON.parse(summarizeCost(await loadRun(fixture.store.path)))).toMatchObject({ calls: 2, estimatedCostMicrousd: 14, reservedMicrousd: 0 });
});
it('defaults to refusing a missing response as possibly charged, with no dispatch', async () => {
  const fixture = await setup(); await startWriter(fixture, false); const { model, requests } = fake();
  await expect(resumeRun(fixture.store.path, model, signal(), options)).rejects.toMatchObject({ code: 5 });
  expect(requests).toHaveLength(0);
  expect((await loadRun(fixture.store.path)).events.some(event => event.type === 'call_unknown')).toBe(true);
});
it('explicit retry keeps prior count and conservative cost while reserving a new unique lineage attempt', async () => {
  const fixture = await setup({ budget: 5000, review: false }); await startWriter(fixture, false);
  const { model, requests } = fake();
  await resumeRun(fixture.store.path, model, signal(), { ...options, retryUnknown: true });
  expect(requests).toHaveLength(1); expect(requests[0]!.callId).toBe('call-2');
  const record = await loadRun(fixture.store.path);
  expect(record.events.filter(event => event.type === 'call_started').map(event => event.payload)).toMatchObject([
    { callId: 'call-1', reservationMicrousd: 2058 }, { callId: 'call-2', retryOf: 'call-1', reservationMicrousd: 2058 } ]);
  expect(record.events.filter(event => event.type === 'call_unknown')).toHaveLength(1);
  expect(JSON.parse(summarizeCost(record))).toMatchObject({ calls: 2, estimatedCostMicrousd: null, reservedMicrousd: 2058 });
});
it.each([{ budget: 3000 }, { maxCalls: 1 }])('retry cannot exceed original budgets %j', async changes => {
  const fixture = await setup({ ...changes, review: false }); await startWriter(fixture, false); const { model, requests } = fake();
  await expect(resumeRun(fixture.store.path, model, signal(), { ...options, retryUnknown: true })).rejects.toMatchObject({ code: 4 });
  expect(requests).toHaveLength(0);
});
it('cached malformed output is never silently retried', async () => {
  const fixture = await setup(); await startWriter(fixture, true, 'not json'); const { model, requests } = fake();
  await expect(resumeRun(fixture.store.path, model, signal(), { ...options, retryUnknown: true })).rejects.toMatchObject({ code: 3 });
  expect(requests).toHaveLength(0);
});
it('completed replay and resume use zero client construction and zero dispatch', async () => {
  const fixture = await setup(); const { model } = fake();
  const expected = await runPipeline(brief, fixture.manifest.config, model, fixture.store, signal(), true); await fixture.store.close();
  expect(await replayRun(fixture.store.path)).toEqual(expected);
  const offline: ModelClient = { complete: () => { throw new Error('Must stay offline'); } };
  expect(await resumeRun(fixture.store.path, offline, signal(), options)).toEqual(expected);
  for (const command of ['replay', 'resume']) {
    let output = ''; const stdout = new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } });
    expect(await main([command, fixture.store.path, '--quiet'], { stdin: Readable.from([]), stdout, stderr: new Writable({ write(_chunk, _encoding, done) { done(); } }) })).toBe(0);
    expect(JSON.parse(output)).toEqual(expected);
  }
  expect(factory.count).toBe(0);
});
it('replay refuses absent result, hash corruption, and semantic corruption even with recomputed hash', async () => {
  const fixture = await setup({ review: false });
  await expect(replayRun(fixture.store.path)).rejects.toMatchObject({ code: 5 });
  const { model } = fake(); await runPipeline(brief, fixture.manifest.config, model, fixture.store, signal(), false); await fixture.store.close();
  const path = join(fixture.store.path, 'result.json'); const envelope = JSON.parse(await readFile(path, 'utf8'));
  envelope.result.candidates[0].title = 'changed'; await writeFile(path, JSON.stringify(envelope));
  await expect(replayRun(fixture.store.path)).rejects.toMatchObject({ code: 5 });
  envelope.result.candidates[0].claims[0].sourceIds = ['missing']; envelope.hash = hashJson(envelope.result);
  await writeFile(path, JSON.stringify(envelope));
  const ledger = await readFile(join(fixture.store.path, 'events.jsonl'), 'utf8');
  await writeFile(join(fixture.store.path, 'events.jsonl'), ledger.split('\n').map(line => { if (!line) return line; const event = JSON.parse(line); if (event.type === 'completed') event.payload.hash = envelope.hash; return JSON.stringify(event); }).join('\n'));
  await expect(replayRun(fixture.store.path)).rejects.toMatchObject({ code: 5 });
});
it.each(['--config', '--runs-dir', '--review', '--format'])('resume refuses override %s without constructing client', async flag => {
  const fixture = await setup(); await fixture.store.close();
  const argv = ['resume', fixture.store.path, flag, ...(['--review'].includes(flag) ? [] : ['override'])];
  const out = new Writable({ write(_chunk, _encoding, done) { done(); } });
  expect(await main(argv, { stdin: Readable.from([]), stdout: out, stderr: out })).toBe(2); expect(factory.count).toBe(0);
});
it('continues multiple rounds from cached W/J, reconstructs repaired settlement, and retains unknown retry cost', async () => {
  const fixture = await setup({ rounds: 2, maxCalls: 5, budget: 5000 });
  const first = fake(); const controller = new AbortController();
  const interrupting: ModelClient = { async complete(request, signal) {
    if (request.callId === 'call-3') { controller.abort(); throw new Error('Lost response'); }
    return first.model.complete(request, signal);
  } };
  await expect(runPipeline(brief, fixture.manifest.config, interrupting, fixture.store, controller.signal, true)).rejects.toMatchObject({ code: 130 });
  await fixture.store.close();
  // Response rename survived; simulate loss of its finish append, leaving no settlement state.
  const ledgerPath = join(fixture.store.path, 'events.jsonl');
  const events = (await readFile(ledgerPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(event => !(event.type === 'call_finished' && event.payload.callId === 'call-2'));
  await writeFile(ledgerPath, events.map((event, index) => JSON.stringify({ ...event, seq: index + 1 })).join('\n') + '\n');
  const { model, requests } = fake();
  const result = await resumeRun(fixture.store.path, model, signal(), { ...options, retryUnknown: true });
  expect(requests.map(request => [request.callId, request.role])).toEqual([['call-4', 'writer'], ['call-5', 'judge']]);
  expect(requests[0]!.input).toContain('Title 1'); expect(requests[0]!.input).toContain('来源支持');
  expect(result.candidates.map(candidate => candidate.id)).toEqual(['r1-c1', 'r2-c1']);
  const record = await loadRun(fixture.store.path);
  expect(record.events.filter(event => event.type === 'round_finished')).toHaveLength(2);
  expect(record.events.find(event => event.type === 'call_finished' && (event.payload as {callId:string}).callId === 'call-2')!.payload).toMatchObject({ recovered: true });
  expect(JSON.parse(summarizeCost(record))).toMatchObject({ calls: 5, estimatedCostMicrousd: null, reservedMicrousd: 2058 });
  const last = record.events.filter(event => event.type === 'call_finished').at(-1)!.payload;
  expect(last).toMatchObject({ limitState: { attempts: 5, settledMicrousd: 28, reservedMicrousd: 2058 } });
});
it('repaired finished response settles its real cost before next frozen-price reservation', async () => {
  const fixture = await setup({ budget: 2065 }); await startWriter(fixture, true);
  const { model, requests } = fake(); await resumeRun(fixture.store.path, model, signal(), options);
  expect(requests).toHaveLength(1);
  expect(JSON.parse(summarizeCost(await loadRun(fixture.store.path)))).toMatchObject({ calls: 2, estimatedCostMicrousd: 14, reservedMicrousd: 0 });
});
it('incompatible software snapshots fail closed before dispatch or migration', async () => {
  const fixture = await setup(); await fixture.store.close();
  const path = join(fixture.store.path, 'manifest.json'); const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.softwareVersion = '9.0.0'; await writeFile(path, JSON.stringify(manifest));
  await writeFile(join(fixture.store.path, 'manifest.hash.json'), JSON.stringify({ schemaVersion: 1, runId: manifest.runId, hash: hashJson(manifest) }));
  const { model, requests } = fake(); await expect(resumeRun(fixture.store.path, model, signal(), options)).rejects.toMatchObject({code:5});
  expect(requests).toHaveLength(0); await expect(replayRun(fixture.store.path)).rejects.toMatchObject({code:5});
});
it('abort during final round append stops before completion and recovers cached output offline', async () => {
  const fixture = await setup({ review: false }); const controller = new AbortController();
  const { model, requests } = fake();
  const wrapped = { ...fixture.store, async append(event: Parameters<typeof fixture.store.append>[0]) {
    await fixture.store.append(event);
    if (event.type === 'round_finished') controller.abort(new AppError(130, 'Late SIGINT'));
  } };
  await expect(runPipeline(brief, fixture.manifest.config, model, wrapped, controller.signal, false)).rejects.toMatchObject({ code: 130 });
  await fixture.store.close(); expect(requests).toHaveLength(1);
  const interrupted = await loadRun(fixture.store.path); expect(interrupted.status).toBe('interrupted'); expect(interrupted.result).toBeUndefined();
  const offline = fake(); const result = await resumeRun(fixture.store.path, offline.model, signal(), options);
  expect(result.candidates).toHaveLength(1); expect(offline.requests).toHaveLength(0);
});
it('abort during completed append keeps final evidence but returns cancellation for fresh and resumed runs', async () => {
  for (const resumed of [false, true]) {
    const fixture = await setup({ review: false }); const controller = new AbortController(); const { model, requests } = fake();
    if (resumed) await fixture.store.close();
    const wrap = (store: typeof fixture.store) => ({ ...store, async complete(result: Parameters<typeof store.complete>[0]) {
      await store.complete(result); controller.abort(new AppError(143, 'Late SIGTERM'));
    } });
    if (resumed) {
      const real = storeApi.reopenRun;
      vi.spyOn(storeApi, 'reopenRun').mockImplementation(async (...args) => wrap(await real(...args)));
      await expect(resumeRun(fixture.store.path, model, controller.signal, options)).rejects.toMatchObject({ code: 143 });
      vi.restoreAllMocks();
    } else {
      await expect(runPipeline(brief, fixture.manifest.config, model, wrap(fixture.store), controller.signal, false)).rejects.toMatchObject({ code: 143 });
      await fixture.store.close();
    }
    expect(requests).toHaveLength(1); const completed = await loadRun(fixture.store.path); expect(completed.status).toBe('completed');
    expect(await replayRun(fixture.store.path)).toEqual(completed.result);
  }
});
it.each(['replay', 'resume'])('late OS signal during offline %s result load suppresses business stdout', async command => {
  const fixture = await setup({ review: false }); const { model } = fake();
  await runPipeline(brief, fixture.manifest.config, model, fixture.store, signal(), false); await fixture.store.close();
  const real = storeApi.loadRun;
  let loads = 0;
  vi.spyOn(storeApi, 'loadRun').mockImplementation(async path => {
    const record = await real(path);
    // Resume has one CLI snapshot, then its own completed-result load.
    if (++loads === (command === 'resume' ? 3 : 1)) process.emit('SIGTERM');
    return record;
  });
  let output = ''; let diagnostic = '';
  const stdout = new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } });
  const stderr = new Writable({ write(chunk, _encoding, done) { diagnostic += chunk; done(); } });
  expect(await main([command, fixture.store.path], { stdin: Readable.from([]), stdout, stderr })).toBe(143);
  expect(output).toBe(''); expect(diagnostic).toContain('Interrupted by SIGTERM'); expect(factory.count).toBe(0);
});
