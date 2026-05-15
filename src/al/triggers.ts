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
 */
export function synthesizeTriggerPublishers(owner: ObjectRef): Publisher[] {
  const events = triggerEventsFor(owner.kind);
  return events.map((eventName) => ({
    owner,
    eventName,
    kind: 'trigger' as const,
    location: undefined
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
