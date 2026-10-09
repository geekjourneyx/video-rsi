import { afterEach, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_JSON_BYTES, readJson } from '../src/io.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
it('keeps the default 1 MiB limit and accepts larger derived stdin with an explicit 8 MiB limit', async () => {
  const encoded = JSON.stringify({ data: 'x'.repeat(MAX_JSON_BYTES) });
  await expect(readJson('-', Readable.from([encoded]))).rejects.toMatchObject({ code: 2 });
  const result = await readJson('-', Readable.from([encoded]), 8 * MAX_JSON_BYTES);
  expect((result as { data: string }).data.length).toBe(MAX_JSON_BYTES);
});
it('accepts derived file input at the explicit byte boundary and rejects one extra byte', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batch-json-'));
  roots.push(root);
  const path = join(root, 'batch.json');
  const limit = 8 * MAX_JSON_BYTES;
  const encoded = JSON.stringify({ data: 'x'.repeat(limit - 11) });
  expect(Buffer.byteLength(encoded)).toBe(limit);
  await writeFile(path, encoded);
  const result = await readJson(path, Readable.from([]), limit);
  expect((result as { data: string }).data.length).toBe(limit - 11);
  await writeFile(path, encoded + ' ');
  await expect(readJson(path, Readable.from([]), limit)).rejects.toMatchObject({ code: 2, message: 'JSON input exceeds 8 MiB' });
});
