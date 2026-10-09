import { expect, it } from 'vitest';
import { parseBatch, renderReport } from '../src/report.js';
import type { EvaluatedBatch } from '../src/contracts.js';
import { candidates, evaluated } from './fixtures.js';
it('renders complete schema JSON without cost or report metadata', () => {
  expect(JSON.parse(renderReport(evaluated, 'json'))).toEqual(evaluated);
  expect(JSON.parse(renderReport(candidates, 'json'))).toEqual(candidates);
});
it('labels model judgments and uncertainty with manual verification advice', () => {
  const batch: EvaluatedBatch = structuredClone(evaluated);
  batch.evaluation.verdicts[0]!.claims[0]!.status = 'uncertain';
  batch.evaluation.status = 'needs_review';
  const markdown = renderReport(batch, 'markdown');
  expect(markdown).toContain('model_judgment');
  expect(markdown).toContain('uncertain');
  expect(markdown).toContain('人工复核');
  expect(markdown).toContain(batch.candidates[0]!.script);
  expect(markdown).toContain('Top');
});
it('renders candidate-only reports without inventing judgments', () => {
  const markdown = renderReport(candidates, 'markdown');
  expect(markdown).toContain('散步');
  expect(markdown).toContain('尚未');
});

it.each([
  ['missing verdict', (batch: EvaluatedBatch) => { batch.evaluation.verdicts = []; }],
  ['duplicate verdict', (batch: EvaluatedBatch) => { batch.evaluation.verdicts.push(structuredClone(batch.evaluation.verdicts[0]!)); }],
  ['unknown verdict candidate', (batch: EvaluatedBatch) => { batch.evaluation.verdicts[0]!.candidateId = 'missing'; }],
  ['missing claim verdict', (batch: EvaluatedBatch) => { batch.evaluation.verdicts[0]!.claims = []; }],
  ['duplicate claim verdict', (batch: EvaluatedBatch) => { batch.evaluation.verdicts[0]!.claims.push(structuredClone(batch.evaluation.verdicts[0]!.claims[0]!)); }],
  ['unknown claim index', (batch: EvaluatedBatch) => { batch.evaluation.verdicts[0]!.claims[0]!.index = 1; }],
  ['unknown Top ID', (batch: EvaluatedBatch) => { batch.evaluation.topIds = ['missing']; }],
  ['too many Top IDs', (batch: EvaluatedBatch) => { batch.evaluation.topIds = ['a', 'b', 'c', 'd']; }],
  ['unsupported candidate in Top', (batch: EvaluatedBatch) => { batch.evaluation.verdicts[0]!.claims[0]!.status = 'unsupported'; batch.evaluation.status = 'needs_review'; }],
  ['incorrect status', (batch: EvaluatedBatch) => { batch.evaluation.verdicts[0]!.claims[0]!.status = 'uncertain'; }],
  ['duplicate candidate ID', (batch: EvaluatedBatch) => { batch.candidates.push(structuredClone(batch.candidates[0]!)); }],
  ['unknown claim source', (batch: EvaluatedBatch) => { batch.candidates[0]!.claims[0]!.sourceIds = ['missing']; }],
] as const)('rejects %s before rendering either format', (_name, alter) => {
  const batch: EvaluatedBatch = structuredClone(evaluated);
  alter(batch);
  for (const format of ['json', 'markdown'] as const) {
    let error: unknown;
    try { renderReport(batch, format); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: 2 });
  }
});
it('rejects candidate-only duplicate identities and dangling sources', () => {
  const duplicate = structuredClone(candidates);
  duplicate.candidates.push(structuredClone(duplicate.candidates[0]!));
  expect(() => parseBatch(duplicate)).toThrow();
  const dangling = structuredClone(candidates);
  dangling.candidates[0]!.claims[0]!.sourceIds = ['missing'];
  expect(() => parseBatch(dangling)).toThrow();
});
it('rejects changed Top ordering rather than silently reranking evidence', () => {
  const batch: EvaluatedBatch = structuredClone(evaluated);
  batch.candidates.push({ ...structuredClone(batch.candidates[0]!), id: 'c2' });
  batch.evaluation.verdicts.push({ ...structuredClone(batch.evaluation.verdicts[0]!), candidateId: 'c2' });
  batch.evaluation.topIds = ['c2', 'c1'];
  expect(() => parseBatch(batch)).toThrow();
  expect(batch.evaluation.topIds).toEqual(['c2', 'c1']);
});
