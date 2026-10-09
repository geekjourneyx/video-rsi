import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPipeline, runJudgePipeline } from '../src/pipeline.js';
import { openRun, loadRun, loadCall, hashJson, MAX_INTERNAL_BYTES } from '../src/store.js';
import type { Config, Completion, CompletionRequest, ModelClient, RunManifest } from '../src/contracts.js';
import { brief, config, candidates } from './fixtures.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function setup(options: { rounds?: number; review?: boolean; maxCalls?: number; budget?: number; prompt?: string; judge?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pipeline-'));
  roots.push(root);
  const cfg: Config = { ...config, rounds: options.rounds ?? 1, candidatesPerRound: 1,
    limits: { ...config.limits, maxCalls: options.maxCalls ?? 10, maxEstimatedCostMicrousd: options.budget ?? null } };
  const manifest: RunManifest = {
    schemaVersion: 1, runId: 'pipeline-test', brief, config: cfg,
    prompts: { writer: options.prompt ?? '\nWriter snapshot\n', judge: '\nJudge snapshot\n' },
    priceSnapshots: Object.values(cfg.models).map(model => ({ provider: model.provider, model: model.model,
      inputPerMillionMicrousd: 1_000_000, outputPerMillionMicrousd: 1_000_000,
      contextWindow: 10, observedAt: '2026-10-09T00:00:00Z', source: 'test catalog' })),
    softwareVersion: '0.1.0', seed: 42,
    operation: options.judge ? { kind: 'judge' } : { kind: 'create', review: options.review ?? true },
    ...(options.judge ? { inputBatch: candidates, inputBatchHash: hashJson(candidates) } : {}),
  };
  return { cfg, manifest, store: await openRun(root, manifest) };
}
function completion(text: string, cost = 10): Completion {
  return { text, stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, estimatedCostMicrousd: cost }, raw: { receipt: 'evidence' } };
}
function client(options: { duplicate?: boolean; bad?: boolean; stopReason?: Completion['stopReason']; cost?: number } = {}) {
  const requests: CompletionRequest[] = [];
  let writes = 0;
  const model: ModelClient = { async complete(request) {
    requests.push(structuredClone(request));
    if (options.bad) return completion('not json');
    if (options.stopReason) return { ...completion('bad output'), stopReason: options.stopReason };
    const input = JSON.parse(request.input);
    if (request.role === 'writer') {
      writes++;
      const { id: _id, round: _round, ...candidate } = candidates.candidates[0]!;
      return completion(JSON.stringify({ candidates: [{ ...candidate, title: options.duplicate ? 'same' : `Title ${writes}` }] }), options.cost);
    }
    return completion(JSON.stringify({ verdicts: input.candidates.map((candidate: { id: string; claims: unknown[] }) => ({
      candidateId: candidate.id, scores: { audience: 3, clarity: 3, consistency: 3, utility: 3 },
      claims: candidate.claims.map((_, index) => ({ index, status: 'uncertain', reason: 'Check manually' })), reason: 'Prior critique',
    })) }), options.cost);
  } };
  return { model, requests };
}
const signal = () => new AbortController().signal;
it('rejects multiple rounds without review before any call', async () => {
  const { cfg, store } = await setup({ rounds: 2, review: false });
  const { model, requests } = client();
  try {
    await expect(runPipeline(brief, cfg, model, store, signal(), false)).rejects.toMatchObject({ code: 2 });
    expect(requests).toHaveLength(0);
  } finally { await store.close(); }
});
it('executes W/J/W/J, preserves history only for writer, and persists exact snapshots', async () => {
  const { cfg, store } = await setup({ rounds: 2 });
  const { model, requests } = client();
  const audited: ModelClient = { async complete(request, abort) {
    const ledger = await loadRun(store.path);
    const started = ledger.events.at(-1)!;
    expect(started.type).toBe('call_started');
    expect(started.payload).toMatchObject({ request, reservationMicrousd: 0 });
    expect(await loadCall(store.path, request.callId)).toBeUndefined();
    return model.complete(request, abort);
  } };
  try {
    const result = await runPipeline(brief, cfg, audited, store, signal(), true);
    expect(requests.map(request => request.role)).toEqual(['writer', 'judge', 'writer', 'judge']);
    expect(requests[0]!.system).toBe('\nWriter snapshot\n');
    expect(requests[2]!.input).toContain('Prior critique');
    expect(requests[3]!.input).not.toContain('Prior critique');
    expect(result.candidates.map(candidate => candidate.round)).toEqual([1, 2]);
    expect('evaluation' in result && result.evaluation.topIds.length).toBe(2);
    const record = await loadRun(store.path);
    expect(record.result).toEqual(result);
    expect(record.status).toBe('completed');
    expect(record.events.filter(event => event.type === 'call_finished')).toHaveLength(4);
    expect((await loadCall(store.path, requests[0]!.callId))!.result.raw).toEqual({ receipt: 'evidence' });
  } finally { await store.close(); }
});
it('keeps earliest identical content across rounds while judging each round once', async () => {
  const { cfg, store } = await setup({ rounds: 2 });
  const { model, requests } = client({ duplicate: true });
  try {
    const result = await runPipeline(brief, cfg, model, store, signal(), true);
    expect(result.candidates.map(candidate => candidate.id)).toEqual(['r1-c1']);
    expect(requests.map(request => request.role)).toEqual(['writer', 'judge', 'writer', 'judge']);
    expect('evaluation' in result && result.evaluation.verdicts.map(verdict => verdict.candidateId)).toEqual(['r1-c1']);
  } finally { await store.close(); }
});
it('rejects planned calls above maxCalls at startup', async () => {
  const { cfg, store } = await setup({ rounds: 2, maxCalls: 3 });
  const { model, requests } = client();
  try {
    await expect(runPipeline(brief, cfg, model, store, signal(), true)).rejects.toMatchObject({ code: 4 });
    expect(requests).toHaveLength(0);
  } finally { await store.close(); }
});
it('stops without dispatch when the next round reservation cannot fit', async () => {
  const { cfg, store } = await setup({ rounds: 2, budget: 3093 });
  const { model, requests } = client({ cost: 1035 });
  try {
    await expect(runPipeline(brief, cfg, model, store, signal(), true)).rejects.toMatchObject({ code: 4 });
    expect(requests).toHaveLength(2);
    expect((await loadRun(store.path)).status).toBe('limited');
  } finally { await store.close(); }
});
it.each(['length', 'error', 'aborted'] as const)('persists and charges %s completions before parsing rejects them', async stopReason => {
  const { cfg, store } = await setup({ review: false });
  const { model, requests } = client({ stopReason });
  try {
    await expect(runPipeline(brief, cfg, model, store, signal(), false)).rejects.toMatchObject({ code: 3 });
    expect(requests).toHaveLength(1);
    const record = await loadRun(store.path);
    expect(record.events.find(event => event.type === 'call_finished')!.payload).toMatchObject({ limitState: { attempts: 1, settledMicrousd: 10 } });
    expect((await loadCall(store.path, requests[0]!.callId))!.result.stopReason).toBe(stopReason);
  } finally { await store.close(); }
});
it('persists malformed output before model parsing fails', async () => {
  const { cfg, store } = await setup({ review: false });
  const { model, requests } = client({ bad: true });
  try {
    await expect(runPipeline(brief, cfg, model, store, signal(), false)).rejects.toMatchObject({ code: 3 });
    expect((await loadCall(store.path, requests[0]!.callId))!.result.text).toBe('not json');
  } finally { await store.close(); }
});
it('judges the frozen input in a new run with its hash', async () => {
  const { cfg, store } = await setup({ judge: true });
  const { model, requests } = client();
  try {
    const result = await runJudgePipeline(cfg, model, store, signal());
    expect(result.runId).toBe('pipeline-test');
    expect(result.candidates).toEqual(candidates.candidates);
    expect(requests.map(request => request.role)).toEqual(['judge']);
    expect((await loadRun(store.path)).manifest.inputBatchHash).toBe(hashJson(candidates));
  } finally { await store.close(); }
});
it('preflights oversized evidence before dispatch', async () => {
  const { cfg, store } = await setup({ review: false });
  const { model, requests } = client();
  // Public callers cannot pass a changed brief that exceeds the durable snapshot.
  try {
    const error = await runPipeline({ ...brief, draft: 'x'.repeat(MAX_INTERNAL_BYTES) }, cfg, model, store, signal(), false).then(() => null, error => error);
    expect(error?.code).toBe(5);
    expect(requests).toHaveLength(0);
  } finally { await store.close(); }
});
