import { describe, it, expect } from 'vitest';
import { parseBrief, parseConfig, candidateBatchSchema, evaluatedBatchSchema, runManifestSchema, priceSnapshotSchema } from '../src/contracts.js';
import { brief, config, candidates, evaluated } from './fixtures.js';
import { readFile } from 'node:fs/promises';
describe('contracts', () => {
  it('accepts valid fixtures', () => {
    expect(parseBrief(brief)).toEqual(brief);
    expect(parseConfig(config)).toEqual(config);
    candidateBatchSchema.parse(candidates);
    evaluatedBatchSchema.parse(evaluated);
  });
  it.each([0, 6])('rejects rounds %s', rounds => expect(() => parseConfig({
    ...config,
    rounds
  })).toThrow());
  it('rejects identical models', () => expect(() => parseConfig({
    ...config,
    models: {
      writer: config.models.writer,
      judge: config.models.writer
    }
  })).toThrow());
  it('rejects unknown fields', () => expect(() => parseConfig({
    ...config,
    secret: 'bad'
  })).toThrow());
  it('rejects reversed durations', () => expect(() => parseBrief({
    ...brief,
    durationSeconds: {
      min: 60,
      max: 30
    }
  })).toThrow());
  it('rejects duplicate source IDs', () => expect(() => parseBrief({
    ...brief,
    sources: [brief.sources[0], brief.sources[0]]
  })).toThrow());
  it('validates centralized recording schemas', () => {
    const price = {
      provider: 'openai',
      model: 'writer',
      inputPerMillionMicrousd: 1000000,
      outputPerMillionMicrousd: 2000000,
      contextWindow: 128000,
      observedAt: '2026-10-09T00:00:00Z',
      source: 'pi-ai'
    };
    priceSnapshotSchema.parse(price);
    runManifestSchema.parse({
      schemaVersion: 1,
      runId: 'r1',
      brief,
      config,
      prompts: {
        writer: 'write',
        judge: 'judge'
      },
      priceSnapshots: [price],
      softwareVersion: '0.1.0',
      seed: 1,
      operation: {
        kind: 'create',
        review: true
      }
    });
  });
  it('validates shipped examples', async () => {
    parseBrief(JSON.parse(await readFile('examples/brief.json', 'utf8')));
    parseConfig(JSON.parse(await readFile('examples/video-rsi.json', 'utf8')));
  });
});
