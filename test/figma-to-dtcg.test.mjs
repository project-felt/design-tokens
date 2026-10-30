import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fetchFigmaVariables, figmaVariablesToNativeExports } from '../src/figma-to-dtcg.mjs';

test('writes native-style DTCG files per local collection mode', () => {
  const files = figmaVariablesToNativeExports({
    meta: {
      variableCollections: {
        colors: {
          id: 'collection:colors', name: 'Semantic colors', key: 'colors-key', remote: false,
          variableIds: ['VariableID:base', 'VariableID:alias'], defaultModeId: 'light',
          modes: [{ modeId: 'light', name: 'Light' }, { modeId: 'dark', name: 'Dark' }]
        },
        library: {
          id: 'collection:library', name: 'Library', remote: true,
          variableIds: ['VariableID:remote'], modes: [{ modeId: 'default', name: 'Default' }]
        },
        figmaOnly: {
          id: 'collection:figma-only', name: 'Figma-only', remote: false,
          variableIds: ['VariableID:internal'], modes: [{ modeId: 'default', name: 'Default' }]
        }
      },
      variables: {
        base: {
          id: 'VariableID:base', key: 'base-key', name: 'felt/color/brand',
          variableCollectionId: 'collection:colors', resolvedType: 'COLOR', scopes: ['FRAME_FILL'],
          valuesByMode: { light: { r: 1, g: 0, b: 0, a: 1 }, dark: { r: 0, g: 0, b: 0, a: 1 } }
        },
        alias: {
          id: 'VariableID:alias', key: 'alias-key', name: 'felt/color/action',
          variableCollectionId: 'collection:colors', resolvedType: 'COLOR', scopes: ['FRAME_FILL'],
          valuesByMode: {
            light: { type: 'VARIABLE_ALIAS', id: 'VariableID:base' },
            dark: { type: 'VARIABLE_ALIAS', id: 'VariableID:base' }
          }
        },
        remote: {
          id: 'VariableID:remote', name: 'remote', variableCollectionId: 'collection:library',
          resolvedType: 'STRING', valuesByMode: { default: 'not exported' }
        },
        internal: {
          id: 'VariableID:internal', name: 'internal', variableCollectionId: 'collection:figma-only',
          resolvedType: 'STRING', valuesByMode: { default: 'not exported' }
        }
      }
    }
  });

  assert.deepEqual(files.map(({ fileName }) => fileName), [
    'Semantic colors/Light.tokens.json',
    'Semantic colors/Dark.tokens.json'
  ]);
  assert.deepEqual(files[0].tokens.felt.color.brand.$value, {
    colorSpace: 'srgb', components: [1, 0, 0], alpha: 1, hex: '#FF0000'
  });
  assert.equal(files[0].tokens.felt.color.action.$value, '{felt.color.brand}');
  assert.deepEqual(Object.keys(files[0].tokens.felt.color.action.$extensions), [
    'com.figma.variableId', 'com.figma.scopes'
  ]);
});

test('preserves extended collection metadata and DTCG group root tokens', () => {
  const file = figmaVariablesToNativeExports({
    meta: {
      variableCollections: {
        base: {
          id: 'base', name: 'Semantic colors', key: 'base-key', remote: false,
          variableIds: ['VariableID:root', 'VariableID:child'], modes: [{ modeId: 'light', name: 'Light' }]
        },
        extension: {
          id: 'extension', name: 'Glass colors', key: 'extension-key', remote: false,
          isExtension: true, baseCollectionId: 'base', parentVariableCollectionId: 'base',
          modes: [{ modeId: 'glass-light', name: 'Light', parentModeId: 'light' }],
          variableOverrides: { 'VariableID:root': { 'glass-light': { type: 'VARIABLE_ALIAS', id: 'VariableID:child' } } }
        }
      },
      variables: {
        root: {
          id: 'VariableID:root', name: 'felt/color/focus', variableCollectionId: 'base', resolvedType: 'COLOR',
          valuesByMode: { light: { r: 1, g: 0, b: 0, a: 1 } }
        },
        child: {
          id: 'VariableID:child', name: 'felt/color/focus/ring', variableCollectionId: 'base', resolvedType: 'COLOR',
          valuesByMode: { light: { r: 0, g: 0, b: 1, a: 1 } }
        }
      }
    }
  }).find(({ fileName }) => fileName === 'Glass colors/Light.tokens.json');

  assert.deepEqual(file.tokens.felt.color.focus.$root, {
    $type: 'color', $value: '{felt.color.focus.ring}',
    $extensions: { 'com.figma.variableId': 'VariableID:root', 'com.figma.isOverride': true }
  });
  assert.deepEqual(file.tokens.$extensions, {
    'com.figma.modeName': 'Light',
    'com.figma.parentVariableSetId': 'base',
    'com.figma.parentVariableSetName': 'Semantic colors'
  });
});

