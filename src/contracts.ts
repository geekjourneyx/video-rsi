import { z } from 'zod';
import { AppError } from './errors.js';
const text = z.string().trim().min(1);
const exactText = z.string().refine(value => value.trim().length > 0, 'Nonempty text required');
const nonnegative = z.number().int().nonnegative();
const version = z.literal(1);
export const sourceSchema = z.strictObject({
  id: text,
  title: text,
  excerpt: text,
  url: z.url().optional()
});
export const briefSchema = z.strictObject({
  schemaVersion: version,
  topic: text,
  platform: text,
  audience: z.array(text),
  durationSeconds: z.strictObject({
    min: z.number().int().min(1).max(300),
    max: z.number().int().min(1).max(300)
  }).refine(v => v.min <= v.max, 'min must be <= max'),
  sources: z.array(sourceSchema).refine(v => new Set(v.map(s => s.id)).size === v.length, 'Duplicate source ID'),
  draft: text.optional()
});
export const modelRefSchema = z.strictObject({
  provider: text,
  model: text,
  apiKeyEnv: text
});
export const configSchema = z.strictObject({
  schemaVersion: version,
  models: z.strictObject({
    writer: modelRefSchema,
    judge: modelRefSchema
  }),
  rounds: z.number().int().min(1).max(5).default(1),
  candidatesPerRound: z.number().int().min(1).max(8).default(3),
  limits: z.strictObject({
    maxCalls: z.number().int().min(1).max(20),
    maxOutputTokens: z.number().int().min(1).max(8192),
    timeoutMs: z.number().int().min(1000).max(120000),
    maxEstimatedCostMicrousd: z.number().int().positive().nullable()
  })
}).refine(v => v.models.writer.provider !== v.models.judge.provider || v.models.writer.model !== v.models.judge.model, 'writer and judge must use different provider/model pairs');
export const candidateSchema = z.strictObject({
  id: text,
  round: z.number().int().min(1).max(5),
  title: text,
  cover: z.strictObject({
    text,
    direction: text
  }),
  script: text,
  hook5s: text,
  hook10s: text,
  claims: z.array(z.strictObject({
    text,
    sourceIds: z.array(text)
  }))
});
const batchShape = {
  schemaVersion: version,
  runId: text,
  brief: briefSchema,
  candidates: z.array(candidateSchema)
};
export const candidateBatchSchema = z.strictObject(batchShape);
const score = z.number().int().min(0).max(4);
export const verdictSchema = z.strictObject({
  candidateId: text,
  scores: z.strictObject({
    audience: score,
    clarity: score,
    consistency: score,
    utility: score
  }),
  claims: z.array(z.strictObject({
    index: nonnegative,
    status: z.enum(['supported', 'uncertain', 'unsupported']),
    reason: text
  })),
  reason: text
});
export const evaluatedBatchSchema = z.strictObject({
  ...batchShape,
  evaluation: z.strictObject({
    kind: z.literal('model_judgment'),
    verdicts: z.array(verdictSchema),
    topIds: z.array(text),
    status: z.enum(['ok', 'needs_review'])
  })
});
export const completionRequestSchema = z.strictObject({
  callId: text,
  role: z.enum(['writer', 'judge']),
  model: modelRefSchema,
  system: exactText,
  input: exactText,
  maxOutputTokens: z.number().int().min(1).max(8192),
  timeoutMs: z.number().int().min(1000).max(120000)
});
export const completionSchema = z.strictObject({
  text: z.string(),
  stopReason: z.enum(['stop', 'length', 'error', 'aborted']),
  usage: z.strictObject({
    inputTokens: nonnegative.nullable(),
    outputTokens: nonnegative.nullable(),
    estimatedCostMicrousd: nonnegative.nullable()
  }),
  providerRequestId: text.optional(),
  raw: z.unknown()
});
export const priceSnapshotSchema = z.strictObject({
  provider: text,
  model: text,
  inputPerMillionMicrousd: nonnegative,
  outputPerMillionMicrousd: nonnegative,
  contextWindow: z.number().int().positive(),
  observedAt: z.iso.datetime({ offset: true }),
  source: text
});
export const runManifestSchema = z.strictObject({
  schemaVersion: version,
  runId: text,
  brief: briefSchema,
  config: configSchema,
  prompts: z.strictObject({
    writer: exactText,
    judge: exactText
  }),
  priceSnapshots: z.array(priceSnapshotSchema),
  softwareVersion: text,
  seed: z.number().int(),
  operation: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('create'),
      review: z.boolean()
    }),
    z.strictObject({ kind: z.literal('judge') })
  ]),
  inputBatch: candidateBatchSchema.optional(),
  inputBatchHash: text.optional()
});
export const runEventSchema = z.strictObject({
  schemaVersion: version,
  seq: nonnegative,
  runId: text,
  type: z.enum(['started', 'call_started', 'call_finished', 'call_unknown', 'round_finished', 'stopped', 'completed']),
  at: z.iso.datetime({ offset: true }),
  payload: z.unknown()
});
export const runRecordSchema = z.strictObject({
  schemaVersion: version,
  runId: text,
  status: z.enum(['running', 'interrupted', 'failed', 'limited', 'completed']),
  manifest: runManifestSchema,
  events: z.array(runEventSchema),
  result: z.union([candidateBatchSchema, evaluatedBatchSchema]).optional()
});
export type Source = z.infer<typeof sourceSchema>;
export type Brief = z.infer<typeof briefSchema>;
export type ModelRef = z.infer<typeof modelRefSchema>;
export type Config = z.infer<typeof configSchema>;
export type Candidate = z.infer<typeof candidateSchema>;
export type CandidateBatch = z.infer<typeof candidateBatchSchema>;
export type Verdict = z.infer<typeof verdictSchema>;
export type EvaluatedBatch = z.infer<typeof evaluatedBatchSchema>;
export type CompletionRequest = z.infer<typeof completionRequestSchema>;
export type Completion = z.infer<typeof completionSchema>;
/** Local checks run before reservation; cached recovery never invokes them. */
export type ModelClient = {
  preflight?(roles: CompletionRequest['role'][]): void | Promise<void>;
  complete(request: CompletionRequest, signal: AbortSignal): Promise<Completion>;
};
export type PriceSnapshot = z.infer<typeof priceSnapshotSchema>;
export type RunManifest = z.infer<typeof runManifestSchema>;
export type RunEvent = z.infer<typeof runEventSchema>;
export type RunRecord = z.infer<typeof runRecordSchema>;
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new AppError(2, result.error.message);
  return result.data;
}
export const parseBrief = (value: unknown): Brief => parse(briefSchema, value);
export const parseConfig = (value: unknown): Config => parse(configSchema, value);
// Model-authored fields exclude program-owned identity and round metadata.
export const writerCandidateSchema = candidateSchema.omit({
  id: true,
  round: true
});
export const writerOutputSchema = z.strictObject({ candidates: z.array(writerCandidateSchema) });
export const judgeOutputSchema = z.strictObject({ verdicts: z.array(verdictSchema) });
const armSchema = z.enum(['manual', 'single', 'multi']);
const minutes = z.number().finite().nonnegative();
export const studyItemSchema = z.strictObject({
  briefId: text,
  variant: armSchema,
  candidate: candidateSchema,
  productionMinutes: minutes,
  runPath: text.optional()
});
export const studySchema = z.strictObject({
  schemaVersion: version,
  seed: z.number().int(),
  arms: z.array(armSchema).min(2).max(3),
  items: z.array(studyItemSchema).min(2)
}).superRefine((v, ctx) => {
  if (new Set(v.arms).size !== v.arms.length)
    ctx.addIssue({
      code: 'custom',
      message: 'Duplicate arm'
    });
  for (const briefId of new Set(v.items.map(i => i.briefId))) {
    const items = v.items.filter(i => i.briefId === briefId);
    if (items.length !== v.arms.length || v.arms.some(a => items.filter(i => i.variant === a).length !== 1))
      ctx.addIssue({
        code: 'custom',
        message: 'Each brief requires exactly one item per selected arm'
      });
  }
});
export const choiceSchema = z.strictObject({
  pairId: text,
  choice: z.enum(['A', 'B', 'tie', 'neither']),
  reason: text,
  editMinutes: minutes,
  supersedes: text.optional()
}).refine(v => (v.choice !== 'tie' && v.choice !== 'neither') || v.editMinutes === 0, 'tie/neither require zero edit minutes');
export const selectionEventSchema = choiceSchema.extend({
  schemaVersion: version,
  eventId: text,
  at: z.iso.datetime({ offset: true })
});
export const blindSummarySchema = z.strictObject({
  pairsCompleted: nonnegative,
  byComparison: z.array(z.strictObject({
    arms: z.array(armSchema).length(2),
    winsA: nonnegative,
    winsB: nonnegative,
    ties: nonnegative,
    neither: nonnegative,
    preferenceA: z.number().min(0).max(1).nullable()
  })),
  byArm: z.array(z.strictObject({
    arm: armSchema,
    estimatedEditMinutesMean: minutes.nullable(),
    productionMinutes: minutes,
    estimatedCostMicrousd: nonnegative.nullable()
  })),
  notes: z.array(text)
});
export type Study = z.infer<typeof studySchema>;
export type StudyItem = z.infer<typeof studyItemSchema>;
export type Choice = z.infer<typeof choiceSchema>;
export type BlindSummary = z.infer<typeof blindSummarySchema>;
