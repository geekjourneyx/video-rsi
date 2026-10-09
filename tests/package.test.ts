import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRun } from '../src/store.js';
import type { RunManifest } from '../src/contracts.js';
import { brief, config, evaluated } from './fixtures.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'));
const env = { ...process.env, npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false' };
for (const key of Object.keys(env)) {
  if (/api.?key|token|secret|password/i.test(key) || /npm_config_http_proxy/i.test(key) || key === 'NODE_OPTIONS') delete env[key as keyof typeof env];
}
let root: string;
let tarball: string;
let binary: string;
let runPath: string;
let guard: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'video-rsi-package-'));
  // Build explicitly before this test. Packing must never invoke check/test recursively.
  if (process.env.PACKAGE_TARBALL) tarball = resolve(process.env.PACKAGE_TARBALL);
  else {
    const output = execFileSync('npm', ['pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', root], { cwd: repository, env, encoding: 'utf8' });
    tarball = join(root, JSON.parse(output)[0].filename);
  }
  // Reuse the committed resolution so offline installs cannot drift to uncached transitive versions.
  const consumer = { name: 'packaged-cli-acceptance', version: '1.0.0', private: true, dependencies: pkg.dependencies };
  const lock = JSON.parse(await readFile(join(repository, 'package-lock.json'), 'utf8'));
  lock.name = consumer.name; lock.version = consumer.version; lock.packages[''] = consumer;
  await writeFile(join(root, 'package.json'), JSON.stringify(consumer));
  await writeFile(join(root, 'package-lock.json'), JSON.stringify(lock));
  execFileSync('npm', ['install', '--offline', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', tarball], { cwd: root, env, stdio: 'pipe' });
  binary = join(root, 'node_modules', '.bin', 'video-rsi');
  guard = join(root, 'deny-network.cjs');
  await writeFile(guard, `const deny=()=>{throw new Error('Unexpected network access in packaged offline CLI');};
    globalThis.fetch=deny;
    for(const name of ['http','https']){const api=require('node:'+name);api.request=deny;api.get=deny;}
    for(const name of ['net','tls']){const api=require('node:'+name);api.connect=deny;api.createConnection=deny;}
    require('node:net').Socket.prototype.connect=deny;
  `);
  const manifest: RunManifest = {
    schemaVersion: 1, runId: evaluated.runId, brief, config, prompts: { writer: 'engineering fixture', judge: 'engineering fixture' },
    priceSnapshots: [], softwareVersion: pkg.version, seed: 42, operation: { kind: 'create', review: true },
  };
  const store = await openRun(join(root, 'runs'), manifest);
  try { await store.complete(evaluated); runPath = store.path; } finally { await store.close(); }
  await writeFile(join(root, 'evaluated.json'), JSON.stringify(evaluated));
}, 120_000);
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

