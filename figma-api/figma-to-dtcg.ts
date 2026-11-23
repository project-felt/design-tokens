import type { LocalVariable, VariableAlias } from '@figma/rest-api-spec';

const FIGMA_API = 'https://api.figma.com/v1';

/**
 * REST documents only the four primitive types, but the live endpoint returns
 * `TIMING` and `EASING` for variables created from motion styles.
 */
export type FigmaVariableType = LocalVariable['resolvedType'] | 'TIMING' | 'EASING';

export type TokenType = 'boolean' | 'color' | 'number' | 'string' | 'duration' | 'cubicBezier' | 'dimension';

export type FigmaAlias = VariableAlias;

export type FigmaRGB = { r: number; g: number; b: number; a?: number };

export type FigmaComposedColor =
  | { color: FigmaRGB; opacity: FigmaAlias }
  | { color: FigmaAlias; opacity: number | FigmaAlias };

/** Easing variables are not in the published REST value union yet. */
export type FigmaEasing = { bezierValues: { p1x: number; p1y: number; p2x: number; p2y: number } };

export type FigmaValue =
  | boolean
  | number
  | string
  | FigmaRGB
  | FigmaAlias
  | FigmaComposedColor
  | FigmaEasing
  | undefined;

export type FigmaMode = { modeId: string; name: string; parentModeId?: string };

export type FigmaVariable = {
  id: string;
  key?: string;
  name: string;
  variableCollectionId: string;
  /** `type` is accepted for payloads from endpoints that predate `resolvedType`. */
  resolvedType?: FigmaVariableType;
  type?: FigmaVariableType;
  valuesByMode?: Record<string, FigmaValue>;
  description?: string;
  scopes?: string[];
  hiddenFromPublishing?: boolean;
  deletedButReferenced?: boolean;
};

export type FigmaCollection = {
  id: string;
  key?: string;
  name: string;
  modes?: FigmaMode[];
  remote?: boolean;
  isExtension?: boolean;
  parentVariableCollectionId?: string;
  rootVariableCollectionId?: string;
  /** Legacy field returned by some endpoints for the base collection. */
  baseCollectionId?: string;
  variableIds?: string[];
  variableOverrides?: Record<string, Record<string, FigmaValue>>;
};

export type FigmaVariablesPayload = {
  variables?: Record<string, FigmaVariable>;
  variableCollections?: Record<string, FigmaCollection>;
};

export type FigmaVariablesResponse = FigmaVariablesPayload & { meta?: FigmaVariablesPayload };

export type NativeToken = {
  $type: TokenType;
  $value: unknown;
  $description?: string;
  $extensions: Record<string, unknown>;
};

export type TokenGroup = { [key: string]: TokenGroup | NativeToken | Record<string, unknown> };

export type NativeTokenExport = {
  collectionName: string;
  modeName: string;
  fileName: string;
  tokens: TokenGroup;
};

export type FetchFigmaVariablesOptions = {
  fileKey?: string;
  token?: string;
  tokenType?: 'personal' | 'oauth';
  request?: typeof fetch;
  retries?: number;
  timeoutMs?: number;
};

type ConversionContext = {
  collection: FigmaCollection;
  baseCollection: FigmaCollection;
  mode: FigmaMode;
  baseModeId: string;
  baseModeName: string;
};

type Resolution = {
  variablesById: Map<string, FigmaVariable>;
  collections: Record<string, FigmaCollection>;
  isOverride: boolean;
  baseCollectionId: string;
  exportedIds: Set<string>;
};

