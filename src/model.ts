import { createModels, type Models, type ModelCost } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import type { Completion, Config, ModelClient, ModelRef, PriceSnapshot } from './contracts.js';
import { AppError } from './errors.js';
export type { PriceSnapshot } from './contracts.js';

function collection(): Models {
  const models = createModels();
  models.setProvider(openaiProvider());
  models.setProvider(anthropicProvider());
  return models;
}
function lookup(models: Models, ref: ModelRef) {
  if (ref.provider !== 'openai' && ref.provider !== 'anthropic') {
    throw new AppError(3, `Unsupported provider: ${ref.provider}`);
  }
  const model = models.getModel(ref.provider, ref.model);
  if (!model) throw new AppError(3, `Unknown model: ${ref.provider}/${ref.model}`);
  return model;
}
function conservativeRates(cost: ModelCost) {
  const rates = [cost, ...(cost.tiers ?? [])];
  return {
    input: Math.max(...rates.map(rate => rate.input)),
    output: Math.max(...rates.map(rate => rate.output)),
  };
}
export function resolvePrice(ref: ModelRef): PriceSnapshot | null {
  let model;
  try {
    model = lookup(collection(), ref);
  } catch {
    return null;
  }
  const rates = conservativeRates(model.cost);
  const input = rates.input * 1_000_000;
  const output = rates.output * 1_000_000;
  if (![input, output].every(value => Number.isSafeInteger(value) && value >= 0)) return null;
  return {
    provider: ref.provider, model: ref.model,
    inputPerMillionMicrousd: input, outputPerMillionMicrousd: output,
    contextWindow: model.contextWindow, observedAt: new Date().toISOString(),
    source: '@earendil-works/pi-ai@1.1.0 static catalog; independent conservative maxima across all input/output tiers',
  };
}
function tokens(value: unknown, failed: boolean): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && (!failed || value > 0) ? value : null;
}
export function createModelClient(config: Config): ModelClient {
  const models = collection();
  lookup(models, config.models.writer);
  lookup(models, config.models.judge);
  function validate(ref: ModelRef, cap: number) {
    const model = lookup(models, ref);
    if (model.api === 'openai-responses' && cap < 16) {
      throw new AppError(3, 'OpenAI Responses requires maxOutputTokens >= 16');
    }
    if (cap > model.maxTokens) throw new AppError(3, 'Output cap exceeds model maximum');
    const apiKey = process.env[ref.apiKeyEnv];
    if (!apiKey) throw new AppError(3, `Missing API key environment variable: ${ref.apiKeyEnv}`);
    return { model, apiKey };
  }
  return {
    preflight(roles) {
      for (const role of roles) validate(config.models[role], config.limits.maxOutputTokens);
    },
    async complete(request, signal): Promise<Completion> {
      const { model, apiKey } = validate(request.model, request.maxOutputTokens);
      const combinedSignal = AbortSignal.any([signal, AbortSignal.timeout(request.timeoutMs)]);
      try {
        const message = await models.completeSimple(model, {
          systemPrompt: request.system,
          messages: [{ role: 'user', content: request.input, timestamp: Date.now() }],
        }, { apiKey, signal: combinedSignal, timeoutMs: request.timeoutMs, maxTokens: request.maxOutputTokens, maxRetries: 0, cacheRetention: 'none' });
        const stopReason = combinedSignal.aborted ? 'aborted' : message.stopReason === 'stop' ? 'stop' : message.stopReason === 'length' ? 'length' : message.stopReason === 'aborted' ? 'aborted' : 'error';
        const failed = stopReason === 'error' || stopReason === 'aborted';
        const input = tokens(message.usage?.input, failed);
        const cacheRead = tokens(message.usage?.cacheRead, false);
        const cacheWrite = tokens(message.usage?.cacheWrite, false);
        const inputTokens = input === null ? null : input + (cacheRead ?? 0) + (cacheWrite ?? 0);
        const outputTokens = tokens(message.usage?.output, failed);
        // Cache writes are disabled. Unexpected cache-write billing is unknown, never ordinary-price usage.
        const rates = conservativeRates(model.cost);
        const estimate = inputTokens === null || outputTokens === null || (cacheWrite ?? 0) > 0 ? null : Math.ceil(inputTokens * rates.input + outputTokens * rates.output);
        const usage = { inputTokens, outputTokens, estimatedCostMicrousd: estimate };
        const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('');
        const providerRequestId = message.responseId;
        const raw = {
          provider: request.model.provider,
          model: request.model.model,
          stopReason,
          usage,
          ...(providerRequestId ? { providerRequestId } : {}),
        };
        return { text, stopReason, usage, raw, ...(providerRequestId ? { providerRequestId } : {}) };
      } catch {
        return {
          text: '',
          stopReason: combinedSignal.aborted ? 'aborted' : 'error',
          usage: { inputTokens: null, outputTokens: null, estimatedCostMicrousd: null },
          raw: { provider: request.model.provider, model: request.model.model },
        };
      }
    },
  };
}
