import { readFile } from 'node:fs/promises';
import { parseConfig } from '../dist/contracts.js';
import { createModelClient, resolvePrice } from '../dist/model.js';

const index = process.argv.indexOf('--config');
if (index < 0 || !process.argv[index + 1]) {
  console.error('Usage: npm run smoke:providers -- --config <private-config>');
  process.exitCode = 2;
} else {
  const config = parseConfig(JSON.parse(await readFile(process.argv[index + 1], 'utf8')));
  const refs = [config.models.writer, config.models.judge];
  if (new Set(refs.map(ref => ref.provider)).size !== 2 || !refs.some(ref => ref.provider === 'openai') || !refs.some(ref => ref.provider === 'anthropic')) {
    throw new Error('Smoke config requires one OpenAI and one Anthropic model');
  }
  const client = createModelClient(config);
  for (const ref of refs) {
    if (!process.env[ref.apiKeyEnv]) {
      console.log(JSON.stringify({ version: '@earendil-works/pi-ai@1.1.0', provider: ref.provider, model: ref.model, status: 'blocked', reason: 'API key absent', calls: 0 }));
      process.exitCode = 3;
      continue;
    }
    for (const cancel of [false, true]) {
      const controller = new AbortController();
      const timer = cancel ? setTimeout(() => controller.abort(), 10) : undefined;
      try {
        const result = await client.complete({ callId: `smoke-${ref.provider}-${cancel ? 'cancel' : 'normal'}`, role: ref === refs[0] ? 'writer' : 'judge', model: ref, system: 'Reply briefly.', input: 'Say hello.', maxOutputTokens: 64, timeoutMs: config.limits.timeoutMs }, controller.signal);
        console.log(JSON.stringify({ version: '@earendil-works/pi-ai@1.1.0', provider: ref.provider, model: ref.model, kind: cancel ? 'controlled-cancel' : 'normal', status: result.stopReason, usage: result.usage, price: resolvePrice(ref), calls: 1 }));
        if (result.stopReason !== (cancel ? 'aborted' : 'stop')) process.exitCode = 3;
      } finally { if (timer !== undefined) clearTimeout(timer); }
    }
  }
}
