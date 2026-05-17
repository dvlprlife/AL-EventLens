import type { ObjectKind, Publisher, Subscriber } from '../al/types';

/** Same label-casing as `treeView.ts`'s `formatKind`. Kept inline because the
 *  table is small and the only other consumer (the tree) lives in a peer
 *  module — promoting to a shared helper waits for the third caller. */
function formatKind(kind: ObjectKind): string {
  switch (kind) {
    case 'codeunit':         return 'Codeunit';
    case 'table':            return 'Table';
    case 'tableextension':   return 'TableExtension';
    case 'page':             return 'Page';
    case 'pageextension':    return 'PageExtension';
    case 'report':           return 'Report';
    case 'reportextension':  return 'ReportExtension';
    case 'query':            return 'Query';
    case 'xmlport':          return 'XmlPort';
    case 'enum':             return 'Enum';
    case 'enumextension':    return 'EnumExtension';
    case 'permissionset':    return 'PermissionSet';
    case 'interface':        return 'Interface';
  }
}

/** Mermaid-safe label fragment. Inside `["..."]`, only `"` and newlines need
 *  escaping for the AL identifier shapes we emit. */
function escapeLabel(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/\r?\n/g, '<br/>');
}

function publisherLabel(p: Publisher): string {
  return `${formatKind(p.owner.kind)}::&quot;${escapeLabel(p.owner.name)}&quot;<br/>${escapeLabel(p.eventName)}`;
}

function subscriberLabel(s: Subscriber): string {
  const line = s.location.range.start.line + 1;
  return `${formatKind(s.owner.kind)}::&quot;${escapeLabel(s.owner.name)}&quot;<br/>:${line}`;
}

/** Deterministic sort so re-exporting the same selection yields a
 *  byte-identical Mermaid string (matters for design-doc diffs). */
function sortSubscribers(subscribers: ReadonlyArray<Subscriber>): Subscriber[] {
  return [...subscribers].sort((a, b) => {
    const byApp = (a.owner.appId ?? '').localeCompare(b.owner.appId ?? '');
    if (byApp !== 0) { return byApp; }
    const byKind = a.owner.kind.localeCompare(b.owner.kind);
    if (byKind !== 0) { return byKind; }
    const byName = a.owner.name.localeCompare(b.owner.name);
    if (byName !== 0) { return byName; }
    return a.location.range.start.line - b.location.range.start.line;
  });
}

/**
 * Render a publisher and its subscribers as a Mermaid `graph LR` diagram
 * suitable for pasting into a Markdown document or design review.
 *
 * Resolved subscribers connect with a solid arrow (`-->`); unresolved with
 * a dotted arrow (`-.->`). Subscribers are sorted by
 * `(owner.appId, owner.kind, owner.name, line)` and assigned stable
 * `S1`..`SN` ids so the output is deterministic.
 */
export function renderMermaid(
  publisher: Publisher,
  subscribers: ReadonlyArray<Subscriber>
): string {
  const lines: string[] = ['graph LR'];
  lines.push(`    P["${publisherLabel(publisher)}"]`);

  const sorted = sortSubscribers(subscribers);
  sorted.forEach((s, i) => {
    lines.push(`    S${i + 1}["${subscriberLabel(s)}"]`);
  });
  sorted.forEach((s, i) => {
    const arrow = s.resolved ? '-->' : '-.->';
    lines.push(`    P ${arrow} S${i + 1}`);
  });

  return lines.join('\n') + '\n';
}
