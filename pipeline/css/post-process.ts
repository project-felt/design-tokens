import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Combines the generated primitive and scheme layers into scheme.css and the
 * complete global.css entrypoint, adding unsuffixed light-dark() tokens.
 */

const header = '/**\n * Do not edit directly, this file was auto-generated.\n */\n\n';

/**
 * Reads a generated CSS file as UTF-8 text.
 * @param file - Path to the generated CSS file.
 * @returns The file contents.
 */
const read = (file: string): string => readFileSync(file, 'utf8');

/**
 * Removes the auto-generated comment from a CSS fragment before composition.
 * @param content - Generated CSS content.
 * @returns CSS content without the generated header.
 */
const stripHeader = (content: string): string => content.replace(/\/\*\*[\s\S]*?\*\/\n\n/, '');

/**
 * Removes fallback values from CSS variable references for global output.
 * @param content - CSS containing variable references with optional fallbacks.
 * @returns CSS with `var(--name, fallback)` reduced to `var(--name)`.
 */
const stripVariableFallbacks = (content: string): string =>
  content.replace(/var\((--[^,()]+),\s*(?:[^()]|\([^()]*\))*\)/g, 'var($1)');

type Declaration = { name: string; value: string };

/**
 * Extracts CSS custom-property declarations from generated CSS.
 * @param content - CSS containing custom-property declarations.
 * @returns Parsed custom-property names and values.
 */
function declarations(content: string): Declaration[] {
  // Extract each indented CSS custom-property declaration: --name: value;
  return [...content.matchAll(/^\s+--([^:]+):\s*(.+);$/gm)].map(([, name, value]) => ({
    name,
    value,
  }));
}

/**
 * Creates the scheme layer that maps each base token to its light and dark
 * scheme-specific variables through `light-dark()`.
 * @param light - Header-free light scheme CSS.
 * @param dark - Header-free dark scheme CSS.
 * @returns The generated `@layer scheme` CSS block.
 */
function schemeLayer(light: string, dark: string): string {
  const darkByBase = new Map(
    declarations(dark).map(({ name, value }) => [name.replace(/-on-dark$/, ''), { name, value }]),
  );
  const vars = declarations(light)
    .map(({ name }) => {
      const base = name.replace(/-on-light$/, '');
      const darkToken = darkByBase.get(base);
      if (!darkToken) return null;
      return `    --${base}: light-dark(var(--${name}), var(--${darkToken.name}));`;
    })
    .filter((value): value is string => value !== null);

  return `@layer scheme {\n  :root {\n${vars.join('\n')}\n  }\n}\n`;
}

/**
 * Combines generated layers into the standalone scheme and global CSS files.
 * @returns Nothing. Writes generated files to `dist/css/`.
 */
export function postProcess(): void {
  const primitive = stripHeader(read('./dist/css/primitive.css'));
  const light = stripHeader(read('./dist/css/scheme/light.css'));
  const dark = stripHeader(read('./dist/css/scheme/dark.css'));
  const scheme = schemeLayer(light, dark);
  const combined = `${header}@layer semantic.light, semantic.dark, scheme;\n\n${light}\n${dark}\n${scheme}`;
  const combinedForGlobal = `${stripVariableFallbacks(light)}\n${stripVariableFallbacks(dark)}\n${scheme}`;

  writeFileSync('./dist/css/scheme/scheme.css', combined);

  writeFileSync(
    './dist/css/global.css',
    `${header}@layer primitive, semantic.light, semantic.dark, scheme;\n\n${primitive}\n${combinedForGlobal}`,
  );
}
