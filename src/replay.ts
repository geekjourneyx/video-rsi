import { completionRequestSchema, type CandidateBatch, type Completion, type EvaluatedBatch, type ModelClient, type RunRecord } from './contracts.js';
import { AppError } from './errors.js';
import { reconstructLimits, reserve } from './limits.js';
import { cancellation, executeManifest, journal, makeCall, type RecoveryCalls } from './pipeline.js';
import { hashJson, loadCall, loadRun, reopenRun } from './store.js';

import { softwareVersion } from './runtime.js';

function compatible(record: RunRecord): void {
  if (record.manifest.softwareVersion !== softwareVersion) throw new AppError(5, 'Run software version is incompatible; no automatic migration', record.runId);
}

/** Read-only verified result; neither loads a provider nor acquires a writer lock. */
export async function replayRun(path: string): Promise<CandidateBatch | EvaluatedBatch> {
  const record = await loadRun(path);
  compatible(record);
  if (!record.result) throw new AppError(5, 'Run has no durable final result', record.runId);
  return record.result;
}

export async function resumeRun(path: string, client: ModelClient, signal: AbortSignal, options: {recoverLock: boolean; retryUnknown: boolean}): Promise<CandidateBatch | EvaluatedBatch> {
  const initial = await loadRun(path);
  compatible(initial);
  if (signal.aborted) throw cancellation(signal);
  if (initial.status === 'completed') return initial.result!;
  const store = await reopenRun(path, options.recoverLock);
  let record: RunRecord | undefined;
  let succeeded = false;
  try {
    record = await loadRun(path);
    if (signal.aborted) throw cancellation(signal);
    if (record.result) { succeeded = true; return record.result; }
    const attempts: RecoveryCalls['attempts'] = [];
    const completions = new Map<string, Completion>();
    for (const event of record.events.filter(event => event.type === 'call_started')) {
      const payload = event.payload as {callId:string; request:unknown; reservationMicrousd:unknown; retryOf?:string};
      const parsed = completionRequestSchema.safeParse(payload.request);
      if (!parsed.success || parsed.data.callId !== payload.callId || !Number.isSafeInteger(payload.reservationMicrousd) || (payload.reservationMicrousd as number) < 0) {
        throw new AppError(5, 'Started attempt lacks exact request/reservation evidence');
      }
      const request = parsed.data;
      const manifest = record.manifest;
      const model = manifest.config.models[request.role];
      if (hashJson(request.model) !== hashJson(model) || request.system !== manifest.prompts[request.role] ||
          request.maxOutputTokens !== manifest.config.limits.maxOutputTokens || request.timeoutMs !== manifest.config.limits.timeoutMs) {
        throw new AppError(5, 'Started request differs from manifest');
      }
      // Reservation comes from the frozen catalog, never today's provider prices.
      const price = manifest.priceSnapshots.find(price => price.provider === model.provider && price.model === model.model) ?? null;
      const expected = reserve({ attempts: 0, reservedMicrousd: 0, settledMicrousd: 0, uncertain: false }, manifest.config.limits, price).reservationMicrousd;
      if (payload.reservationMicrousd !== expected) throw new AppError(5, 'Started reservation differs from frozen price');
      attempts.push({request, ...(payload.retryOf ? {retryOf:payload.retryOf} : {})});
      const call = await loadCall(path, request.callId);
      if (call) completions.set(request.callId, call.result);
    }
    if (attempts.length > record.manifest.config.limits.maxCalls) throw new AppError(5, 'Recorded attempts exceed call limit');
    const parents = new Set(attempts.map(attempt => attempt.retryOf));
    if (!options.retryUnknown && attempts.some(attempt => !completions.has(attempt.request.callId) && !parents.has(attempt.request.callId))) {
      throw new AppError(5, 'Unknown call may have been charged; use --retry-unknown to authorize another attempt');
    }
    const state = reconstructLimits(record, completions);
    const ledger = journal(store, record);
    const call = makeCall(record, client, store, signal, ledger, { state, attempts, completions, retryUnknown: options.retryUnknown });
    const result = await executeManifest(record, call, ledger);
    if (signal.aborted) throw cancellation(signal);
    await store.complete(result);
    succeeded = true;
    return result;
  } catch (error) {
    const app = error instanceof AppError ? error : new AppError(5, 'Recovery evidence is invalid');
    if (record && record.status !== 'completed') {
      await store.append({type:'stopped',payload:{code:app.code,status:app.code===4?'limited':app.code===130||app.code===143?'interrupted':'failed',message:app.message}});
    }
    throw new AppError(app.code, app.message, initial.runId);
  } finally {
    await store.close();
    // Preserve already-completed evidence and report cancellation after the last await.
    if (succeeded && signal.aborted) {
      const app = cancellation(signal);
      throw new AppError(app.code, app.message, initial.runId);
    }
  }
}
