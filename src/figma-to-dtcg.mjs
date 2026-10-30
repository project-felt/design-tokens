const FIGMA_API = 'https://api.figma.com/v1';

const TYPE_MAP = {
  BOOLEAN: 'boolean',
  COLOR: 'color',
  FLOAT: 'number',
  STRING: 'string',
  TIMING: 'duration',
  EASING: 'cubicBezier'
};

const LENGTH_SCOPES = new Set([
  'CORNER_RADIUS', 'GAP', 'STROKE_FLOAT', 'WIDTH_HEIGHT', 'FONT_SIZE',
  'EFFECT_FLOAT', 'LETTER_SPACING', 'PARAGRAPH_SPACING', 'PARAGRAPH_INDENT'
]);

export async function fetchFigmaVariables({ fileKey, token, tokenType = 'personal', request = fetch, retries = 2, timeoutMs = 15000 }) {
  if (!fileKey) throw new Error('A Figma file key is required.');
  if (!token) throw new Error('A Figma token is required.');

  const headers = tokenType === 'oauth'
    ? { Authorization: `Bearer ${token}` }
    : { 'X-Figma-Token': token };
  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await request(`${FIGMA_API}/files/${encodeURIComponent(fileKey)}/variables/local`, {
        headers,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      if (attempt >= retries || error.name === 'TimeoutError' || error.name === 'AbortError') throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      continue;
    }
    if (response.ok) return response.json();
    if (attempt < retries && (response.status === 429 || response.status >= 500)) {
      const retryAfter = response.headers?.get('retry-after');
      const seconds = retryAfter === null || retryAfter === undefined ? NaN : Number(retryAfter);
      const date = retryAfter && !Number.isFinite(seconds) ? Date.parse(retryAfter) : NaN;
      const delay = Number.isFinite(seconds) ? seconds * 1000
        : Number.isFinite(date) ? Math.max(0, date - Date.now()) : 500 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(0, delay), 30000)));
      continue;
    }
    const detail = await response.text();
    throw new Error(`Figma API request failed (${response.status}): ${detail}`);
  }
}

/**
 * Convert a Figma variables response into the native exporter layout:
 * <collection>/<mode>.tokens.json, with each file containing only that
 * collection's token tree for the selected mode.
 */
export function figmaVariablesToNativeExports(response, { mode } = {}) {
  const data = response.meta ?? response;
  const collections = data.variableCollections ?? {};
  const variables = Object.values(data.variables ?? {});
  const variablesById = new Map();
  for (const variable of variables) {
    variablesById.set(variable.id, variable);
    if (variable.key) variablesById.set(`VariableID:${variable.key}/-1:-1`, variable);
  }
  const outputFiles = [];

  for (const collection of Object.values(collections)) {
    if (collection.remote || collection.name === 'Figma-only') continue;

    const baseCollection = collectionRoot(collection, collections);
    const collectionIds = collection.variableIds && new Set(collection.variableIds);
    const collectionVariables = variables.filter((variable) => !variable.deletedButReferenced && (
      collectionIds ? collectionIds.has(variable.id) : variable.variableCollectionId === baseCollection.id
    ));
    const exportedIds = new Set(collectionVariables.map((variable) => variable.id));
    const modes = collection.modes ?? [];

    for (const selectedMode of modes) {
      if (mode && selectedMode.name !== mode && selectedMode.modeId !== mode) continue;
      const baseModeId = rootModeId(collection, selectedMode, collections);
      const baseMode = baseCollection.modes?.find((item) => item.modeId === baseModeId);
      const context = {
        collection,
        baseCollection,
        mode: selectedMode,
        baseModeId,
        baseModeName: baseMode?.name ?? selectedMode.name
      };
      const tokenTree = {};
      const referenceTokens = new Set();

      for (const variable of collectionVariables) {
        const { value: rawValue, isOverride } = modeValue(variable, context, collections);
        if (rawValue === undefined) {
          throw new Error(`Missing value for "${variable.name}" in "${collection.name}/${selectedMode.name}".`);
        }
        // Resolve the selected mode (including extension overrides), even
        // though Figma's native export sometimes uses the default mode for
        // composed color $values in extended collections.
        const token = createNativeToken(variable, rawValue, context, {
          variablesById,
          collections,
          isOverride,
          baseCollectionId: baseCollection.id,
          exportedIds
        });
        if (isVariableAlias(rawValue) && exportedIds.has(variablesById.get(rawValue.id)?.id)) {
          referenceTokens.add(token);
        }
        setNativePath(tokenTree, variable.name.split('/'), token, variable.id, collection.name, selectedMode.name);
      }

      validateNativeReferences(tokenTree, referenceTokens, collection.name, selectedMode.name);

      const rootExtensions = { 'com.figma.modeName': selectedMode.name };
      if (collection.isExtension) {
        const parentCollection = collections[collection.parentVariableCollectionId];
        if (collection.parentVariableCollectionId) {
          rootExtensions['com.figma.parentVariableSetId'] = collection.parentVariableCollectionId;
        }
        if (parentCollection?.name) {
          rootExtensions['com.figma.parentVariableSetName'] = parentCollection.name;
        }
      }
      tokenTree.$extensions = rootExtensions;

      outputFiles.push({
        collectionName: collection.name,
        modeName: selectedMode.name,
        fileName: `${collection.name}/${selectedMode.name}.tokens.json`,
        tokens: tokenTree
      });
    }
  }

  if (mode && !outputFiles.length) throw new Error(`No local collection has a mode named or identified by "${mode}".`);

  return outputFiles;
}

