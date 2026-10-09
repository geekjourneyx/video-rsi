import { afterEach, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, mkdir, readdir, readFile, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { brief, config, candidates, evaluated } from './fixtures.js';
import { loadRun } from '../src/store.js';
const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => { children.splice(0).forEach(child => { if (child.exitCode === null) child.kill('SIGKILL'); }); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'signal-cli-')); roots.push(root);
  const modules = join(root, 'modules'); await mkdir(modules);
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  // Compile actual production modules; only the paid-provider adapter is replaced.
  for (const name of await readdir(new URL('../src', import.meta.url))) {
    if (!name.endsWith('.ts') || name === 'model.ts') continue;
    const source = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
    await writeFile(join(modules, name.replace(/\.ts$/, '.js')), ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText);
  }
  await cp(new URL('../src/prompts', import.meta.url), join(modules, 'prompts'), { recursive: true });
  // Resolve the real installed zod without copying any production algorithm.
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', imports: {}, version: JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version }));
  const { symlink } = await import('node:fs/promises'); await symlink(join(process.cwd(), 'node_modules'), join(root, 'node_modules'), 'dir');
  await writeFile(join(modules, 'model.js'), `
export const resolvePrice = () => null;
export function createModelClient() {
  if (process.env.FIXTURE_OFFLINE) throw new Error('Client constructed during offline replay');
  return { async complete(request, signal) {
    process.send?.({dispatched: request.role, callId: request.callId});
    const input = JSON.parse(request.input);
    if ((request.role === 'judge' && process.env.FIXTURE_PAUSE) || process.env.FIXTURE_PIPE) {
      await new Promise((resolve, reject) => {
        const abort = () => { process.removeListener('message', release); reject(new Error('fixture aborted')); };
        signal.addEventListener('abort', abort, {once:true});
        if (signal.aborted) return abort();
        const release = () => {
          if (process.env.FIXTURE_PIPE) {
            process.stdout.write('x'.repeat(1024*1024), error => error ? reject(error) : resolve());
          } else resolve();
        };
        process.once('message', release);
      });
    }
    const candidate = ${JSON.stringify(candidates.candidates[0])};
    delete candidate.id; delete candidate.round;
    const verdict = ${JSON.stringify(evaluated.evaluation.verdicts[0])};
    const text = JSON.stringify(request.role === 'writer' ? {candidates: Array.from({length:input.count}, (_,i)=>({...candidate,title:'Title '+i}))} : {verdicts:input.candidates.map(item=>({...verdict,candidateId:item.id}))});
    return {text,stopReason:'stop',usage:{inputTokens:1,outputTokens:1,estimatedCostMicrousd:7},raw:{}};
  }};
}
`);
  const cfg = join(root, 'config.json'); const input = join(root, 'brief.json');
  await writeFile(cfg, JSON.stringify({ ...config, limits: { ...config.limits, maxCalls: 4 } })); await writeFile(input, JSON.stringify(brief));
  return { root, cli: join(modules, 'cli.js'), cfg, input, runs: join(root, 'runs') };
}
function launch(cli: string, argv: string[], env: NodeJS.ProcessEnv = {}) {
  const child = fork(cli, argv, { silent: true, env: { ...process.env, ...env } }); children.push(child);
  let out = ''; let err = ''; const dispatched: string[] = [];
  child.stdout!.on('data', chunk => { out += chunk; }); child.stderr!.on('data', chunk => { err += chunk; });
  child.on('message', message => { const event = message as {dispatched?:string}; if (event.dispatched) dispatched.push(event.dispatched); });
  const exit = new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve => child.once('exit', (code, signal) => resolve({code,signal})));
  return { child, exit, out: () => out, err: () => err, dispatched };
}
function barrier(child: ChildProcess, role: string) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Dispatch barrier timeout')), 5000);
    child.on('message', message => { if ((message as {dispatched?:string}).dispatched === role) { clearTimeout(timeout); resolve(); } });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Child exited before barrier: ${code}`)); });
  });
}
it.each([['SIGINT', 130], ['SIGTERM', 143]] as const)('real %s exits %s, preserves cached writer and unknown judge, explicit restart dispatches only judge', async (signal, code) => {
  const f = await fixture(); const run = launch(f.cli, ['create', f.input, '--review', '--config', f.cfg, '--runs-dir', f.runs], { FIXTURE_PAUSE: '1' });
  await barrier(run.child, 'judge'); run.child.kill(signal);
  expect(await run.exit).toEqual({ code, signal: null }); expect(run.out()).toBe('');
  expect(JSON.parse(run.err())).toMatchObject({code});
  const path = join(f.runs, (await readdir(f.runs))[0]!); const record = await loadRun(path);
  expect(record.events.filter(event => event.type === 'call_finished')).toHaveLength(1);
  expect(record.events.filter(event => event.type === 'call_unknown')).toHaveLength(1);
  const refused = launch(f.cli, ['resume', path]); expect((await refused.exit).code).toBe(5); expect(refused.dispatched).toEqual([]);
  const resumed = launch(f.cli, ['resume', path, '--retry-unknown', '--quiet']); expect((await resumed.exit).code).toBe(0);
  expect(resumed.dispatched).toEqual(['judge']); expect(JSON.parse(resumed.out()).evaluation.kind).toBe('model_judgment');
  const replay = launch(f.cli, ['replay', path], { FIXTURE_OFFLINE: '1' }); expect((await replay.exit).code).toBe(0); expect(replay.dispatched).toEqual([]); expect(replay.out()).toBe(resumed.out());
}, 15000);
it('real SIGKILL requires explicit lock recovery and never repeats a cached writer', async () => {
  const f = await fixture(); const run = launch(f.cli, ['create', f.input, '--review', '--config', f.cfg, '--runs-dir', f.runs], { FIXTURE_PAUSE: '1' });
  await barrier(run.child, 'judge'); run.child.kill('SIGKILL'); expect((await run.exit).signal).toBe('SIGKILL');
  const path = join(f.runs, (await readdir(f.runs))[0]!);
  const blocked = launch(f.cli, ['resume', path, '--retry-unknown']); expect((await blocked.exit).code).toBe(5);
  const resumed = launch(f.cli, ['resume', path, '--recover-lock', '--retry-unknown', '--quiet']); expect((await resumed.exit).code).toBe(0); expect(resumed.dispatched).toEqual(['judge']);
}, 15000);
it('OS output pipe closure cancels in-flight dispatch without another call or stack', async () => {
  const f = await fixture(); const run = launch(f.cli, ['create', f.input, '--review', '--config', f.cfg, '--runs-dir', f.runs], { FIXTURE_PIPE: '1' });
  await barrier(run.child, 'writer'); run.child.stdout!.destroy(); run.child.send('release-pipe-probe');
  expect((await run.exit).code).toBe(0); expect(run.err()).toBe(''); expect(run.dispatched).toEqual(['writer']);
  const path = join(f.runs, (await readdir(f.runs))[0]!); expect((await loadRun(path)).events.filter(event => event.type === 'call_started')).toHaveLength(1);
}, 15000);
async function lateBarrierCli(f: Awaited<ReturnType<typeof fixture>>, phase: 'round' | 'result', signal: NodeJS.Signals) {
  const path = join(f.root, 'late-cli.js');
  await writeFile(path, `
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
const realOpen = fs.open;
let held = false;
async function barrier() {
  if (held) return;
  held = true;
  process.channel?.ref();
  await new Promise(resolve => {
    process.once(${JSON.stringify(signal)}, resolve);
    process.send?.({dispatched:'late-${phase}'});
  });
  process.channel?.unref();
}
fs.open = async (...args) => {
  const handle = await realOpen(...args);
  const target = String(args[0]);
  if (${JSON.stringify(phase)} === 'round' && target.endsWith('events.jsonl')) {
    const realWrite = handle.writeFile.bind(handle);
    handle.writeFile = async (...values) => {
      if (typeof values[0] === 'string' && JSON.parse(values[0]).type === 'round_finished') await barrier();
      return realWrite(...values);
    };
  }
  if (${JSON.stringify(phase)} === 'result' && target.endsWith('result.json')) {
    const realRead = handle.readFile.bind(handle);
    handle.readFile = async (...values) => { const data = await realRead(...values); await barrier(); return data; };
  }
  return handle;
};
syncBuiltinESMExports();
const {main} = await import('./modules/cli.js');
process.exitCode = await main(process.argv.slice(2), {stdin:process.stdin, stdout:process.stdout, stderr:process.stderr});
`);
  return path;
}
it('real SIGINT during final round append returns 130 before completion and cached recovery sends zero calls', async () => {
  const f = await fixture(); const cli = await lateBarrierCli(f, 'round', 'SIGINT');
  const run = launch(cli, ['create', f.input, '--config', f.cfg, '--runs-dir', f.runs]);
  await barrier(run.child, 'late-round'); run.child.kill('SIGINT');
  expect(await run.exit).toEqual({code:130,signal:null}); expect(run.out()).toBe(''); expect(run.dispatched).toEqual(['writer','late-round']);
  const path = join(f.runs, (await readdir(f.runs))[0]!); expect((await loadRun(path)).result).toBeUndefined();
  const recovered = launch(f.cli, ['resume', path, '--quiet'], {FIXTURE_OFFLINE:'1'});
  expect((await recovered.exit).code).toBe(0); expect(recovered.dispatched).toEqual([]); expect(JSON.parse(recovered.out()).candidates).toHaveLength(3);
}, 15000);
it.each(['replay', 'resume'])('real SIGTERM during offline %s final-result read returns 143 with no stdout or dispatch', async command => {
  const f = await fixture(); const created = launch(f.cli, ['create', f.input, '--config', f.cfg, '--runs-dir', f.runs, '--quiet']);
  expect((await created.exit).code).toBe(0);
  const path = join(f.runs, (await readdir(f.runs))[0]!); const cli = await lateBarrierCli(f, 'result', 'SIGTERM');
  const run = launch(cli, [command, path, '--quiet'], {FIXTURE_OFFLINE:'1'});
  await barrier(run.child, 'late-result'); run.child.kill('SIGTERM');
  expect(await run.exit).toEqual({code:143,signal:null}); expect(run.out()).toBe(''); expect(run.dispatched).toEqual(['late-result']);
  expect((await loadRun(path)).status).toBe('completed');
  const replay = launch(f.cli, ['replay', path], {FIXTURE_OFFLINE:'1'}); expect((await replay.exit).code).toBe(0); expect(replay.out()).toBe(created.out());
}, 15000);

// Keep stdin open: cancellation must not depend on the producer reaching EOF.
it.each([['SIGINT', 130], ['SIGTERM', 143]] as const)('open stdin exits promptly on %s with status %s', async (signal, code) => {
  const f = await fixture();
  const wrapper = join(f.root, 'stdin-cli.js');
  await writeFile(wrapper, `
