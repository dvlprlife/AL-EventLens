import type { Publisher } from '../al/types';
import { parseNamespacesSymbols } from './schemaNamespaces';

/**
 * Parse a `SymbolReference.json` body (string or already-parsed object)
 * and return its declared publishers.
 *
 * Two schemas exist in the wild — legacy flat (object-kind arrays at the
 * root) and BC 24+ nested (object-kind arrays inside `Namespaces[]`,
 * possibly recursive). Real BC 26+ Microsoft packages carry **both**
 * surfaces in the same file (a few legacy un-namespaced objects at the
 * root, the vast majority inside `Namespaces[]`), so the parser must
 * always walk both rather than picking one. `parseNamespacesSymbols`
 * does exactly that — it extracts from the root container and recurses
 * into any nested namespaces — which makes it correct for both schemas.
 */
export function parseSymbolReference(json: unknown, appId: string): Publisher[] {
  return parseNamespacesSymbols(json, appId);
}