test('rejects colliding API variable names with both variable IDs', () => {
  assert.throws(() => figmaVariablesToNativeExports({
    meta: {
      variableCollections: {
        collection: {
          id: 'collection', name: 'Primitives', remote: false,
          variableIds: ['VariableID:second', 'VariableID:first'],
          modes: [{ modeId: 'value', name: 'Value' }]
        }
      },
      variables: {
        first: { id: 'VariableID:first', key: 'a-key', name: 'felt/effect/size/55', variableCollectionId: 'collection', resolvedType: 'FLOAT', valuesByMode: { value: 1 } },
        second: { id: 'VariableID:second', key: 'z-key', name: 'felt/effect/size/55', variableCollectionId: 'collection', resolvedType: 'FLOAT', valuesByMode: { value: 2 } }
      }
    }
  }), /Duplicate token path "felt\/effect\/size\/55".*VariableID:first and VariableID:second/);
});

test('does not sort variables to match Figma native export order', () => {
  const [file] = figmaVariablesToNativeExports({
    meta: {
      variableCollections: {
        local: {
          id: 'local', name: 'Local', variableIds: ['VariableID:a', 'VariableID:z'],
          modes: [{ modeId: 'default', name: 'Default' }]
        },
        external: {
          id: 'external', name: 'External', key: 'external-key', remote: true,
          modes: [{ modeId: 'default', name: 'Default' }]
        }
      },
      variables: {
        z: {
          id: 'VariableID:z', name: 'group/z', variableCollectionId: 'local', resolvedType: 'FLOAT',
          valuesByMode: { default: { type: 'VARIABLE_ALIAS', id: 'VariableID:external' } }
        },
        a: {
          id: 'VariableID:a', name: 'group/a', variableCollectionId: 'local', resolvedType: 'FLOAT',
          valuesByMode: { default: 2 }
        },
        external: {
          id: 'VariableID:external', key: 'external-key', name: 'external/value',
          variableCollectionId: 'external', resolvedType: 'FLOAT', valuesByMode: { default: 1 }
        }
      }
    }
  });

  assert.deepEqual(Object.keys(file.tokens.group), ['z', 'a']);
  assert.deepEqual(Object.keys(file.tokens.group.z.$extensions['com.figma.aliasData']), [
    'targetVariableId', 'targetVariableName', 'targetVariableSetId', 'targetVariableSetName'
  ]);
});

test('rejects missing values, unresolved aliases and circular local references', () => {
  const response = {
    variableCollections: {
      colors: { id: 'colors', name: 'Colors', modes: [{ modeId: 'dark', name: 'Dark' }] }
    },
    variables: {
      a: { id: 'a', name: 'a', variableCollectionId: 'colors', resolvedType: 'COLOR', valuesByMode: {} }
    }
  };
  assert.throws(() => figmaVariablesToNativeExports(response), /Missing value.*Colors\/Dark/);
  response.variables.a.valuesByMode.dark = { type: 'VARIABLE_ALIAS', id: 'missing' };
  assert.throws(() => figmaVariablesToNativeExports(response), /Cannot resolve alias "missing"/);
  response.variables.a.valuesByMode.dark = { type: 'VARIABLE_ALIAS', id: 'b' };
  response.variables.b = {
    id: 'b', name: 'b', variableCollectionId: 'colors', resolvedType: 'COLOR',
    valuesByMode: { dark: { type: 'VARIABLE_ALIAS', id: 'a' } }
  };
  assert.throws(() => figmaVariablesToNativeExports(response), /Circular token reference.*a -> b -> a/);
  response.variables.a.valuesByMode.dark = {
    color: { r: 1, g: 0, b: 0 }, opacity: { type: 'VARIABLE_ALIAS', id: 'missing' }
  };
  assert.throws(() => figmaVariablesToNativeExports(response), /Cannot resolve composed opacity alias "missing"/);
  response.variables.a.resolvedType = 'UNSUPPORTED';
  assert.throws(() => figmaVariablesToNativeExports(response), /Unsupported Figma variable type "UNSUPPORTED"/);
});

