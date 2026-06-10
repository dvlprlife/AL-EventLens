# Contributing to AL EventLens

Thanks for your interest in improving AL EventLens. This document covers how to report issues, set up a development environment, and get a pull request merged.

## Reporting issues

Use the issue forms (bug report / feature request) — blank issues are disabled. For bugs, the AL project context fields matter: most indexing bugs depend on where the events live (workspace `.al` vs `.alpackages/*.app`), the subscriber syntax generation (pre-BC22 string-literal vs BC22+ `Codeunit::"Name"`), and the `SymbolReference.json` schema (flat vs nested `Namespaces[]`).

This repo runs an agent-assisted issue pipeline (see [`agents/WORKFLOW.md`](agents/WORKFLOW.md)): maintainers queue an issue for automated planning/implementation by applying the `agent` and `status: need plan` labels. **Please don't apply `agent` or `status: *` labels yourself** — file the issue with the form's default label and a maintainer will triage it.

## Development setup

- Node.js 20.x (what CI uses) and VS Code 1.85+.
- Clone and install:

  ```sh
  git clone https://github.com/dvlprlife/AL-EventLens.git
  cd AL-EventLens
  npm ci
  ```

## Build, run, test

| Command | What it does |
| --- | --- |
| `npm run compile` | Type-check (`tsc --noEmit`), emit JS to `dist/`, and bundle with esbuild |
| `npm run watch` | Watch mode (esbuild + `tsc --noEmit` in parallel) |
| `npm run check-types` | Type-check only |
| `npm run lint` | `eslint src` (flat config, `eslint.config.mjs`) |
| `npm test` | Runs the suite under `@vscode/test-cli` (`vscode-test`); `pretest` compiles and lints first |
| `npm run package` | Production bundle (what `vsce` packages) |

To run the extension, open the repo in VS Code and press **F5** ("Run Extension" launch config — it compiles first, then opens an Extension Development Host). Point the dev host at a workspace containing `.al` files and/or an `.alpackages` folder to exercise indexing. Tests live in `src/test/` and run in a downloaded VS Code instance via `.vscode-test.mjs`.

## Pull requests

- Never commit to `main` — every change goes through a PR. Agent-worked issues use `issue-{number}-short-description` branches; releases use `release/x.y.z` (maintainer-run, see [`agents/RELEASE.md`](agents/RELEASE.md)).
- CI (`.github/workflows/build.yml`) runs on every PR: `tsc --noEmit`, `node esbuild.js --production`, and `npm test` on Ubuntu/macOS/Windows, plus a `vsce package` smoke test on Linux. [CodeQL](.github/workflows/codeql.yml) (`javascript-typescript`, `security-extended` queries) also analyzes every PR — the extension decompresses untrusted `.app` packages in-process, so treat its findings as blocking.
- **CHANGELOG**: user-visible changes need a one-line entry under `## [Unreleased]` in `CHANGELOG.md` (Keep a Changelog format) in the same PR. Contributor-facing-only changes (tests, CI, `agents/`, internal docs) skip it — note the skip in the PR body.
- **README**: a new user-discoverable command, setting, or keybinding must update the matching `README.md` section (Features / Commands / Settings) in the same PR.
- Commit messages reference the issue (`Closes #N`).
- Dependency bumps are handled by [Dependabot](.github/dependabot.yml) (weekly, grouped, labeled `dependencies`) — no need to open manual bump PRs.

## Project conventions

[`CLAUDE.md`](CLAUDE.md) and the "AL-specific notes" in [`agents/WORKFLOW.md`](agents/WORKFLOW.md) are the source of truth for architecture constraints. The load-bearing ones:

- **VS Code Web compatibility is mandatory**: all file access goes through `vscode.workspace.fs` (never Node `fs`); `.app` decompression uses JSZip (never Node `zlib`/`unzipper`).
- **AL source is the source of truth for events**; `SymbolReference.json` strips `[EventSubscriber]` attributes at compile time. Both subscriber syntaxes and both `SymbolReference.json` schemas must stay supported.
- **Layer discipline**: `src/al/`, `src/symbols/`, and `src/index/` are pure (no `vscode` imports beyond types); only `src/extension.ts` and `src/ui/` touch the editor/webview.
- **Stubs fail loudly** — never silently no-op (e.g. `.NEA` runtime packages are encrypted: detect and skip with a clear error).
- TypeScript strict mode: no `any`, no unused locals, explicit returns.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
