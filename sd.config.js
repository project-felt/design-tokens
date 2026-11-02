import { rmSync } from 'node:fs';
import { loadConfig } from './pipeline/config.js';
import { buildIndex } from './pipeline/tokens.js';
import { buildLayer } from './pipeline/css/base.js';
import { postProcess } from './pipeline/css/post-process.js';
import { emitVariants } from './pipeline/css/variants.js';

rmSync('./dist/css', { recursive: true, force: true });

const config = loadConfig();
const index = buildIndex(config);

for (const collection of config.base) {
  if (collection.role === 'primitive') {
    const mode = collection.sources[0];
    await buildLayer(index, {
      collection: collection.name,
      mode: mode.name,
      file: mode.file,
      destination: '.layers/primitive.css',
      layerName: 'primitive',
      groupBy: 1,
    });
    continue;
  }

  if (collection.role === 'motion' || collection.role === 'unit') {
    const mode = collection.sources[0];
    await buildLayer(index, {
      collection: collection.name,
      mode: mode.name,
      file: mode.file,
      destination: `.layers/${collection.role}.css`,
      layerName: collection.role === 'unit' ? 'semantic' : `semantic.${collection.role}`,
      groupBy: collection.role === 'unit' ? 2 : undefined,
    });
    continue;
  }

  if (collection.role === 'color') {
    for (const mode of collection.sources) {
      const scheme = mode.name.toLowerCase();
      if (scheme !== 'light' && scheme !== 'dark') {
        throw new Error(`Color collection "${collection.name}" has unexpected mode "${mode.name}"`);
      }
      await buildLayer(index, {
        collection: collection.name,
        mode: mode.name,
        file: mode.file,
        destination: `.scheme/${scheme}.css`,
        layerName: `semantic.${scheme}`,
        nameSuffix: `-on-${scheme}`,
      });
    }
  }
}

postProcess();

const emitted = emitVariants(config, index);

for (const warning of index.warnings) console.warn(`warning: ${warning}`);

console.log(`composed-color drift warnings: ${index.warnings.length}`);
for (const [name, count] of Object.entries(emitted.modes)) {
  console.log(`mode ${name}: ${count} tokens`);
}
for (const [name, count] of Object.entries(emitted.densities)) {
  console.log(`density ${name}: ${count} tokens`);
}
