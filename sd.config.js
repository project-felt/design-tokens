import { primitive } from './pipeline/css/primitive.js';
import { semanticLight, semanticDark } from './pipeline/css/semantic.js';
import { postProcess } from './pipeline/css/post-process.js';

await primitive.buildAllPlatforms();
await semanticLight.buildAllPlatforms();
await semanticDark.buildAllPlatforms();

postProcess();