import {main} from './modules/cli.js';
process.stdin.once('readable', () => process.send?.({dispatched:'stdin-ready'}));
process.exitCode = await main(process.argv.slice(2), {stdin:process.stdin,stdout:process.stdout,stderr:process.stderr});
`);
  const run = launch(wrapper, ['report', '-']);
  const ready = barrier(run.child, 'stdin-ready');
  run.child.stdin!.write('{');
  await ready;
  run.child.kill(signal);
  const timeout = setTimeout(() => run.child.kill('SIGKILL'), 1500);
  try {
    expect(await run.exit).toEqual({
      code,
      signal: null
    });
    expect(run.out()).toBe('');
    expect(JSON.parse(run.err())).toMatchObject({ code });
  }
  finally {
    clearTimeout(timeout);
  }
}, 10000);
it('an alternate package version creates, replays and resumes its own frozen runs', async () => {
  const f = await fixture();
  await writeFile(join(f.root, 'package.json'), JSON.stringify({
    type: 'module',
    version: '0.2.7'
  }));
  const created = launch(f.cli, ['create', f.input, '--config', f.cfg, '--runs-dir', f.runs, '--quiet']);
  expect((await created.exit).code).toBe(0);
  const path = join(f.runs, (await readdir(f.runs))[0]!);
  expect((await loadRun(path)).manifest.softwareVersion).toBe('0.2.7');
  for (const command of ['replay', 'resume']) {
    const recovered = launch(f.cli, [command, path, '--quiet'], { FIXTURE_OFFLINE: '1' });
    expect((await recovered.exit).code).toBe(0);
    expect(recovered.out()).toBe(created.out());
    expect(recovered.dispatched).toEqual([]);
  }
  await writeFile(join(f.root, 'package.json'), JSON.stringify({
    type: 'module',
    version: '9.0.0'
  }));
  for (const command of ['replay', 'resume']) {
    const incompatible = launch(f.cli, [command, path, '--quiet'], { FIXTURE_OFFLINE: '1' });
    expect((await incompatible.exit).code).toBe(5);
    expect(incompatible.out()).toBe('');
    expect(incompatible.dispatched).toEqual([]);
  }
}, 15000);
it.each(['report', 'blind'] as const)('real SIGTERM after offline %s input read prevents business output and preparation', async (command) => {
  const f = await fixture();
  const wrapper = join(f.root, 'late-input.js');
  await writeFile(wrapper, `
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const createReadStream = fs.createReadStream;
fs.createReadStream = (...args) => {
 const stream = createReadStream(...args);
 const iterator = stream[Symbol.asyncIterator].bind(stream);
 stream[Symbol.asyncIterator] = async function* () {
 for await (const chunk of {[Symbol.asyncIterator]:iterator}) yield chunk;
 process.channel?.ref();
 await new Promise(resolve => {
  process.once('SIGTERM', resolve);
  process.send?.({dispatched:'input-read'});
 });
 process.channel?.unref();
 };
 return stream;
};
syncBuiltinESMExports();
const {main} = await import('./modules/cli.js');
process.exitCode = await main(process.argv.slice(2), {stdin:process.stdin,stdout:process.stdout,stderr:process.stderr});
`);
  const input = join(f.root, 'offline.json');
  const out = join(f.root, 'blind-output');
  const study = {
    schemaVersion: 1,
    seed: 1,
    arms: ['single', 'multi'],
    items: ['single', 'multi'].map(variant => ({
      briefId: 'brief',
      variant,
      candidate: candidates.candidates[0],
      productionMinutes: 1,
    })),
  };
  await writeFile(input, JSON.stringify(command === 'report' ? evaluated : study));
  const argv = command === 'report' ? ['report', input] : ['blind', 'prepare', input, '--out', out];
  const run = launch(wrapper, argv, { FIXTURE_OFFLINE: '1' });
  await barrier(run.child, 'input-read');
  run.child.kill('SIGTERM');
  expect(await run.exit).toEqual({
    code: 143,
    signal: null
  });
  expect(run.out()).toBe('');
  expect(JSON.parse(run.err())).toMatchObject({ code: 143 });
  await expect(readdir(out)).rejects.toMatchObject({ code: 'ENOENT' });
}, 15000);
it('real SIGINT during blind preparation finishes durable evidence before returning 130', async () => {
  const f = await fixture();
  const wrapper = join(f.root, 'blind-write.js');
  await writeFile(wrapper, `
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
const realOpen = fs.open;
fs.open = async (...args) => {
 const handle = await realOpen(...args);
 if (String(args[0]).endsWith('allocation.json')) {
 const realWrite = handle.writeFile.bind(handle);
 handle.writeFile = async (...values) => {
  process.channel?.ref();
  await new Promise(resolve => {
  process.once('SIGINT', resolve);
  process.send?.({dispatched:'blind-write'});
  });
  process.channel?.unref();
  return realWrite(...values);
 };
 }
 return handle;
};
syncBuiltinESMExports();
const {main} = await import('./modules/cli.js');
process.exitCode = await main(process.argv.slice(2), {stdin:process.stdin,stdout:process.stdout,stderr:process.stderr});
`);
  const input = join(f.root, 'study.json');
  const out = join(f.root, 'blind-output');
  await writeFile(input, JSON.stringify({
    schemaVersion: 1,
    seed: 1,
    arms: ['single', 'multi'],
    items: ['single', 'multi'].map(variant => ({
      briefId: 'brief',
      variant,
      candidate: candidates.candidates[0],
      productionMinutes: 1,
    })),
  }));
  const run = launch(wrapper, ['blind', 'prepare', input, '--out', out]);
  await barrier(run.child, 'blind-write');
  run.child.kill('SIGINT');
  expect(await run.exit).toEqual({
    code: 130,
    signal: null
  });
  expect(run.out()).toBe('');
  expect(JSON.parse(run.err())).toMatchObject({ code: 130 });
  expect((await readdir(out)).sort()).toEqual(['allocation.json', 'review.md', 'selection.jsonl']);
  expect(JSON.parse(await readFile(join(out, 'allocation.json'), 'utf8')).pairs).toHaveLength(1);
  expect(await readFile(join(out, 'selection.jsonl'), 'utf8')).toBe('');
  expect(await readFile(join(out, 'review.md'), 'utf8')).toContain('方案盲选');
}, 15000);
