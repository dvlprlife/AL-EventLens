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

/**
 * Friendly-name metadata for an app. For a dependency app this is populated
 * from the `.alpackages/*.app` `NavxManifest.xml` `<App Name="..."
 * Publisher="..."` attributes; for a workspace AL project it comes from the
 * project's `app.json` `name` / `publisher` fields. `name` / `appPublisher`
 * are optional — old/minimal `.app` packages and bare `app.json` files may
 * omit them. `appPublisher` is named explicitly (rather than `publisher`)
 * to avoid colliding with the AL EventLens domain concept of an *event
 * publisher*.
 */
export interface AppMeta {
  readonly appId: string;
  readonly name?: string;
  readonly appPublisher?: string;
  /** True when this entry describes a workspace AL project (sourced from an
   *  `app.json`), as opposed to a `.alpackages/*.app` dependency package.
   *  Drives the tree's workspace-first sort and `root-folder` icon. */
  readonly isWorkspaceApp?: boolean;
}

/** Identifier for an AL object — the (kind, id, name) triple. */
export interface ObjectRef {
  readonly kind: ObjectKind;
  /** Numeric object id when known (synthesized trigger publishers always have one; pure AL source may omit). */
  readonly id?: number;
  /** Object name as declared in source. */
  readonly name: string;
  /** Owning app id — the `.app` GUID for a packaged dependency, or the
   *  workspace `app.json` `id` for an object parsed from a workspace AL
   *  project. `undefined` for a loose `.al` file under no `app.json`. */
  readonly appId?: string;
}

/**
 * One parameter on an event publisher's procedure signature — captured so the
 * panel detail pane can show subscribers what data the event exposes. Sourced
 * from AL source for workspace publishers and from `SymbolReference.json`'s
 * `Parameters[]` for `.alpackages/*.app` publishers. Synthesized trigger
 * publishers carry no parameters (their signatures are implicit and vary by
 * trigger).
 */
export interface Parameter {
  /** Parameter name as declared. */
  readonly name: string;
  /** Type text in AL form, e.g. `Boolean`, `Integer`, `Code[20]`, `Record "Sales Header"`. */
  readonly typeText: string;
  /** True if declared with the `var` modifier. */
  readonly isVar: boolean;
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
  /**
   * Procedure parameters, when known. Undefined for synthesized trigger
   * publishers and for any publisher whose source couldn't be parsed (e.g.
   * a malformed `Parameters[]` entry in `SymbolReference.json`). An empty
   * array means "parsed and confirmed to take no parameters."
   */
  readonly parameters?: ReadonlyArray<Parameter>;
}

/**
 * A test **handler method** — a procedure carrying one of AL's handler
 * attributes (`[MessageHandler]`, `[ConfirmHandler]`, `[PageHandler]`, …).
 * These are only legal inside a codeunit with `SubType = Test`.
 */
export interface HandlerDeclaration {
  /** Codeunit declaring the handler. */
  readonly owner: ObjectRef;
  /** The handler procedure's own name — the name tests reference it by. */
  readonly name: string;
  /** The attribute that marks it, source-cased, e.g. `MessageHandler`. */
  readonly handlerKind: string;
  /** Source location of the procedure declaration. */
  readonly location: vscode.Location;
}

/**
 * One `[HandlerFunctions('A,B')]` attribute — a test method's declaration of
 * the handler methods it uses. AL resolves these **within the same test
 * codeunit only**, so `owner` scopes the reference completely; there is no
 * cross-file or cross-app target as there is for a `Subscriber`.
 */
export interface HandlerReference {
  /** Codeunit declaring the referencing test method. */
  readonly owner: ObjectRef;
  /** The test procedure carrying the `[HandlerFunctions]` attribute. */
  readonly testMethod: string;
  /** Handler names listed in the attribute, trimmed, in source order. */
  readonly handlerNames: ReadonlyArray<string>;
  /** Source location of the test procedure declaration. */
  readonly location: vscode.Location;
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
