import type { ObjectKind, Publisher, Subscriber } from '../al/types';

/**
 * Canonical key for matching a publisher to its subscribers. Case-insensitive
 * on name and event so quoted/unquoted and mixed-case forms compare equal.
 *
 * Used by `resolveSubscribers`, the CodeLens count, the export-Mermaid
 * handler, and anywhere else that needs publisher ↔ subscriber correlation.
 * The webview keeps its own JS-encoded copy because it runs in the iframe
 * sandbox and cannot import TS modules; if the matching rule ever changes,
 * `src/ui/panelHtml.ts:findSubscribersFor` must move in lockstep.
 */
function matchKey(kind: ObjectKind, name: string, event: string): string {
  return `${kind} ${name.toLowerCase()} ${event.toLowerCase()}`;
}

/** Key derived from a publisher's (owner.kind, owner.name, eventName). */
export function publisherKey(p: Publisher): string {
  return matchKey(p.owner.kind, p.owner.name, p.eventName);
}

/** Key derived from a subscriber's (target.kind, target.name, targetEvent). */
export function subscriberKey(s: Subscriber): string {
  return matchKey(s.target.kind, s.target.name, s.targetEvent);
}

/** All subscribers whose target matches the given publisher. */
export function findSubscribersFor(
  publisher: Publisher,
  subscribers: ReadonlyArray<Subscriber>
): Subscriber[] {
  const k = publisherKey(publisher);
  return subscribers.filter((s) => subscriberKey(s) === k);
}

/** Map from publisher key → count of subscribers targeting that key. */
export function countSubscribersByPublisherKey(
  subscribers: ReadonlyArray<Subscriber>
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of subscribers) {
    const k = subscriberKey(s);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}
