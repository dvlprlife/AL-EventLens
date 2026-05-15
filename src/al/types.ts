import * as vscode from 'vscode';

/** AL object kinds we care about for event indexing. */
export type ObjectKind =
  | 'codeunit'
  | 'table'
  | 'tableextension'
  | 'page'
  | 'pageextension'
  | 'report'
  | 'reportextension'
  | 'query'
  | 'xmlport'
  | 'enum'
  | 'enumextension'
  | 'permissionset'
  | 'interface';

/** What flavor of event a publisher emits. */
export type EventKind = 'integration' | 'business' | 'trigger';

/** Identifier for an AL object — the (kind, id, name) triple. */
export interface ObjectRef {
  readonly kind: ObjectKind;
  /** Numeric object id when known (synthesized trigger publishers always have one; pure AL source may omit). */
  readonly id?: number;
  /** Object name as declared in source. */
  readonly name: string;
  /** Owning app id, when the object came from a packaged dependency. */
  readonly appId?: string;
}

/** A discovered event publisher. */
export interface Publisher {
  readonly owner: ObjectRef;
  /** Procedure name that carries `[IntegrationEvent]`/`[BusinessEvent]`, or the trigger name for synthesized publishers. */
  readonly eventName: string;
  readonly kind: EventKind;
  /** Source location of the procedure declaration, or undefined for synthesized triggers. */
  readonly location?: vscode.Location;
  /**
   * URI of the source file this publisher is attributed to, when known.
   * Real publishers carry their position in `location`; this field exists
   * so the save watcher can tag synthesized **trigger** publishers (which
   * have no `location`) with the file that contributed them, letting the
   * `EventIndexStore` replace them on a subsequent save instead of
   * accumulating duplicates.
   */
  readonly sourceUri?: vscode.Uri;
}

/** A discovered event subscriber. */
export interface Subscriber {
  /** The procedure declaring `[EventSubscriber(...)]`. */
  readonly owner: ObjectRef;
  /** Target object the subscriber listens to. */
  readonly target: ObjectRef;
  /** Target event name the subscriber listens for. */
  readonly targetEvent: string;
  /** Source location of the procedure declaration. */
  readonly location: vscode.Location;
  /** True once link resolution has matched this subscriber to a known publisher. */
  readonly resolved: boolean;
}
