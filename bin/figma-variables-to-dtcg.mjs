#!/usr/bin/env node
import { fetchFigmaVariables, figmaVariablesToNativeExports } from '../src/figma-to-dtcg.mjs';
import { writeNativeExports } from '../src/write-exports.mjs';

try {
  const args = parseArgs(process.argv.slice(2));
  const fileKey = args.file ?? process.env.FIGMA_FILE_KEY;
  const token = args.token ?? process.env.FIGMA_TOKEN;
  const tokenType = args['token-type'] ?? process.env.FIGMA_TOKEN_TYPE ?? 'personal';
  const outputDirectory = args.output;
  if (!['personal', 'oauth'].includes(tokenType)) {
    throw new Error('Token type must be "personal" or "oauth".');
  }
  if (!outputDirectory) {
    throw new Error('An output directory is required. Pass --output DIR.');
  }
  const response = await fetchFigmaVariables({ fileKey, token, tokenType });
  const files = figmaVariablesToNativeExports(response, { mode: args.mode });
  const root = await writeNativeExports(files, outputDirectory, { partial: Boolean(args.mode) });
  process.stdout.write(`Exported ${files.length} mode file${files.length === 1 ? '' : 's'} to ${root}\n`);
} catch (error) {
  process.stderr.write(`Error: ${error.message}\n`);
  process.exitCode = 1;
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--help' || value === '-h') {
      process.stdout.write('Usage: figma-variables-to-dtcg --output DIR [--file FILE_KEY] [--token TOKEN] [--mode MODE]\n');
      process.exit(0);
    }
    if (!value.startsWith('--')) throw new Error(`Unknown argument: ${value}`);
    const [key, inlineValue] = value.slice(2).split('=', 2);
    result[key] = inlineValue ?? values[++index];
  }
  return result;
}
