import StyleDictionary from 'style-dictionary';
import { transformGroups } from 'style-dictionary/enums';
import { primitiveSource } from '../shared.js';
import '../formats.js';

export const primitive = new StyleDictionary({
  source: primitiveSource,
  platforms: {
    css: {
      transformGroup: transformGroups.css,
      buildPath: './dist/css/',
      files: [
        {
          destination: 'primitive.css',
          format: 'css/layer',
          options: { layerName: 'primitive' },
        },
      ],
    },
  },
});
