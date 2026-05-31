# Agent Workflow

This document describes the full lifecycle of an issue through the agent system for the `dvlprlife/AL-EventLens` repository.

> **Cutting a release?** See [`RELEASE.md`](RELEASE.md) — the release process is mechanical and doesn't go through the planner/worker pipeline.

## Agents

| Agent | File | Purpose |
|-------|------|---------|
| Repo Check | `repo-check.md` | Ensures all required labels exist in the repo |
| Issue Planner | `issue-planner.md` | Reviews issues and writes implementation plans |
| Issue Worker | `issue-worker.md` | Implements changes, commits, and opens a PR |
| PR Reviewer | `pr-reviewer.md` | Reviews the PR against the plan, AC, code quality, and CLAUDE.md |

---

## Issue Lifecycle

### 1. Setup (Repo Check Agent)
Run once before using the other agents to ensure all required labels exist.

```
agent: repo-check
```

---

### 2. Issue Created by Human
A human creates an issue and applies the following labels to queue it for agent processing:

| Label | Purpose |
|-------|---------|
| `agent` | Marks the issue for agent pickup |
| `status: need plan` | Signals the issue planner to review it |

---

### 3. Planning (Issue Planner Agent)
The planner finds issues labeled `agent` + `status: need plan`.

**Happy path — enough information:**
1. Posts an `## Implementation Plan` comment (file-by-file changes + acceptance criteria)
2. Removes `status: need plan`, adds `status: ready`

**Failure path — not enough information:**
1. Adds `status: follow up` and `human` labels, removes `agent`
2. Posts a `## Needs Clarification` comment explaining what is missing
3. Stops — human intervention required

---

### 4. Implementation (Issue Worker Agent)
The worker finds issues labeled `agent` + `status: ready`.

1. Swaps `status: ready` → `status: in-progress`
2. Verifies an `## Implementation Plan` comment exists — if not, transitions back to `status: need plan` and stops
3. Creates a branch, implements the changes, commits, and pushes
4. Opens a PR referencing the issue
5. Swaps `status: in-progress` → `status: in-review`
6. Posts a comment on the issue linking to the PR

---

### 4.5. Automated Review (PR Reviewer Agent)
The reviewer finds issues labeled `agent` + `status: in-review`.

1. Locates the open PR referencing the issue (`Closes #{number}`)
2. Gathers the issue body, the `## Implementation Plan` comment, the PR, and the diff
3. Reviews against six criteria: Implementation Plan adherence, Acceptance Criteria, code quality, CLAUDE.md compliance, CHANGELOG compliance, and README compliance
4. Posts a review on the PR (request changes if findings exist, comment review otherwise — agents cannot self-approve)
5. Posts a summary comment on the issue

**If findings:** adds `status: follow up` + `human`, removes `status: in-review`.
**If clean:** adds `status: agent approved`, removes `status: in-review`.

---

### 5. Review (Human)
A human reviews the PR. On merge the issue is closed.

---

## Label State Machine

```
[human creates issue]
        │
        ▼
  agent + status: need plan
        │
        ▼ (issue planner)
        ├─── not enough info ──▶ status: follow up + human  (awaits human)
        │
        ▼
  agent + status: ready
        │
        ▼ (issue worker)
  agent + status: in-progress
        │
        ├─── no plan found ──▶ status: need plan  (replanner picks up)
        │
        ▼
  agent + status: in-review
        │
        ▼ (pr reviewer)
        ├─── findings ──▶ status: follow up + human  (awaits human)
        │
        ▼
  agent + status: agent approved
        │
        ▼ (human merges PR)
  issue closed
```

---

## Required Labels

| Label | Color | Description |
|-------|-------|-------------|
| `agent` | `#0075ca` | Issue is assigned to agent processing |
| `status: need plan` | `#fbca04` | Awaiting implementation plan |
| `status: ready` | `#0e8a16` | Planned and ready for the worker |
| `status: in-progress` | `#e4e669` | Worker is actively implementing |
| `status: in-review` | `#d93f0b` | PR open, awaiting human review |
| `status: follow up` | `#c5def5` | Needs follow-up after human review |
| `status: agent approved` | `#2da44e` | PR reviewer agent found no issues; awaiting human approval |
| `human` | `#b60205` | Requires human attention |

---

## Non-agent PR streams

[Dependabot](../.github/dependabot.yml) PRs (npm + GitHub Actions, weekly, grouped) are a **human-reviewed** stream that lives **outside** this label state machine. They carry only the `dependencies` label — never `agent` or any `status:*` label — so the planner / worker / reviewer agents never pick them up as pipeline work. They run through the same `build.yml` CI matrix as any other PR.

---

## AL-specific notes

These are the architectural ground rules the PR Reviewer should treat as load-bearing alongside `CLAUDE.md`. They are repeated here so the reviewer agent loads them automatically with `agents/WORKFLOW.md`.

### Source of truth

- **AL source files (`.al`) are the source of truth for events.** `SymbolReference.json` inside compiled `.app` packages does **not** preserve `[EventSubscriber]` attributes — they are stripped at compile time. Publishers *are* preserved in `SymbolReference.json` and may be read from there, but workspace parsing always uses `.al` for consistency.
- **Two subscriber syntaxes** must be recognized: pre-BC22 (`'Codeunit Name'`, `'OnEvent'` — string literals, quoted event name) and BC22+ (`Codeunit::"Name"`, `OnEvent` — bare event identifier). The regex covers both.
- **Trigger events are implicit.** Table and Page objects get synthesized virtual publishers per trigger event (`OnAfterDeleteEvent`, `OnBeforeValidateEvent`, etc.) during indexing, gated by `alEventLens.includeTriggerEvents`.

### `.app` package format

- `.app` files are a 40-byte **NAVX** header followed by a standard PKZIP archive. Strip the header, then unzip with JSZip — never with a Node-only zip library, since the extension must run in VS Code Web.
- **Two `SymbolReference.json` schemas** are in the wild and both must be supported: the older flat schema and the newer nested `Namespaces[]` schema (dominant in BC 24+). Schema detection lives in `src/symbols/detect.ts`.
- **`.NEA` files are encrypted runtime packages** and are unreadable. Detect them and skip with a clear, user-visible error — never silently no-op.

### Build & runtime constraints

- **VS Code Web compatibility is mandatory.** The extension is browser-bundled (`platform: 'browser'` in `esbuild.js`, `browser` field in `package.json`, no `main`). All file access goes through `vscode.workspace.fs` — Node `fs` is banned. `.app` decompression uses JSZip, not the Node `zlib`/`unzipper` ecosystem.
- **Cache strategy:** parsed `.app` results are stored in `extensionContext.globalStorageUri`, keyed by `(appId, version, mtime)`, and re-loaded on workspace open.
- **Layer discipline:** `src/al/`, `src/symbols/`, and `src/index/` are pure (no `vscode` imports beyond types). Only `src/extension.ts` and `src/ui/` touch the editor or webview.
- **Stubs fail loudly:** a not-yet-implemented code path must throw with a clear message (e.g. `"readApp: .NEA runtime packages are encrypted and unsupported"`), never silently no-op or return a fake success.
