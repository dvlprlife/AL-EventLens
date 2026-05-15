import type { Publisher } from '../al/types';

/**
 * Parse the **legacy flat** `SymbolReference.json` schema (pre-BC 24) and
 * return its declared publishers. Subscribers are not represented in
 * `SymbolReference.json` — they are stripped at compile time — so this
 * function returns publishers only.
 */
export function parseFlatSymbols(json: unknown, appId: string): Publisher[] {
  throw new Error(`parseFlatSymbols(appId=${appId}, typeof json=${typeof json}): not yet implemented`);
}
