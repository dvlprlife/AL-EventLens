import type * as vscode from 'vscode';
import { stripComments } from './parser';
import type { ObjectRef, Publisher } from './types';

const TABLE_TRIGGER_EVENTS: ReadonlyArray<string> = [
  'OnBeforeInsertEvent',
  'OnAfterInsertEvent',
  'OnBeforeModifyEvent',
  'OnAfterModifyEvent',
  'OnBeforeDeleteEvent',
  'OnAfterDeleteEvent',
  'OnBeforeRenameEvent',
  'OnAfterRenameEvent',
  'OnBeforeValidateEvent',
  'OnAfterValidateEvent'
];

const PAGE_TRIGGER_EVENTS: ReadonlyArray<string> = [
  'OnOpenPageEvent',
  'OnClosePageEvent',
  'OnQueryClosePageEvent',
  'OnInsertRecordEvent',
  'OnModifyRecordEvent',
  'OnDeleteRecordEvent',
  'OnNewRecordEvent',
  'OnAfterGetCurrRecordEvent'
];

/**
 * For a Table or Page object, return the set of virtual publishers that
 * cover its implicit trigger events (`OnAfterDeleteEvent`,
 * `OnBeforeValidateEvent`, etc.). Called only when the user has opted in
 * via `alEventLens.includeTriggerEvents`.
 *
 * Returns `[]` for any other object kind, including `tableextension` and
 * `pageextension` — extensions don't define their own trigger events;
 * subscribers target the underlying table or page.
 *
 * Pass `sourceUri` (the URI of the workspace `.al` file declaring the
 * Table/Page) so the `EventIndexStore`'s save-survival filter can evict
 * these synthesized publishers when the same file is re-saved. `.app`-
 * bundled trigger owners have no workspace source file — call without
 * `sourceUri` for those; the resulting `undefined` survives every
 * workspace-save eviction (correct behavior — bundled triggers must not
 * be replaced by a workspace save event).
 */
export function synthesizeTriggerPublishers(
  owner: ObjectRef,
  sourceUri?: vscode.Uri
): Publisher[] {
  const events = triggerEventsFor(owner.kind);
  return events.map((eventName) => ({
    owner,
    eventName,
    kind: 'trigger' as const,
    location: undefined,
    sourceUri
  }));
}

function triggerEventsFor(kind: ObjectRef['kind']): ReadonlyArray<string> {
  switch (kind) {
    case 'table':
      return TABLE_TRIGGER_EVENTS;
    case 'page':
      return PAGE_TRIGGER_EVENTS;
    default:
      return [];
  }
}

// Object-header pattern aligned with src/al/parser.ts but limited to Table
// and Page (and their *extension* siblings, which we deliberately ignore —
// extensions don't define their own trigger events). Kept here rather than
// re-exported from parser.ts so callers can dedupe owners across many files
// in one pass without re-running the full publisher/subscriber regex sweep.
// Operates on comment-stripped text so commented-out headers don't
// synthesize phantom trigger publishers.
const tablePageHeaderRe =
  /^\s*(table|page)\b\s+(?:(\d+)\s+)?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/gim;

/**
 * Walk a single AL source file's text and emit one `ObjectRef` per Table or
 * Page header into the supplied dedup map. The map's keys are scoped by
 * `appId` (case-insensitive — GUID casing differs between `app.json` `id`
 * and `NavxManifest.xml` `Id`) so identically-named objects in different
 * packages aren't collapsed, and case-insensitive on name to match the
 * resolver. Only the dedup key is normalized; the emitted `ObjectRef`
 * keeps its source-cased `appId` for display/grouping. Pass the
 * same map across many files in a pass to dedupe globally; pass a fresh
 * empty map per file for incremental save handling.
 *
 * Used by the workspace indexer (full pass) and the save watcher
 * (incremental pass) to feed `synthesizeTriggerPublishers`.
 */
export function collectTriggerOwners(
  text: string,
  out: Map<string, ObjectRef>,
  appId?: string
): void {
  const cleaned = stripComments(text);
  // Reset lastIndex because the regex carries state across calls.
  tablePageHeaderRe.lastIndex = 0;
  for (const m of cleaned.matchAll(tablePageHeaderRe)) {
    const kind = m[1].toLowerCase() === 'table' ? 'table' : 'page';
    const id = m[2] ? parseInt(m[2], 10) : undefined;
    const name = m[3] ?? m[4] ?? '';
    if (!name) {
      continue;
    }
    const key = `${appId?.toLowerCase() ?? '__workspace__'}|${kind}|${name.toLowerCase()}`;
    if (out.has(key)) {
      continue;
    }
    out.set(key, { kind, id, name, appId });
  }
}