test('points references at $root when the target token also has children', () => {
  const [file] = figmaVariablesToNativeExports({
    variableCollections: {
      colors: { id: 'colors', name: 'Colors', modes: [{ modeId: 'one', name: 'One' }] }
    },
    variables: {
      root: { id: 'root', name: 'color/root', variableCollectionId: 'colors', resolvedType: 'COLOR', valuesByMode: { one: { r: 1, g: 0, b: 0 } } },
      child: { id: 'child', name: 'color/root/child', variableCollectionId: 'colors', resolvedType: 'COLOR', valuesByMode: { one: { r: 0, g: 0, b: 1 } } },
      alias: { id: 'alias', name: 'color/alias', variableCollectionId: 'colors', resolvedType: 'COLOR', valuesByMode: { one: { type: 'VARIABLE_ALIAS', id: 'root' } } }
    }
  });
  assert.equal(file.tokens.color.alias.$value, '{color.root.$root}');
});

test('resolves composed colors using the selected extension mode and its overrides', () => {
  const file = figmaVariablesToNativeExports({
    meta: {
      variableCollections: {
        base: {
          id: 'base', name: 'Colors', remote: false, key: 'base-key', defaultModeId: 'light',
          variableIds: ['VariableID:surface', 'VariableID:white', 'VariableID:black', 'VariableID:hover', 'VariableID:dependent'],
          modes: [{ modeId: 'light', name: 'Light' }, { modeId: 'dark', name: 'Dark' }]
        },
        extension: {
          id: 'extension', name: 'Extended colors', remote: false, isExtension: true,
          baseCollectionId: 'base', parentVariableCollectionId: 'base',
          modes: [{ modeId: 'ext-dark', name: 'Dark', parentModeId: 'dark' }],
          variableOverrides: {
            'VariableID:surface': {
              'ext-dark': {
                color: { type: 'VARIABLE_ALIAS', id: 'VariableID:black' },
                opacity: 50
              }
            }
          }
        },
        primitives: {
          id: 'primitives', name: 'Primitives', remote: true,
          modes: [{ modeId: 'value', name: 'Value' }]
        }
      },
      variables: {
        'VariableID:surface': {
          id: 'VariableID:surface', name: 'felt/color/surface', variableCollectionId: 'base', resolvedType: 'COLOR',
          valuesByMode: {
            light: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:white' }, opacity: 100 },
            dark: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:black' }, opacity: 50 }
          }
        },
        'VariableID:white': {
          id: 'VariableID:white', name: 'felt/color/white', variableCollectionId: 'base', resolvedType: 'COLOR',
          valuesByMode: { light: { r: 1, g: 1, b: 1, a: 1 }, dark: { r: 1, g: 1, b: 1, a: 1 } }
        },
        'VariableID:black': {
          id: 'VariableID:black', name: 'felt/color/black', variableCollectionId: 'base', resolvedType: 'COLOR',
          valuesByMode: { light: { r: 0, g: 0, b: 0, a: 1 }, dark: { r: 0, g: 0, b: 0, a: 1 } }
        },
        'VariableID:hover': {
          id: 'VariableID:hover', name: 'felt/color/hover', variableCollectionId: 'base', resolvedType: 'COLOR',
          valuesByMode: {
            light: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:white' }, opacity: 25 },
            dark: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:white' }, opacity: { type: 'VARIABLE_ALIAS', id: 'VariableID:opacity15' } }
          }
        },
        'VariableID:opacity15': {
          id: 'VariableID:opacity15', name: 'felt/opacity/15', variableCollectionId: 'primitives',
          resolvedType: 'FLOAT', valuesByMode: { value: 15 }
        },
        'VariableID:dependent': {
          id: 'VariableID:dependent', name: 'felt/color/dependent', variableCollectionId: 'base', resolvedType: 'COLOR',
          valuesByMode: {
            light: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:surface' }, opacity: 25 },
            dark: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:surface' }, opacity: 15 }
          }
        }
      }
    }
  }).find(({ fileName }) => fileName === 'Extended colors/Dark.tokens.json');

  const token = file.tokens.felt.color.surface;
  assert.deepEqual(token.$value, { colorSpace: 'srgb', components: [0, 0, 0], alpha: 0.5, hex: '#000000' });
  assert.equal(token.$extensions['com.figma.composedColor'].colorArg.alias.targetVariableName, 'felt/color/black');
  assert.equal(token.$extensions['com.figma.isOverride'], true);
  assert.deepEqual(file.tokens.felt.color.hover.$value, {
    colorSpace: 'srgb', components: [1, 1, 1], alpha: Math.fround(0.15), hex: '#FFFFFF'
  });
  assert.equal(file.tokens.felt.color.hover.$extensions['com.figma.composedColor'].opacityArg.alias.targetVariableName, 'felt/opacity/15');
  assert.deepEqual(file.tokens.felt.color.dependent.$value, {
    colorSpace: 'srgb', components: [0, 0, 0], alpha: Math.fround(0.15), hex: '#000000'
  });
  assert.equal(file.tokens.felt.color.hover.$extensions['com.figma.composedColor'].opacityArg.alias.targetVariableName, 'felt/opacity/15');
});

