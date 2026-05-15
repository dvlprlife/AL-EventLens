import type { Publisher } from '../al/types';
import { coerceToObject, extractPublishersFromContainer, isPlainObject } from './schemaFlat';

/**
 * Parse the **nested `Namespaces[]`** `SymbolReference.json` schema
 * (dominant in BC 24+) and return its declared publishers. As with the
 * flat schema, subscribers are not present in `SymbolReference.json`.
 *
 * The per-object/per-method shape is identical to the flat schema — only
 * the namespace nesting differs. Object arrays may appear both at the
 * root (for un-namespaced objects) and inside each `Namespaces[]` entry,
 * which can itself contain further `Namespaces[]` entries. Walk all of
 * them.
 */
export function parseNamespacesSymbols(json: unknown, appId: string): Publisher[] {
  const root = coerceToObject(json, 'parseNamespacesSymbols');
  return walkNamespaceTree(root, appId);
}

function walkNamespaceTree(container: unknown, appId: string): Publisher[] {
  const out: Publisher[] = [...extractPublishersFromContainer(container, appId)];
  if (isPlainObject(container) && Array.isArray(container.Namespaces)) {
    for (const ns of container.Namespaces) {
      out.push(...walkNamespaceTree(ns, appId));
    }
  }
  return out;
}
