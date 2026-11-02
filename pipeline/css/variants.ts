import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Density,
  Mode,
  ResolvedCollection,
  ResolvedConfig,
  SourceFile,
} from '../config.js';
import { header } from '../formats.js';
import {
  collectionKey,
  cssName,
  cssValue,
  findToken,
  isFigmaOnly,
  tokenKey,
  tokenSignature,
  type Token,
  type TokenIndex,
} from '../tokens.js';

const isOverride = (token: Token): boolean =>
  token.token.$extensions?.['com.figma.isOverride'] === true;

/**
 * Writes a public CSS file. Mode and density files contain only their own
 * layer; `global.css` must be loaded first to establish the cascade order.
 * @param path - Path relative to `dist/css/`.
 * @param body - Layer block.
 */
function writeVariant(path: string, body: string): void {
  const destination = `./dist/css/${path}`;
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, `${header}\n\n${body}\n`);
}

/**
 * Resolves a mode token to a primitive reference, falling back to the base
 * collection for source modes where the token is not overridden.
 * @param collection - Mode collection.
 * @param sourceMode - Figma mode within the collection.
 * @param path - Logical token path.
 * @param index - Token index.
 * @returns CSS value.
 */
function modeValue(
  collection: ResolvedCollection,
  sourceMode: SourceFile,
  path: string[],
  index: TokenIndex,
): string {
  const token = findToken(index, collection.name, sourceMode.name, path);
  if (token && isOverride(token)) return cssValue(token, index);

  const parent = sourceMode.parent ?? collection.sources[0]?.parent;
  if (!parent) {
    throw new Error(`Mode collection "${collection.name}" has no parent collection`);
  }
  const base = findToken(index, parent, sourceMode.name, path);
  if (!base) {
    throw new Error(
      `Cannot resolve ${parent}/${sourceMode.name} ${tokenKey(path)} for mode ${collection.name}`,
    );
  }
  return cssValue(base, index);
}

/**
 * Applies an optional namespace to a generated custom-property name. Global
 * variants override base tokens; namespaced variants declare plane-specific
 * properties such as `--felt-density-border-radius-md`.
 * @param name - Base custom-property name.
 * @param namespace - Optional namespace such as `density` or `mode`.
 * @returns The name to emit.
 */
const variantName = (name: string, namespace?: string): string => {
  if (!namespace) return name;
  return name.startsWith('felt-')
    ? `felt-${namespace}-${name.slice('felt-'.length)}`
    : `${namespace}-${name}`;
};

/**
 * Resolves the density name for a mode unit.
 * @param densityByMode - Map of source mode name to density name.
 * @param mode - Mode being built.
 * @param sourceMode - Figma mode within the unit collection.
 * @returns The density selector value.
 */
function densityNameFor(
  densityByMode: Map<string, string>,
  mode: Mode,
  sourceMode: SourceFile,
): string {
  const name = densityByMode.get(sourceMode.name);
  if (!name) {
    throw new Error(
      `Mode "${mode.name}" unit mode "${sourceMode.name}" has no matching density in tokens.config.yaml`,
    );
  }
  return name;
}

/**
 * Builds one mode file from the union of overridden tokens in its source modes.
 * Unit overrides are emitted per source mode; non-default source modes use a
 * compound selector such as
 * `[data-felt-mode="high-contrast"][data-felt-density="compact"]`.
 * @param mode - Mode configuration.
 * @param index - Token index.
 * @param densityByMode - Map of source mode name to density name.
 * @param namespace - Optional namespace for the emitted custom properties.
 * @returns Number of distinct token paths emitted.
 */
