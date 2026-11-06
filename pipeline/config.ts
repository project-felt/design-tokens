import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export type Role = 'primitive' | 'color' | 'unit' | 'motion';

export type SourceFile = {
  name: string;
  file: string;
  parent?: string;
};

export type ResolvedCollection = {
  name: string;
  role: Role;
  dir: string;
  sources: SourceFile[];
};

export type Mode = {
  name: string;
  collections: ResolvedCollection[];
};

export type Density = {
  name: string;
  collection: string;
  source: SourceFile;
};

export type ResolvedConfig = {
  base: ResolvedCollection[];
  modes: Mode[];
  densities: Density[];
};

export const sourceRoot = 'tokens/figma';

const roles = new Set<Role>(['primitive', 'color', 'unit', 'motion']);
const modeFilePattern = /\.tokens\.json$/;

function fail(message: string): never {
  throw new Error(`tokens.config.yaml: ${message}`);
}

const asObject = (value: unknown, message: string): Record<string, any> => {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, any>;
  }
  return fail(message);
};

const asArray = (value: unknown, message: string): unknown[] => {
  if (Array.isArray(value)) return value;
  return fail(message);
};

const asName = (value: unknown, message: string): string => {
  if (typeof value === 'string' && value.length > 0) return value;
  return fail(message);
};

/**
 * Reads the mode metadata Figma writes at the root of every exported file.
 * @param file - Token file path.
 * @returns The mode name and optional parent collection name.
 */
function readRootMetadata(file: string): { modeName?: string; parent?: string } {
  const root = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
  const extensions = root.$extensions;
  if (typeof extensions !== 'object' || extensions === null) return {};
  return {
    modeName:
      typeof extensions['com.figma.modeName'] === 'string'
        ? extensions['com.figma.modeName']
        : undefined,
    parent:
      typeof extensions['com.figma.parentVariableSetName'] === 'string'
        ? extensions['com.figma.parentVariableSetName']
        : undefined,
  };
}

/**
 * Lists every exported mode file in a collection folder and validates that the
 * filename matches the mode name embedded in the JSON.
 * @param dir - Collection directory.
 * @returns Source entries sorted by filename.
 */
function listSources(dir: string): SourceFile[] {
  const files = readdirSync(dir)
    .filter((file) => modeFilePattern.test(file))
    .sort();

  if (files.length === 0) return fail(`collection "${dir}" has no .tokens.json files`);

  return files.map((file) => {
    const path = join(dir, file);
    const name = file.replace(modeFilePattern, '');
    const metadata = readRootMetadata(path);
    if (!metadata.modeName) return fail(`${path} is missing $extensions.com.figma.modeName`);
    if (metadata.modeName !== name) {
      return fail(
        `${path}: filename "${name}" does not match modeName "${metadata.modeName}"`,
      );
    }
    return { name, file: path, parent: metadata.parent };
  });
}

/**
 * Validates one configured collection and resolves its source files. Unit
 * collections select files by density name; other roles use `source`/`sources`.
 * @param raw - Raw YAML entry.
 * @param where - Human-readable location for error messages.
 * @returns The resolved collection.
 */
function resolveCollection(raw: unknown, where: string): ResolvedCollection {
  const entry = asObject(raw, `${where} must be a mapping`);
  const name = asName(entry.name, `${where}.name is required`);
  const roleValue = entry.role;
  const role: Role =
    typeof roleValue === 'string' && roles.has(roleValue as Role)
      ? (roleValue as Role)
      : fail(`${where}.role must be one of ${[...roles].join(', ')}`);

  if (entry.density !== undefined && entry.source !== undefined) {
    fail(`${where}: use either "density" or "source", not both`);
  }
  if (entry.densities !== undefined && entry.sources !== undefined) {
    fail(`${where}: use either "densities" or "sources", not both`);
  }
  const singleKey =
    entry.density !== undefined ? 'density' : entry.source !== undefined ? 'source' : undefined;
  const listKey =
    entry.densities !== undefined
      ? 'densities'
      : entry.sources !== undefined
        ? 'sources'
        : undefined;
  if (singleKey && listKey) {
    fail(`${where}: use either "${singleKey}" or "${listKey}", not both`);
  }
  const single =
    singleKey === undefined
      ? undefined
      : asName(entry[singleKey], `${where}.${singleKey} must be a non-empty string`);
  const requested =
    listKey === undefined
      ? undefined
      : asArray(entry[listKey], `${where}.${listKey} must be a list`).map((item, index) =>
          asName(item, `${where}.${listKey}[${index}] must be a non-empty string`),
        );
  if (requested && new Set(requested).size !== requested.length) {
    fail(`${where}.${listKey} contains a duplicate entry`);
  }

  const dir = join(sourceRoot, name);
  let directory = false;
  try {
    directory = statSync(dir).isDirectory();
  } catch {
    directory = false;
  }
  if (!directory) return fail(`collection folder "${dir}" does not exist`);

  const allSources = listSources(dir);
  let sources: SourceFile[];

  if (role === 'color') {
    const names = allSources.map((item) => item.name.toLowerCase()).sort();
    if (names.length !== 2 || names[0] !== 'dark' || names[1] !== 'light') {
      return fail(`${where}: role "color" needs exactly the Light and Dark schemes`);
    }
    sources = allSources;
  } else if (requested) {
    sources = requested.map((requestedName) => {
      const selected = allSources.find((item) => item.name === requestedName);
      if (!selected) {
        return fail(
          `${where}.${listKey} "${requestedName}" does not exist in ${dir} (found ${allSources
            .map((item) => item.name)
            .join(', ')})`,
        );
      }
      return selected;
    });
  } else if (single) {
    const selected = allSources.find((item) => item.name === single);
    if (!selected) {
      return fail(
        `${where}.${singleKey} "${single}" does not exist in ${dir} (found ${allSources
          .map((item) => item.name)
          .join(', ')})`,
      );
    }
    sources = [selected];
  } else if (allSources.length === 1) {
    sources = allSources;
  } else {
    return fail(
      `${where}.density is required because "${name}" has ${allSources.length} source files`,
    );
  }

  return { name, role, dir, sources };
}

