# Felt design tokens
Design tokens for the Felt design system

## Export Figma variables as DTCG JSON

Requires Node.js 18 or newer and access to Figma's Variables REST API (an Enterprise organization member with file view access and the `file_variables:read` scope). The exporter uses Figma's local variables REST endpoint and writes one DTCG-style JSON file per local collection and mode. Set `FIGMA_TOKEN` and `FIGMA_FILE_KEY` in your environment (the key is the identifier in the Figma file URL), then run:

```sh
node bin/figma-variables-to-dtcg.mjs --output "./tokens/figma"
```

Alternatively, pass credentials explicitly (the token may be visible in your shell history or process list; environment variables are preferred):

```sh
node bin/figma-variables-to-dtcg.mjs \
  --file "$FIGMA_FILE_KEY" \
  --token "$FIGMA_TOKEN" \
  --output "./tokens/figma"
```

Only file-local collections are exported; remote library collections and `Figma-only` are excluded. Every mode is exported by default. Use `--mode MODE_NAME` (or a mode ID) to export only matching modes, and `--token-type oauth` for an OAuth access token. The files retain Figma metadata for traceability; JSON key order is not significant.

Figma float variables representing lengths (spacing, radius, stroke width, size, font size, and effect measurements) export as DTCG `dimension` values in pixels. Opacity, font weight, z-index, and proportional line heights remain unitless `number` tokens; explicitly named `figma-only` line-height measurements export in pixels. The exporter interprets duration numbers as seconds and outputs milliseconds (verify this assumption against your Figma source). Cubic Bézier easing values export as DTCG `cubicBezier` arrays. Figma's REST API documents only `BOOLEAN`, `COLOR`, `FLOAT`, and `STRING` as `resolvedType` values, so the exporter explicitly interprets the `felt/duration/*`, `felt/motion/duration/*`, `felt/easing/*`, and `felt/motion/easing/*` families as duration and easing tokens; other families need their own mapping. This changes the shape of these tokens compared with older exports, so update downstream Style Dictionary transforms accordingly.

The exporter validates names and references and fails on duplicate token paths. Requests time out after 15 seconds and retry transient failures up to twice, honoring `Retry-After` (capped at 30 seconds per attempt). Successful exports stage files before updating the output. A `.figma-variables-export.json` manifest records exporter-managed files: subsequent full exports prune obsolete managed files, while `--mode` exports leave other modes in place. Files that existed before the first manifest are not pruned automatically; unrelated files are never pruned.

For composed colors in extended collections, `$value` resolves the selected mode and its overrides, as displayed in Figma. Figma's native JSON export can instead serialize the base collection's default-mode color while retaining the selected mode's `com.figma.composedColor` metadata; those `$value` fields will therefore differ from the native export. A missing mode value, unresolved alias, or circular token reference fails the export instead of producing incomplete tokens.

Run the exporter tests with:

```sh
node --test test/*.test.mjs
```
