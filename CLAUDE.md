# AL EventLens

VS Code extension for indexing and visualizing event publishers and
subscribers across an AL/Business Central workspace and its dependency apps.

## Identity
- Publisher: `dvlprlife`
- Extension ID: `dvlprlife.al-eventlens`
- Display name: `AL EventLens`
- Command palette prefix (display): `AL EventLens:`
- Command IDs (internal): `alEventLens.*` (camelCase)
- Settings prefix: `alEventLens.`
- Activity bar view ID: `alEventLensView`
- Engine: `^1.85.0`
- License: MIT
- Tagline: *See event publishers and subscribers across your AL workspace,
  and the lines that connect them.*

## Author conventions (carry from existing dvlprlife extensions)
Before generating new code or docs, read the two reference repos:
- `C:/Users/brad/GitHub/Markdown-Forge`
- `C:/Users/brad/GitHub/Selection-Count`

Match the patterns you find there. Specifically:
- README structure: tagline → short paragraph → Demo (GIFs) → Features
  (bold name + dash + plain explanation) → Commands table → Keybindings
  table → Settings table → Requirements → Issues → License.
- Tone: direct and technical. No hyperbole, no marketing voice.
- Settings keys: camelCase namespaced (e.g. `alEventLens.cache.enabled`).
- Command IDs: `alEventLens.verbNoun` (e.g. `alEventLens.openPanel`).
- Repo name on GitHub: Title-Case-Hyphenated (`AL-EventLens`).

## Files to mirror from existing dvlprlife extensions
Before generating these files for AL EventLens, read the equivalents in
both reference repos and match their structure, format, and tone:
- `README.md` — section order, headings, demo block layout
- `CHANGELOG.md` — format, version-bump conventions, entry style
- `AGENTS.md` — content and style; this is the human/AI collaboration
  guide for the repo and must read consistently across the portfolio
- `package.json` — fields used, ordering, contributor conventions
- `tsconfig.json` — strictness, target, module settings
- `.vscodeignore` — what's excluded from the .vsix
- ESLint config if present
- Folder layout under `src/`

If the two reference repos disagree on any convention, stop and ask
which to follow rather than picking. Don't average them.

For `AGENTS.md` specifically: mirror the structure and tone of the
existing two exactly, then add an "AL-specific notes" section at the
end with the architecture decisions below.

## Architecture decisions already locked in
- **Source of truth for events: AL source files (.al), parsed by regex.**
  SymbolReference.json in compiled .app packages does NOT preserve
  [EventSubscriber] attributes — they're stripped at compile time.
  Publishers ARE preserved in SymbolReference.json but we parse source
  uniformly for consistency.
- **.app file format**: 40-byte NAVX header + standard PKZIP. .NEA files
  are encrypted runtime packages and unreadable; detect and skip with a
  clear error.
- **Two SymbolReference schemas** in the wild: flat (older) and nested
  `Namespaces[]` (BC 24+, dominant in BC 28). Both must be supported.
- **Two EventSubscriber syntaxes**: pre-BC22 (string-literal target and
  quoted event name) and BC22+ (`Codeunit::"Name"` and bare event
  identifier). Both must be supported by the regex.
- **Trigger events** on tables/pages (`OnAfterDeleteEvent`,
  `OnBeforeValidateEvent`, etc.) are implicit; synthesize virtual
  publishers for each Table/Page object during indexing.
- **Cache strategy**: parse on workspace open, cache to
  `extensionContext.globalStorageUri` keyed by (appId, version, mtime).
- **VS Code Web compatibility**: use only `vscode.workspace.fs`
  (not Node `fs`) and a browser-compatible zip lib (JSZip).

## Validated in POC (Python prototype, see prior chat)
- Tested against four real `.app` files (Microsoft BaseApp,
  Business Foundation, Test Runner, plus a third-party extension).
- ~30 ms to index all four apps end-to-end.
- 162 publishers, 54 subscribers found.
- 33/54 subscriber→publisher links resolved without BaseApp loaded
  (remaining 21 are BaseApp / system targets and resolve once BaseApp
  is present in `.alpackages`).

## Key technical references
- BC events docs:
  https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/devenv-subscribing-to-events
- Closest competitor: AL Object Designer (`martonsagi.al-object-designer`)
  — lists subscribers but no bidirectional graph and no cross-app
  resolution. AL EventLens differentiates by surfacing resolved
  subscriber→publisher links across the workspace and dependencies.

## v1 scope (in)
- Index publishers + subscribers from workspace `.al` files
- Index publishers from `.alpackages/*.app` (SymbolReference.json) and
  subscribers from bundled `src/*.al` when present
- Webview panel: searchable publisher list + subscriber detail
- Subscriber-count badges on publishers in the list
- "Resolved" vs "unresolved" status per subscriber
- Jump-to-source on click
- CodeLens above `[IntegrationEvent]` / `[BusinessEvent]` declarations
  showing subscriber count
- Mermaid export
- Trigger-event synthesis for Tables and Pages
- Incremental re-index on file save

## v1 scope (out, defer to later versions)
- Graph / force-directed visualization
- Runtime event recorder integration
- Transitive cascade analysis ("if I subscribe to X, what does my
  subscriber's code transitively trigger?")
- Ordering / conflict detection between multiple subscribers on the
  same event
- Reading from `.NEA` runtime packages (impossible; they're encrypted)