const TYPE_MAP: Partial<Record<FigmaVariableType, TokenType>> = {
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

export async function fetchFigmaVariables({
  fileKey,
  token,
  tokenType = 'personal',
  request = fetch,
  retries = 2,
  timeoutMs = 15000
}: FetchFigmaVariablesOptions = {}): Promise<FigmaVariablesResponse> {
  if (!fileKey) throw new Error('A Figma file key is required.');
  if (!token) throw new Error('A Figma token is required.');

  const headers: Record<string, string> = tokenType === 'oauth'
    ? { Authorization: `Bearer ${token}` }
    : { 'X-Figma-Token': token };
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await request(`${FIGMA_API}/files/${encodeURIComponent(fileKey)}/variables/local`, {
        headers,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      const name = (error as Error).name;
      if (attempt >= retries || name === 'TimeoutError' || name === 'AbortError') throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      continue;
    }
    if (response.ok) return (await response.json()) as FigmaVariablesResponse;
    if (attempt < retries && (response.status === 429 || response.status >= 500)) {
      const retryAfter = response.headers.get('retry-after');
      const seconds = retryAfter === null ? NaN : Number(retryAfter);
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
export function figmaVariablesToNativeExports(
  response: FigmaVariablesResponse,
  { mode }: { mode?: string } = {}
): NativeTokenExport[] {
  const data = response.meta ?? response;
  const collections = data.variableCollections ?? {};
  const variables = Object.values(data.variables ?? {});
  const variablesById = new Map<string, FigmaVariable>();
  for (const variable of variables) {
    variablesById.set(variable.id, variable);
    if (variable.key) variablesById.set(`VariableID:${variable.key}/-1:-1`, variable);
  }
  const outputFiles: NativeTokenExport[] = [];

  for (const collection of Object.values(collections)) {
    if (collection.remote || collection.name === 'Figma-only') continue;

    const baseCollection = collectionRoot(collection, collections);
    const collectionIds = collection.variableIds && new Set(collection.variableIds);
    const collectionVariables = variables.filter((variable) => !variable.deletedButReferenced && !variable.name.includes('figma-only') && (
      collectionIds ? collectionIds.has(variable.id) : variable.variableCollectionId === baseCollection.id
    ));
    const exportedIds = new Set(collectionVariables.map((variable) => variable.id));
    const modes = collection.modes ?? [];

    for (const selectedMode of modes) {
      if (mode && selectedMode.name !== mode && selectedMode.modeId !== mode) continue;
      const baseModeId = rootModeId(collection, selectedMode, collections);
      const baseMode = baseCollection.modes?.find((item) => item.modeId === baseModeId);
      const context: ConversionContext = {
        collection,
        baseCollection,
        mode: selectedMode,
        baseModeId,
        baseModeName: baseMode?.name ?? selectedMode.name
      };
      const tokenTree: TokenGroup = {};
      const referenceTokens = new Set<NativeToken>();

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
        if (isVariableAlias(rawValue)) {
          const target = variablesById.get(rawValue.id);
          if (target && exportedIds.has(target.id)) referenceTokens.add(token);
        }
        setNativePath(tokenTree, variable.name.split('/'), token, variable.id, collection.name, selectedMode.name);
      }

      validateNativeReferences(tokenTree, referenceTokens, collection.name, selectedMode.name);

      const rootExtensions: Record<string, unknown> = { 'com.figma.modeName': selectedMode.name };
      if (collection.isExtension) {
        const parentCollection = collection.parentVariableCollectionId
          ? collections[collection.parentVariableCollectionId]
          : undefined;
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
        tokens: sortTokenTree(tokenTree)
      });
    }
  }

  if (mode && !outputFiles.length) throw new Error(`No local collection has a mode named or identified by "${mode}".`);

  return outputFiles;
}

function createNativeToken(
  variable: FigmaVariable,
  rawValue: FigmaValue,
  context: ConversionContext,
  resolution: Resolution
): NativeToken {
  const type = tokenType(variable);
  if (!type) throw new Error(`Unsupported Figma variable type "${resolvedType(variable)}" for "${variable.name}".`);
  const extensions: Record<string, unknown> = { 'com.figma.variableId': variable.id };
  if (variable.hiddenFromPublishing) extensions['com.figma.hiddenFromPublishing'] = true;
  if (variable.scopes?.length) {
    extensions['com.figma.scopes'] = variable.scopes.map((scope) => scope === 'STROKE_COLOR' ? 'STROKE' : scope);
  }
  if (type === 'string') extensions['com.figma.type'] = 'string';

  let value: unknown;
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

  const token = { $type: type, $value: value } as NativeToken;
  if (variable.description) token.$description = decodeFigmaDescription(variable.description);
  token.$extensions = extensions;
  return token;
}

function decodeFigmaDescription(description: string): string {
  return description
    .replaceAll('&#39;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function isVariableAlias(value: unknown): value is FigmaAlias {
  return typeof value === 'object' && value !== null
    && (value as FigmaAlias).type === 'VARIABLE_ALIAS'
    && typeof (value as FigmaAlias).id === 'string';
}

function isComposedColor(value: unknown): value is FigmaComposedColor {
  return typeof value === 'object' && value !== null && ('color' in value || 'opacity' in value);
}

function isRgb(value: unknown): value is FigmaRGB {
  if (typeof value !== 'object' || value === null) return false;
  const channels = value as Record<string, unknown>;
  return ['r', 'g', 'b'].every((channel) => typeof channels[channel] === 'number');
}

function resolveComposedColor(
  value: FigmaComposedColor,
  context: ConversionContext,
  resolution: Resolution
): unknown {
  let color: FigmaValue = value.color;
  const opacityValue = value.opacity;
  if (isVariableAlias(value.color)) {
    const colorArg = value.color;
    color = resolveAliasValue(colorArg.id, context, resolution);
    if (color === undefined) throw new Error(`Cannot resolve composed color alias "${colorArg.id}".`);
  }
  let opacity: FigmaValue = opacityValue;
  if (isVariableAlias(opacityValue)) opacity = resolveAliasValue(opacityValue.id, context, resolution);
  if (isVariableAlias(opacityValue) && opacity === undefined) {
    throw new Error(`Cannot resolve composed opacity alias "${opacityValue.id}".`);
  }
  if (!isRgb(color) || typeof opacity !== 'number') {
    throw new Error('A composed color must resolve to RGB components and numeric opacity.');
  }
  return formatNativeValue('color', { ...color, a: Math.fround(opacity / 100) });
}

function nativeComposedArgument(
  value: FigmaRGB | FigmaAlias | number,
  resolution: Resolution,
  baseCollectionId?: string
): Record<string, unknown> {
  if (isVariableAlias(value)) {
    return { type: 'alias', alias: nativeAliasData(value.id, resolution, baseCollectionId) };
  }
  if (typeof value === 'number') return { type: 'number', value };
  return { type: typeof value, value };
}

function nativeAliasData(
  variableId: string,
  { variablesById, collections }: Pick<Resolution, 'variablesById' | 'collections'>,
  baseCollectionId?: string
): Record<string, unknown> {
  const variable = variablesById.get(variableId);
  if (!variable) return { targetVariableName: variableId };
  const collection = collections[variable.variableCollectionId];
  if (variable.variableCollectionId === baseCollectionId) return { targetVariableName: variable.name };
  const metadata: Record<string, unknown> = {};
  if (variable.key) metadata.targetVariableId = `VariableID:${variable.key}/-1:-1`;
  metadata.targetVariableName = variable.name;
  if (collection?.key) metadata.targetVariableSetId = `VariableCollectionId:${collection.key}/-1:-1`;
  if (collection?.name) metadata.targetVariableSetName = collection.name;
  return metadata;
}

function resolveAliasValue(
  variableId: string,
  context: ConversionContext,
  resolution: Resolution,
  seen: Set<string> = new Set()
): FigmaValue {
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
  const targetContext: ConversionContext = inCurrentTree ? context : {
    collection: targetCollection,
    baseCollection: targetCollection,
    mode: targetMode,
    baseModeId: targetMode.modeId,
    baseModeName: targetMode.name
  };
  const { value } = modeValue(target, targetContext, resolution.collections);
  if (isVariableAlias(value)) return resolveAliasValue(value.id, targetContext, resolution, seen);
  if (isComposedColor(value)) {
    // A plain alias inherits the whole composed color, including its opacity.
    let color: FigmaValue = value.color;
    if (isVariableAlias(color)) color = resolveAliasValue(color.id, targetContext, resolution, new Set(seen));
    let opacity: FigmaValue = value.opacity;
    if (isVariableAlias(opacity)) opacity = resolveAliasValue(opacity.id, targetContext, resolution, new Set(seen));
    if (!isRgb(color) || typeof opacity !== 'number') {
      throw new Error(`Cannot resolve composed color "${variableId}".`);
    }
    return { ...color, a: Math.fround(opacity / 100) };
  }
  return value;
}

function selectAliasMode(collection: FigmaCollection, context: ConversionContext): FigmaMode | undefined {
  const modes = collection.modes ?? [];
  if (collection.id === context.baseCollection.id) {
    return modes.find((item) => item.modeId === context.baseModeId)
      ?? modes.find((item) => item.name === context.baseModeName);
  }
  return modes.find((item) => item.name === context.baseModeName)
    ?? (modes.length === 1 ? modes[0] : undefined);
}

function modeValue(
  variable: FigmaVariable,
  context: ConversionContext,
  collections: Record<string, FigmaCollection>
): { value: FigmaValue; isOverride: boolean } {
  let current: FigmaCollection | undefined = context.collection;
  let mode: FigmaMode = context.mode;
  const seen = new Set<string>();
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
    const parent: FigmaCollection | undefined = collections[current.parentVariableCollectionId];
    if (!parent) throw new Error(`Missing parent collection for "${context.collection.name}".`);
    const parentMode = parent.modes?.find((item) => item.modeId === mode.parentModeId);
    if (!parentMode) throw new Error(`Missing parent mode for "${context.collection.name}/${context.mode.name}".`);
    mode = parentMode;
    current = parent;
  }
  return { value: variable.valuesByMode?.[context.baseModeId], isOverride: false };
}

function formatNativeValue(type: TokenType, value: FigmaValue): unknown {
  if (type === 'color' && isRgb(value)) {
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
    const bezier = (value as FigmaEasing | undefined)?.bezierValues;
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

function setNativePath(
  root: TokenGroup,
  segments: string[],
  value: NativeToken,
  variableId: string,
  collectionName: string,
  modeName: string
): void {
  if (segments.some((segment) => !segment || segment.startsWith('$') || /[{}.]/.test(segment) || segment === '__proto__' || segment === 'constructor' || segment === 'prototype')) {
    throw new Error(`Invalid DTCG token path "${segments.join('/')}" for ${variableId} in "${collectionName}/${modeName}".`);
  }
  let current: Record<string, unknown> = root;
  for (const segment of segments.slice(0, -1)) {
    const existing = current[segment];
    if (existing === undefined) {
      const group: TokenGroup = {};
      current[segment] = group;
      current = group;
    } else if (typeof existing !== 'object' || existing === null || '$type' in existing) {
      const wrapped: TokenGroup = { $root: existing as NativeToken };
      current[segment] = wrapped;
      current = wrapped;
    } else {
      current = existing as TokenGroup;
    }
  }
  const leaf = segments.at(-1) as string;
  const existing = current[leaf];
  if (existing !== undefined) {
    const existingToken = existing as TokenGroup;
    if (typeof existing === 'object' && existing !== null && !('$type' in existing) && existingToken.$root === undefined) {
      existingToken.$root = value;
    } else {
      const pathToken = existing as NativeToken;
      const rootToken = existingToken.$root as NativeToken | undefined;
      const existingId = (pathToken.$extensions as Record<string, unknown> | undefined)?.['com.figma.variableId']
        ?? (rootToken?.$extensions as Record<string, unknown> | undefined)?.['com.figma.variableId'];
      throw new Error(`Duplicate token path "${segments.join('/')}" in "${collectionName}/${modeName}": ${existingId} and ${variableId}.`);
    }
    return;
  }
  current[leaf] = value;
}

function validateNativeReferences(
  root: TokenGroup,
  referenceTokens: Set<NativeToken>,
  collectionName: string,
  modeName: string
): void {
  const tokens = new Map<string, NativeToken>();
  function collect(node: TokenGroup | Record<string, unknown>, path: string[] = []): void {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$extensions') continue;
      const tokenPath = [...path, key];
      const token = value as NativeToken;
      if (token?.$type) tokens.set(tokenPath.join('.'), token);
      else if (value && typeof value === 'object') collect(value as TokenGroup, tokenPath);
    }
  }
  collect(root);
  const checked = new Set<string>();
  function visit(path: string, visiting: Set<string> = new Set()): void {
    if (checked.has(path)) return;
    if (visiting.has(path)) throw new Error(`Circular token reference in "${collectionName}/${modeName}": ${[...visiting, path].join(' -> ')}`);
    const token = tokens.get(path);
    if (!token) throw new Error(`Missing token reference "${path}" in "${collectionName}/${modeName}".`);
    const reference = referenceTokens.has(token) && /^\{([^{}]+)\}$/.exec(String(token.$value));
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

function sortTokenTree<T extends object>(node: T): T {
  const sorted: Record<string, unknown> = {};
  const properties: string[] = [];
  const children: string[] = [];
  for (const key of Object.keys(node)) (key.startsWith('$') ? properties : children).push(key);
  children.sort();
  const entries = node as Record<string, unknown>;
  for (const key of children) sorted[key] = sortTokenTree(entries[key] as object);
  for (const key of properties) {
    sorted[key] = key === '$root' ? sortTokenTree(entries[key] as object) : entries[key];
  }
  return sorted as T;
}

function resolvedType(variable: FigmaVariable): FigmaVariableType | undefined {
  return variable.resolvedType ?? variable.type;
}

function isLength(variable: FigmaVariable): boolean {
  return variable.scopes?.some((scope) => LENGTH_SCOPES.has(scope)) === true
    || (variable.scopes?.includes('LINE_HEIGHT') === true && variable.name.includes('/figma-only/'));
}

function tokenType(variable: FigmaVariable): TokenType | undefined {
  const figmaType = resolvedType(variable);
  // REST documents only four primitive types; these named families carry richer semantics.
  if (figmaType === 'FLOAT' && /^felt\/(?:motion\/)?duration\//.test(variable.name)) return 'duration';
  if (figmaType === 'STRING' && /^felt\/(?:motion\/)?easing\//.test(variable.name)) return 'cubicBezier';
  if (figmaType === 'FLOAT' && isLength(variable)) return 'dimension';
  return figmaType ? TYPE_MAP[figmaType] : undefined;
}

function collectionRoot(
  collection: FigmaCollection,
  collections: Record<string, FigmaCollection>
): FigmaCollection {
  const root = collections[collection.rootVariableCollectionId ?? collection.baseCollectionId ?? ''];
  if (root) return root;
  let current = collection;
  const seen = new Set<string>();
  while (current.parentVariableCollectionId) {
    if (seen.has(current.id)) throw new Error(`Circular collection extension at "${current.name}".`);
    seen.add(current.id);
    const parent: FigmaCollection | undefined = collections[current.parentVariableCollectionId];
    if (!parent) throw new Error(`Missing parent collection for "${collection.name}".`);
    current = parent;
  }
  return current;
}

function rootModeId(
  collection: FigmaCollection,
  mode: FigmaMode,
  collections: Record<string, FigmaCollection>
): string {
  let current = collection;
  let selected: FigmaMode = mode;
  const seen = new Set<string>();
  while (current.parentVariableCollectionId) {
    if (seen.has(current.id)) throw new Error(`Circular collection extension at "${current.name}".`);
    seen.add(current.id);
    const parent = collections[current.parentVariableCollectionId];
    if (!parent) throw new Error(`Missing parent collection for "${collection.name}".`);
    selected = parent.modes?.find((item) => item.modeId === selected.parentModeId) as FigmaMode;
    if (!selected) throw new Error(`Missing parent mode for "${collection.name}/${mode.name}".`);
    current = parent;
  }
  return selected.modeId;
}
