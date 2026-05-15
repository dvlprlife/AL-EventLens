import type { Publisher, Subscriber } from '../al/types';

/**
 * For each subscriber, attempt to match it against a publisher in the
 * provided publisher set. Returns a new subscriber list where each entry
 * has its `resolved` flag set accordingly.
 *
 * Matching is `(target.kind, target.name, targetEvent)` — case-insensitive
 * on names so quoted and unquoted forms compare equal.
 */
export function resolveSubscribers(
  publishers: ReadonlyArray<Publisher>,
  subscribers: ReadonlyArray<Subscriber>
): Subscriber[] {
  throw new Error(`resolveSubscribers(${publishers.length} publishers, ${subscribers.length} subscribers): not yet implemented`);
}