test('exports inherited and locally created extension variables and multi-level overrides', () => {
  const files = figmaVariablesToNativeExports({
    variableCollections: {
      base: { id: 'base', name: 'Base', variableIds: ['a'], modes: [{ modeId: 'light', name: 'Light' }] },
      middle: { id: 'middle', name: 'Middle', parentVariableCollectionId: 'base', rootVariableCollectionId: 'base',
        variableIds: ['a', 'b'], modes: [{ modeId: 'middle-light', name: 'Light', parentModeId: 'light' }],
        variableOverrides: { a: { 'middle-light': 2 } } },
      leaf: { id: 'leaf', name: 'Leaf', parentVariableCollectionId: 'middle', rootVariableCollectionId: 'base',
        variableIds: ['a', 'b'], modes: [{ modeId: 'leaf-light', name: 'Light', parentModeId: 'middle-light' }] }
    },
    variables: {
      a: { id: 'a', name: 'size/a', variableCollectionId: 'base', resolvedType: 'FLOAT', valuesByMode: { light: 1 } },
      b: { id: 'b', name: 'size/b', variableCollectionId: 'middle', resolvedType: 'FLOAT', valuesByMode: { 'middle-light': 3 } }
    }
  });
  const leaf = files.find((file) => file.collectionName === 'Leaf').tokens;
  assert.equal(leaf.size.a.$value, 2);
  assert.equal(leaf.size.a.$extensions['com.figma.isOverride'], true);
  assert.equal(leaf.size.b.$value, 3);
});

test('rejects ambiguous cross-collection modes rather than using a default value', () => {
  const response = {
    variableCollections: {
      source: { id: 'source', name: 'Source', modes: [{ modeId: 'dark', name: 'Dark' }] },
      other: { id: 'other', name: 'Other', remote: true, defaultModeId: 'day',
        modes: [{ modeId: 'day', name: 'Day' }, { modeId: 'night', name: 'Night' }] }
    },
    variables: {
      a: { id: 'a', name: 'color/a', variableCollectionId: 'source', resolvedType: 'COLOR',
        valuesByMode: { dark: { type: 'VARIABLE_ALIAS', id: 'b' } } },
      b: { id: 'b', name: 'color/b', variableCollectionId: 'other', resolvedType: 'COLOR',
        valuesByMode: { day: { r: 1, g: 0, b: 0 }, night: { r: 0, g: 0, b: 1 } } }
    }
  };
  assert.throws(() => figmaVariablesToNativeExports(response), /Cannot select a mode for alias "b"/);
});

test('exports dimensions and DTCG cubicBezier arrays without changing unitless floats', () => {
  const [file] = figmaVariablesToNativeExports({
    variableCollections: { a: { id: 'a', name: 'Tokens', modes: [{ modeId: 'one', name: 'One' }] } },
    variables: {
      radius: { id: 'radius', name: 'radius', variableCollectionId: 'a', resolvedType: 'FLOAT',
        scopes: ['CORNER_RADIUS'], valuesByMode: { one: 4 } },
      opacity: { id: 'opacity', name: 'opacity', variableCollectionId: 'a', resolvedType: 'FLOAT',
        scopes: ['COLOR_OPACITY'], valuesByMode: { one: 25 } },
      easing: { id: 'easing', name: 'easing', variableCollectionId: 'a', resolvedType: 'EASING',
        valuesByMode: { one: { bezierValues: { p1x: 0.4, p1y: 0, p2x: 0.2, p2y: 1 } } } }
    }
  });
  assert.deepEqual([file.tokens.radius.$type, file.tokens.radius.$value], ['dimension', { value: 4, unit: 'px' }]);
  assert.deepEqual([file.tokens.opacity.$type, file.tokens.opacity.$value], ['number', 25]);
  assert.deepEqual([file.tokens.easing.$type, file.tokens.easing.$value], ['cubicBezier', [0.4, 0, 0.2, 1]]);
});

