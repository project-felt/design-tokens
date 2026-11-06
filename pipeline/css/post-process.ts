import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { header, layerOrder } from '../formats.js';

const read = (file: string): string => readFileSync(file, 'utf8');

/**
 * Removes the auto-generated comment from a CSS fragment before composition.
 * @param content - Generated CSS content.
 * @returns CSS content without the generated header.
 */
const stripHeader = (content: string): string =>
  content.replace(/^\/\*\*[\s\S]*?\*\/\n\n/, '').trim();

type Declaration = { name: string; value: string };

/**
 * Extracts CSS custom-property declarations from generated CSS.
 * @param content - CSS containing custom-property declarations.
 * @returns Parsed custom-property names.
 */
function declarations(content: string): Declaration[] {
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
    declarations(dark).map(({ name }) => [name.replace(/-on-dark$/, ''), name]),
  );
  const vars = declarations(light)
    .map(({ name }) => {
      const base = name.replace(/-on-light$/, '');
      const darkName = darkByBase.get(base);
      if (!darkName) return null;
      return `    --${base}: light-dark(var(--${name}), var(--${darkName}));`;
    })
    .filter((value): value is string => value !== null);

  return `@layer scheme {\n  :root {\n${vars.join('\n')}\n  }\n}\n`;
}

/**
 * Combines generated base layers into `global.css`.
 * @returns Nothing. Writes generated files to `dist/css/`.
 */
export function postProcess(): void {
  const primitive = stripHeader(read('./dist/css/.layers/primitive.css'));
  const unit = stripHeader(read('./dist/css/.layers/unit.css'));
  const motion = stripHeader(read('./dist/css/.layers/motion.css'));
  const light = stripHeader(read('./dist/css/.scheme/light.css'));
  const dark = stripHeader(read('./dist/css/.scheme/dark.css'));
  const scheme = schemeLayer(light, dark);

  writeFileSync(
    './dist/css/global.css',
    `${header}\n\n@layer ${layerOrder};\n\n${primitive}\n\n${unit}\n\n${motion}\n\n${light}\n\n${dark}\n\n${scheme}`,
  );

  rmSync('./dist/css/.layers', { recursive: true, force: true });
  rmSync('./dist/css/.scheme', { recursive: true, force: true });
}