function buildMode(
  mode: Mode,
  index: TokenIndex,
  densityByMode: Map<string, string>,
  namespace?: string,
): number {
  const selector = `[data-felt-mode="${mode.name}"]`;
  const blocks = new Map<string, Map<string, string>>();

  const add = (blockSelector: string, name: string, value: string): void => {
    let declarations = blocks.get(blockSelector);
    if (!declarations) {
      declarations = new Map();
      blocks.set(blockSelector, declarations);
    }
    const existing = declarations.get(name);
    if (existing && existing !== value) {
      throw new Error(`Mode "${mode.name}" defines --${name} twice`);
    }
    declarations.set(name, value);
  };

  const overrides = new Map<string, Set<string>>();
  for (const collection of mode.collections) {
    for (const sourceMode of collection.sources) {
      const keys = new Set<string>();
      for (const token of index.collections.get(
        collectionKey(collection.name, sourceMode.name),
      )?.tokens ?? []) {
        if (isFigmaOnly(token.path)) continue;
        if (isOverride(token)) keys.add(token.key);
      }
      overrides.set(collectionKey(collection.name, sourceMode.name), keys);
    }
  }

  const overrideKeys = (
    collection: ResolvedCollection,
    sourceMode: SourceFile,
  ): Set<string> =>
    overrides.get(collectionKey(collection.name, sourceMode.name)) ?? new Set<string>();

  const paths = new Set<string>();

  for (const collection of mode.collections) {
    if (collection.role === 'color') {
      const light = collection.sources.find(
        (sourceMode) => sourceMode.name.toLowerCase() === 'light',
      );
      const dark = collection.sources.find(
        (sourceMode) => sourceMode.name.toLowerCase() === 'dark',
      );
      if (!light || !dark) {
        throw new Error(`Mode color collection "${collection.name}" needs Light and Dark modes`);
      }
      const keys = new Set([
        ...overrideKeys(collection, light),
        ...overrideKeys(collection, dark),
      ]);
      for (const key of keys) {
        paths.add(key);
        const path = key.split('.');
        const scoped = findToken(index, collection.name, light.name, path);
        const darkScoped = findToken(index, collection.name, dark.name, path);
        if (!scoped && !darkScoped) continue;

        const name = cssName(path);
        const onLight = variantName(`${name}-on-light`, namespace);
        const onDark = variantName(`${name}-on-dark`, namespace);
        add(selector, onLight, modeValue(collection, light, path, index));
        add(selector, onDark, modeValue(collection, dark, path, index));
        add(
          selector,
          variantName(name, namespace),
          `light-dark(var(--${onLight}), var(--${onDark}))`,
        );
      }
    } else if (collection.role === 'unit') {
      const defaultMode =
        collection.sources.find((sourceMode) => sourceMode.name.toLowerCase() === 'default') ??
        collection.sources[0];
      if (!defaultMode) {
        throw new Error(`Mode unit collection "${collection.name}" has no modes`);
      }

      for (const sourceMode of collection.sources) {
        const blockSelector =
          sourceMode === defaultMode
            ? selector
            : `${selector}[data-felt-density="${densityNameFor(
                densityByMode,
                mode,
                sourceMode,
              )}"]`;
        for (const key of overrideKeys(collection, sourceMode)) {
          paths.add(key);
          const path = key.split('.');
          if (!findToken(index, collection.name, sourceMode.name, path)) continue;
          add(
            blockSelector,
            variantName(cssName(path), namespace),
            modeValue(collection, sourceMode, path, index),
          );
        }
      }
    }
  }

  const rules = [...blocks].map(([blockSelector, declarations]) => {
    const lines = [...declarations].map(([name, value]) => `    --${name}: ${value};`);
    return `  ${blockSelector} {\n${lines.join('\n')}\n  }`;
  });
  const body = `@layer mode.${mode.name} {\n${rules.join('\n\n')}\n}`;
  writeVariant(`modes/${mode.name}${namespace ? '-namespaced' : ''}.css`, body);
  return paths.size;
}

/**
 * Builds one density file containing only tokens that differ from the base
 * density.
 * @param density - Density configuration.
 * @param baseMode - Base collection mode name.
 * @param index - Token index.
 * @param namespace - Optional namespace for the emitted custom properties.
 * @returns Number of emitted token paths.
 */
function buildDensity(
  density: Density,
  baseMode: string,
  index: TokenIndex,
  namespace?: string,
): number {
  const base = index.collections.get(collectionKey(density.collection, baseMode));
  const mode = index.collections.get(collectionKey(density.collection, density.source.name));
  if (!base || !mode) {
    throw new Error(`Missing tokens for density "${density.name}"`);
  }

  const lines: string[] = [];
  for (const token of mode.tokens) {
    if (isFigmaOnly(token.path)) continue;
    const baseToken = base.byPath.get(token.key);
    if (baseToken && tokenSignature(baseToken) === tokenSignature(token)) continue;
    lines.push(
      `    --${variantName(cssName(token.path), namespace)}: ${cssValue(token, index)};`,
    );
  }

  const selector = `[data-felt-density="${density.name}"]`;
  const body = `@layer density {\n  ${selector} {\n${lines.join('\n')}\n  }\n}`;
  writeVariant(`density/${density.name}${namespace ? '-namespaced' : ''}.css`, body);
  return lines.length;
}

/**
 * Emits all mode and density files.
 * @param config - Resolved build configuration.
 * @param index - Token index.
 * @returns Emitted path counts for logging.
 */
export function emitVariants(
  config: ResolvedConfig,
  index: TokenIndex,
): { modes: Record<string, number>; densities: Record<string, number> } {
  const densityByMode = new Map(
    config.densities.map((density) => [density.source.name, density.name]),
  );

  const modes: Record<string, number> = {};
  for (const mode of config.modes) {
    modes[mode.name] = buildMode(mode, index, densityByMode);
    modes[`${mode.name}-namespaced`] = buildMode(mode, index, densityByMode, 'mode');
  }

  const densities: Record<string, number> = {};
  for (const density of config.densities) {
    const source = config.base.find((entry) => entry.name === density.collection);
    if (!source) throw new Error(`Density source "${density.collection}" is not a base collection`);
    const baseMode = source.sources[0]?.name;
    if (!baseMode) throw new Error(`Density source "${density.collection}" has no base mode`);
    densities[density.name] = buildDensity(density, baseMode, index);
    densities[`${density.name}-namespaced`] = buildDensity(
      density,
      baseMode,
      index,
      'density',
    );
  }

  return { modes, densities };
}
