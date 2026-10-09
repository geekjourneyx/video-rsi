import { readFile } from 'node:fs/promises';

/** The installed package owns creation and exact-version recovery compatibility. */
export const { version: softwareVersion } = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };
