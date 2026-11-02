import { readFileSync } from 'node:fs';
import type { ResolvedConfig } from './config.js';

export type FigmaToken = {
  $type?: string;
  $value: unknown;
  $description?: string;
  $extensions?: Record<string, any>;
};

export type Token = {
  key: string;
  path: string[];
  token: FigmaToken;
  file: string;
  line: number;
  collection: string;
  mode: string;
  isPrimitive: boolean;
};

export type CollectionMode = {
  collection: string;
  mode: string;
  file: string;
  tokens: Token[];
  byPath: Map<string, Token>;
};

export type TokenIndex = {
  collections: Map<string, CollectionMode>;
  primitive?: CollectionMode;
  knownPaths: Set<string>;
  warnings: string[];
};

const lengthCategories = [
  'border/radius',
  'border/width',
  'effect/blur',
  'effect/size',
  'glyph/size',
  'font/size',
  'icon/size',
  'text-decoration',
  'space',
];

const fontStacks: Record<string, string> = {
  'Red Hat Display': '"Red Hat Display", Arial, Helvetica, sans-serif',
  'Red Hat Text': '"Red Hat Text", Arial, Helvetica, sans-serif',
  'Red Hat Mono': '"Red Hat Mono", "Lucida Console", "Courier New", monospace',
};

export const collectionKey = (collection: string, mode: string): string =>
  `${collection}\u0000${mode}`;

export const tokenKey = (path: string[]): string => path.join('.');

export const toPath = (variableName: string): string[] => variableName.split('/');

/**
 * Converts a token path to its CSS custom-property name.
 * @param path - Token path segments.
 * @returns A kebab-case name without the trailing `$root` marker.
 */
export function cssName(path: string[]): string {
  const segments = path.at(-1) === '$root' ? path.slice(0, -1) : path;
  return segments
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export const isFigmaOnly = (path: string[]): boolean => path.includes('figma-only');

const isObject = (value: unknown): value is Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Builds a path -> line map by walking the pretty-printed JSON.
 * @param text - Raw file contents.
 * @returns Map of raw token paths (including `$root`) to `$value` line numbers.
 */
function lineMap(text: string): Map<string, number> {
  const lines = text.split('\n');
  const stack: { indent: number; key: string }[] = [];
  const map = new Map<string, number>();
  const currentPath = (): string => {
    const keys: string[] = [];
    for (const entry of stack) {
      if (entry.key.startsWith('$') && entry.key !== '$root') break;
      keys.push(entry.key);
    }
    return keys.join('.');
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const close = line.match(/^(\s*)\}\s*,?\s*$/);
    if (close) {
      const indent = close[1].length;
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
      continue;
    }
    const match = line.match(/^(\s*)"([^"]+)":\s*(.*)$/);
    if (!match) continue;
    const [, whitespace, key, rest] = match;
    if (key === '$value') map.set(currentPath(), index + 1);
    if (rest.startsWith('{')) stack.push({ indent: whitespace.length, key });
  }
  return map;
}

/**
 * Flattens a DTCG document into tokens, including group-level `$root` tokens.
 * @param node - Current JSON object.
 * @param path - Logical token path.
 * @param rawPath - Path including `$root`, used for line lookup.
 * @param file - Source file.
 * @param lines - Path -> line map.
 * @param collection - Collection name.
 * @param mode - Mode name.
 * @param tokens - Output array.
 */
