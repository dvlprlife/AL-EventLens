import type { Publisher, Subscriber } from '../al/types';

/**
 * Render a publisher and its subscribers as a Mermaid `graph LR` diagram
 * suitable for pasting into a Markdown document or design review.
 */
export function renderMermaid(
  publisher: Publisher,
  subscribers: ReadonlyArray<Subscriber>
): string {
  throw new Error(`renderMermaid(${publisher.owner.name}.${publisher.eventName}, ${subscribers.length} subscribers): not yet implemented`);
}
