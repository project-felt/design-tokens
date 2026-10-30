import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeNativeExports } from '../src/write-exports.mjs';

test('full exports prune only managed files and partial exports keep other modes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'figma-export-test-'));
  const root = path.join(directory, 'tokens');
  const light = { collectionName: 'Colors', modeName: 'Light', tokens: { light: { $type: 'number', $value: 1 } } };
  const dark = { collectionName: 'Colors', modeName: 'Dark', tokens: { dark: { $type: 'number', $value: 2 } } };
  try {
    await writeNativeExports([light, dark], root);
    await writeFile(path.join(root, 'user-file.txt'), 'untouched');
    await assert.rejects(() => writeNativeExports([light, { ...dark, collectionName: 'Colors', modeName: 'Light' }], root),
      /same output file/);
    assert.equal(JSON.parse(await readFile(path.join(root, 'Colors/Dark.tokens.json'))).dark.$value, 2);
    await writeNativeExports([{ ...light, tokens: { light: { $type: 'number', $value: 3 } } }], root, { partial: true });
    assert.equal(JSON.parse(await readFile(path.join(root, 'Colors/Dark.tokens.json'))).dark.$value, 2);
    await writeNativeExports([light], root);
    assert.deepEqual(await readdir(path.join(root, 'Colors')), ['Light.tokens.json']);
    assert.equal(await readFile(path.join(root, 'user-file.txt'), 'utf8'), 'untouched');
    assert.equal(JSON.parse(await readFile(path.join(root, 'Colors/Light.tokens.json'))).light.$value, 1);
    await assert.rejects(() => writeNativeExports([light, light], root), /same output file/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