function createNativeToken(variable, rawValue, context, resolution) {
  const type = tokenType(variable);
  if (!type) throw new Error(`Unsupported Figma variable type "${resolvedType(variable)}" for "${variable.name}".`);
  const extensions = { 'com.figma.variableId': variable.id };
  if (variable.hiddenFromPublishing) extensions['com.figma.hiddenFromPublishing'] = true;
  if (variable.scopes?.length) {
    extensions['com.figma.scopes'] = variable.scopes.map((scope) => scope === 'STROKE_COLOR' ? 'STROKE' : scope);
  }
  if (type === 'string') extensions['com.figma.type'] = 'string';

  let value;
  if (isComposedColor(rawValue)) {
    value = resolveComposedColor(rawValue, context, resolution);
    extensions['com.figma.composedColor'] = {
      colorArg: nativeComposedArgument(rawValue.color, resolution, resolution.baseCollectionId),
      opacityArg: nativeComposedArgument(rawValue.opacity, resolution, resolution.baseCollectionId)
    };
  } else if (isVariableAlias(rawValue)) {
    const target = resolution.variablesById.get(rawValue.id);
    if (target && resolution.exportedIds.has(target.id)) {
      value = `{${target.name.split('/').join('.')}}`;
    } else {
      const resolved = resolveAliasValue(rawValue.id, context, resolution);
      if (resolved === undefined) throw new Error(`Cannot resolve alias "${rawValue.id}" for "${variable.name}".`);
      value = formatNativeValue(type, resolved);
      extensions['com.figma.aliasData'] = nativeAliasData(rawValue.id, resolution);
    }
  } else {
    value = formatNativeValue(type, rawValue);
  }

  if (resolution.isOverride) {
    extensions['com.figma.isOverride'] = true;
  }

  const token = { $type: type, $value: value };
  if (variable.description) token.$description = decodeFigmaDescription(variable.description);
  token.$extensions = extensions;
  return token;
}

