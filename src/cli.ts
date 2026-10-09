#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { randomInt, randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import { AppError } from './errors.js';
import { studySchema, candidateBatchSchema, parseBrief, parseConfig, type CandidateBatch, type RunManifest } from './contracts.js';
import { MAX_BATCH_JSON_BYTES, MAX_JSON_BYTES, readJson } from './io.js';
import { cancellation, checkPlan, runJudgePipeline, runPipeline } from './pipeline.js';
import { replayRun, resumeRun } from './replay.js';
import { parseBatch, renderReport, summarizeCost } from './report.js';
import { prepareBlind, recordChoice, summarizeBlind } from './blind.js';
import { hashJson, loadRun, openRun, type RunStore } from './store.js';

import { softwareVersion } from './runtime.js';

function write(stream: Writable, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(text, error => error ? reject(error) : resolve());
  });
}

function candidateInput(value: unknown): CandidateBatch {
  const result = candidateBatchSchema.safeParse(value);
  if (!result.success) throw new AppError(2, 'Judge input must be a CandidateBatch');
  const batch = result.data;
  const ids = new Set(batch.brief.sources.map(source => source.id));
  if (new Set(batch.candidates.map(candidate => candidate.id)).size !== batch.candidates.length) {
    throw new AppError(2, 'Duplicate input candidate ID');
  }
  if (batch.candidates.some(candidate => candidate.claims.some(claim => claim.sourceIds.some(id => !ids.has(id))))) {
    throw new AppError(2, 'Candidate referenced an unknown source ID');
  }
  return batch;
}

