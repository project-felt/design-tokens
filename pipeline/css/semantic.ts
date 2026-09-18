import StyleDictionary from 'style-dictionary';
import { transformGroups } from 'style-dictionary/enums';
import '../formats.js';

/**
 * Filters a Style Dictionary token to the configured semantic source file.
 * @param token - Token supplied by Style Dictionary during file generation.
 * @param source - Source file that should be retained.
 * @returns Whether the token came from the requested source file.
 */
const isFromSource = (token: { filePath: string }, source: string): boolean =>
  token.filePath === source;

/**
 * Creates a Style Dictionary instance for one semantic color scheme.
 * @param source - Source DTCG JSON file for the scheme.
 * @param destination - CSS output path relative to the CSS build directory.
 * @param layerName - CSS cascade layer name.
 * @param nameSuffix - Suffix appended to each generated custom property.
 * @returns A configured Style Dictionary instance.
 */
const config = (
  source: string,
  destination: string,
  layerName: string,
  nameSuffix: string,
) => new StyleDictionary({
  source: [source],
  platforms: {
    css: {
      transformGroup: transformGroups.css,
      buildPath: './dist/css/',
      files: [
        {
          destination,
          format: 'css/layer',
          filter: (token: { filePath: string }) => isFromSource(token, source),
          options: { layerName, nameSuffix },
        },
      ],
    },
  },
});

export const semanticLight = config(
  'src/semantic.light.tokens.json',
  '.scheme/light.css',
  'semantic.light',
  '-on-light',
);

export const semanticDark = config(
  'src/semantic.dark.tokens.json',
  '.scheme/dark.css',
  'semantic.dark',
  '-on-dark',
);
