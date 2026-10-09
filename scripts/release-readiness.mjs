import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

// This read-only gate must pass before release dependencies, signing, or publishing.
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const blockers = [];
if (pkg.private !== false) blockers.push('package.private must be false after the owner approves publication');
if (!pkg.license || pkg.license === 'UNLICENSED') blockers.push('choose an owner-approved license and replace UNLICENSED');
const license = await readFile('LICENSE', 'utf8').catch(() => '');
if (!license.trim()) blockers.push('add the owner-approved LICENSE file');
if (process.env.RELEASE_TAG !== `v${pkg.version}`) blockers.push(`release tag must match package version: v${pkg.version}`);
if (pkg.repository?.url !== 'https://github.com/geekjourneyx/video-rsi.git') blockers.push('repository.url must match https://github.com/geekjourneyx/video-rsi.git');
if (process.env.GITHUB_REPOSITORY !== 'geekjourneyx/video-rsi') blockers.push('release repository must be geekjourneyx/video-rsi');
if (process.env.REPOSITORY_VISIBILITY !== 'public') blockers.push('provenance requires a public GitHub repository and public npm package');
if (Number(process.versions.node.split('.')[0]) < 24) blockers.push('release requires Node 24 or newer');
const npmVersion = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
const [major, minor, patch] = npmVersion.split('.').map(Number);
if (!(major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1))))) blockers.push('trusted publishing requires npm >=11.5.1');
if (blockers.length) {
  console.error('Release blocked:\n' + blockers.map(message => '- ' + message).join('\n'));
  process.exitCode = 1;
} else console.log(`Release metadata ready: ${pkg.name}@${pkg.version}. npm ownership and trusted-publisher configuration still require owner setup.`);
