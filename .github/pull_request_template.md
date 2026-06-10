# Summary

<!-- What changed and why. -->

Closes #<!-- issue number — agent-pipeline tooling locates PRs by this line -->

## Checklist

Mirrors what CI (`build.yml`) runs on every PR:

- [ ] `npm run check-types` passes (CI runs `tsc --noEmit` on Ubuntu, macOS, and Windows)
- [ ] `node esbuild.js --production` builds cleanly
- [ ] `npm run lint` passes (`eslint src`)
- [ ] `npm test` passes (`vscode-test`; `pretest` compiles and lints first)
- [ ] User-visible change → one-line entry added under `## [Unreleased]` in `CHANGELOG.md`; if contributor-facing only, say so below so the reviewer knows the skip is deliberate
- [ ] New user-discoverable command, setting, or keybinding → `README.md` Features/Commands/Settings updated; otherwise note the skip below
- [ ] No Node-only APIs introduced (`vscode.workspace.fs` only, JSZip for `.app` decompression — the extension must keep running on VS Code Web)

CI also runs a `vsce package` smoke test and a CodeQL (`javascript-typescript`, security-extended) analysis on every PR — no local step needed, but findings must be resolved.

## CHANGELOG / README skips (if any)

<!-- e.g. "No CHANGELOG entry: CI-only change." -->