function cli(args: string[], input?: string) {
  return spawnSync(binary, args, { cwd: root, env: { ...env, NODE_OPTIONS: `--require=${guard}` }, encoding: 'utf8', input });
}
describe('installed tarball outside the repository', () => {
  it('contains only runtime distribution, readme, package metadata and an owner-chosen license', () => {
    const files = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n');
    expect(files.length).toBeGreaterThan(4);
    expect(files.every(file => /^package\/(dist\/|README\.md$|package\.json$|LICENSE$)/.test(file))).toBe(true);
    expect(files).toContain('package/dist/cli.js');
    expect(files).toContain('package/dist/runtime.js');
    expect(files).toContain('package/dist/prompts/writer.md');
    expect(files).toContain('package/dist/prompts/judge.md');
    expect(files.some(file => /(^|\/)(runs|tests|\.env|node_modules|\.superpowers)(\/|\.|$)/.test(file))).toBe(false);
    const readme = execFileSync('tar', ['-xOzf', tarball, 'package/README.md'], {encoding:'utf8'});
    expect(readme).toContain('https://github.com/geekjourneyx/video-rsi/blob/main/docs/personal-trial.md');
    expect(readme).toContain('npm 包不包含 `examples/` 和 `docs/`');
    const packaged = JSON.parse(execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' }));
    expect(packaged.version).toBe(pkg.version);
    expect(packaged.dependencies).toEqual(pkg.dependencies);
    if (pkg.license !== 'UNLICENSED') expect(files).toContain('package/LICENSE');
  });
  it('runs help and version with no credentials or network', () => {
    const help = cli(['--help']);
    expect(help.status).toBe(0); expect(help.stderr).toBe(''); expect(help.stdout).toContain('Commands: create, judge, report, resume, replay, blind');
    const version = cli(['--version']);
    expect(version.status).toBe(0); expect(version.stderr).toBe(''); expect(version.stdout.trim()).toBe(pkg.version);
  });
  it('dry-runs publication of the same inspected tarball without credentials or registry access', () => {
    const output = execFileSync('npm', ['publish', tarball, '--dry-run', '--offline', '--ignore-scripts', '--access', 'public', '--json'], { cwd: root, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const dryRun = JSON.parse(output);
    expect(dryRun.id).toBe(`${pkg.name}@${pkg.version}`);
    expect(dryRun.files.map((file: { path: string }) => file.path)).toContain('dist/cli.js');
    expect(dryRun.files.every((file: { path: string }) => /^(dist\/|README\.md$|package\.json$|LICENSE$)/.test(file.path))).toBe(true);
  });
  it('ships prompt assets relative to the installed module', async () => {
    for (const role of ['writer', 'judge']) {
      expect(await readFile(join(root, 'node_modules/video-rsi/dist/prompts', role + '.md'), 'utf8')).toContain('JSON');
    }
  });
  it('reports and replays a fixture persisted by the real store offline', () => {
    const report = cli(['report', 'evaluated.json']);
    expect(report.status).toBe(0); expect(report.stderr).toBe(''); expect(JSON.parse(report.stdout)).toEqual(evaluated);
    const stdin = cli(['report', '-', '--format', 'markdown'], JSON.stringify(evaluated));
    expect(stdin.status).toBe(0); expect(stdin.stderr).toBe(''); expect(stdin.stdout).toContain('model_judgment');
    const replay = cli(['replay', runPath]);
    expect(replay.status).toBe(0); expect(replay.stderr).toBe(''); expect(JSON.parse(replay.stdout)).toEqual(evaluated);
  });
  it('refuses tampered persisted evidence instead of returning an unverified replay', async () => {
    const path = join(runPath, 'result.json');
    const original = await readFile(path, 'utf8');
    const envelope = JSON.parse(original); envelope.result.candidates[0].title = 'tampered';
    await writeFile(path, JSON.stringify(envelope));
    try { const replay = cli(['replay', runPath]); expect(replay.status).toBe(5); expect(replay.stdout).toBe(''); expect(JSON.parse(replay.stderr).code).toBe(5); }
    finally { await writeFile(path, original); }
  });
});

it('declares a bounded npm package and an offline check without publishing lifecycles', () => {
  expect(pkg.files).toEqual(['dist/', 'README.md', 'LICENSE']);
  expect(pkg.scripts.check).toBe('npm run typecheck && npm run build && npm test');
  expect(pkg.scripts).not.toHaveProperty('prepublishOnly');
  expect(pkg.scripts).not.toHaveProperty('prepare');
  expect(pkg.scripts).not.toHaveProperty('prepack');
  expect(pkg.engines.node).toBe('>=22.19.0');
  expect(Object.keys(pkg.dependencies).sort()).toEqual(['@earendil-works/pi-ai', 'zod']);
  expect(pkg.repository).toEqual({ type: 'git', url: 'https://github.com/geekjourneyx/video-rsi.git' });
  if (pkg.license === 'UNLICENSED') expect(pkg.private).toBe(true);
});
it('keeps PR CI offline across both supported systems and the minimum Node floor', async () => {
  const workflow = await readFile(join(repository, '.github/workflows/ci.yml'), 'utf8');
  expect(workflow).toContain('pull_request:'); expect(workflow).toContain('ubuntu-latest'); expect(workflow).toContain('macos-latest');
  expect(workflow).toContain("'22.19.0'"); expect(workflow).toContain("'24'");
  expect(workflow.indexOf('npm ci')).toBeLessThan(workflow.indexOf('npm run check'));
  expect(workflow).toContain('npm test -- tests/package.test.ts'); expect(workflow).not.toContain('smoke:providers');
  expect(workflow).not.toContain('id-token: write');
});
it('publishes only releases using OIDC after inspecting and installing the exact tarball', async () => {
  const workflow = await readFile(join(repository, '.github/workflows/publish.yml'), 'utf8');
  expect(workflow).toContain('release:'); expect(workflow).toContain('types: [published]');
  expect(workflow).not.toMatch(/^  (push|pull_request|workflow_dispatch):/m);
  expect(workflow).toContain('id-token: write'); expect(workflow).toContain('contents: read');
  expect(workflow).toContain('runs-on: ubuntu-latest'); expect(workflow).toContain('environment: npm');
  expect(workflow).toContain("node-version: '24'"); expect(workflow).toContain('npm@11.9.0');
  expect(workflow).toContain('package-manager-cache: false'); expect(workflow).not.toContain('NPM_TOKEN');
  expect(workflow).toContain('node scripts/release-readiness.mjs');
  expect(workflow.indexOf('npm run check')).toBeLessThan(workflow.indexOf('npm pack --ignore-scripts'));
  expect(workflow).toContain('PACKAGE_TARBALL'); expect(workflow).toContain('npm test -- tests/package.test.ts');
  expect(workflow).toContain('sha256sum --check');
  expect(workflow).toContain('npm publish "$PACKAGE_TARBALL" --dry-run --ignore-scripts --access public');
  expect(workflow).toContain('npm publish "$PACKAGE_TARBALL" --ignore-scripts --provenance --access public');
  for (const name of ['checkout', 'setup-node']) expect(workflow).toMatch(new RegExp('actions/' + name + '@[a-f0-9]{40}'));
});

it('release readiness explains the private/license blockers and rejects a mismatched version tag', async () => {
  const script = join(repository, 'scripts/release-readiness.mjs');
  const releaseEnv = { ...env, RELEASE_TAG: 'v' + pkg.version, GITHUB_REPOSITORY: 'geekjourneyx/video-rsi', REPOSITORY_VISIBILITY: 'public' };
  const blocked = spawnSync(process.execPath, [script], { cwd: repository, env: releaseEnv, encoding: 'utf8' });
  if (pkg.license === 'UNLICENSED' || pkg.private) {
    expect(blocked.status).toBe(1); expect(blocked.stderr).toContain('private'); expect(blocked.stderr).toContain('LICENSE');
  }
  const fixture = join(root, 'release-ready');
  const { mkdir } = await import('node:fs/promises'); await mkdir(fixture);
  const ready = { ...pkg, private: false, license: 'MIT' };
  await writeFile(join(fixture, 'package.json'), JSON.stringify(ready));
  await writeFile(join(fixture, 'LICENSE'), 'Engineering fixture only; no repository license chosen.');
  const run = (overrides = {}) => spawnSync(process.execPath, [script], { cwd: fixture, env: { ...releaseEnv, ...overrides }, encoding: 'utf8' });
  const readyResult = run();
  if (Number(process.versions.node.split('.')[0]) >= 24) expect(readyResult.status).toBe(0);
  else { expect(readyResult.status).toBe(1); expect(readyResult.stderr).toContain('Node 24'); }
  const wrongTag = run({ RELEASE_TAG: 'v9.9.9' }); expect(wrongTag.status).toBe(1); expect(wrongTag.stderr).toContain('version');
  const wrongRepository = run({ GITHUB_REPOSITORY: 'someone/fork' }); expect(wrongRepository.status).toBe(1); expect(wrongRepository.stderr).toContain('repository');
  const privateRepository = run({ REPOSITORY_VISIBILITY: 'private' }); expect(privateRepository.status).toBe(1); expect(privateRepository.stderr).toContain('public');
  await writeFile(join(fixture, 'package.json'), JSON.stringify({ ...ready, repository: { type: 'git', url: 'https://github.com/someone/fork.git' } }));
  const wrongUrl = run(); expect(wrongUrl.status).toBe(1); expect(wrongUrl.stderr).toContain('repository.url');
});
