import { afterEach, expect, it, vi } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CompletionRequest } from '../src/contracts.js';
import { brief, config, candidates, evaluated } from './fixtures.js';
import { loadRun, hashJson } from '../src/store.js';
import { main } from '../src/cli.js';
import * as inputApi from '../src/io.js';
import { MAX_JSON_BYTES } from '../src/io.js';
const fake = vi.hoisted(() => ({ requests: [] as CompletionRequest[], factories: 0 }));
vi.mock('../src/model.js', () => ({
  resolvePrice: () => null,
  createModelClient: () => {
    fake.factories++;
    return { async complete(request: CompletionRequest) {
      fake.requests.push(request);
      const input = JSON.parse(request.input);
      const { id: _id, round: _round, ...candidate } = candidates.candidates[0]!;
      const response = request.role === 'writer' ? { candidates: Array.from({ length: input.count }, (_, i) => ({ ...candidate, title: `Title ${i}` })) }
        : { verdicts: input.candidates.map((candidate: { id: string; claims: unknown[] }) => ({ candidateId: candidate.id,
          scores: { audience: 3, clarity: 3, consistency: 3, utility: 3 },
          claims: candidate.claims.map((_, index) => ({ index, status: 'supported', reason: 'Given excerpt' })), reason: 'Model opinion' })) };
      return { text: JSON.stringify(response), stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, estimatedCostMicrousd: 5 }, raw: {} };
    } };
  },
}));
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  fake.requests.length = 0;
  fake.factories = 0;
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
function sink() {
  let text = '';
  return { stream: new Writable({ write(chunk, _encoding, done) { text += chunk; done(); } }), text: () => text };
}
async function invoke(argv: string[], input: unknown) {
  const out = sink();
  const err = sink();
  const code = await main(argv, { stdin: Readable.from([JSON.stringify(input)]), stdout: out.stream, stderr: err.stream });
  return { code, out: out.text(), err: err.text() };
}
async function files(cfg = config) {
  const root = await mkdtemp(join(tmpdir(), 'cli-route-'));
  roots.push(root);
  const path = join(root, 'config.json');
  await writeFile(path, JSON.stringify(cfg));
  return { path, runs: join(root, 'runs') };
}
it('report reads stdin and emits a single JSON offline without config/model loading', async () => {
  const result = await invoke(['report', '-'], evaluated);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out)).toEqual(evaluated);
  expect(result.err).toBe('');
  expect(fake.factories).toBe(0);
  expect(fake.requests).toHaveLength(0);
});
it('create stdin output is parseable, schema clean, and already durable', async () => {
  const { path, runs } = await files();
  const result = await invoke(['create', '-', '--config', path, '--runs-dir', runs], brief);
  expect(result.code).toBe(0);
  const batch = JSON.parse(result.out);
  expect(batch.candidates).toHaveLength(3);
  expect(batch).not.toHaveProperty('cost');
  const record = await loadRun(join(runs, batch.runId));
  expect(record.result).toEqual(batch);
  expect(record.manifest.operation).toEqual({ kind: 'create', review: false });
  expect(record.manifest.prompts.writer).toContain('candidates');
  expect(JSON.parse(result.err)).toMatchObject({ calls: 1, estimatedCostMicrousd: 5, costThresholdEnabled: false });
});
it('standalone judge stdin preserves source batch and creates fresh run identity', async () => {
  const { path, runs } = await files();
  const result = await invoke(['judge', '-', '--config', path, '--runs-dir', runs], candidates);
  expect(result.code).toBe(0);
  const batch = JSON.parse(result.out);
  expect(batch.runId).not.toBe(candidates.runId);
  expect(batch.candidates).toEqual(candidates.candidates);
  const record = await loadRun(join(runs, batch.runId));
  expect(record.manifest.operation).toEqual({ kind: 'judge' });
  expect(record.manifest.inputBatch).toEqual(candidates);
  expect(record.manifest.inputBatchHash).toBe(hashJson(candidates));
  expect(fake.requests.map(request => request.role)).toEqual(['judge']);
  expect(await readdir(runs)).toEqual([batch.runId]);
});
it('create review routes all configured rounds and quiet suppresses cost diagnostics', async () => {
  const cfg = { ...config, rounds: 2, limits: { ...config.limits, maxCalls: 4 } };
  const { path, runs } = await files(cfg);
  const result = await invoke(['create', '-', '--review', '--quiet', '--config', path, '--runs-dir', runs], brief);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out).evaluation.topIds.length).toBeLessThanOrEqual(3);
  expect(fake.requests.map(request => request.role)).toEqual(['writer', 'judge', 'writer', 'judge']);
  expect(result.err).toBe('');
});
it('rejects invalid flags and dangling source references before client construction', async () => {
  const { path, runs } = await files();
  const bad = structuredClone(candidates);
  bad.candidates[0]!.claims[0]!.sourceIds = ['missing'];
  const result = await invoke(['judge', '-', '--config', path, '--runs-dir', runs], bad);
  expect(result.code).toBe(2);
  expect(result.out).toBe('');
  expect(fake.factories).toBe(0);
  expect((await invoke(['create', '-', '--format', 'markdown', '--config', path], brief)).code).toBe(2);
});

