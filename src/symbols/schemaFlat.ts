import type { EventKind, ObjectKind, Parameter, Publisher } from '../al/types';

const CONTAINER_KINDS: ReadonlyArray<readonly [string, ObjectKind]> = [
  ['Codeunits', 'codeunit'],
  ['Tables', 'table'],
  ['Pages', 'page'],
  ['Reports', 'report'],
  ['Queries', 'query'],
  ['XmlPorts', 'xmlport'],
  ['Interfaces', 'interface']
];

/**
 * Parse the **legacy flat** `SymbolReference.json` schema (pre-BC 24) and
 * return its declared publishers. Subscribers are not represented in
 * `SymbolReference.json` — they are stripped at compile time — so this
 * function returns publishers only.
 *
 * Accepts either a JSON string (with optional UTF-8 BOM) or an
 * already-parsed unknown. The BC24+ nested `Namespaces[]` schema is
 * handled by a separate parser; this one walks only the top-level
 * object-kind arrays.
 */
export function parseFlatSymbols(json: unknown, appId: string): Publisher[] {
  const root = coerceToObject(json, 'parseFlatSymbols');
  return extractPublishersFromContainer(root, appId);
}

/**
 * Extract publishers from a single container object that has top-level
 * `Codeunits[]` / `Tables[]` / `Pages[]` / etc. arrays. Exported so the
 * nested `Namespaces[]` schema parser can call it recursively.
 */
export function extractPublishersFromContainer(
  container: unknown,
  appId: string
): Publisher[] {
  if (!isPlainObject(container)) {
    return [];
  }
  const publishers: Publisher[] = [];
  for (const [arrayKey, ownerKind] of CONTAINER_KINDS) {
    const arr = container[arrayKey];
    if (!Array.isArray(arr)) {
      continue;
    }
    for (const obj of arr) {
      collectFromObject(obj, ownerKind, appId, publishers);
    }
  }
  return publishers;
}

function collectFromObject(
  obj: unknown,
  ownerKind: ObjectKind,
  appId: string,
  out: Publisher[]
): void {
  if (!isPlainObject(obj)) {
    return;
  }
  const name = typeof obj.Name === 'string' ? obj.Name : '';
  if (!name) {
    return;
  }
  const idValue = obj.Id;
  const id = typeof idValue === 'number' ? idValue : undefined;
  const methods = obj.Methods;
  if (!Array.isArray(methods)) {
    return;
  }
  for (const method of methods) {
    const kind = eventKindFor(method);
    if (!kind) {
      continue;
    }
    if (!isPlainObject(method) || typeof method.Name !== 'string') {
      continue;
    }
    out.push({
      owner: { kind: ownerKind, id, name, appId },
      eventName: method.Name,
      kind,
      location: undefined,
      parameters: extractParameters(method.Parameters)
    });
  }
}

/**
 * Convert `SymbolReference.json` `Parameters[]` into `Parameter` records. The
 * shape mirrors AL: each entry has `Name`, optional `IsVar`, and a
 * `TypeDefinition` that describes the type. Unknown / malformed entries are
 * skipped silently — surfacing them as errors would force the indexer to
 * abort an otherwise-usable package over cosmetic data.
 */
function extractParameters(raw: unknown): ReadonlyArray<Parameter> | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const out: Parameter[] = [];
  for (const p of raw) {
    if (!isPlainObject(p) || typeof p.Name !== 'string') {
      continue;
    }
    const typeText = renderTypeDefinition(p.TypeDefinition);
    if (!typeText) {
      continue;
    }
    out.push({
      name: p.Name,
      typeText,
      isVar: p.IsVar === true
    });
  }
  return out;
}

/**
 * Render a `SymbolReference.json` `TypeDefinition` as AL source text. Handles
 * the common shapes seen in BC symbols:
 *
 *  - Bare scalars: `{ Name: 'Boolean' }` → `Boolean`
 *  - Length-bound text: `{ Name: 'Code', Length: 20 }` → `Code[20]`
 *  - Subtyped scalars: `{ Name: 'Record', Subtype: { Name: 'Sales Header' } }` → `Record "Sales Header"`
 *    Names without spaces are emitted unquoted; names with spaces or special
 *    characters round-trip through `"…"` so the displayed signature is valid
 *    AL syntax.
 *  - Generics: `{ Name: 'List', TypeArguments: [...] }` → `List of [Code[20]]`
 *
 * Falls back to the bare `Name` for shapes we don't recognize. Returns
 * `undefined` only if the input isn't an object at all.
 */
function renderTypeDefinition(td: unknown): string | undefined {
  if (!isPlainObject(td) || typeof td.Name !== 'string') {
    return undefined;
  }
  const base = td.Name;
  if (typeof td.Length === 'number' && td.Length > 0) {
    return `${base}[${td.Length}]`;
  }
  if (isPlainObject(td.Subtype) && typeof td.Subtype.Name === 'string') {
    return `${base} ${quoteIfNeeded(td.Subtype.Name)}`;
  }
  if (Array.isArray(td.TypeArguments) && td.TypeArguments.length > 0) {
    const args = td.TypeArguments
      .map((t) => renderTypeDefinition(t))
      .filter((s): s is string => typeof s === 'string');
    if (args.length > 0) {
      return `${base} of [${args.join(', ')}]`;
    }
  }
  return base;
}

function quoteIfNeeded(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${name}"`;
}

function eventKindFor(method: unknown): EventKind | undefined {
  if (!isPlainObject(method)) {
    return undefined;
  }
  const attrs = method.Attributes;
  if (!Array.isArray(attrs)) {
    return undefined;
  }
  for (const attr of attrs) {
    if (!isPlainObject(attr) || typeof attr.Name !== 'string') {
      continue;
    }
    const lower = attr.Name.toLowerCase();
    if (lower === 'integrationevent') {
      return 'integration';
    }
    if (lower === 'businessevent') {
      return 'business';
    }
  }
  return undefined;
}

export function coerceToObject(json: unknown, label: string): unknown {
  if (typeof json === 'string') {
    const body = json.charCodeAt(0) === 0xFEFF ? json.slice(1) : json;
    try {
      return JSON.parse(body);
    } catch (e) {
      const cause = e instanceof Error ? e.message : String(e);
      throw new Error(`${label}: input string is not valid JSON (${cause})`);
    }
  }
  if (json === null || json === undefined) {
    throw new Error(`${label}: input is ${json === null ? 'null' : 'undefined'}`);
  }
  if (typeof json !== 'object') {
    throw new Error(`${label}: input is a ${typeof json}, expected string or object`);
  }
  return json;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
