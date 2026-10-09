import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createModelClient, resolvePrice } from '../src/model.js';
import { brief, config, candidates, evaluated } from './fixtures.js';
import { main } from '../src/cli.js';
import { loadRun } from '../src/store.js';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';

const mocks = vi.hoisted(() => ({ complete: vi.fn(), lookup: vi.fn() }));
vi.mock('@earendil-works/pi-ai', () => ({ createModels: () => ({ setProvider: vi.fn(), getModel: mocks.lookup, completeSimple: mocks.complete }) }));
vi.mock('@earendil-works/pi-ai/providers/openai', () => ({ openaiProvider: () => ({ id: 'openai' }) }));
vi.mock('@earendil-works/pi-ai/providers/anthropic', () => ({ anthropicProvider: () => ({ id: 'anthropic' }) }));
const request = { callId: 'call1', role: 'writer' as const, model: config.models.writer, system: 'system', input: 'input', maxOutputTokens: 64, timeoutMs: 1000 };
const model = { id: 'writer', provider: 'openai', api: 'openai-responses', cost: { input: 2, output: 8 }, contextWindow: 1000, maxTokens: 100 };
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('OPENAI_API_KEY', 'secret-key');
  mocks.lookup.mockReturnValue(model);
  mocks.complete.mockResolvedValue({ content: [{ type: 'text', text: 'hello' }, { type: 'thinking', thinking: 'private' }], stopReason: 'stop', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, responseId: 'response1', headers: { authorization: 'secret-key' }, errorMessage: 'secret-key' });
});
afterEach(() => vi.unstubAllEnvs());
describe('Pi adapter', () => {
  it('maps text, price and usage without serializing secrets or headers', async () => {
    const result = await createModelClient(config).complete(request, new AbortController().signal);
    expect(result).toMatchObject({ text: 'hello', stopReason: 'stop', providerRequestId: 'response1', usage: { inputTokens: 10, outputTokens: 5, estimatedCostMicrousd: 60 } });
    expect(JSON.stringify(result.raw)).not.toContain('secret-key');
    expect(JSON.stringify(result.raw)).not.toContain('headers');
    expect(resolvePrice(request.model)).toMatchObject({ inputPerMillionMicrousd: 2000000, outputPerMillionMicrousd: 8000000 });
  });
  it.each(['error', 'aborted', 'length'])('retains non-success stop %s and partial usage', async (stopReason) => {
    mocks.complete.mockResolvedValue({ content: [], stopReason, usage: { input: 7 } });
    expect(await createModelClient(config).complete(request, new AbortController().signal)).toMatchObject({ stopReason, usage: { inputTokens: 7, outputTokens: null, estimatedCostMicrousd: null } });
  });
  it('passes cancellation, token cap and disables retries', async () => {
    const controller = new AbortController();
    const pending = createModelClient(config).complete(request, controller.signal);
    controller.abort();
    await pending;
    const options = mocks.complete.mock.calls[0][2];
    expect(options.signal.aborted).toBe(true);
    expect(options).toMatchObject({ maxTokens: 64, maxRetries: 0, apiKey: 'secret-key' });
  });
  it('rejects unknown provider and model before dispatch', async () => {
    expect(() => createModelClient({ ...config, models: { ...config.models, writer: { ...request.model, provider: 'other' } } })).toThrow();
    mocks.lookup.mockReturnValue(undefined);
    expect(() => createModelClient(config)).toThrow();
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it('rejects OpenAI Responses output caps below its provider minimum', async () => {
    await expect(createModelClient(config).complete({ ...request, maxOutputTokens: 1 }, new AbortController().signal)).rejects.toThrow('16');
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it('does not treat initialized zero counters on errors as free usage', async () => {
    mocks.complete.mockResolvedValue({ content: [], stopReason: 'error', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    expect((await createModelClient(config).complete(request, new AbortController().signal)).usage).toEqual({ inputTokens: null, outputTokens: null, estimatedCostMicrousd: null });
  });
  it('preserves billed cache tokens in total input', async () => {
    mocks.complete.mockResolvedValue({ content: [], stopReason: 'stop', usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 30 } });
    expect((await createModelClient(config).complete(request, new AbortController().signal)).usage.inputTokens).toBe(60);
  });
  it('returns sanitized unknown usage for transport exceptions', async () => {
    mocks.complete.mockRejectedValue(new Error('secret-key'));
    const result = await createModelClient(config).complete(request, new AbortController().signal);
    expect(result.stopReason).toBe('error');
    expect(result.usage.estimatedCostMicrousd).toBeNull();
    expect(JSON.stringify(result)).not.toContain('secret-key');
  });
  it('rejects missing explicit credentials without dispatch', async () => {
    vi.stubEnv('OPENAI_API_KEY', undefined);
    await expect(createModelClient(config).complete(request, new AbortController().signal)).rejects.toThrow('Missing API key');
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('snapshots independent conservative maxima across pricing tiers', () => {
    mocks.lookup.mockReturnValue({ ...model, cost: { ...model.cost, tiers: [
      { inputTokensAbove: 100, input: 4, output: 9 },
      { inputTokensAbove: 200, input: 3, output: 12 },
    ] } });
    expect(resolvePrice(request.model)).toMatchObject({ inputPerMillionMicrousd: 4000000, outputPerMillionMicrousd: 12000000 });
  });

  it('disables premium cache writes even when long retention is configured in the environment', async () => {
    vi.stubEnv('PI_CACHE_RETENTION', 'long');
    vi.stubEnv('ANTHROPIC_API_KEY', 'secret-anthropic-key');
    mocks.lookup.mockReturnValue({ ...model, api: 'anthropic-messages', provider: 'anthropic', cost: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 } });
    mocks.complete.mockResolvedValue({ content: [], stopReason: 'stop', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 100, cacheWrite1h: 100 } });
    const result = await createModelClient(config).complete({ ...request, model: config.models.judge }, new AbortController().signal);
    expect(mocks.complete.mock.calls[0][2]).toMatchObject({ cacheRetention: 'none' });
    expect(result.usage.inputTokens).toBe(110);
    expect(result.usage.estimatedCostMicrousd).toBeNull();
  });

});

async function invokeCli(argv: string[], input: unknown = brief) {
  let output = '';
  let diagnostic = '';
  const code = await main(argv, {
    stdin: Readable.from([JSON.stringify(input)]),
    stdout: new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } }),
    stderr: new Writable({ write(chunk, _encoding, done) { diagnostic += chunk; done(); } }),
  });
  return {
    code,
    output,
    diagnostic
  };
}
async function cliFixture() {
  const root = await mkdtemp(join(tmpdir(), 'preflight-'));
  const path = join(root, 'config.json');
  const cfg = {
    ...config,
    candidatesPerRound: 1,
    limits: {
      ...config.limits,
      maxOutputTokens: 64
    }
  };
  await writeFile(path, JSON.stringify(cfg));
  return {
    root,
    path,
    runs: join(root, 'runs')
  };
}
it.each(['key', 'minimum', 'maximum'])('review preflights the judge %s before any writer dispatch', async (failure) => {
  const f = await cliFixture();
  vi.stubEnv('ANTHROPIC_API_KEY', failure === 'key' ? undefined : 'judge-secret');
  mocks.lookup.mockImplementation((provider: string) => ({
    ...model,
    provider,
    api: provider === 'anthropic' && failure === 'minimum' ? 'openai-responses' : 'anthropic-messages',
    maxTokens: provider === 'anthropic' && failure === 'maximum' ? 32 : 100,
  }));
  if (failure === 'minimum') {
    await writeFile(f.path, JSON.stringify({
      ...config,
      limits: {
        ...config.limits,
        maxOutputTokens: 8
      }
    }));
  }
  try {
    const result = await invokeCli(['create', '-', '--review', '--config', f.path, '--runs-dir', f.runs]);
    expect(result.code).toBe(3);
    expect(result.output).toBe('');
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(JSON.parse(result.diagnostic).message).toContain(failure === 'key' ? 'ANTHROPIC_API_KEY' : failure === 'minimum' ? '16' : 'maximum');
    for (const id of await readdir(f.runs).catch(() => [])) {
      const record = await loadRun(join(f.runs, id));
      expect(record.events.filter(event => event.type === 'call_started')).toHaveLength(0);
    }
  }
  finally {
    await rm(f.root, {
      recursive: true,
      force: true
    });
  }
});
it('local judge configuration failure remains correctable on resume without repeating its cached writer', async () => {
  const f = await cliFixture();
  vi.stubEnv('ANTHROPIC_API_KEY', 'judge-secret');
  mocks.lookup.mockReturnValue({
    ...model,
    maxTokens: 100
  });
  mocks.complete.mockImplementation(async (_model, context) => {
    const input = JSON.parse(context.messages[0].content);
    const { id: _id, round: _round, ...candidate } = candidates.candidates[0]!;
    if ('count' in input)
      vi.stubEnv('ANTHROPIC_API_KEY', undefined);
    return {
      content: [{
          type: 'text',
          text: JSON.stringify('count' in input ? { candidates: [candidate] } : {
            verdicts: input.candidates.map((item: {
              id: string;
            }) => ({
              ...evaluated.evaluation.verdicts[0],
              candidateId: item.id
            })),
          })
        }],
      stopReason: 'stop',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0
      }
    };
  });
  try {
    const initial = await invokeCli(['create', '-', '--review', '--config', f.path, '--runs-dir', f.runs]);
    expect(initial.code).toBe(3);
    expect(JSON.parse(initial.diagnostic).message).toContain('ANTHROPIC_API_KEY');
    const path = join(f.runs, (await readdir(f.runs))[0]!);
    const failed = await loadRun(path);
    expect(failed.events.filter(event => event.type === 'call_started')).toHaveLength(1);
    expect(failed.events.filter(event => event.type === 'call_finished')).toHaveLength(1);
    vi.stubEnv('OPENAI_API_KEY', undefined);
    const blocked = await invokeCli(['resume', path, '--quiet']);
    expect(blocked.code).toBe(3);
    expect((await loadRun(path)).events.filter(event => event.type === 'call_started')).toHaveLength(1);
    vi.stubEnv('ANTHROPIC_API_KEY', 'corrected-secret');
    const recovered = await invokeCli(['resume', path, '--quiet']);
    expect(recovered.code).toBe(0);
    expect(JSON.parse(recovered.output).evaluation.kind).toBe('model_judgment');
    expect(mocks.complete).toHaveBeenCalledTimes(2);
    vi.stubEnv('ANTHROPIC_API_KEY', undefined);
    for (const command of ['resume', 'replay']) {
      const offline = await invokeCli([command, path, '--quiet']);
      expect(offline.code).toBe(0);
      expect(offline.output).toBe(recovered.output);
    }
    expect(mocks.complete).toHaveBeenCalledTimes(2);
  }
  finally {
    await rm(f.root, {
      recursive: true,
      force: true
    });
  }
});
it.each(['create', 'judge'] as const)('%s preflights credentials and caps only for the roles it will dispatch', async (command) => {
  const f = await cliFixture();
  vi.stubEnv('OPENAI_API_KEY', command === 'create' ? 'writer-secret' : undefined);
  vi.stubEnv('ANTHROPIC_API_KEY', command === 'judge' ? 'judge-secret' : undefined);
  mocks.lookup.mockImplementation((provider: string) => ({
    ...model,
    api: 'anthropic-messages',
    maxTokens: provider === (command === 'create' ? 'openai' : 'anthropic') ? 100 : 1,
  }));
  const { id: _id, round: _round, ...candidate } = candidates.candidates[0]!;
  mocks.complete.mockImplementation(async (_model, context) => {
    const input = JSON.parse(context.messages[0].content);
    return {
      content: [{
          type: 'text',
          text: JSON.stringify(command === 'create' ? { candidates: [candidate] } : {
            verdicts: input.candidates.map((item: {
              id: string;
            }) => ({
              ...evaluated.evaluation.verdicts[0],
              candidateId: item.id
            })),
          })
        }],
      stopReason: 'stop',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0
      },
    };
  });
  try {
    const result = await invokeCli([command, '-', '--quiet', '--config', f.path, '--runs-dir', f.runs], command === 'create' ? brief : candidates);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output).candidates).toHaveLength(1);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  }
  finally {
    await rm(f.root, {
      recursive: true,
      force: true
    });
  }
});
