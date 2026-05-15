# AL EventLens

See event publishers and subscribers across your AL workspace, and the lines that connect them.

AL EventLens indexes every `[IntegrationEvent]`, `[BusinessEvent]`, and `[EventSubscriber]` in your AL workspace and its `.alpackages` dependencies, then surfaces the resolved publisher → subscriber graph in a searchable panel, an activity-bar view, and inline CodeLens hints. No more grepping across apps to figure out who is listening to which event.

## Demo

_Demo GIFs and screenshots will be added once the first UI surface ships._

## Features

- **Workspace-wide event index** — Parses every `.al` file in the workspace and every `.app` in `.alpackages` to build a single index of publishers and subscribers. Pre-BC22 (`'Codeunit Name'`, `'OnEvent'`) and BC22+ (`Codeunit::"Name"`, `OnEvent`) subscriber syntaxes are both recognized.
- **Resolved subscriber → publisher links** — Each subscriber is matched against its target publisher and marked **resolved** or **unresolved**. Unresolved subscribers usually mean the target app is missing from `.alpackages`; resolved ones are click-jumpable.
- **Trigger events as first-class publishers** — Implicit table and page trigger events (`OnAfterDeleteEvent`, `OnBeforeValidateEvent`, …) are synthesized as virtual publishers so subscribers to them resolve cleanly.
- **Searchable webview panel** — Publisher list with subscriber-count badges; click a publisher to see all subscribers in a detail pane; click a subscriber to jump to its source.
- **Activity-bar view** — A dedicated `AL EventLens` view groups publishers by their source app.
- **CodeLens** — Live subscriber-count CodeLens above each `[IntegrationEvent]` and `[BusinessEvent]` declaration. Click it to open the panel scoped to that publisher.
- **Mermaid export** — One command renders the current publisher's subscriber set as a Mermaid diagram for docs or design reviews.
- **Incremental re-index on save** — Saved AL files re-parse just the touched objects; the rest of the index stays warm.
- **Persistent cache** — Parsed `.app` results are cached in extension global storage, keyed by `(appId, version, mtime)`, so re-opening a workspace is near-instant.
- **VS Code Web ready** — All file access goes through `vscode.workspace.fs`, so the extension runs on `vscode.dev` and `github.dev` as well as desktop.

## Commands

| Command | Description |
| --- | --- |
| `AL EventLens: Open Panel` | Open the searchable publisher/subscriber webview panel. |
| `AL EventLens: Refresh Index` | Force a full re-index of the workspace and `.alpackages` dependencies. |
| `AL EventLens: Reveal Publisher` | Open the panel scoped to the publisher under the cursor (also fired by CodeLens). |
| `AL EventLens: Go to Subscriber` | Jump to the source location of a subscriber selected in the panel. |
| `AL EventLens: Export to Mermaid` | Copy a Mermaid diagram of the current publisher's subscribers to the clipboard. |

All commands are available through the Command Palette (search for "AL EventLens") and through the activity-bar view.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `alEventLens.cache.enabled` | `true` | Cache parsed `.app` symbol results in extension global storage. |
| `alEventLens.indexOnSave` | `true` | Re-index AL files incrementally when they are saved. |
| `alEventLens.scanAlpackages` | `true` | Index `.alpackages/*.app` packages in addition to workspace source. |
| `alEventLens.includeTriggerEvents` | `true` | Synthesize virtual publishers for table/page trigger events. |
| `alEventLens.codeLens.enabled` | `true` | Show subscriber-count CodeLens above event declarations. |

## Requirements

- Visual Studio Code 1.85 or later.

## Issues and feedback

Please file issues and feature requests on [GitHub](https://github.com/dvlprlife/AL-EventLens).

## License

MIT
