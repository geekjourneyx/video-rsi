import { createHash } from 'node:crypto';
import {
  parseBrief, parseConfig, type Brief, type Candidate, type CandidateBatch,
  type Completion, type CompletionRequest, type Config, type EvaluatedBatch,
  type ModelClient, type RunManifest, type RunRecord, type Verdict,
} from './contracts.js';
import { generate, type ContentCall } from './create.js';
import { evaluate, rank } from './judge.js';
import { AppError } from './errors.js';
import { reserve, settle, type LimitState } from './limits.js';
import { hashJson, loadRun, MAX_INTERNAL_BYTES, type RunStore } from './store.js';

export function checkPlan(config: Config, review: boolean): void {
  if (!review && config.rounds !== 1) {
    throw new AppError(2, 'Multiple rounds require --review');
  }
  if ((review ? 2 * config.rounds : 1) > config.limits.maxCalls) {
    throw new AppError(4, 'Planned calls exceed maxCalls');
  }
}

export function cancellation(signal: AbortSignal): AppError {
  return signal.reason instanceof AppError ? signal.reason : new AppError(130, 'Run cancelled');
}

/** Match the exact envelope the journal will serialize, including metadata. */
function preflightStarted(record: RunRecord, seq: number, payload: unknown): void {
  const event = { type: 'call_started', payload, schemaVersion: 1, seq,
    runId: record.runId, at: new Date().toISOString() };
  const serialized = JSON.stringify(event);
  if (Buffer.byteLength(serialized) > MAX_INTERNAL_BYTES) {
    throw new AppError(5, 'Call evidence exceeds 8 MiB');
  }
}

type Journal = { nextSeq: number; append: RunStore['append'] };

export function journal(store: RunStore, record: RunRecord): Journal {
  const ledger: Journal = {
    nextSeq: record.events.at(-1)!.seq + 1,
    async append(event) {
      await store.append(event);
      ledger.nextSeq++;
    },
  };
  return ledger;
}

export type RecoveryCalls = {
  state: LimitState;
  attempts: { request: CompletionRequest; retryOf?: string }[];
  completions: Map<string, Completion>;
  retryUnknown: boolean;
};

