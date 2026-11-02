# Felt design tokens

Design tokens for the Felt design system. The source is the DTCG-formatted Figma
export in `tokens/figma/`; the build generates layered CSS custom properties from it.

## Setup

```sh
npm ci
```

## Build

```sh
npm run build
```

Wireit type-checks and compiles the pipeline, then generates the CSS. A build starts by
removing `dist/css/`, so removed or renamed tokens cannot leave stale output.

## Source layout

The Figma export is kept verbatim: one folder per collection, one file per source mode.

```text
tokens/figma/
├── Primitives/Value.tokens.json
├── Semantic colors/{Light,Dark}.tokens.json
├── Semantic units/{Default,Compact,Spacious}.tokens.json
├── Semantic motion/Mode 1.tokens.json
├── High contrast colors/{Light,Dark}.tokens.json
├── Glass colors/{Light,Dark}.tokens.json
└── High contrast units/{Default,Compact,Spacious}.tokens.json
```

`tokens.config.yaml` decides which collections are built and how. A collection with one
file needs no selector. Unit collections name their source files by `density` (or
`densities`); other roles use `source` (or `sources`). Light/Dark scheme pairs are
discovered automatically for `role: color`.

```yaml
base:
  - name: Primitives
    role: primitive
  - name: Semantic motion
    role: motion
  - name: Semantic colors
    role: color
  - name: Semantic units
    role: unit
    density: Default

modes:
  - name: glass
    collections:
      - name: Glass colors
        role: color
  - name: high-contrast
    collections:
      - name: High contrast colors
        role: color
      - name: High contrast units
        role: unit
        densities: [Default, Compact, Spacious]

densities:
  - name: compact
    collection: Semantic units
    density: Compact
  - name: spacious
    collection: Semantic units
    density: Spacious
```

## Generated CSS

```text
dist/css/
├── global.css                 base package (primitives + semantics + schemes)
├── modes/
│   ├── glass.css
│   ├── glass-namespaced.css
│   ├── high-contrast.css
│   └── high-contrast-namespaced.css
└── density/
    ├── compact.css
    ├── compact-namespaced.css
    ├── spacious.css
    └── spacious-namespaced.css
```

Load `global.css` first. Modes and densities only override base tokens, so they depend
on it:

```css
@import "./dist/css/global.css";
@import "./dist/css/modes/glass.css";
@import "./dist/css/density/compact.css";
```

`global.css` declares the top-level cascade-layer order; mode and density files only
declare their own layer. Load `global.css` first so that order is established. The
`semantic.*` sublayers (`unit`, `motion`, `light`, `dark`) are created inside `semantic`
by `global.css`.

```css
@layer primitive, semantic, scheme, density, mode;
```

Unit tokens are grouped into sublayers by category:
`semantic.border-radius`, `semantic.border-width`, `semantic.font-size`,
`semantic.space-fixed`, and so on. Primitives are grouped one level deep:
`primitive.color`, `primitive.border`, `primitive.font`, `primitive.space`,
`primitive.effect`, `primitive.glyph`, `primitive.layout`, `primitive.opacity`,
`primitive.duration`, `primitive.easing`.

## Schemes, modes, and densities

These are independent axes:

| Axis | Values | Attribute |
|---|---|---|
| Scheme | light / dark | `color-scheme` |
| Mode | glass / high-contrast | `data-felt-mode` |
| Density | default / compact / spacious | `data-felt-density` |

Modes are mutually exclusive; density composes with either.

```css
:root {
  color-scheme: light dark;
}
```

```html
<html data-felt-mode="glass" data-felt-density="compact">
```

Each mode and density also has a `-namespaced` file. Those files declare
plane-namespaced properties (`--felt-mode-*`, `--felt-density-*`) instead of overriding
the base names, so consumers opt in explicitly and can compose them.

## Token values are references

Primitives are the only tokens with literal values. Semantic and mode tokens are
`var()` chains that end at a primitive, so changing a primitive updates everything that
depends on it. There are no fallback values in the generated CSS.

```css
--felt-color-surface-primary: light-dark(
  var(--felt-color-surface-primary-on-light),
  var(--felt-color-surface-primary-on-dark)
);
--felt-color-surface-primary-on-light: var(--felt-color-white);
```

Translucent tokens are composed from a color and an opacity primitive:

```css
--felt-color-fill-interactive-subtle-hover-on-light:
  color-mix(
    in srgb,
    var(--felt-color-gray-30) calc(var(--felt-opacity-25) * 1%),
    transparent
  );
```

## Using tokens

```css
.card {
  border-radius: var(--felt-border-radius-md);
  border-width: var(--felt-border-width-thin);
  background: var(--felt-color-surface-primary);
  color: var(--felt-color-text-primary);
  padding: var(--felt-space-fixed-md);
}
```

Primitive tokens remain available as `--felt-*` custom properties. Unit tokens use
semantic names such as `--felt-space-fixed-md`, `--felt-font-size-body-md`, and
`--felt-icon-size-md`.

## Data notes

- **Composed `$value`.** The build resolves `com.figma.composedColor` rather than `$value`
  for composed colors. Extended collections previously materialized `$value` from the
  Light mode; the current export is consistent, so the drift check reports zero. Any
  future divergence still prints a warning.
- **Cubic bezier values** arrive as DTCG arrays and are emitted as `cubic-bezier(…)`.
- **`figma-only` tokens** are excluded from CSS.
- **`$root` tokens** such as `felt.border.width.interactive.focus` are emitted with the
  group path as their name (`--felt-border-width-interactive-focus`).

## Build pipeline

```text
pipeline/
├── config.ts                # YAML config loading and validation
├── tokens.ts                # parsing, reference resolution, drift warnings
├── formats.ts               # Style Dictionary format and name transform
└── css/
    ├── base.ts              # base layers from collection/source files
    ├── variants.ts          # mode and density emitters
    └── post-process.ts      # global.css and layer composition
```

`sd.config.js` orchestrates the build. Generated CSS should not be edited directly;
update the Figma export or `tokens.config.yaml` and rebuild.
