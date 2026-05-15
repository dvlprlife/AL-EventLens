import type { Publisher } from '../al/types';
import { parseFlatSymbols } from './schemaFlat';
import { parseNamespacesSymbols } from './schemaNamespaces';

/**
 * Detect which `SymbolReference.json` schema is in use and dispatch to
 * the correct parser. The BC 24+ schema nests everything under a
 * top-level `Namespaces[]`; the legacy schema lays object arrays out
 * flat at the root.
 */
export function parseSymbolReference(json: unknown, appId: string): Publisher[] {
  if (json !== null && typeof json === 'object' && 'Namespaces' in (json as object)) {
    return parseNamespacesSymbols(json, appId);
  }
  return parseFlatSymbols(json, appId);
}