/** Shared paid path; cached attempts are matched against the regenerated exact request. */
export function makeCall(record: RunRecord, client: ModelClient, store: RunStore, signal: AbortSignal, ledger: Journal, recovery?: RecoveryCalls): ContentCall {
  const { manifest } = record;
  let state: LimitState = recovery?.state ?? { attempts: 0, reservedMicrousd: 0, settledMicrousd: 0, uncertain: false };
  const roots = recovery?.attempts.filter(attempt => !attempt.retryOf) ?? [];
  const children = new Map(recovery?.attempts.filter(attempt => attempt.retryOf).map(attempt => [attempt.retryOf!, attempt]));
  let cursor = 0;
  const used = new Set(recovery?.attempts.map(attempt => attempt.request.callId));
  function gate(completion: Completion): Completion {
    const budget = manifest.config.limits.maxEstimatedCostMicrousd;
    if (completion.stopReason === 'stop' && budget !== null &&
        (state.uncertain || state.reservedMicrousd + state.settledMicrousd > budget)) {
      throw new AppError(4, state.uncertain ? 'Call cost is unknown; estimated budget cannot continue' : 'Estimated cost limit reached');
    }
    return completion;
  }
  return async (role, system, input) => {
    if (signal.aborted) throw cancellation(signal);
    const model = manifest.config.models[role];
    const price = manifest.priceSnapshots.find(price => price.provider === model.provider && price.model === model.model) ?? null;
    let prior = roots[cursor++];
    if (prior) {
      const expected = { callId: prior.request.callId, role, model: { ...model }, system, input,
        maxOutputTokens: manifest.config.limits.maxOutputTokens, timeoutMs: manifest.config.limits.timeoutMs };
      if (hashJson(expected) !== hashJson(prior.request)) throw new AppError(5, 'Cached request differs from frozen execution');
      while (children.has(prior.request.callId)) {
        const child = children.get(prior.request.callId)!;
        if (hashJson({ ...child.request, callId: prior.request.callId }) !== hashJson(prior.request)) {
          throw new AppError(5, 'Retry request differs from its parent');
        }
        prior = child;
      }
      const cached = recovery!.completions.get(prior.request.callId);
      if (cached) return gate(cached);
      if (!recovery!.retryUnknown) throw new AppError(5, 'Unknown call may have been charged; use --retry-unknown to authorize another attempt');
    }
    // Only a genuinely new attempt needs local provider configuration. Exclude
    // durable responses, including retry descendants, from remaining roles.
    const plan: CompletionRequest['role'][] = manifest.operation.kind === 'judge'
      ? ['judge'] : manifest.operation.review
        ? Array.from({ length: manifest.config.rounds }, () => ['writer', 'judge'] as const).flat()
        : ['writer'];
    const remaining = plan.slice(cursor - 1).filter((_role, offset) => {
      let attempt = roots[cursor - 1 + offset];
      while (attempt && children.has(attempt.request.callId)) attempt = children.get(attempt.request.callId)!;
      return !attempt || !recovery?.completions.has(attempt.request.callId);
    });
    await client.preflight?.([...new Set(remaining)]);
    if (signal.aborted) throw cancellation(signal);
    const reservation = reserve(state, manifest.config.limits, price);
    let nextId = reservation.next.attempts;
    while (used.has(`call-${nextId}`)) nextId++;
    const request: CompletionRequest = {
      callId: `call-${nextId}`, role, model: { ...model }, system, input,
      maxOutputTokens: manifest.config.limits.maxOutputTokens,
      timeoutMs: manifest.config.limits.timeoutMs,
    };
    // Check the exact request and its persisted event before any paid dispatch.
    hashJson(request);
    const payload = { callId: request.callId, request, reservationMicrousd: reservation.reservationMicrousd,
      limitState: reservation.next, ...(prior ? { retryOf: prior.request.callId } : {}) };
    preflightStarted(record, ledger.nextSeq, payload);
    await ledger.append({ type: 'call_started', payload });
    used.add(request.callId);
    state = reservation.next;
    if (signal.aborted) {
      await ledger.append({ type: 'call_unknown', payload: { callId: request.callId, reason: 'Cancelled after reservation; no durable response' } });
      throw cancellation(signal);
    }
    let completion: Completion;
    try {
      // Prevent a client from mutating the durable request snapshot.
      completion = await client.complete(structuredClone(request), signal);
    } catch {
      if (signal.aborted) {
        await ledger.append({ type: 'call_unknown', payload: { callId: request.callId, reason: 'Cancelled dispatched attempt has no durable response; it may have been charged' } });
        throw cancellation(signal);
      }
      completion = { text: '', stopReason: signal.aborted ? 'aborted' : 'error',
        usage: { inputTokens: null, outputTokens: null, estimatedCostMicrousd: null },
        raw: { reason: 'Client rejected; usage and possible charge unknown' } };
    }
    await store.saveCall(request.callId, request, completion);
    state = settle(state, reservation.reservationMicrousd, completion);
    await ledger.append({ type: 'call_finished', payload: { callId: request.callId,
      usage: completion.usage, reservationMicrousd: reservation.reservationMicrousd, limitState: state } });
    if (signal.aborted) throw cancellation(signal);
    return gate(completion);
  };
}

async function execute<T>(store: RunStore, signal: AbortSignal, operation: (record: RunRecord) => Promise<T>): Promise<T> {
  const record = await loadRun(store.path);
  let result: T;
  try {
    if (record.events.length !== 1 || record.status !== 'running') {
      throw new AppError(5, 'Pipeline requires a fresh run; resume is a separate operation');
    }
    result = await operation(record);
  } catch (error) {
    const app = error instanceof AppError ? error : new AppError(1, 'Pipeline failed');
    await store.append({ type: 'stopped', payload: { code: app.code,
      status: app.code === 4 ? 'limited' : app.code === 130 || app.code === 143 ? 'interrupted' : 'failed',
      message: app.message } });
    throw new AppError(app.code, app.message, record.runId);
  }
  // Cancellation after durable completion must not append after completed.
  if (signal.aborted) {
    const app = cancellation(signal);
    throw new AppError(app.code, app.message, record.runId);
  }
  return result;
}

