import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MANIFEST = '.figma-variables-export.json';

function safeName(value) {
  return value.replace(/[\\/]/g, '-').replace(/^\.+$/, '_');
}

export async function writeNativeExports(files, outputDirectory, { partial = false } = {}) {
  const root = path.resolve(outputDirectory);
  const destinations = new Map();
  for (const file of files) {
    const relative = path.join(safeName(file.collectionName), `${safeName(file.modeName)}.tokens.json`);
    if (destinations.has(relative)) throw new Error(`Multiple modes map to the same output file: ${relative}`);
    destinations.set(relative, JSON.stringify(file.tokens, null, 2));
  }

  await mkdir(path.dirname(root), { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(root), '.figma-export-'));
  const manifestPath = path.join(root, MANIFEST);
  try {
    let previous = [];
    try {
      previous = JSON.parse(await readFile(manifestPath, 'utf8')).files;
      if (!Array.isArray(previous) || previous.some((entry) =>
        typeof entry !== 'string' || path.isAbsolute(entry) || entry.split(path.sep).some((part) => !part || part === '..')
        || !entry.endsWith('.tokens.json')
      )) throw new Error(`Invalid export manifest at ${manifestPath}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const obsolete = partial ? [] : previous.filter((entry) => !destinations.has(entry));
    const current = partial ? [...new Set([...previous, ...destinations.keys()])] : [...destinations.keys()];
    const changes = [...new Set([...destinations.keys(), ...obsolete, MANIFEST])];
    for (const [relative, contents] of destinations) {
      const staged = path.join(staging, 'new', relative);
      await mkdir(path.dirname(staged), { recursive: true });
      await writeFile(staged, contents, 'utf8');
    }
    await writeFile(path.join(staging, MANIFEST), JSON.stringify({ files: current }, null, 2) + '\n', 'utf8');

    const existing = new Set();
    for (const relative of changes) {
      const destination = path.join(root, relative);
      try {
        if (!(await stat(destination)).isFile()) throw new Error(`Not a file: ${destination}`);
        existing.add(relative);
        const backup = path.join(staging, 'backup', relative);
        await mkdir(path.dirname(backup), { recursive: true });
        await copyFile(destination, backup);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }

    const changed = [];
    try {
      await mkdir(root, { recursive: true });
      for (const relative of changes) {
        const destination = path.join(root, relative);
        if (relative === MANIFEST || destinations.has(relative)) {
          await mkdir(path.dirname(destination), { recursive: true });
          await rename(path.join(staging, relative === MANIFEST ? MANIFEST : path.join('new', relative)), destination);
        } else {
          await rm(destination);
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
