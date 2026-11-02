import StyleDictionary from 'style-dictionary';
import '../formats.js';
import { setTokenIndex } from '../formats.js';
import type { TokenIndex } from '../tokens.js';

export type BuildLayerOptions = {
  collection: string;
  mode: string;
  file: string;
  destination: string;
  layerName: string;
  nameSuffix?: string;
  groupBy?: number;
};

/**
 * Builds one exported collection/mode into a CSS layer file.
 * @param index - Parsed token index.
 * @param options - Source file and layer configuration.
 * @returns Nothing. Writes the generated CSS file.
 */
export async function buildLayer(
  index: TokenIndex,
  options: BuildLayerOptions,
): Promise<void> {
  setTokenIndex(index);

  const dictionary = new StyleDictionary({
    source: [options.file],
    usesDtcg: true,
    platforms: {
      css: {
        buildPath: './dist/css/',
        transforms: ['name/felt'],
        files: [
          {
            destination: options.destination,
            format: 'css/layer',
            options: {
              layerName: options.layerName,
              nameSuffix: options.nameSuffix ?? '',
              collection: options.collection,
              mode: options.mode,
              groupBy: options.groupBy,
            },
          },
        ],
      },
    },
  });

  await dictionary.buildAllPlatforms();
}
