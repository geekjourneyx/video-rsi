import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareBlind, recordChoice, summarizeBlind } from '../src/blind.js';
import type { Study } from '../src/contracts.js';
import { candidates } from './fixtures.js';
const roots: string[] = [];
async function path() {
  const p = await mkdtemp(join(tmpdir(), 'blind-'));
  roots.push(p);
  return join(p, 'study');
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(p => rm(p, {
    recursive: true,
    force: true
  })));
});
function study(arms: Study['arms'] = ['single', 'multi']): Study {
  return {
    schemaVersion: 1,
    seed: 42,
    arms,
    items: ['b1', 'b2'].flatMap(briefId => arms.map(variant => ({
      briefId,
      variant,
      candidate: {
        ...candidates.candidates[0],
        id: `SECRET-${variant}`,
        round: variant === 'multi' ? 2 : 1
      },
      productionMinutes: 2
    })))
  };
}
async function allocation(p: string) {
  return JSON.parse(await readFile(join(p, 'allocation.json'), 'utf8')) as {
    pairs: {
      pairId: string;
      a: number;
      b: number;
    }[];
  };
}
it('deterministically shuffles every comparison and conceals metadata in review', async () => {
  const a = await path(), b = await path();
  await prepareBlind(study(['manual', 'single', 'multi']), a);
  await prepareBlind(study(['manual', 'single', 'multi']), b);
  expect(await allocation(a)).toEqual(await allocation(b));
  expect((await allocation(a)).pairs).toHaveLength(6);
  const review = await readFile(join(a, 'review.md'), 'utf8');
  expect(review).toContain('b1');
  for (const leak of ['SECRET', 'variant', 'round', 'runPath', 'provider', 'model', 'usage']) {
    expect(review).not.toContain(leak);
  }
  const orientations = (await allocation(a)).pairs.map(p => p.a % 3 < p.b % 3);
  expect(orientations).toContain(true);
  expect(orientations).toContain(false);
});
it('requires all selected arms once per brief and refuses existing directories', async () => {
  const s = study();
  s.items.pop();
  await expect(prepareBlind(s, await path())).rejects.toMatchObject({ code: 2 });
  const duplicate = study();
  duplicate.items[1] = duplicate.items[0];
  await expect(prepareBlind(duplicate, await path())).rejects.toMatchObject({ code: 2 });
  const p = await path();
  await prepareBlind(study(), p);
  expect((await allocation(p)).pairs).toHaveLength(2);
  await expect(prepareBlind(study(), p)).rejects.toMatchObject({ code: 5 });
});
it('rejects incomplete unblinding and appends valid superseding corrections', async () => {
  const p = await path();
  await prepareBlind(study(), p);
  const pairs = (await allocation(p)).pairs;
  await expect(summarizeBlind(p)).rejects.toMatchObject({ code: 5 });
  const choice = {
    pairId: pairs[0].pairId,
    choice: 'A' as const,
    reason: 'usable',
    editMinutes: 4
  };
  await recordChoice(p, choice);
  await expect(recordChoice(p, choice)).rejects.toMatchObject({ code: 5 });
  const first = JSON.parse((await readFile(join(p, 'selection.jsonl'), 'utf8')).trim());
  await expect(recordChoice(p, {
    ...choice,
    pairId: pairs[1].pairId,
    supersedes: first.eventId
  })).rejects.toMatchObject({ code: 5 });
  await recordChoice(p, {
    ...choice,
    choice: 'tie',
    editMinutes: 0,
    supersedes: first.eventId
  });
  await expect(recordChoice(p, {
    ...choice,
    supersedes: first.eventId
  })).rejects.toMatchObject({ code: 5 });
  await recordChoice(p, {
    pairId: pairs[1].pairId,
    choice: 'neither',
    reason: 'unusable',
    editMinutes: 0
  });
  expect((await readFile(join(p, 'selection.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(3);
  const summary = await summarizeBlind(p);
  expect(summary.pairsCompleted).toBe(2);
  expect(summary.byComparison[0]).toMatchObject({
    ties: 1,
    neither: 1,
    preferenceA: 0.5
  });
  expect(summary.byArm.every(a => a.estimatedEditMinutesMean === null)).toBe(true);
});
it('excludes neither from denominator and zero-minute estimates from tie/neither', async () => {
  const p = await path();
  await prepareBlind(study(), p);
  for (const pair of (await allocation(p)).pairs) {
    await recordChoice(p, {
      pairId: pair.pairId,
      choice: 'neither',
      reason: 'no',
      editMinutes: 0
    });
  }
  expect((await summarizeBlind(p)).byComparison[0]).toMatchObject({
    neither: 2,
    preferenceA: null
  });
  await expect(recordChoice(p, {
    pairId: 'unknown',
    choice: 'tie',
    reason: 'x',
    editMinutes: 1
  })).rejects.toMatchObject({ code: 2 });
});
it('maps left/right winners into named comparisons and keeps manual costs unknown', async () => {
  const p = await path();
  const s = study(['manual', 'single', 'multi']);
  await prepareBlind(s, p);
  for (const pair of (await allocation(p)).pairs) {
    const winner = s.items[pair.a].variant === 'single' ? 'A' : s.items[pair.b].variant === 'single' ? 'B' : 'tie';
    await recordChoice(p, {
      pairId: pair.pairId,
      choice: winner,
      reason: 'selected',
      editMinutes: winner === 'tie' ? 0 : 3
    });
  }
  const summary = await summarizeBlind(p);
  expect(summary.byComparison.find(c => c.arms[0] === 'single')).toMatchObject({
    winsA: 2,
    preferenceA: 1
  });
  expect(summary.byArm.find(a => a.arm === 'single')).toMatchObject({
    estimatedEditMinutesMean: 3,
    productionMinutes: 4,
    estimatedCostMicrousd: null
  });
  expect(summary.byArm.find(a => a.arm === 'manual')?.estimatedCostMicrousd).toBeNull();
});
it('serializes simultaneous records and refuses tampered allocation or journal tails', async () => {
  const { writeFile } = await import('node:fs/promises');
  const p = await path();
  await prepareBlind(study(), p);
  const pair = (await allocation(p)).pairs[0];
  const c = {
    pairId: pair.pairId,
    choice: 'A' as const,
    reason: 'x',
    editMinutes: 0
  };
  const results = await Promise.allSettled([recordChoice(p, c), recordChoice(p, c)]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const journal = await readFile(join(p, 'selection.jsonl'), 'utf8');
  await writeFile(join(p, 'selection.jsonl'), journal.trimEnd());
  await expect(summarizeBlind(p)).rejects.toMatchObject({ code: 5 });
  await writeFile(join(p, 'selection.jsonl'), journal);
  const raw = JSON.parse(await readFile(join(p, 'allocation.json'), 'utf8'));
  raw.pairs[0].a = raw.pairs[0].b;
  await writeFile(join(p, 'allocation.json'), JSON.stringify(raw));
  await expect(summarizeBlind(p)).rejects.toMatchObject({ code: 5 });
});
it('attributes only verified referenced candidate runs and preserves unknown attempt costs', async () => {
  const { openRun } = await import('../src/store.js');
  const { brief, config, evaluated } = await import('./fixtures.js');
  const base = await path();
  const runs = join(base, 'runs');
  const manifest = {
    schemaVersion: 1 as const,
    runId: 'cost-run',
    brief,
    config,
    prompts: {
      writer: 'write',
      judge: 'judge'
    },
    priceSnapshots: [],
    softwareVersion: 'test',
    seed: 1,
    operation: {
      kind: 'create' as const,
      review: true
    }
  };
  const store = await openRun(runs, manifest);
  const request = {
    callId: 'call-1',
    role: 'writer' as const,
    model: config.models.writer,
    system: 'write',
    input: 'input',
    maxOutputTokens: 10,
    timeoutMs: 1000
  };
  await store.append({
    type: 'call_started',
    payload: {
      callId: 'call-1',
      request
    }
  });
  await store.saveCall('call-1', request, {
    text: 'result',
    stopReason: 'stop',
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      estimatedCostMicrousd: 7
    },
    raw: {}
  });
  await store.append({
    type: 'call_finished',
    payload: { callId: 'call-1' }
  });
  await store.complete({
    ...evaluated,
    runId: manifest.runId
  });
  await store.close();
  const s = study(['manual', 'single']);
  s.items = s.items.slice(0, 2);
  s.items[1].candidate = structuredClone(evaluated.candidates[0]);
  s.items[1].runPath = store.path;
  const p = await path();
  await prepareBlind(s, p);
  const pair = (await allocation(p)).pairs[0];
  await recordChoice(p, {
    pairId: pair.pairId,
    choice: 'tie',
    reason: 'same',
    editMinutes: 0
  });
  expect((await summarizeBlind(p)).byArm.find(a => a.arm === 'single')?.estimatedCostMicrousd).toBe(7);
  s.items[1].candidate.script = 'unrelated';
  const bad = await path();
  await prepareBlind(s, bad);
  await recordChoice(bad, {
    pairId: (await allocation(bad)).pairs[0].pairId,
    choice: 'neither',
    reason: 'no',
    editMinutes: 0
  });
  await expect(summarizeBlind(bad)).rejects.toMatchObject({ code: 5 });
});
it('runs blind CLI offline with complete stdout results and rejects unrelated options', async () => {
  const { Readable, Writable } = await import('node:stream');
  const { main } = await import('../src/cli.js');
  async function invoke(args: string[], input: unknown = {}) {
    let stdout = '', stderr = '';
    const code = await main(args, {
      stdin: Readable.from([JSON.stringify(input)]),
      stdout: new Writable({ write(c, _e, done) {
          stdout += c;
          done();
        } }),
      stderr: new Writable({ write(c, _e, done) {
          stderr += c;
          done();
        } })
    });
    return {
      code,
      stdout,
      stderr
    };
  }
  const p = await path();
  const result = await invoke(['blind', 'prepare', '-', '--out', p], study());
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ directory: p });
  expect(result.stderr).toBe('');
  expect((await invoke(['blind', 'summary', p])).code).toBe(5);
  for (const pair of (await allocation(p)).pairs) {
    expect((await invoke(['blind', 'record', p, '--pair', pair.pairId, '--choice', 'neither', '--reason', 'no', '--edit-minutes', '0'])).code).toBe(0);
  }
  expect(JSON.parse((await invoke(['blind', 'summary', p])).stdout).pairsCompleted).toBe(2);
  expect((await invoke(['blind', 'summary', p, '--config', 'missing'])).code).toBe(2);
});
it('reports a missing selection journal as evidence conflict in both API and CLI', async () => {
  const { unlink } = await import('node:fs/promises');
  const { Readable, Writable } = await import('node:stream');
  const { main } = await import('../src/cli.js');
  const p = await path();
  await prepareBlind(study(), p);
  const pair = (await allocation(p)).pairs[0];
  await unlink(join(p, 'selection.jsonl'));
  const choice = {
    pairId: pair.pairId,
    choice: 'A' as const,
    reason: 'usable',
    editMinutes: 0
  };
  await expect(recordChoice(p, choice)).rejects.toMatchObject({ code: 5 });
  await expect(summarizeBlind(p)).rejects.toMatchObject({ code: 5 });
  for (const args of [
    ['blind', 'summary', p],
    ['blind', 'record', p, '--pair', pair.pairId, '--choice', 'A', '--reason', 'usable', '--edit-minutes', '0']
  ]) {
    let stdout = '', stderr = '';
    const code = await main(args, {
      stdin: Readable.from([]),
      stdout: new Writable({ write(c, _e, done) {
          stdout += c;
          done();
        } }),
      stderr: new Writable({ write(c, _e, done) {
          stderr += c;
          done();
        } })
    });
    expect(code).toBe(5);
    expect(stdout).toBe('');
    expect(JSON.parse(stderr).code).toBe(5);
  }
});