function decodeFigmaDescription(description) {
  return description
    .replaceAll('&#39;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function isVariableAlias(value) {
  return value?.type === 'VARIABLE_ALIAS' && typeof value.id === 'string';
}

function isComposedColor(value) {
  return value && typeof value === 'object' && ('color' in value || 'opacity' in value);
}

function resolveComposedColor(value, context, resolution) {
  let color = isComposedColor(value) ? value.color : value;
  const opacityValue = isComposedColor(value) ? value.opacity : undefined;
  if (isVariableAlias(color)) {
    color = resolveAliasValue(color.id, context, resolution);
    if (color === undefined) throw new Error(`Cannot resolve composed color alias "${value.color.id}".`);
  }
  let opacity = opacityValue;
  if (isVariableAlias(opacityValue)) opacity = resolveAliasValue(opacityValue.id, context, resolution);
  if (isVariableAlias(opacityValue) && opacity === undefined) {
    throw new Error(`Cannot resolve composed opacity alias "${opacityValue.id}".`);
  }
  if (!color || typeof color !== 'object' || !['r', 'g', 'b'].every((channel) => typeof color[channel] === 'number') || typeof opacity !== 'number') {
    throw new Error('A composed color must resolve to RGB components and numeric opacity.');
  }
  color = { ...color, a: Math.fround(opacity / 100) };
  return formatNativeValue('color', color);
}

function nativeComposedArgument(value, resolution, baseCollectionId) {
  if (isVariableAlias(value)) {
    return { type: 'alias', alias: nativeAliasData(value.id, resolution, baseCollectionId) };
  }
  if (typeof value === 'number') return { type: 'number', value };
  return { type: typeof value, value };
}

function nativeAliasData(variableId, { variablesById, collections }, baseCollectionId) {
  const variable = variablesById.get(variableId);
  if (!variable) return { targetVariableName: variableId };
  const collection = collections[variable.variableCollectionId];
  if (variable.variableCollectionId === baseCollectionId) return { targetVariableName: variable.name };
  const metadata = {};
  if (variable.key) metadata.targetVariableId = `VariableID:${variable.key}/-1:-1`;
  metadata.targetVariableName = variable.name;
  if (collection?.key) metadata.targetVariableSetId = `VariableCollectionId:${collection.key}/-1:-1`;
  if (collection?.name) metadata.targetVariableSetName = collection.name;
  return metadata;
}

function resolveAliasValue(variableId, context, resolution, seen = new Set()) {
  if (seen.has(variableId)) return undefined;
  const target = resolution.variablesById.get(variableId);
  if (!target) return undefined;
  seen.add(variableId);

  const targetCollection = resolution.collections[target.variableCollectionId];
  if (!targetCollection) return undefined;
  const targetMode = selectAliasMode(targetCollection, context);
  if (!targetMode) {
    throw new Error(`Cannot select a mode for alias "${variableId}" in collection "${targetCollection.name}" from "${context.collection.name}/${context.mode.name}".`);
  }
  const inCurrentTree = targetCollection.id === context.baseCollection.id;
  const targetContext = inCurrentTree ? context : {
    collection: targetCollection,
    baseCollection: targetCollection,
    mode: targetMode,
    baseModeId: targetMode.modeId,
    baseModeName: targetMode.name
  };
  const { value } = modeValue(target, targetContext, resolution.collections);
  if (isVariableAlias(value)) return resolveAliasValue(value.id, targetContext, resolution, seen);
  if (isComposedColor(value)) {
    return isVariableAlias(value.color)
      ? resolveAliasValue(value.color.id, targetContext, resolution, seen)
      : value.color;
  }
  return value;
}

function selectAliasMode(collection, context) {
  const modes = collection.modes ?? [];
  if (collection.id === context.baseCollection.id) {
    return modes.find((item) => item.modeId === context.baseModeId)
      ?? modes.find((item) => item.name === context.baseModeName);
  }
  return modes.find((item) => item.name === context.baseModeName)
    ?? (modes.length === 1 ? modes[0] : undefined);
}

function modeValue(variable, context, collections) {
  let current = context.collection;
  let mode = context.mode;
  const seen = new Set();
  while (current) {
    if (seen.has(current.id)) throw new Error(`Circular collection extension at "${current.name}".`);
    seen.add(current.id);
    const overrides = current.variableOverrides?.[variable.id];
    if (overrides && Object.hasOwn(overrides, mode.modeId)) {
      return { value: overrides[mode.modeId], isOverride: true };
    }
    if (current.id === variable.variableCollectionId) {
      return { value: variable.valuesByMode?.[mode.modeId], isOverride: false };
    }
    if (!current.parentVariableCollectionId) break;
    const parent = collections[current.parentVariableCollectionId];
    if (!parent) throw new Error(`Missing parent collection for "${context.collection.name}".`);
    mode = parent.modes?.find((item) => item.modeId === mode.parentModeId);
    if (!mode) throw new Error(`Missing parent mode for "${context.collection.name}/${context.mode.name}".`);
    current = parent;
  }
  return { value: variable.valuesByMode?.[context.baseModeId], isOverride: false };
}

function formatNativeValue(type, value) {
  if (type === 'color' && value && typeof value === 'object' && ['r', 'g', 'b'].every((channel) => channel in value)) {
    const components = [value.r, value.g, value.b];
    return {
      colorSpace: 'srgb',
      components,
      alpha: value.a ?? 1,
      hex: `#${components.map((component) => Math.round(component * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`
    };
  }
  if (type === 'duration' && typeof value === 'number') {
    return { value: Number((value * 1000).toFixed(5)), unit: 'ms' };
  }
  if (type === 'dimension' && typeof value === 'number') return { value, unit: 'px' };
  if (type === 'cubicBezier') {
    const bezier = value?.bezierValues;
    const points = bezier ? [bezier.p1x, bezier.p1y, bezier.p2x, bezier.p2y]
      : typeof value === 'string' && /^cubic-bezier\(([^)]+)\)$/.exec(value)?.[1].split(',').map(Number);
    if (!points || points.length !== 4 || points.some((part) => !Number.isFinite(part))
      || points[0] < 0 || points[0] > 1 || points[2] < 0 || points[2] > 1) {
      throw new Error(`Invalid cubic Bézier value: ${JSON.stringify(value)}.`);
    }
    return points.map((part) => Number(part.toFixed(6)));
  }
  return value;
}

