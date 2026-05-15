import type { ObjectKind, Publisher, Subscriber } from '../al/types';

const key = (kind: ObjectKind, name: string, event: string): string =>
  `${kind} ${name.toLowerCase()} ${event.toLowerCase()}`;

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
  const known = new Set<string>();
  for (const p of publishers) {
    known.add(key(p.owner.kind, p.owner.name, p.eventName));
  }
  return subscribers.map((s) => ({
    ...s,
    resolved: known.has(key(s.target.kind, s.target.name, s.targetEvent)),
  }));
}