/**
 * Loads and validates the build configuration.
 * @param configPath - Path to the YAML config.
 * @returns Resolved collections, modes, and densities.
 */
export function loadConfig(configPath = 'tokens.config.yaml'): ResolvedConfig {
  let parsed: unknown;
  try {
    parsed = parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read ${configPath}: ${(error as Error).message}`);
  }
  const document = asObject(parsed, 'expected a mapping at the document root');

  const rawBase = asArray(document.base, '"base" must be a list');
  const base = rawBase.map((entry, index) =>
    resolveCollection(entry, `base[${index}]`),
  );

  const baseNames = new Set(base.map((entry) => entry.name));
  const seen = new Set<string>();
  for (const collection of base) {
    if (seen.has(collection.name)) fail(`duplicate collection "${collection.name}"`);
    seen.add(collection.name);
  }

  const rawModes =
    document.modes === undefined ? [] : asArray(document.modes, '"modes" must be a list');
  const modes: Mode[] = rawModes.map((raw, index) => {
    const entry = asObject(raw, `modes[${index}] must be a mapping`);
    const name = asName(entry.name, `modes[${index}].name is required`);
    const rawCollections = asArray(
      entry.collections,
      `modes[${index}].collections must be a non-empty list`,
    );
    if (rawCollections.length === 0) {
      fail(`modes[${index}].collections must be a non-empty list`);
    }

    const collections = rawCollections.map((collectionRaw, collectionIndex) => {
      const collection = resolveCollection(
        collectionRaw,
        `modes[${index}].collections[${collectionIndex}]`,
      );
      if (seen.has(collection.name)) {
        fail(`collection "${collection.name}" is configured more than once`);
      }
      seen.add(collection.name);

      const parent = collection.sources[0]?.parent;
      if (!parent || !baseNames.has(parent)) {
        fail(
          `mode collection "${collection.name}" must extend a base collection (parentVariableSetName: ${
            parent ?? 'missing'
          })`,
        );
      }
      return collection;
    });

    return { name, collections };
  });

  const baseUnits = new Map(
    base.filter((entry) => entry.role === 'unit').map((entry) => [entry.name, entry]),
  );

  const rawDensities =
    document.densities === undefined
      ? []
      : asArray(document.densities, '"densities" must be a list');
  const densities: Density[] = rawDensities.map((raw, index) => {
    const entry = asObject(raw, `densities[${index}] must be a mapping`);
    const name = asName(entry.name, `densities[${index}].name is required`);
    const collection = asName(
      entry.collection,
      `densities[${index}].collection is required`,
    );
    const sourceName = asName(
      entry.density,
      `densities[${index}].density is required`,
    );

    if (!baseUnits.has(collection)) {
      return fail(
        `densities[${index}].collection must be a base collection with role "unit"`,
      );
    }
    const full = listSources(join(sourceRoot, collection));
    const selected = full.find((item) => item.name === sourceName);
    if (!selected) {
      return fail(
        `densities[${index}].density "${sourceName}" does not exist in ${collection} (found ${full
          .map((item) => item.name)
          .join(', ')})`,
      );
    }
    return { name, collection, source: selected };
  });

  const classified = new Set([
    ...base.map((entry) => entry.name),
    ...modes.flatMap((mode) => mode.collections.map((entry) => entry.name)),
  ]);
  for (const entry of readdirSync(sourceRoot)) {
    const path = join(sourceRoot, entry);
    if (!statSync(path).isDirectory()) continue;
    if (!classified.has(entry)) {
      fail(`Unclassified collection "${entry}" in ${sourceRoot}/`);
    }
  }

  return { base, modes, densities };
}
