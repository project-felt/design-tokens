import StyleDictionary from 'style-dictionary';
import {
  collectionKey,
  cssName,
  cssValue,
  isFigmaOnly,
  tokenKey,
  type Token,
  type TokenIndex,
} from './tokens.js';

export const header = [
  '/**',
  ' * Do not edit directly, this file was auto-generated.',
  ' */',
].join('\n');

export const layerOrder = 'primitive, semantic, scheme, density, mode';

let index: TokenIndex | undefined;

/**
 * Sets the token index used by the registered formatter.
 * @param value - Parsed token index.
 */
export function setTokenIndex(value: TokenIndex): void {
  index = value;
}

type FormatOptions = {
  layerName: string;
  nameSuffix?: string;
  collection: string;
  mode: string;
  groupBy?: number;
};

type Declaration = { path: string[]; declaration: string };

/**
 * Formats tokens as custom properties inside a named CSS layer. When
 * `groupBy` is set, declarations are split into sublayers named after the
 * first N path segments (for example `semantic.border-radius`).
 * @param args - Style Dictionary formatter arguments.
 * @returns Generated CSS for the configured layer.
 */
function layerFormat({ dictionary, options }: any): string {
  if (!index) throw new Error('Token index has not been initialised');

  const {
    layerName,
    nameSuffix = '',
    collection,
    mode,
    groupBy,
  } = options as FormatOptions;
  const scoped = index.collections.get(collectionKey(collection, mode));

  const entries: Declaration[] = dictionary.allTokens
    .map((token: { path: string[] }): Declaration | null => {
      const path = token.path.map(String).filter((segment) => segment !== '$root');
      if (isFigmaOnly(path)) return null;

      const key = tokenKey(path);
      const raw: Token | undefined = scoped?.byPath.get(key) ?? index?.primitive?.byPath.get(key);
      if (!raw) {
        throw new Error(`No parsed token for ${collection}/${mode} ${key}`);
      }
      return {
        path,
        declaration: `    --${cssName(path)}${nameSuffix}: ${cssValue(raw, index!)};`,
      };
    })
    .filter((entry: Declaration | null): entry is Declaration => entry !== null);

  if (!groupBy) {
    const declarations = entries.map((entry) => entry.declaration).join('\n');
    return `${header}\n\n@layer ${layerName} {\n  :root {\n${declarations}\n  }\n}\n`;
  }

  const groups = new Map<string, string[]>();
  for (const entry of entries) {
    const group = entry.path.slice(1, 1 + groupBy).join('-') || layerName;
    const lines = groups.get(group) ?? [];
    lines.push(entry.declaration);
    groups.set(group, lines);
  }

  const blocks = [...groups.keys()].sort().map((group) => {
    const lines = groups.get(group) ?? [];
    return `@layer ${layerName}.${group} {\n  :root {\n${lines.join('\n')}\n  }\n}`;
  });

  return `${header}\n\n${blocks.join('\n\n')}\n`;
}

StyleDictionary.registerTransform({
  name: 'name/felt',
  type: 'name',
  transform: (token: { path: string[] }) => cssName(token.path.map(String)),
});

StyleDictionary.registerFormat({
  name: 'css/layer',
  format: layerFormat,
});
