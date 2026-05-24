# Cutting a Release

This is the runbook for shipping a new AL EventLens version to the VS Code Marketplace. It is the de facto process distilled from 0.1.0 → 0.1.4; treat the order as load-bearing — most steps depend on the previous one being done.

The release isn't done through the agent pipeline (`agents/WORKFLOW.md`) — the release commit is a small, fully-mechanical change that doesn't need a planner. The release PR itself goes through the same `release/0.1.X` → squash-merge flow as feature PRs, but is authored directly.

---

## 0. Pre-flight

1. On `main`, working tree clean:
   ```
   git checkout main && git pull
   git status
   ```
2. Tests green locally:
   ```
   npm test
   ```
3. `package.json` version is the LAST released version (e.g. `0.1.4` if you're about to cut `0.1.5`).
4. `CHANGELOG.md` `[Unreleased]` section has all the user-visible changes since the last tag.

If any of these are off, **stop and fix before proceeding** — release commits are mechanical and shouldn't carry surprises.

---

## 1. Consolidate the CHANGELOG

`[Unreleased]` accumulates one entry per PR during development. Many of those entries describe fixes-to-fixes for bugs that never shipped — they're internal scaffolding from the agent pipeline, not user-visible deltas. Before tagging, collapse them.

Rules:

- Keep entries that describe a behavior change a user of the previous release would notice (a new feature, a perf win they'll feel, a bug they hit).
- Merge entries that describe iterations on the same subsystem (e.g. three sequential "generation guard" fixes → one entry about concurrent index/save races).
- Preserve the technical detail in parentheses (full file paths, mechanism) — match the 0.1.3 / 0.1.2 style. The CHANGELOG is read by curious users, not marketers.
- Drop entries about bugs introduced AND fixed within the same release.

This is editorial work — read the section as a user would and rewrite for clarity.

---

## 2. Bump version and date the section

```
# package.json
"version": "0.1.4"  →  "version": "0.1.5"
```

```
# CHANGELOG.md
## [Unreleased]

## [Unreleased]
                       →
## [0.1.5] - YYYY-MM-DD
```

Add a fresh empty `## [Unreleased]` above the dated section so the next development cycle has somewhere to write.

Use today's date in `YYYY-MM-DD` format (matches the previous releases — `date +%Y-%m-%d` if you need to look it up).

---

## 3. Release commit on a release branch

```
git checkout -b release/0.1.5
git add CHANGELOG.md package.json
git commit -m "$(cat <<'EOF'
release: 0.1.5

<2–4 sentence summary of what's in the release — what users will notice
when they update. Mirror the structure of the existing release commits.>

Co-authored-by: dvlprlife <dvlprlife@users.noreply.github.com>
Co-authored-by: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
git push -u origin release/0.1.5
```

**Trailer convention:** both `Co-authored-by` lines, lowercase `Co-authored-by:` (not the default capitalized `Co-Authored-By:`). See `commit_trailers.md` in memory.

---

## 4. Open the release PR

```
gh pr create --repo dvlprlife/AL-EventLens --title "release: 0.1.5" --body "..."
```

Wait for the 3-platform CI matrix (macOS / Ubuntu / Windows) to go green:

```
gh pr checks <N> --repo dvlprlife/AL-EventLens --watch
```

Then squash-merge with branch deletion:

```
gh pr merge <N> --repo dvlprlife/AL-EventLens --squash --delete-branch
```

If branch protection requires a review the agent can't give, use `--admin` to override. This pattern is documented in memory (`workflow_no_direct_main.md` notes the override for the release path).

Sync local main:

```
git checkout main && git pull
```

---

## 5. Tag

```
git tag v0.1.5 -m "Release 0.1.5 — <one-line summary>"
git push origin v0.1.5
```

Always an annotated tag (`-m`), never lightweight. The tag is the canonical reference for the release.

---

## 6. Package the .vsix

```
npx vsce package
```

Inspect the file list it prints — confirm it's roughly the size of the previous release (.vsix size grew from ~870 KB at 0.1.0 to ~925 KB at 0.1.4 — order-of-magnitude jumps suggest something leaked in).

Output: `al-eventlens-0.1.5.vsix` at the repo root.

---

## 7. Publish

```
npx vsce publish --pat <token> --packagePath al-eventlens-0.1.5.vsix
```

`--pat <token>` is the path of least resistance — it skips the interactive `vsce login` prompt entirely. The token must be a current Personal Access Token with:

- **Organization scope:** "All accessible organizations" (NOT a specific org — this was the failure mode on the 0.1.4 publish)
- **Permission scope:** Marketplace → Manage
- **Issued from:** the Microsoft account that owns the `dvlprlife` publisher

Get a fresh PAT at https://dev.azure.com/_usersSettings/tokens (no org prefix in the URL — that's the cross-org token UI).

⚠️ **The PAT will be visible in shell history.** After publishing, either rotate the PAT or clear the relevant lines from history.

CDN may take a few minutes before new installs see the update — `vsce publish` returns success as soon as Marketplace accepts the upload.

---

## 8. Cleanup

### Delete the local .vsix

```
rm al-eventlens-0.1.5.vsix
```

The `.vsix` is a build artifact, not a source file. Keeping it around in the working tree is a recipe for accidentally committing it.

### Prune merged release branches

`gh pr merge --delete-branch` removes the remote branch; the local copy lingers:

```
git branch -d release/0.1.5            # delete local
git remote prune origin                 # prune stale tracking refs
```

### Rotate or scrub the PAT

The PAT was in the `vsce publish` command line. Either:

- Go to the Azure DevOps token UI and **revoke** the PAT (then create a new one if you anticipate more publishes soon), OR
- Clear the relevant shell history lines (`history -d <line>` in bash; `Clear-History` in PowerShell — though note PowerShell's history is per-session).

Don't skip this. Marketplace PATs grant write access to the extension listing.

### Verify

```
gh api /repos/dvlprlife/AL-EventLens/releases/tags/v0.1.5 --jq .name 2>&1 | head -1
git log --oneline -3
node -p "require('./package.json').version"
```

Plus visit the marketplace listing to confirm the new version is live:
https://marketplace.visualstudio.com/items?itemName=dvlprlife.al-eventlens

---

## 9. Post trio (blog + LinkedIn + tweet)

Every release gets three companion posts, written to drafts under `posts/` (the `posts/` directory is gitignored — these drafts don't go to the marketplace or the public repo):

- `posts/v0.1.5.md` — long-form blog post for https://www.dvlprlife.com
- `posts/v0.1.5-linkedin.md` — LinkedIn version
- `posts/v0.1.5-twitter.md` — tweet

### Voice

Direct, dry, comfortable with technical jargon. No marketing hype. Short paragraphs, em dashes, parenthetical asides, light self-deprecation, contractions. First-person (the user is a solo developer). See `feedback_blog_voice.md` in memory for the full convention — established 2026-04-25 on the Markdown Foundry 0.3.0 launch.

**Avoid:** "powerful," "blazing fast," "revolutionary," excessive emoji, marketing-deck listicles, breathless framing.

### Blog post (`posts/v0.1.5.md`)

- Length: 600–900 words
- Structure: hero image, H1 title, lede paragraph, 2–3 `##` headings, one or two inline images/GIFs from `images/demo/`
- Hero image at the top references `../images/blog/<post-slug>-hero.png` (or reuse a generic one). Source SVG and rasterized PNG go in `images/blog/` — they're excluded from the .vsix via `.vscodeignore` so they don't bloat the marketplace package.
- Link the marketplace listing in the lede.

### LinkedIn (`posts/v0.1.5-linkedin.md`)

- Length: ~150–300 words, denser than a tweet but shorter than the blog post
- Bullet points are fine (LinkedIn's renderer handles them well)
- End with a link placeholder — `[link to blog post or marketplace]`

### Twitter / X (`posts/v0.1.5-twitter.md`)

- Length: a single tweet (≤280 chars) OR a 2–3 tweet micro-thread if the feature really needs it
- No hashtags unless they're load-bearing

### Drafting workflow

Drafts live in `posts/` (gitignored — see `project_post_drafts.md` in memory). The user copies them into the blog repo / LinkedIn / X manually. Don't `git add` anything in `posts/`.

If new promotional art is needed (hero image, etc.), add to `images/blog/<slug>-<asset>.{svg,png}` — the existing `.vscodeignore` glob `images/blog/**` keeps it out of the .vsix.

---

## Common pitfalls

- **PAT expired** — the symptom is `"Access Denied: The Personal Access Token used has expired"`. Get a fresh one with the scopes above.
- **PAT scoped to one org** — the symptom is `"TF400813: The user 'aaaaaaaa-...' is not authorized"` (anonymous-user GUID). Create the PAT with **All accessible organizations**, not a specific org.
- **Stacked PRs auto-closing** — if a release PR somehow depends on an in-flight branch, `gh pr merge --delete-branch` on the dependency closes the dependent. Release PRs should always be off `main`, never stacked.
- **Forgot to update CHANGELOG date** — if the section still says `[Unreleased]` after publishing, fix it in a follow-up `chore:` commit. Users reading the CHANGELOG from a tagged release shouldn't see `[Unreleased]`.
- **`.vsix` committed** — if you forget to `rm` it after publishing, it'll show up in the next `git status`. Don't commit it; just delete it. The repo's `.gitignore` should cover `*.vsix` already; if it doesn't, add it.

---

## What this process intentionally skips

- **No GitHub Release.** The git tag is sufficient — the marketplace listing IS the release page for users. Memory: the existing v0.1.x tags are pushed without an attached GitHub Release.
- **No semver-major bumps yet.** Everything's been patch / minor under 0.1.x. When 1.0.0 lands, this runbook needs a Migration / Breaking Changes section.
- **No automated changelog generation.** The `[Unreleased]` section is hand-curated during development; the release step consolidates it. A `git log`-driven generator would re-introduce the internal-fix-chain noise this process exists to clean up.
