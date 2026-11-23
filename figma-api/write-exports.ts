import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { NativeTokenExport } from './figma-to-dtcg.js';

const MANIFEST = '.figma-variables-export.json';

type Manifest = { files: string[] };

type WriteOptions = { partial?: boolean };

function safeName(value: string): string {
  return value.replace(/[\\/]/g, '-').replace(/^\.+$/, '_');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

export async function writeNativeExports(
  files: NativeTokenExport[],
  outputDirectory: string,
  { partial = false }: WriteOptions = {}
): Promise<string> {
  const root = path.resolve(outputDirectory);
  const destinations = new Map<string, string>();
  const destinationKeys = new Map<string, string>();
  for (const file of files) {
    const relative = path.join(safeName(file.collectionName), `${safeName(file.modeName)}.tokens.json`);
    // Compare case- and Unicode-normalized paths so names that differ only by
    // case or normalization cannot silently overwrite each other on
    // case-insensitive filesystems (macOS, Windows).
    const key = relative.normalize('NFC').toLowerCase();
    const existing = destinationKeys.get(key);
    if (existing !== undefined) {
      throw new Error(`Multiple modes map to the same output file: ${existing} and ${relative}`);
    }
    destinationKeys.set(key, relative);
    destinations.set(relative, JSON.stringify(file.tokens, null, 2));
  }

  await mkdir(path.dirname(root), { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(root), '.figma-export-'));
  const manifestPath = path.join(root, MANIFEST);
  try {
    let previous: string[] = [];
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
      previous = manifest.files;
      if (!Array.isArray(previous) || previous.some((entry) =>
        typeof entry !== 'string' || path.isAbsolute(entry) || entry.split(path.sep).some((part) => !part || part === '..')
        || !entry.endsWith('.tokens.json')
      )) throw new Error(`Invalid export manifest at ${manifestPath}`);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    }

    const obsolete = partial ? [] : previous.filter((entry) => !destinations.has(entry));
    const current = partial ? [...new Set([...previous, ...destinations.keys()])] : [...destinations.keys()];
    // Remove obsolete files before writing new ones so a case-only rename cannot
    // delete a file that was just written on a case-insensitive filesystem.
    const changes = [...new Set([...obsolete, ...destinations.keys(), MANIFEST])];
    for (const [relative, contents] of destinations) {
      const staged = path.join(staging, 'new', relative);
      await mkdir(path.dirname(staged), { recursive: true });
      await writeFile(staged, contents, 'utf8');
    }
    await writeFile(path.join(staging, MANIFEST), JSON.stringify({ files: [...current].sort() }, null, 2) + '\n', 'utf8');

    const existing = new Set<string>();
    for (const relative of changes) {
      const destination = path.join(root, relative);
      try {
        if (!(await stat(destination)).isFile()) throw new Error(`Not a file: ${destination}`);
        existing.add(relative);
        const backup = path.join(staging, 'backup', relative);
        await mkdir(path.dirname(backup), { recursive: true });
        await copyFile(destination, backup);
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
      }
    }

    const changed: string[] = [];
    try {
      await mkdir(root, { recursive: true });
      for (const relative of changes) {
        const destination = path.join(root, relative);
        if (relative === MANIFEST || destinations.has(relative)) {
          await mkdir(path.dirname(destination), { recursive: true });
          await rename(path.join(staging, relative === MANIFEST ? MANIFEST : path.join('new', relative)), destination);
        } else {
          await rm(destination, { force: true });
        }
        changed.push(relative);
      }
    } catch (error) {
      for (const relative of changed.reverse()) {
        const destination = path.join(root, relative);
        if (existing.has(relative)) await copyFile(path.join(staging, 'backup', relative), destination);
        else await rm(destination, { force: true });
      }
      throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return root;
}
