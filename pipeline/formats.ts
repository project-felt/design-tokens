import StyleDictionary from 'style-dictionary';

type Token = {
  $value?: unknown;
  $extensions?: Record<string, any>;
  original?: { $value?: unknown };
  name: string;
  path?: string[];
};

type Dictionary = {
  allTokens: Token[];
  unfilteredTokenMap: Map<string, Token>;
};

type FormatOptions = {
  layerName: string;
  nameSuffix?: string;
};

const header = [
  '/**',
  ' * Do not edit directly, this file was auto-generated.',
  ' */',
].join('\n');

const pixelLengthCategories = new Set([
  'border/radius',
  'border/width',
  'effect/blur',
  'effect/size',
  'glyph/size',
  'space',
]);

/**
 * Identifies Figma number tokens whose values represent CSS lengths.
 * @param token - Style Dictionary token being formatted.
 * @returns Whether the numeric value should be suffixed with `px`.
 */
function hasPixelUnit(token: Token): boolean {
  const category = token.path?.slice(1, -1).join('/');
  return category !== undefined && pixelLengthCategories.has(category);
}

/**
 * Converts a DTCG value into a CSS-compatible value string.
 * @param value - Raw DTCG token value.
 * @returns A CSS value, including units or a color hex when available.
 */
function rawCssValue(value: unknown, unit = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return `${value}${unit}`;

  if (
    value &&
    typeof value === 'object' &&
    'value' in value &&
    typeof value.value === 'number' &&
    'unit' in value &&
    typeof value.unit === 'string'
  ) {
    return `${value.value}${value.unit}`;
  }

  if (value && typeof value === 'object' && 'hex' in value && typeof value.hex === 'string') {
    return value.hex;
  }

  return JSON.stringify(value) ?? '';
}

/**
 * Formats a token value, preserving DTCG and Figma aliases as CSS variables.
 * @param token - Style Dictionary token being formatted.
 * @param dictionary - Dictionary used to resolve DTCG references.
 * @returns A CSS value with an optional resolved fallback.
 */
function cssValue(token: Token, dictionary: Dictionary): string {
  const fallback = rawCssValue(token.$value, hasPixelUnit(token) ? 'px' : '');
  const extensions = token.$extensions ?? {};
  const aliasName =
    extensions['com.figma.aliasData']?.targetVariableName ??
    extensions['com.figma.composedColor']?.colorArg?.alias?.targetVariableName;
  if (aliasName) return `var(--${aliasName.replaceAll('/', '-')}, ${fallback})`;

  const reference = token.original?.$value;
  if (typeof reference === 'string' && /^\{.+\}$/.test(reference)) {
    const referencedToken = dictionary.unfilteredTokenMap.get(reference);
    if (referencedToken) return `var(--${referencedToken.name}, ${fallback})`;
  }

  return fallback;
}

/**
 * Formats all tokens as custom properties inside a named CSS layer.
 * @param args - Style Dictionary formatter arguments.
 * @returns Generated CSS for the configured layer.
 */
function layerFormat({ dictionary, options }: any): string {
  const suffix = options.nameSuffix ?? '';
  const vars = dictionary.allTokens
    .map((token: Token) => `    --${token.name}${suffix}: ${cssValue(token, dictionary)};`)
    .join('\n');

  return `${header}\n\n@layer ${options.layerName} {\n  :root {\n${vars}\n  }\n}\n`;
}

StyleDictionary.registerFormat({
  name: 'css/layer',
  format: layerFormat,
});
