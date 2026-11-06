import { loadConfig } from './config.js';
import { buildIndex } from './tokens.js';

/**
 * Prints build diagnostics. Runs after generation because Wireit hides the
 * successful output of tasks that declare files, so the warnings would
 * otherwise never reach the terminal.
 */
const config = loadConfig();
const index = buildIndex(config);

for (const warning of index.warnings) {
  console.warn(`warning: ${warning}`);
}
console.log(`composed-color drift warnings: ${index.warnings.length}`);