function walk(
  node: Record<string, any>,
  path: string[],
  rawPath: string[],
  file: string,
  lines: Map<string, number>,
  collection: string,
  mode: string,
  isPrimitive: boolean,
  tokens: Token[],
): void {
  for (const key of Object.keys(node)) {
    if (key === '$root') {
      const token = node.$root as FigmaToken;
      if (token && typeof token === 'object' && token.$value !== undefined) {
        tokens.push({
          key: tokenKey(path),
          path,
          token,
          file,
          line: lines.get([...rawPath, '$root'].join('.')) ?? 0,
          collection,
          mode,
          isPrimitive,
        });
      }
      continue;
    }
    if (key.startsWith('$')) continue;

    const child = node[key];
    if (!isObject(child)) continue;
    const nextPath = [...path, key];
    if (child.$value !== undefined) {
      tokens.push({
        key: tokenKey(nextPath),
        path: nextPath,
        token: child as FigmaToken,
        file,
        line: lines.get([...rawPath, key].join('.')) ?? 0,
        collection,
        mode,
        isPrimitive,
      });
    } else {
      walk(
        child,
        nextPath,
        [...rawPath, key],
        file,
        lines,
        collection,
        mode,
        isPrimitive,
        tokens,
      );
    }
  }
}

/**
 * Reads one exported collection/mode file.
 * @param collection - Collection name.
 * @param mode - Mode entry.
 * @returns Parsed tokens for the file.
 */
function readCollectionMode(
  collection: string,
  mode: { name: string; file: string },
  isPrimitive: boolean,
): CollectionMode {
  const text = readFileSync(mode.file, 'utf8');
  const document = JSON.parse(text) as Record<string, any>;
  const tokens: Token[] = [];
  walk(document, [], [], mode.file, lineMap(text), collection, mode.name, isPrimitive, tokens);
  const byPath = new Map(tokens.map((token) => [token.key, token]));
  return { collection, mode: mode.name, file: mode.file, tokens, byPath };
}

/**
 * Parses every collection/mode referenced by the config.
 * @param config - Resolved build configuration.
 * @returns Indexed tokens plus validation warnings.
 */
export function buildIndex(config: ResolvedConfig): TokenIndex {
  const collections = new Map<string, CollectionMode>();
  const knownPaths = new Set<string>();

  const add = (
    collection: string,
    mode: { name: string; file: string },
    isPrimitive: boolean,
  ): void => {
    const parsed = readCollectionMode(collection, mode, isPrimitive);
    collections.set(collectionKey(collection, mode.name), parsed);
    for (const token of parsed.tokens) knownPaths.add(token.key);
  };

  for (const entry of config.base) {
    for (const source of entry.sources) add(entry.name, source, entry.role === 'primitive');
  }
  for (const mode of config.modes) {
    for (const entry of mode.collections) {
      for (const source of entry.sources) add(entry.name, source, false);
    }
  }
  for (const density of config.densities) {
    add(density.collection, density.source, false);
  }

  const primitiveCollection = config.base.find((entry) => entry.role === 'primitive');
  const primitive = primitiveCollection
    ? collections.get(
        collectionKey(primitiveCollection.name, primitiveCollection.sources[0].name),
      )
    : undefined;
  const index: TokenIndex = { collections, primitive, knownPaths, warnings: [] };
  index.warnings = composedWarnings(index);
  return index;
}

/**
 * Returns a token by collection, mode, and logical path.
 * @param index - Token index.
 * @param collection - Collection name.
 * @param mode - Mode name.
 * @param path - Logical token path.
 * @returns The token, falling back to the primitive collection.
 */
export function findToken(
  index: TokenIndex,
  collection: string,
  mode: string,
  path: string[],
): Token | undefined {
  const scoped = index.collections.get(collectionKey(collection, mode));
  return scoped?.byPath.get(tokenKey(path)) ?? index.primitive?.byPath.get(tokenKey(path));
}

const composed = (token: FigmaToken): Record<string, any> | undefined =>
  token.$extensions?.['com.figma.composedColor'];

const aliasTarget = (token: FigmaToken): string | undefined => {
  const alias = token.$extensions?.['com.figma.aliasData'];
  return typeof alias?.targetVariableName === 'string' ? alias.targetVariableName : undefined;
};

const dtcgReference = (token: FigmaToken): string | undefined => {
  const value = token.$value;
  return typeof value === 'string' && /^\{.+\}$/.test(value) ? value.slice(1, -1) : undefined;
};

const isColor = (token: FigmaToken): boolean =>
  token.$type === 'color' || (isObject(token.$value) && 'hex' in token.$value);