export async function main(
  argv: string[], io: { stdin: Readable; stdout: Writable; stderr: Writable },
): Promise<number> {
  const controller = new AbortController();
  let store: RunStore | undefined;
  let brokenPipe = false;
  const interrupt = () => controller.abort(new AppError(130, 'Interrupted by SIGINT'));
  const terminate = () => controller.abort(new AppError(143, 'Interrupted by SIGTERM'));
  const outputError = (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') {
      brokenPipe = true;
      controller.abort(new AppError(130, 'Output pipe closed'));
    }
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  io.stdout.on('error', outputError);
  const checkCancelled = () => {
    if (controller.signal.aborted) throw cancellation(controller.signal);
  };
  const output = async (text: string) => {
    checkCancelled();
    await write(io.stdout, text);
    checkCancelled();
  };
  try {
    let parsed: ReturnType<typeof parseArgs>;
    try {
      parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
        help: { type: 'boolean' }, version: { type: 'boolean' }, config: { type: 'string' },
        'runs-dir': { type: 'string' }, quiet: { type: 'boolean' }, review: { type: 'boolean' },
        format: { type: 'string' }, 'recover-lock': { type: 'boolean' }, 'retry-unknown': { type: 'boolean' },
        out: { type: 'string' }, pair: { type: 'string' }, choice: { type: 'string' },
        reason: { type: 'string' }, 'edit-minutes': { type: 'string' }, supersedes: { type: 'string' },
      } });
    } catch (error) {
      throw new AppError(2, error instanceof Error ? error.message : 'Invalid arguments');
    }
    const { values, positionals } = parsed;
    if (values.help) {
      await output('video-rsi — short-video candidate workflow\nUsage: video-rsi <command> [input] [--config path]\nCommands: create, judge, report, resume, replay, blind\nBlind: prepare <study.json|-> --out <directory> | record <directory> --pair <id> --choice A|B|tie|neither --reason <text> --edit-minutes <n> [--supersedes <eventId>] | summary <directory>\n');
      return 0;
    }
    if (values.version) {
      await output(softwareVersion + '\n');
      return 0;
    }
    const [command, input] = positionals;
    const blindOptions = ['out', 'pair', 'choice', 'reason', 'edit-minutes', 'supersedes'];
    if (command === 'blind') {
      const directory = positionals[2];
      if (!directory || positionals.length !== 3 || !['prepare', 'record', 'summary'].includes(input ?? '')) throw new AppError(2, 'Invalid blind command');
      const allowed = input === 'prepare' ? ['out', 'quiet'] : input === 'record' ? ['pair', 'choice', 'reason', 'edit-minutes', 'supersedes', 'quiet'] : ['quiet'];
      if (Object.keys(values).some(key => !allowed.includes(key))) throw new AppError(2, 'Option is not supported by this blind command');
      checkCancelled();
      if (input === 'prepare') {
        if (!values.out) throw new AppError(2, '--out is required');
        const parsedStudy = studySchema.safeParse(await readJson(directory, io.stdin, MAX_BATCH_JSON_BYTES, controller.signal));
        if (!parsedStudy.success) throw new AppError(2, 'Invalid study');
        checkCancelled();
        await prepareBlind(parsedStudy.data, String(values.out), controller.signal);
        await output(JSON.stringify({schemaVersion: 1, directory: values.out}) + '\n');
      } else if (input === 'record') {
        if (!values.pair || !values.choice || !values.reason || typeof values['edit-minutes'] !== 'string' || !values['edit-minutes'].trim()) throw new AppError(2, 'Record requires pair, choice, reason and edit-minutes');
        checkCancelled();
        await recordChoice(directory, {pairId: String(values.pair), choice: String(values.choice) as 'A'|'B'|'tie'|'neither', reason: String(values.reason), editMinutes: Number(values['edit-minutes']), ...(values.supersedes ? {supersedes: String(values.supersedes)} : {})}, controller.signal);
        await output(JSON.stringify({schemaVersion: 1, recorded: true}) + '\n');
      } else await output(JSON.stringify(await summarizeBlind(directory), null, 2) + '\n');
      checkCancelled();
      return 0;
    }
    if (blindOptions.some(key => values[key] !== undefined)) throw new AppError(2, 'Blind option used for another command');
    if (command === 'resume' || command === 'replay') {
      if (!input || input === '-' || positionals.length !== 2) throw new AppError(2, 'Exactly one run directory is required');
      const allowed = command === 'resume' ? ['quiet', 'recover-lock', 'retry-unknown'] : ['quiet'];
      if (Object.keys(values).some(key => !allowed.includes(key))) throw new AppError(2, 'Resume/replay use frozen manifest; overrides are not supported');
      let result;
      if (command === 'replay') result = await replayRun(input);
      else {
        const record = await loadRun(input);
        // Construct the real client only if recovery actually dispatches a call.
        // This also keeps completed resume and cached failures entirely offline.
        let client: import('./contracts.js').ModelClient | undefined;
        const lazy: import('./contracts.js').ModelClient = { async preflight(roles) {
          if (!client) client = (await import('./model.js')).createModelClient(record.manifest.config);
          await client.preflight?.(roles);
        }, async complete(request, signal) {
          if (!client) client = (await import('./model.js')).createModelClient(record.manifest.config);
          return client.complete(request, signal);
        } };
        result = await resumeRun(input, lazy, controller.signal, {recoverLock: values['recover-lock'] === true, retryUnknown: values['retry-unknown'] === true});
        if (!values.quiet) await write(io.stderr, summarizeCost(await loadRun(input)) + '\n');
      }
      if (controller.signal.aborted) throw cancellation(controller.signal);
      await output(renderReport(result, 'json') + '\n');
      if (controller.signal.aborted) throw cancellation(controller.signal);
      return 0;
    }
    if (!['create', 'judge', 'report'].includes(command ?? '')) {
      throw new AppError(2, `Unsupported command: ${command ?? '(missing)'}`);
    }
    if (!input || positionals.length !== 2) throw new AppError(2, 'Exactly one input path or - is required');
    if (values['retry-unknown'] !== undefined || values['recover-lock'] !== undefined ||
        (command !== 'create' && values.review !== undefined) ||
        (command !== 'report' && values.format !== undefined)) {
      throw new AppError(2, 'Option is not supported by this command');
    }
    if (command === 'report') {
      const format = values.format ?? 'json';
      if (format !== 'json' && format !== 'markdown') throw new AppError(2, 'Report format must be json or markdown');
      const batch = parseBatch(await readJson(input, io.stdin, MAX_BATCH_JSON_BYTES, controller.signal));
      await output(renderReport(batch, format) + '\n');
      return 0;
    }
    const value = await readJson(input, io.stdin, command === 'judge' ? MAX_BATCH_JSON_BYTES : MAX_JSON_BYTES, controller.signal);
    const batch = command === 'judge' ? candidateInput(value) : undefined;
    const brief = batch?.brief ?? parseBrief(value);
    const config = parseConfig(await readJson(String(values.config ?? './video-rsi.json'), io.stdin, MAX_JSON_BYTES, controller.signal));
    const review = values.review === true;
    if (command === 'create') checkPlan(config, review);
    const prompts = {
      writer: await readFile(new URL('./prompts/writer.md', import.meta.url), 'utf8'),
      judge: await readFile(new URL('./prompts/judge.md', import.meta.url), 'utf8'),
    };
    // Provider code is only loaded for paid operations, after public input validation.
    const { createModelClient, resolvePrice } = await import('./model.js');
    const client = createModelClient(config);
    const prices = Object.values(config.models).map(resolvePrice).filter(price => price !== null);
    const manifest: RunManifest = {
      schemaVersion: 1, runId: randomUUID(), brief, config, prompts,
      priceSnapshots: prices, softwareVersion, seed: randomInt(0, 0x1_0000_0000),
      operation: command === 'judge' ? { kind: 'judge' } : { kind: 'create', review },
      ...(batch ? { inputBatch: batch, inputBatchHash: hashJson(batch) } : {}),
    };
    checkCancelled();
    store = await openRun(String(values['runs-dir'] ?? './runs'), manifest);
    const result = command === 'judge'
      ? await runJudgePipeline(config, client, store, controller.signal)
      : await runPipeline(brief, config, client, store, controller.signal, review);
    const record = await loadRun(store.path);
    await store.close();
    if (!values.quiet) await write(io.stderr, summarizeCost(record) + '\n');
    if (controller.signal.aborted) throw cancellation(controller.signal);
    await output(renderReport(result, 'json') + '\n');
    if (controller.signal.aborted) throw cancellation(controller.signal);
    return 0;
  } catch (error) {
    if (brokenPipe || (error as NodeJS.ErrnoException)?.code === 'EPIPE') return 0;
    const app = error instanceof AppError ? error : new AppError(1, 'Internal error');
    await write(io.stderr, JSON.stringify({ code: app.code, message: app.message,
      ...(app.runId ? { runId: app.runId } : {}) }) + '\n');
    return app.code;
  } finally {
    await store?.close();
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    io.stdout.removeListener('error', outputError);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2), {
    stdin: process.stdin, stdout: process.stdout, stderr: process.stderr,
  });
}