function matchConfig(config: Config, manifest: RunManifest): void {
  if (hashJson(parseConfig(config)) !== hashJson(manifest.config)) {
    throw new AppError(5, 'Config differs from manifest snapshot');
  }
}

export async function runPipeline(
  brief: Brief, config: Config, client: ModelClient, store: RunStore,
  signal: AbortSignal, review: boolean,
): Promise<CandidateBatch | EvaluatedBatch> {
  return execute(store, signal, async record => {
    const manifest = record.manifest;
    matchConfig(config, manifest);
    if (hashJson(parseBrief(brief)) !== hashJson(manifest.brief) ||
        manifest.operation.kind !== 'create' || manifest.operation.review !== review) {
      throw new AppError(5, 'Creation inputs differ from manifest snapshot');
    }
    checkPlan(manifest.config, review);
    const ledger = journal(store, record);
    const call = makeCall(record, client, store, signal, ledger);
    const result = await executeManifest(record, call, ledger);
    if (signal.aborted) throw cancellation(signal);
    await store.complete(result);
    return result;
  });
}

/** Deterministic content orchestration reused by fresh runs and recovery. */
export async function executeManifest(record: RunRecord, call: ContentCall, ledger: Journal): Promise<CandidateBatch | EvaluatedBatch> {
  const { manifest } = record;
  if (manifest.operation.kind === 'judge') {
    if (!manifest.inputBatch || manifest.inputBatchHash !== hashJson(manifest.inputBatch)) throw new AppError(5, 'Standalone judgment requires frozen input');
    return evaluate({ ...manifest.inputBatch, runId: record.runId }, call, manifest.prompts.judge, manifest.seed);
  }
  checkPlan(manifest.config, manifest.operation.review);
  const candidates: Candidate[] = [];
  const verdicts: Verdict[] = [];
  const seen = new Set<string>();
  let previous: EvaluatedBatch | null = null;
  for (let round = 1; round <= manifest.config.rounds; round++) {
    const generated = await generate(manifest.brief, round, previous, call,
      manifest.prompts.writer, manifest.config.candidatesPerRound);
    const batch: CandidateBatch = { schemaVersion: 1, runId: record.runId, brief: manifest.brief, candidates: generated };
    const judged = manifest.operation.review ? await evaluate(batch, call, manifest.prompts.judge, manifest.seed) : null;
    for (const candidate of generated) {
      const hash = createHash('sha256').update(JSON.stringify([candidate.title, candidate.script])).digest('hex');
      if (seen.has(hash)) continue;
      seen.add(hash);
      candidates.push(candidate);
      const verdict = judged?.evaluation.verdicts.find(verdict => verdict.candidateId === candidate.id);
      if (verdict) verdicts.push(verdict);
    }
    if (manifest.operation.review) previous = { ...batch, candidates: [...candidates], evaluation: rank(candidates, [...verdicts]) };
    if (!record.events.some(event => event.type === 'round_finished' && (event.payload as {round?:number}).round === round)) await ledger.append({ type: 'round_finished', payload: { round,
      candidateIds: candidates.map(candidate => candidate.id) } });
  }
  const result: CandidateBatch | EvaluatedBatch = previous ?? {
    schemaVersion: 1, runId: record.runId, brief: manifest.brief, candidates,
  };
  return result;
}

/** Standalone judgment gets a distinct manifest and run, retaining source batch evidence. */
export async function runJudgePipeline(
  config: Config, client: ModelClient, store: RunStore, signal: AbortSignal,
): Promise<EvaluatedBatch> {
  return execute(store, signal, async record => {
    const manifest = record.manifest;
    matchConfig(config, manifest);
    if (manifest.operation.kind !== 'judge' || !manifest.inputBatch ||
        manifest.inputBatchHash !== hashJson(manifest.inputBatch)) {
      throw new AppError(5, 'Standalone judgment requires a frozen input batch and hash');
    }
    const ledger = journal(store, record);
    const result = await executeManifest(record, makeCall(record, client, store, signal, ledger), ledger) as EvaluatedBatch;
    if (signal.aborted) throw cancellation(signal);
    await store.complete(result);
    return result;
  });
}