/**
 * Compares composed args with the materialized `$value` for every composed
 * token. Mismatches are expected in extended collections and are reported as
 * warnings so the export drift stays visible.
 * @param index - Token index.
 * @returns Warning strings.
 */
function composedWarnings(index: TokenIndex): string[] {
  const warnings: string[] = [];

  const resolveColor = (
    collection: string,
    mode: string,
    path: string[],
    seen: Set<string> = new Set(),
  ): { hex: string; alpha: number } | undefined => {
    const key = `${collection}\u0000${mode}\u0000${tokenKey(path)}`;
    if (seen.has(key)) return undefined;
    seen.add(key);

    const token = findToken(index, collection, mode, path);
    if (!token) return undefined;
    const composition = composed(token.token);
    if (composition) {
      const colorArg = composition.colorArg;
      const colorPath =
        colorArg?.type === 'alias' ? toPath(colorArg.alias.targetVariableName) : undefined;
      if (!colorPath) return undefined;
      const color = resolveColor(collection, mode, colorPath, seen);
      if (!color) return undefined;
      const opacityArg = composition.opacityArg;
      const opacity =
        opacityArg?.type === 'alias'
          ? Number(
              findToken(index, collection, mode, toPath(opacityArg.alias.targetVariableName))
                ?.token.$value,
            )
          : Number(opacityArg?.value);
      if (!Number.isFinite(opacity)) return undefined;
      return { hex: color.hex, alpha: Math.round(opacity) / 100 };
    }

    const reference = dtcgReference(token.token);
    if (reference) return resolveColor(collection, mode, toPath(reference), seen);

    const alias = aliasTarget(token.token);
    if (alias) return resolveColor(collection, mode, toPath(alias), seen);

    if (isObject(token.token.$value) && 'hex' in token.token.$value) {
      return {
        hex: String(token.token.$value.hex).toLowerCase(),
        alpha: Math.round(Number(token.token.$value.alpha ?? 1) * 100) / 100,
      };
    }
    return undefined;
  };

  for (const entry of index.collections.values()) {
    for (const token of entry.tokens) {
      const composition = composed(token.token);
      if (!composition) continue;
      const colorArg = composition.colorArg;
      if (colorArg?.type !== 'alias') continue;
      const colorPath = toPath(colorArg.alias.targetVariableName);
      const color = resolveColor(entry.collection, entry.mode, colorPath);
      if (!color) continue;
      const opacityArg = composition.opacityArg;
      const opacity =
        opacityArg?.type === 'alias'
          ? Number(
              findToken(
                index,
                entry.collection,
                entry.mode,
                toPath(opacityArg.alias.targetVariableName),
              )?.token.$value,
            )
          : Number(opacityArg?.value);
      if (!Number.isFinite(opacity)) continue;

      const materialized = token.token.$value;
      if (!isObject(materialized) || !('hex' in materialized)) continue;
      const expected = `${color.hex.toLowerCase()}@${Math.round(opacity) / 100}`;
      const actual = `${String(materialized.hex).toLowerCase()}@${Math.round(Number(materialized.alpha ?? 1) * 100) / 100}`;
      if (expected !== actual) {
        warnings.push(
          `${token.file}:${token.line} ${token.key}: composedColor resolves to ${expected}, $value is ${actual}`,
        );
      }
    }
  }
  return warnings;
}

/**
 * Whether a path should receive a `px` suffix.
 * @param path - Token path without `$root`.
 * @returns True for CSS length categories.
 */
export function hasPixelUnit(path: string[]): boolean {
  const category = path.slice(1, -1).join('/');
  return lengthCategories.some((entry) => category === entry || category.startsWith(`${entry}/`));
}

/**
 * Formats a primitive/literal value as CSS.
 * @param path - Token path.
 * @param value - Raw DTCG value.
 * @returns CSS text.
 */