test('recognizes this design system’s duration and easing families in REST primitive types', () => {
  const [file] = figmaVariablesToNativeExports({
    variableCollections: { a: { id: 'a', name: 'Primitives', modes: [{ modeId: 'value', name: 'Value' }] } },
    variables: {
      duration: { id: 'duration', name: 'felt/duration/10', variableCollectionId: 'a', resolvedType: 'FLOAT',
        valuesByMode: { value: 0.1 } },
      easing: { id: 'easing', name: 'felt/easing/10', variableCollectionId: 'a', resolvedType: 'STRING',
        valuesByMode: { value: 'cubic-bezier(0.4, 0, 0.2, 1)' } }
    }
  });
  assert.deepEqual(file.tokens.felt.duration['10'].$value, { value: 100, unit: 'ms' });
  assert.deepEqual(file.tokens.felt.easing['10'].$value, [0.4, 0, 0.2, 1]);
  assert.equal(file.tokens.felt.easing['10'].$type, 'cubicBezier');
});

test('rejects invalid token paths', () => {
  const response = { variableCollections: { a: { id: 'a', name: 'A', modes: [{ modeId: 'm', name: 'M' }] } },
    variables: { one: { id: 'one', name: 'group/bad.name', variableCollectionId: 'a', resolvedType: 'FLOAT', valuesByMode: { m: 1 } } } };
  assert.throws(() => figmaVariablesToNativeExports(response), /Invalid DTCG token path/);
  response.variables.one.name = 'group/__proto__';
  assert.throws(() => figmaVariablesToNativeExports(response), /Invalid DTCG token path/);
});

test('retries rate limits but not permanent errors, with the appropriate authentication header', async () => {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1
      ? { ok: false, status: 429, headers: { get: () => '0' } }
      : { ok: true, json: async () => ({ meta: { variables: {} } }) };
  };
  assert.deepEqual(await fetchFigmaVariables({ fileKey: 'file key', token: 'secret', tokenType: 'oauth', request }),
    { meta: { variables: {} } });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /file%20key\/variables\/local$/);
  assert.deepEqual(calls[0].options.headers, { Authorization: 'Bearer secret' });
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  await assert.rejects(() => fetchFigmaVariables({ fileKey: 'key', token: 'secret', retries: 0,
    request: async () => ({ ok: false, status: 403, text: async () => 'Invalid scope' }) }),
  /Figma API request failed \(403\): Invalid scope/);
});

test('checked-in token files have valid easing and dimension shapes and retain composed aliases', async () => {
  const root = path.resolve('tokens/figma');
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await inspect(file);
      else if (entry.name.endsWith('.tokens.json')) {
        const data = JSON.parse(await readFile(file, 'utf8'));
        function walk(node) {
          for (const [key, value] of Object.entries(node)) {
            if (key.startsWith('$') && key !== '$root') continue;
            if (value && typeof value === 'object' && '$value' in value) {
              if (value.$type === 'cubicBezier') {
                assert.equal(value.$value.length, 4, file);
                assert.ok(value.$value.every(Number.isFinite), file);
              }
              if (value.$type === 'dimension' && typeof value.$value !== 'string') {
                assert.equal(value.$value.unit, 'px', file);
                assert.equal(typeof value.$value.value, 'number', file);
              }
            } else if (value && typeof value === 'object') walk(value);
          }
        }
        walk(data);
      }
    }
  }
  await inspect(root);
  const glass = JSON.parse(await readFile(path.join(root, 'Glass colors/Dark.tokens.json'), 'utf8'));
  const hover = glass.felt.color.fill.interactive.subtle.hover;
  assert.equal(hover.$value.alpha, Math.fround(0.15));
  assert.equal(hover.$extensions['com.figma.composedColor'].opacityArg.alias.targetVariableName, 'felt/opacity/15');
  assert.equal(hover.$extensions['com.figma.composedColor'].colorArg.alias.targetVariableName, 'felt/color/gray/30');
});