it('passes a derived batch larger than 1 MiB through create, judge, and report', async () => {
  const overhead = Buffer.byteLength(JSON.stringify({ ...brief, draft: '' }));
  const largeBrief = { ...brief, draft: 'x'.repeat(MAX_JSON_BYTES - overhead - 1) };
  expect(Buffer.byteLength(JSON.stringify(largeBrief))).toBeLessThanOrEqual(MAX_JSON_BYTES);
  const { path, runs } = await files();
  const created = await invoke(['create', '-', '--quiet', '--config', path, '--runs-dir', runs], largeBrief);
  expect(created.code).toBe(0);
  expect(Buffer.byteLength(created.out)).toBeGreaterThan(MAX_JSON_BYTES);
  const candidateBatch = JSON.parse(created.out);
  expect(Buffer.byteLength(JSON.stringify(candidateBatch))).toBeGreaterThan(MAX_JSON_BYTES);
  const judged = await invoke(['judge', '-', '--quiet', '--config', path, '--runs-dir', runs], candidateBatch);
  expect(judged.code).toBe(0);
  const evaluatedBatch = JSON.parse(judged.out);
  const report = await invoke(['report', '-'], evaluatedBatch);
  expect(report.code).toBe(0);
  expect(JSON.parse(report.out)).toEqual(evaluatedBatch);
});
it.each(['judge', 'report'])('rejects %s derived input above 8 MiB before any client', async command => {
  const oversized = { ...candidates, brief: { ...brief, draft: 'x'.repeat(8 * MAX_JSON_BYTES) } };
  const result = await invoke([command, '-'], oversized);
  expect(result.code).toBe(2);
  expect(JSON.parse(result.err).message).toContain('8 MiB');
  expect(result.out).toBe('');
  expect(fake.factories).toBe(0);
});
it('rejects malformed evaluated report without stdout or client loading', async () => {
  const bad = { ...evaluated, evaluation: { ...evaluated.evaluation, verdicts: [], topIds: ['a', 'b', 'c', 'd'], status: 'ok' } };
  const result = await invoke(['report', '-'], bad);
  expect(result.code).toBe(2);
  expect(result.out).toBe('');
  expect(fake.factories).toBe(0);
});

it.each(['report', 'blind'])('late %s input cancellation suppresses output and preparation', async (command) => {
  const f = await files();
  const outDir = join(f.runs, 'blind');
  await (await import('node:fs/promises')).mkdir(f.runs);
  const realRead = inputApi.readJson;
  vi.spyOn(inputApi, 'readJson').mockImplementation(async (...args) => {
    const result = await realRead(...args);
    process.emit('SIGTERM');
    return result;
  });
  const study = {
    schemaVersion: 1,
    seed: 1,
    arms: ['single', 'multi'],
    items: [
      {
        briefId: 'brief',
        variant: 'single',
        candidate: candidates.candidates[0],
        productionMinutes: 1
      },
      {
        briefId: 'brief',
        variant: 'multi',
        candidate: candidates.candidates[0],
        productionMinutes: 1
      },
    ]
  };
  const result = await invoke(command === 'report' ? ['report', '-'] : ['blind', 'prepare', '-', '--out', outDir], command === 'report' ? evaluated : study);
  expect(result.code).toBe(143);
  expect(result.out).toBe('');
  expect(JSON.parse(result.err)).toMatchObject({ code: 143 });
  await expect(readdir(outDir)).rejects.toMatchObject({ code: 'ENOENT' });
});
it.each(['report', 'blind'])('%s cancellation during output returns the signal status', async (command) => {
  const f = await files();
  let diagnostic = '';
  const stdout = new Writable({ write(_chunk, _encoding, done) { process.emit('SIGINT'); done(); } });
  const stderr = new Writable({ write(chunk, _encoding, done) { diagnostic += chunk; done(); } });
  const study = {
    schemaVersion: 1,
    seed: 1,
    arms: ['single', 'multi'],
    items: [
      {
        briefId: 'brief',
        variant: 'single',
        candidate: candidates.candidates[0],
        productionMinutes: 1
      },
      {
        briefId: 'brief',
        variant: 'multi',
        candidate: candidates.candidates[0],
        productionMinutes: 1
      },
    ]
  };
  const argv = command === 'report' ? ['report', '-'] : ['blind', 'prepare', '-', '--out', join(f.runs, 'blind')];
  // prepare needs an existing parent directory, not an implicit mkdir hierarchy.
  if (command === 'blind')
    await (await import('node:fs/promises')).mkdir(f.runs);
  expect(await main(argv, {
    stdin: Readable.from([JSON.stringify(command === 'report' ? evaluated : study)]),
    stdout,
    stderr
  })).toBe(130);
  expect(JSON.parse(diagnostic)).toMatchObject({ code: 130 });
});
