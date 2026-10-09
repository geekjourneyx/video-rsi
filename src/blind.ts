import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { studySchema, choiceSchema, selectionEventSchema, type Study, type Choice, type BlindSummary, type StudyItem } from './contracts.js';
import { AppError } from './errors.js';
import { MAX_BATCH_JSON_BYTES, readJson } from './io.js';
import { hashJson, loadRun, loadCall, lockRun } from './store.js';
import { cancellation } from './pipeline.js';
import { parseBatch } from './report.js';
const pairSchema = z.strictObject({
  pairId: z.string().regex(/^[a-f0-9]{24}$/),
  briefId: z.string().min(1),
  a: z.number().int().nonnegative(),
  b: z.number().int().nonnegative()
});
const allocationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  study: studySchema,
  pairs: z.array(pairSchema),
  hash: z.string()
});
type Pair = z.infer<typeof pairSchema>;
type Selection = z.infer<typeof selectionEventSchema>;
function checked<T>(schema: z.ZodType<T>, value: unknown, code: 2 | 5): T {
  const p = schema.safeParse(value);
  if (!p.success)
    throw new AppError(code, 'Invalid blind study or selection evidence');
  return p.data;
}
function pairsFor(study: Study): Pair[] {
  let state = study.seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pairs: Pair[] = [];
  for (const briefId of new Set(study.items.map(i => i.briefId))) {
    const indices = study.items.flatMap((i, n) => i.briefId === briefId ? [n] : []);
    for (let x = 0; x < indices.length; x++) {
      for (let y = x + 1; y < indices.length; y++) {
        const [a, b] = random() < 0.5 ? [indices[x], indices[y]] : [indices[y], indices[x]];
        const pairId = createHash('sha256').update(JSON.stringify([study.seed, pairs.length])).digest('hex').slice(0, 24);
        pairs.push({
          pairId,
          briefId,
          a,
          b
        });
      }
    }
  }
  for (let i = pairs.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
  }
  return pairs;
}
async function durable(path: string, data: string) {
  if (Buffer.byteLength(data) > MAX_BATCH_JSON_BYTES)
    throw new AppError(2, 'Blind document exceeds 8 MiB');
  const h = await open(path, 'wx', 0o600);
  try {
    await h.writeFile(data);
    await h.sync();
  }
  finally {
    await h.close();
  }
}
async function syncDir(path: string) {
  const h = await open(path, 'r');
  try {
    await h.sync();
  }
  finally {
    await h.close();
  }
}
function content(item: StudyItem): string {
  const c = item.candidate;
  return [
    `标题：${c.title}`,
    `封面：${c.cover.text}`,
    `构图：${c.cover.direction}`,
    `5 秒内容：${c.hook5s}`,
    `10 秒内容：${c.hook10s}`,
    '脚本：',
    c.script,
    '主张：',
    ...c.claims.map(claim => `${claim.text}（来源：${claim.sourceIds.join(', ')}）`)
  ].join('\n\n');
}
export async function prepareBlind(input: Study, out: string, signal?: AbortSignal): Promise<void> {
  const parsed = checked(studySchema, input, 2);
  // Freeze relative evidence references before writing a portable allocation.
  const study = {
    ...parsed,
    items: parsed.items.map(i => ({
      ...i,
      ...(i.runPath ? { runPath: resolve(i.runPath) } : {})
    }))
  };
  const pairs = pairsFor(study);
  const body = {
    schemaVersion: 1 as const,
    study,
    pairs
  };
  const review = [
    '# 方案盲选',
    '',
    ...pairs.flatMap(p => [
      `## 比较 ${p.pairId}`,
      `简报参考：${p.briefId}`,
      '### A',
      content(study.items[p.a]),
      '### B',
      content(study.items[p.b]),
      ''
    ])
  ].join('\n\n');
  const allocation = JSON.stringify({
    ...body,
    hash: hashJson(body)
  }, null, 2);
  if (Buffer.byteLength(allocation) > MAX_BATCH_JSON_BYTES || Buffer.byteLength(review) > MAX_BATCH_JSON_BYTES)
    throw new AppError(2, 'Blind document exceeds 8 MiB');
  if (signal?.aborted)
    throw cancellation(signal);
  // Once preparation starts, finish durable writes before reporting cancellation.
  try {
    await mkdir(out, { mode: 0o700 });
  }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST')
      throw new AppError(5, 'Blind output directory already exists');
    throw e;
  }
  await durable(join(out, 'allocation.json'), allocation);
  await durable(join(out, 'review.md'), review);
  await durable(join(out, 'selection.jsonl'), '');
  await syncDir(out);
  if (signal?.aborted)
    throw cancellation(signal);
}
async function load(dir: string) {
  let allocation: z.infer<typeof allocationSchema>;
  try {
    allocation = checked(allocationSchema, await readJson(join(dir, 'allocation.json'), Readable.from([]), MAX_BATCH_JSON_BYTES), 5);
  }
  catch (e) {
    if (e instanceof AppError && e.code === 5)
      throw e;
    throw new AppError(5, 'Cannot read blind allocation');
  }
  const { hash, ...body } = allocation;
  if (hash !== hashJson(body) || hashJson(allocation.pairs) !== hashJson(pairsFor(allocation.study)))
    throw new AppError(5, 'Blind allocation integrity mismatch');
  return allocation;
}
async function selections(dir: string, pairs: Pair[]) {
  try {
    const latest = new Map<string, Selection>();
    const ids = new Set<string>();
    // Streaming lines keep total history unbounded while limiting individual records.
    const { createReadStream } = await import('node:fs');
    const { createInterface } = await import('node:readline');
    const stream = createReadStream(join(dir, 'selection.jsonl'));
    const lines = createInterface({
      input: stream,
      crlfDelay: Infinity
    });
    try {
      for await (const line of lines) {
        if (Buffer.byteLength(line) > MAX_BATCH_JSON_BYTES)
          throw new AppError(5, 'Selection record exceeds 8 MiB');
        let event: Selection;
        try {
          event = checked(selectionEventSchema, JSON.parse(line), 5);
        }
        catch {
          throw new AppError(5, 'Invalid selection journal');
        }
        if (!pairs.some(p => p.pairId === event.pairId) || ids.has(event.eventId))
          throw new AppError(5, 'Unknown pair or duplicate selection event');
        const previous = latest.get(event.pairId);
        if (previous ? event.supersedes !== previous.eventId : event.supersedes !== undefined)
          throw new AppError(5, 'Invalid superseding selection');
        ids.add(event.eventId);
        latest.set(event.pairId, event);
      }
    }
    finally {
      lines.close();
      stream.destroy();
    }
    // A missing newline is incomplete evidence, never silently accepted or overwritten.
    const h = await open(join(dir, 'selection.jsonl'), 'r');
    try {
      const size = (await h.stat()).size;
      if (size) {
        const last = Buffer.alloc(1);
        await h.read(last, 0, 1, size - 1);
        if (last[0] !== 10)
          throw new AppError(5, 'Incomplete selection journal tail');
      }
    }
    finally {
      await h.close();
    }
    return latest;
  }
  catch (error) {
    if (error instanceof AppError)
      throw error;
    throw new AppError(5, 'Cannot read blind selection journal');
  }
}
export async function recordChoice(dir: string, input: Choice, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted)
    throw cancellation(signal);
  const choice = checked(choiceSchema, input, 2);
  const release = await lockRun(dir, false);
  try {
    const allocation = await load(dir);
    const latest = await selections(dir, allocation.pairs);
    if (!allocation.pairs.some(p => p.pairId === choice.pairId))
      throw new AppError(2, 'Unknown pair ID');
    const previous = latest.get(choice.pairId);
    if (previous ? choice.supersedes !== previous.eventId : choice.supersedes !== undefined)
      throw new AppError(5, 'Selection exists or supersedes is not the current event for this pair');
    const event = {
      schemaVersion: 1,
      ...choice,
      eventId: randomUUID(),
      at: new Date().toISOString()
    };
    const line = JSON.stringify(event) + '\n';
    if (Buffer.byteLength(line) > MAX_BATCH_JSON_BYTES)
      throw new AppError(2, 'Selection record exceeds 8 MiB');
    if (signal?.aborted)
      throw cancellation(signal);
    const h = await open(join(dir, 'selection.jsonl'), 'a');
    try {
      await h.writeFile(line);
      await h.sync();
    }
    finally {
      await h.close();
    }
  }
  finally {
    await release();
  }
  if (signal?.aborted)
    throw cancellation(signal);
}
async function cost(item: StudyItem, notes: string[]): Promise<number | null> {
  if (!item.runPath)
    return null;
  const record = await loadRun(item.runPath);
  if (record.status !== 'completed' || !record.result)
    throw new AppError(5, 'Study cost requires a completed referenced run');
  const result = parseBatch(record.result);
  const candidate = result.candidates.find(c => c.id === item.candidate.id);
  if (!candidate || hashJson(candidate) !== hashJson(item.candidate))
    throw new AppError(5, 'Study candidate differs from referenced run result');
  if (item.variant === 'manual' || record.manifest.operation.kind !== 'create' || !record.manifest.operation.review ||
    (item.variant === 'single' ? record.manifest.config.rounds !== 1 : record.manifest.config.rounds < 2))
    throw new AppError(5, 'Study arm differs from referenced run operation');
  if (!('evaluation' in result) || result.evaluation.topIds[0] !== item.candidate.id)
    throw new AppError(5, 'Study candidate must be the preselected Top 1');
  notes.push(`${item.variant} / ${item.briefId}: ${record.manifest.config.rounds} configured rounds; ${record.events.filter(e => e.type === 'call_started').length} attempted calls; maxCalls=${record.manifest.config.limits.maxCalls}; maxOutputTokens=${record.manifest.config.limits.maxOutputTokens}; cost threshold microusd=${record.manifest.config.limits.maxEstimatedCostMicrousd ?? 'disabled'}.`);
  let total = 0;
  for (const event of record.events.filter(e => e.type === 'call_started')) {
    const id = (event.payload as {
      callId: string;
    }).callId;
    const call = await loadCall(item.runPath, id);
    if (!call || call.result.usage.estimatedCostMicrousd === null)
      return null;
    total += call.result.usage.estimatedCostMicrousd;
  }
  return total;
}
export async function summarizeBlind(dir: string): Promise<BlindSummary> {
  const release = await lockRun(dir, false);
  try {
    const allocation = await load(dir);
    const latest = await selections(dir, allocation.pairs);
    if (latest.size !== allocation.pairs.length)
      throw new AppError(5, 'All comparisons must be completed before unblinding');
    const { study } = allocation;
    const byComparison: BlindSummary['byComparison'] = [];
    const edits = new Map<string, number[]>();
    for (let i = 0; i < study.arms.length; i++) {
      for (let j = i + 1; j < study.arms.length; j++) {
        byComparison.push({
          arms: [study.arms[i], study.arms[j]],
          winsA: 0,
          winsB: 0,
          ties: 0,
          neither: 0,
          preferenceA: null
        });
      }
    }
    for (const pair of allocation.pairs) {
      const selection = latest.get(pair.pairId)!;
      const a = study.items[pair.a].variant, b = study.items[pair.b].variant;
      const row = byComparison.find(r => r.arms.includes(a) && r.arms.includes(b))!;
      if (selection.choice === 'tie')
        row.ties++;
      else if (selection.choice === 'neither')
        row.neither++;
      else {
        const winner = selection.choice === 'A' ? a : b;
        if (winner === row.arms[0])
          row.winsA++;
        else
          row.winsB++;
        const times = edits.get(winner) ?? [];
        times.push(selection.editMinutes);
        edits.set(winner, times);
      }
    }
    for (const row of byComparison) {
      const denominator = row.winsA + row.winsB + row.ties;
      row.preferenceA = denominator ? (row.winsA + row.ties * 0.5) / denominator : null;
    }
    const notes: string[] = [];
    const byArm: BlindSummary['byArm'] = [];
    for (const arm of study.arms) {
      const items = study.items.filter(i => i.variant === arm);
      const costs = await Promise.all(items.map(i => cost(i, notes)));
      const times = edits.get(arm) ?? [];
      byArm.push({
        arm,
        productionMinutes: items.reduce((sum, i) => sum + i.productionMinutes, 0),
        estimatedEditMinutesMean: times.length ? times.reduce((a, b) => a + b, 0) / times.length : null,
        estimatedCostMicrousd: costs.some(c => c === null) ? null : costs.reduce<number>((a, b) => a + b!, 0)
      });
    }
    return {
      pairsCompleted: latest.size,
      byComparison,
      byArm,
      notes: [
        ...notes,
        'Edit minutes estimate changes to the selected A/B proposal only; tie/neither require 0 and are excluded from edit means.',
        'Preference denominator includes wins and ties; neither is excluded and reported separately. Completed pairs provide coverage.',
        'Production minutes are reported separately, including manual work; missing or unknown verified model costs remain null.',
        'Personal creative preference and limited blinding do not establish audience impact, statistical significance, or algorithm efficiency. Compare actual budgets before interpreting time or cost advantages.',
        'Brief IDs are neutral references only; this Study schema does not contain full Brief text.'
      ]
    };
  }
  finally {
    await release();
  }
}