function setNativePath(root, segments, value, variableId, collectionName, modeName) {
  if (segments.some((segment) => !segment || segment.startsWith('$') || /[{}.]/.test(segment) || segment === '__proto__' || segment === 'constructor' || segment === 'prototype')) {
    throw new Error(`Invalid DTCG token path "${segments.join('/')}" for ${variableId} in "${collectionName}/${modeName}".`);
  }
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    if (!Object.hasOwn(current, segment)) {
      current[segment] = {};
    } else if (typeof current[segment] !== 'object' || '$type' in current[segment]) {
      current[segment] = { $root: current[segment] };
    }
    current = current[segment];
  }
  const leaf = segments.at(-1);
  if (current[leaf] !== undefined) {
    if (typeof current[leaf] === 'object' && !('$type' in current[leaf]) && current[leaf].$root === undefined) {
      current[leaf].$root = value;
    } else {
      const existing = current[leaf].$extensions?.['com.figma.variableId']
        ?? current[leaf].$root?.$extensions?.['com.figma.variableId'];
      throw new Error(`Duplicate token path "${segments.join('/')}" in "${collectionName}/${modeName}": ${existing} and ${variableId}.`);
    }
    return;
  }
  current[leaf] = value;
}

function validateNativeReferences(root, referenceTokens, collectionName, modeName) {
  const tokens = new Map();
  function collect(node, path = []) {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$extensions') continue;
      const tokenPath = [...path, key];
      if (value?.$type) tokens.set(tokenPath.join('.'), value);
      else if (value && typeof value === 'object') collect(value, tokenPath);
    }
  }
  collect(root);
  const checked = new Set();
  function visit(path, visiting = new Set()) {
    if (checked.has(path)) return;
    if (visiting.has(path)) throw new Error(`Circular token reference in "${collectionName}/${modeName}": ${[...visiting, path].join(' -> ')}`);
    const token = tokens.get(path);
    if (!token) throw new Error(`Missing token reference "${path}" in "${collectionName}/${modeName}".`);
    const reference = referenceTokens.has(token) && /^\{([^{}]+)\}$/.exec(token.$value);
    if (reference) {
      // A variable may be both a token and a group. Refer to its $root token.
      const target = tokens.has(reference[1]) ? reference[1] : `${reference[1]}.$root`;
      if (tokens.has(target) && target !== reference[1]) token.$value = `{${target}}`;
      visiting.add(path);
      visit(target, visiting);
      visiting.delete(path);
    }
    checked.add(path);
  }
  for (const path of tokens.keys()) visit(path);
}

function resolvedType(variable) {
  return variable.resolvedType ?? variable.type;
}

function isLength(variable) {
  return variable.scopes?.some((scope) => LENGTH_SCOPES.has(scope))
    || (variable.scopes?.includes('LINE_HEIGHT') && variable.name.includes('/figma-only/'));
}

function tokenType(variable) {
  const figmaType = resolvedType(variable);
  // REST documents only four primitive types; these named families carry richer semantics.
  if (figmaType === 'FLOAT' && /^felt\/(?:motion\/)?duration\//.test(variable.name)) return 'duration';
  if (figmaType === 'STRING' && /^felt\/(?:motion\/)?easing\//.test(variable.name)) return 'cubicBezier';
  if (figmaType === 'FLOAT' && isLength(variable)) return 'dimension';
  return TYPE_MAP[figmaType];
}

function collectionRoot(collection, collections) {
  const root = collections[collection.rootVariableCollectionId ?? collection.baseCollectionId];
  if (root) return root;
  let current = collection;
  const seen = new Set();
  while (current.parentVariableCollectionId) {
    if (seen.has(current.id)) throw new Error(`Circular collection extension at "${current.name}".`);
    seen.add(current.id);
    current = collections[current.parentVariableCollectionId];
    if (!current) throw new Error(`Missing parent collection for "${collection.name}".`);
  }
  return current;
}

function rootModeId(collection, mode, collections) {
  let current = collection;
  let selected = mode;
  const seen = new Set();
  while (current.parentVariableCollectionId) {
    if (seen.has(current.id)) throw new Error(`Circular collection extension at "${current.name}".`);
    seen.add(current.id);
    const parent = collections[current.parentVariableCollectionId];
    if (!parent) throw new Error(`Missing parent collection for "${collection.name}".`);
    selected = parent.modes?.find((item) => item.modeId === selected.parentModeId);
    if (!selected) throw new Error(`Missing parent mode for "${collection.name}/${mode.name}".`);
    current = parent;
  }
  return selected.modeId;
}
