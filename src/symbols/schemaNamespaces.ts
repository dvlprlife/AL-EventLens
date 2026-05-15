import type { Publisher } from '../al/types';

/**
 * Parse the **nested `Namespaces[]`** `SymbolReference.json` schema
 * (dominant in BC 24+) and return its declared publishers. As with the
 * flat schema, subscribers are not present in `SymbolReference.json`.
 */
export function parseNamespacesSymbols(json: unknown, appId: string): Publisher[] {
  throw new Error(`parseNamespacesSymbols(appId=${appId}, typeof json=${typeof json}): not yet implemented`);
}
