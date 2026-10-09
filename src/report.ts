import { candidateBatchSchema, evaluatedBatchSchema, type CandidateBatch, type EvaluatedBatch, type RunRecord } from './contracts.js';
import { AppError } from './errors.js';
import { rank } from './judge.js';
import { reconstructLimits } from './limits.js';

export function parseBatch(value: unknown): CandidateBatch | EvaluatedBatch {
  const parsed = evaluatedBatchSchema.or(candidateBatchSchema).safeParse(value);
  if (!parsed.success) throw new AppError(2, 'Input must be a CandidateBatch or EvaluatedBatch');
  const batch = parsed.data;
  const candidateIds = new Set(batch.candidates.map(candidate => candidate.id));
  if (candidateIds.size !== batch.candidates.length) {
    throw new AppError(2, 'Duplicate input candidate ID');
  }
  const sourceIds = new Set(batch.brief.sources.map(source => source.id));
  if (batch.candidates.some(candidate => candidate.claims.some(claim =>
    claim.sourceIds.some(id => !sourceIds.has(id))))) {
    throw new AppError(2, 'Candidate referenced an unknown source ID');
  }
  if ('evaluation' in batch) {
    let expected: EvaluatedBatch['evaluation'];
    try {
      expected = rank(batch.candidates, batch.evaluation.verdicts);
    } catch {
      throw new AppError(2, 'Evaluation must cover every candidate and claim exactly once');
    }
    const supplied = batch.evaluation;
    if (supplied.status !== expected.status || supplied.topIds.length !== expected.topIds.length ||
        supplied.topIds.some((id, index) => id !== expected.topIds[index])) {
      throw new AppError(2, 'Evaluation Top IDs or status disagree with its verdicts');
    }
  }
  // Validate consistency without replacing or reranking supplied evidence.
  return batch;
}

export function renderReport(batch: CandidateBatch | EvaluatedBatch, format: 'json' | 'markdown'): string {
  const parsed = parseBatch(batch);
  if (format === 'json') return JSON.stringify(parsed, null, 2);
  if (format !== 'markdown') throw new AppError(2, 'Report format must be json or markdown');
  const evaluation = 'evaluation' in parsed ? parsed.evaluation : null;
  const lines = [`# ${parsed.brief.topic}`, '', `Run: ${parsed.runId}`, '',
    evaluation ? `评审：model_judgment（模型判断）；状态：${evaluation.status}` : '尚未进行模型评审。', '',
    '发布前请人工复核主张、出处与内容。supported 仅代表模型判断；uncertain 与 unsupported 不代表事实已获验证。', ''];
  if (evaluation) lines.push(`Top: ${evaluation.topIds.join(', ') || '无可推荐项'}`, '');
  for (const candidate of parsed.candidates) {
    lines.push(`## ${candidate.id} · 第 ${candidate.round} 轮 · ${candidate.title}`, '',
      `封面：${candidate.cover.text}`, '', `画面方向：${candidate.cover.direction}`, '',
      `5 秒钩子：${candidate.hook5s}`, '', `10 秒钩子：${candidate.hook10s}`, '', candidate.script, '');
    const verdict = evaluation?.verdicts.find(verdict => verdict.candidateId === candidate.id);
    if (verdict) lines.push(`评分（0–4）：受众 ${verdict.scores.audience} · 清晰 ${verdict.scores.clarity} · 一致 ${verdict.scores.consistency} · 实用 ${verdict.scores.utility}`, '', verdict.reason, '');
    for (const [index, claim] of candidate.claims.entries()) {
      const judgment = verdict?.claims.find(judgment => judgment.index === index);
      lines.push(`- 主张：${claim.text}；来源：${claim.sourceIds.join(', ') || '未提供'}${judgment ? `；${judgment.status}：${judgment.reason}` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Cost lives beside the business schema and is derived from durable run evidence. */
export function summarizeCost(record: RunRecord): string {
  const state = reconstructLimits(record);
  const started = record.events.filter(event => event.type === 'call_started');
  const finished = new Set(record.events.filter(event => event.type === 'call_finished').map(event => (event.payload as {callId:string}).callId));
  const unknown = started.some(event => !finished.has((event.payload as {callId:string}).callId));
  return JSON.stringify({ runId: record.runId, calls: state.attempts,
    estimatedCostMicrousd: state.uncertain || unknown ? null : state.settledMicrousd,
    reservedMicrousd: state.reservedMicrousd,
    costThresholdEnabled: record.manifest.config.limits.maxEstimatedCostMicrousd !== null,
  });
}
