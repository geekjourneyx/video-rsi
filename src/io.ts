import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { AppError } from './errors.js';

export const MAX_JSON_BYTES = 1024 * 1024;
export const MAX_BATCH_JSON_BYTES = 8 * MAX_JSON_BYTES;

/** Brief/config use the default; derived batch readers explicitly select 8 MiB. */
export async function readJson(
  path: string, input: Readable, maximumBytes = MAX_JSON_BYTES, signal?: AbortSignal,
): Promise<unknown> {
  const cancelled = () => signal?.reason instanceof AppError ? signal.reason : new AppError(130, 'Run cancelled');
  if (signal?.aborted) throw cancelled();
  const stream = path === '-' ? input : createReadStream(path);
  const abort = () => stream.destroy(cancelled());
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    signal?.addEventListener('abort', abort, { once: true });
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      size += bytes.length;
      if (size > maximumBytes) {
        stream.destroy();
        throw new AppError(2, `JSON input exceeds ${maximumBytes / MAX_JSON_BYTES} MiB`);
      }
      chunks.push(bytes);
    }
    if (signal?.aborted) throw cancelled();
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    if (error instanceof AppError) throw error;
    throw new AppError(2, `Cannot read JSON: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
