# Felt design tokens

Design tokens for the Felt design system. The source files are DTCG-formatted
JSON exports from Figma, and the build uses [Style Dictionary](https://styledictionary.com/)
to generate layered CSS custom properties.

## Setup

Install dependencies with npm:

```sh
npm ci
```

## Build

Generate the CSS files with:

```sh
npm run build
```

Wireit splits the build into cached internal tasks. The build checks
TypeScript, compiles the pipeline, cleans stale `dist/` output, and generates
the CSS outputs in dependency order.

The build reads only the JSON files in `src/` and writes generated files to
`dist/css/`. The `dist/` directory is ignored by git and can be safely
removed and regenerated at any time.

Each build starts by cleaning the existing `dist/` directory, so generated
files removed or renamed from the pipeline cannot remain stale.

## Source files

```text
src/
├── primitives.tokens.json       # Raw values such as colors, spacing, and type
├── semantic.light.tokens.json   # Semantic values for light mode
└── semantic.dark.tokens.json    # Semantic values for dark mode
```

Figma aliases are preserved when possible. The build understands direct DTCG
references, Figma `aliasData`, and Figma composed-color aliases.

## Generated CSS

```text
dist/css/
├── global.css             # Primitive, semantic, and scheme layers
└── primitive.css          # @layer primitive
```

Use `global.css` when the application needs the complete token set:

```css
@import "./dist/css/global.css";
```

The generated layers are ordered as follows:

```css
@layer primitive, semantic.light, semantic.dark, scheme;
```

## Using primitive tokens

Primitive tokens are available as `--felt-*` custom properties:

```css
.card {
  border-radius: var(--felt-border-radius-20);
  border-width: var(--felt-border-width-10);
  background: var(--felt-color-gray-10);
}
```

When a semantic token aliases a primitive token, the temporary scheme
declarations preserve that relationship and include the resolved value as a
fallback. The declarations written to `global.css` omit the fallback:

```css
--felt-color-brand-primary-on-dark: var(--felt-color-red-50, #ee0000);
```

## Using light and dark schemes

Scheme-specific tokens use `-on-light` and `-on-dark` suffixes:

```css
--felt-color-fill-disabled-on-light: var(--felt-color-gray-30, #c7c7c7);
--felt-color-fill-disabled-on-dark: var(--felt-color-gray-40, #a3a3a3);
```

The `scheme` layer exposes the unsuffixed token through `light-dark()`:

```css
--felt-color-fill-disabled: light-dark(
  var(--felt-color-fill-disabled-on-light),
  var(--felt-color-fill-disabled-on-dark)
);
```

The consuming application controls which scheme is active by setting
`color-scheme`. For example:

```css
:root {
  color-scheme: light dark;
}

[data-theme="light"] {
  color-scheme: light;
}

[data-theme="dark"] {
  color-scheme: dark;
}

.button {
  background: var(--felt-color-fill-interactive-default);
  color: var(--felt-color-text-default);
}
```

## Build pipeline

The build entrypoint is `sd.config.js`. Pipeline responsibilities are split
into:

```text
pipeline/
├── formats.ts               # Layered CSS formatting and alias preservation
├── shared.ts                # Source file configuration
└── css/
    ├── primitive.ts         # Primitive layer
    ├── semantic.ts          # Light and dark scheme layers
    └── post-process.ts      # Combines temporary scheme layers into global.css
```

The JavaScript files generated beside these TypeScript sources are build
artifacts and should not be edited directly.

Generated CSS should not be edited directly. Make source changes in `src/`
and run `npm run build` again.