export function rawValue(path: string[], value: unknown, type?: string): string {
  if (typeof value === 'string') {
    if (path.join('/').includes('/font/family/')) return fontStacks[value] ?? value;
    return value;
  }
  if (typeof value === 'number') return `${value}${hasPixelUnit(path) ? 'px' : ''}`;
  if (Array.isArray(value)) {
    if (type !== 'cubicBezier') {
      throw new Error(`${path.join('.')}: unsupported array value`);
    }
    if (value.length !== 4 || !value.every((entry) => typeof entry === 'number')) {
      throw new Error(`${path.join('.')}: cubicBezier needs four numbers`);
    }
    return `cubic-bezier(${value.join(', ')})`;
  }
  if (isObject(value) && 'hex' in value) {
    const hex = String(value.hex);
    const alpha = Number(value.alpha ?? 1);
    if (alpha >= 1) return hex;
    if (Array.isArray(value.components) && value.components.length >= 3) {
      const [red, green, blue] = value.components.map((component: number) =>
        Math.round(Number(component) * 255),
      );
      return `rgb(${red} ${green} ${blue} / ${Math.round(alpha * 100) / 100})`;
    }
    return hex;
  }
  if (isObject(value) && 'value' in value && 'unit' in value) {
    return `${value.value}${value.unit}`;
  }
  return JSON.stringify(value) ?? '';
}

const referenceName = (token: Token, index: TokenIndex, reference: string): string => {
  const path = toPath(reference);
  if (!index.knownPaths.has(tokenKey(path))) {
    throw new Error(`${token.file}:${token.line} ${token.key}: unknown reference "${reference}"`);
  }
  return `var(--${cssName(path)})`;
};

/**
 * Resolves a token to CSS using references only. Primitives emit raw values;
 * every semantic token must terminate at a primitive.
 * @param token - Indexed token.
 * @param index - Token index.
 * @returns CSS value text.
 */
export function cssValue(token: Token, index: TokenIndex): string {
  if (token.isPrimitive) return rawValue(token.path, token.token.$value, token.token.$type);

  const composition = composed(token.token);
  if (composition) {
    const colorArg = composition.colorArg;
    if (colorArg?.type !== 'alias') {
      throw new Error(
        `${token.file}:${token.line} ${token.key}: composedColor colorArg must be an alias`,
      );
    }
    const colorRef = referenceName(token, index, colorArg.alias.targetVariableName);
    const opacityArg = composition.opacityArg;
    if (opacityArg?.type === 'alias') {
      const opacityRef = referenceName(token, index, opacityArg.alias.targetVariableName);
      return `color-mix(in srgb, ${colorRef} calc(${opacityRef} * 1%), transparent)`;
    }
    const opacity = Number(opacityArg?.value);
    if (!Number.isFinite(opacity)) {
      throw new Error(`${token.file}:${token.line} ${token.key}: invalid opacityArg`);
    }
    if (Math.round(opacity) === 100) return colorRef;
    return `color-mix(in srgb, ${colorRef} ${opacity}%, transparent)`;
  }

  const reference = dtcgReference(token.token);
  if (reference) return referenceName(token, index, reference);

  const alias = aliasTarget(token.token);
  if (alias) return referenceName(token, index, alias);

  if (isColor(token.token)) {
    throw new Error(
      `${token.file}:${token.line} ${token.key}: color token has no reference to a primitive`,
    );
  }

  return rawValue(token.path, token.token.$value, token.token.$type);
}

/**
 * Builds a comparison signature for a token, used to diff density modes.
 * @param token - Indexed token.
 * @returns Stable string signature.
 */
export function tokenSignature(token: Token): string {
  const composition = composed(token.token);
  if (composition) {
    const color = composition.colorArg?.alias?.targetVariableName ?? '';
    const opacity =
      composition.opacityArg?.alias?.targetVariableName ??
      String(composition.opacityArg?.value ?? '');
    return `composed:${color}:${opacity}`;
  }
  const reference = dtcgReference(token.token);
  if (reference) return `ref:${reference}`;
  const alias = aliasTarget(token.token);
  if (alias) return `alias:${alias}`;
  return `value:${JSON.stringify(token.token.$value)}`;
}
