# Change Log

All notable changes to the AL EventLens extension will be documented in this file. This project adheres to [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- AL source parser (`src/al/parser.ts`) recognizes publisher (`[IntegrationEvent]`, `[BusinessEvent]`) and subscriber (`[EventSubscriber]`, both pre-BC22 and BC22+ syntaxes) declarations across all AL object kinds, returning typed `Publisher` and `Subscriber` records with `vscode.Location` pointing at the procedure name.
- Trigger-event synthesis (`src/al/triggers.ts`) produces 10 virtual publishers per Table object (`OnBeforeInsertEvent`, `OnAfterInsertEvent`, `OnBeforeModifyEvent`, `OnAfterModifyEvent`, `OnBeforeDeleteEvent`, `OnAfterDeleteEvent`, `OnBeforeRenameEvent`, `OnAfterRenameEvent`, `OnBeforeValidateEvent`, `OnAfterValidateEvent`) and 8 per Page object (`OnOpenPageEvent`, `OnClosePageEvent`, `OnQueryClosePageEvent`, `OnInsertRecordEvent`, `OnModifyRecordEvent`, `OnDeleteRecordEvent`, `OnNewRecordEvent`, `OnAfterGetCurrRecordEvent`). The indexer will gate this on the `alEventLens.includeTriggerEvents` setting.
- `.app` package reader (`src/symbols/appReader.ts`) reads BC application packages via `vscode.workspace.fs` (web-compatible), validates the 40-byte NAVX header, decompresses the embedded PKZIP with JSZip, and extracts the `appId`, `version`, `SymbolReference.json` body, and bundled AL source files under `src/**`. `.NEA` runtime packages are detected by extension and rejected with a clear error rather than a silent failure.
- Legacy `SymbolReference.json` schema parser (`src/symbols/schemaFlat.ts`) extracts publisher events (`IntegrationEvent`, `BusinessEvent`) from the pre-BC24 flat schema for Codeunits, Tables, Pages, Reports, Queries, XmlPorts, and Interfaces. Accepts either a JSON string (with optional UTF-8 BOM, common in Microsoft `.app` packages) or an already-parsed object.
- Nested-namespaces `SymbolReference.json` schema parser (`src/symbols/schemaNamespaces.ts`) handles the BC24+ schema where object-kind arrays live recursively inside `Namespaces[]` entries. Walks both root-level arrays and nested namespaces at any depth. Reuses `extractPublishersFromContainer` from `schemaFlat.ts` so the per-object/per-method walk isn't duplicated. With this, `detect.ts` routes both schemas correctly: `Namespaces` key present → nested parser, otherwise → flat parser. The full `.app` ingestion pipeline (`readApp` → `parseSymbolReference`) is now operational; the indexer just needs to wire it into a workspace scan.
- Subscriber-to-publisher resolver (`src/index/resolver.ts`) sets the `resolved` flag on each subscriber by matching `(kind, name, eventName)` case-insensitively against the workspace publisher set. Trigger publishers participate equally with `[IntegrationEvent]` / `[BusinessEvent]` publishers; `Subscriber.target.appId` is ignored so cross-app resolution works. Pure function over already-parsed `Publisher[]` and `Subscriber[]` — no I/O, no `vscode` runtime imports — ready to compose into the workspace indexer.
- Workspace event indexer (`src/index/indexer.ts`) composes the AL parser, trigger synthesizer, `.app` reader, schema parsers, and subscriber resolver into a single `buildIndex(context)` call. Walks `**/*.al` under workspace folders and `**/.alpackages/*.app`, gates package scanning on `alEventLens.scanAlpackages` and trigger synthesis on `alEventLens.includeTriggerEvents`, tolerates a corrupted or `.NEA`-rejected `.app` per package via `console.warn` without aborting the run, and returns a fully resolved `EventIndex`. `extension.ts` invokes it during `activate()` and logs publisher/subscriber counts for verification — no panel, tree, or CodeLens wiring yet.

### Changed

- Dual-platform bundle: `package.json` now declares both `main` (Node bundle at `dist/extension.js`) and `browser` (Web Worker bundle at `dist/web/extension.js`). VS Code Desktop loads the Node bundle; `vscode.dev` and `github.dev` continue to load the browser bundle. Source-level web-discipline is preserved — the browser bundle is built from the same source and would fail to build if anything used Node-only APIs.

## [0.1.0] - 2026-05-14

Initial public release.

### Added

- Workspace-wide indexing of event publishers (`[IntegrationEvent]`, `[BusinessEvent]`) and subscribers (`[EventSubscriber]`) from `.al` files. Both pre-BC22 (`'Codeunit Name'`, `'OnEvent'`) and BC22+ (`Codeunit::"Name"`, `OnEvent`) subscriber syntaxes are recognized.
- Indexing of publishers from `.alpackages/*.app` packages via `SymbolReference.json`, supporting both the legacy flat schema and the BC 24+ nested `Namespaces[]` schema. Encrypted `.NEA` runtime packages are detected and skipped with a clear diagnostic.
- Trigger-event synthesis: virtual publishers for `OnAfterDeleteEvent`, `OnBeforeValidateEvent`, etc. on Table and Page objects, gated by `alEventLens.includeTriggerEvents`.
- Subscriber → publisher link resolution with **resolved** / **unresolved** status per subscriber.
- Webview panel — searchable publisher list with subscriber-count badges and a subscriber-detail view; jump-to-source on click.
- Activity-bar view (`AL EventLens`) listing publishers grouped by source app.
- CodeLens above `[IntegrationEvent]` and `[BusinessEvent]` declarations showing the live subscriber count, gated by `alEventLens.codeLens.enabled`.
- Mermaid export command copies the current publisher's subscriber graph to the clipboard as a Mermaid diagram.
- Incremental re-index on file save, gated by `alEventLens.indexOnSave`.
- Persistent cache in `extensionContext.globalStorageUri` keyed by `(appId, version, mtime)`, gated by `alEventLens.cache.enabled`.
- Five `alEventLens.*` settings governing cache, save-watching, package scanning, trigger synthesis, and CodeLens display.
- VS Code Web compatibility — all file access uses `vscode.workspace.fs` and `.app` decompression uses JSZip, so the extension runs on `vscode.dev` and `github.dev`.
