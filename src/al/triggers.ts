import type { ObjectRef, Publisher } from './types';

/**
 * For a Table or Page object, return the set of virtual publishers that
 * cover its implicit trigger events (`OnAfterDeleteEvent`,
 * `OnBeforeValidateEvent`, etc.). Called only when the user has opted in
 * via `alEventLens.includeTriggerEvents`.
 */
export function synthesizeTriggerPublishers(owner: ObjectRef): Publisher[] {
  throw new Error(`synthesizeTriggerPublishers(${owner.kind} ${owner.name}): not yet implemented`);
}
