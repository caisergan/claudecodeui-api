# Sync Fork with Upstream + Port Local Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reset our fork's `main` to match `upstream/main` (siteboon/claudecodeui), preserving all 8 local commits in backup branches, then re-apply our local features on top of upstream's new module-based TypeScript architecture.

**Architecture:** Three-stage process. (1) Save current fork state to backup branches. (2) Hard-reset `main` to `upstream/main` and force-push to `origin`. (3) Create a single porting branch `feat/port-from-pre-merge-backup` and re-apply each local feature as an atomic commit, adapting to upstream's new file layout (`server/modules/**/*.ts` instead of `server/{projects,providers}/*.js`). When all features are ported and verified, fast-forward `main`.

**Tech Stack:**
- Node.js + Express backend (mixed `.js` and `.ts` after upstream refactor)
- Test framework: `node:test` (Node's built-in runner, not vitest/jest) — see `server/modules/projects/tests/*.test.ts` for canonical patterns
- TypeScript via `tsx` / `tsconfig.json`
- React frontend (Vite) — minimal porting needed (one types file)
- Git workflow: backup branches + force-push to fork's `main`, then porting branch

**Pre-state assumptions verified:**
- Upstream remote `upstream` is configured and fetched (commit `beb0a50` is current upstream/main HEAD)
- Backup branch `backup/pre-upstream-merge` already points to local main `3e809e2`
- Working tree is currently in a half-merged conflicted state (must be aborted in Phase 0)
- Merge-base between local main and upstream/main: `25b00b58de907142408da292b9640dcdf7746242`

**Total scope:** 14 files modified across 8 commits, +2,892/-28 lines. Ten discrete features to port.

---

## Feature inventory (porting catalog)

| # | Feature | Source file(s) | Target file(s) in upstream | LOC | Effort |
|---|---|---|---|---|---|
| F1 | `.gitignore` additions | `.gitignore` | `.gitignore` | +6 | trivial |
| F2 | `run.sh` helper script | `run.sh` (new) | `run.sh` (new) | +16 | trivial |
| F3 | API integration docs | `docs/API_INTEGRATION.md` (new) | same | +652 | trivial |
| F4 | Demo UI | `public/session-api-demo.html` (new) | same | +823 | trivial |
| F5 | API docs HTML updates | `public/api-docs.html` | same | +111/-6 | low |
| F6 | Frontend type additions (provider/model fields) | `src/types/app.ts` | same | +7 | low |
| F7 | Codex canonical session ID preservation | `server/openai-codex.js` (+9), `server/providers/codex/adapter.js` (+10) | `server/openai-codex.js`, `server/modules/providers/list/codex/codex.provider.ts` | +19 | medium |
| F8 | Provider model tracking | `server/projects.js` (+35), `server/gemini-cli.js` (+12), `server/sessionManager.js` (+11) | `server/modules/providers/list/{claude,cursor,codex,gemini}/*-sessions.provider.ts`, `server/gemini-cli.js`, `server/sessionManager.js` | +58 | high |
| F9 | Agent API session-management routes | `server/routes/agent.js` (+289) | same path; uses upstream's `server/modules/providers/services/sessions.service.ts`, `server/modules/projects/services/projects-with-sessions-fetch.service.ts` | +289 | very high |
| F10 | Authenticated usage-limits endpoint | `server/routes/usage-limits.js` (new, 895 lines), `server/index.js` (+1 import) | same path; rewrite registry imports | +896 | very high |

---

## File structure: new files to create during porting

- `feat/port-from-pre-merge-backup` branch only — no main changes until verified
- New files created on porting branch:
  - `run.sh` (re-add)
  - `docs/API_INTEGRATION.md` (re-add)
  - `public/session-api-demo.html` (re-add)
  - `server/routes/usage-limits.js` (re-add but rewritten for new registry)
  - `server/modules/providers/list/codex/codex.provider.ts` test file (if missing): `server/modules/providers/list/codex/codex.provider.test.ts`
  - `server/modules/providers/list/codex/codex-sessions.provider.test.ts` (model field parity test)
  - `server/modules/providers/list/claude/claude-sessions.provider.test.ts` (model field parity test)
  - `server/modules/providers/list/cursor/cursor-sessions.provider.test.ts` (model field parity test)
  - `server/modules/providers/list/gemini/gemini-sessions.provider.test.ts` (model field parity test)

- Files modified on porting branch (in order):
  - `.gitignore`
  - `server/index.js` (one import line for usage-limits)
  - `server/openai-codex.js` (Codex thread.started handling)
  - `server/sessionManager.js` (metadata param + provider/model fields)
  - `server/gemini-cli.js` (model defaulting + session metadata writeback)
  - `src/types/app.ts` (provider/model frontend fields)
  - `server/modules/providers/list/{claude,cursor,codex,gemini}/*-sessions.provider.ts` (model extraction)
  - `server/modules/providers/list/codex/codex.provider.ts` (thread_started → session_created normalization)
  - `server/routes/agent.js` (new GET routes adapted to module APIs)
  - `public/api-docs.html`

---

## Phase 0: Pre-flight & abort current merge

### Task 0.1: Confirm clean exit from in-progress merge

**Files:** none (working tree only)

- [ ] **Step 1: Verify we're currently in a merge state**

Run: `git status | head -5`
Expected: `On branch main` and `You have unmerged paths.`

- [ ] **Step 2: Save the conflicted-merge tree to a recovery branch (paranoia, optional)**

Run:
```bash
git stash push --include-untracked -m "WIP: conflicted merge state 2026-05-06" || true
git stash list | head -3
```
Expected: stash list shows the WIP entry (or nothing, if there's no stashable diff because the file is in conflict markers, which is fine — the backup branch from Phase 1 will cover everything anyway).

- [ ] **Step 3: Abort the merge**

Run: `git merge --abort`
Expected: silent success.

- [ ] **Step 4: Verify clean working tree on local main**

Run:
```bash
git status
git log --oneline -3
```
Expected: `working tree clean`, latest commit `3e809e2 chore: ignore generated graphify and OMX artifacts`.

- [ ] **Step 5: Drop the safety stash if you took one in step 2**

Run: `git stash list` then if non-empty: `git stash drop`
Expected: stash list empty.

---

## Phase 1: Comprehensive backup

The `backup/pre-upstream-merge` branch already exists from earlier in this session. We add finer-grained per-feature branches so individual features are easy to inspect and cherry-pick during porting.

### Task 1.1: Verify the umbrella backup branch

**Files:** none

- [ ] **Step 1: Confirm branch exists and points where expected**

Run:
```bash
git branch --list 'backup/*'
git log --oneline backup/pre-upstream-merge -3
```
Expected: `backup/pre-upstream-merge` listed, top commit `3e809e2 chore: ignore generated graphify and OMX artifacts`.

### Task 1.2: Create per-feature backup tags (one tag per local commit)

Tags don't move, so they're safer than branches for "frozen historical reference points."

**Files:** none

- [ ] **Step 1: Create annotated tags pointing to each local commit**

Run:
```bash
git tag -a backup/pre-merge/01-extend-api-session-mgmt 0335af7 -m "Local commit before upstream merge"
git tag -a backup/pre-merge/02-codex-canonical-ids c6f0ef2 -m "Local commit before upstream merge"
git tag -a backup/pre-merge/03-usage-limits-endpoint 7a89d08 -m "Local commit before upstream merge"
git tag -a backup/pre-merge/04-api-docs 1c4f546 -m "Local commit before upstream merge"
git tag -a backup/pre-merge/05-demo-ui 1707a7c -m "Local commit before upstream merge"
git tag -a backup/pre-merge/06-run-script f3da5e4 -m "Local commit before upstream merge"
git tag -a backup/pre-merge/07-gitignore-graphify 7a016a5 -m "Local commit before upstream merge"
git tag -a backup/pre-merge/08-gitignore-extra 3e809e2 -m "Local commit before upstream merge"
```
Expected: silent success.

- [ ] **Step 2: Verify all tags created**

Run: `git tag -l 'backup/pre-merge/*'`
Expected: 8 tags listed.

### Task 1.3: Push backup branch and tags to `origin`

So they survive even if the local checkout is wiped.

**Files:** none

- [ ] **Step 1: Push backup branch**

Run: `git push origin backup/pre-upstream-merge`
Expected: branch created on origin.

- [ ] **Step 2: Push backup tags**

Run: `git push origin --tags 'backup/pre-merge/*' || git push origin 'refs/tags/backup/pre-merge/*'`
Expected: 8 new tags pushed.

If the wildcard form fails (some Git versions), fall back:
```bash
for tag in $(git tag -l 'backup/pre-merge/*'); do
  git push origin "$tag"
done
```

- [ ] **Step 3: Verify on remote**

Run: `git ls-remote --tags origin 'refs/tags/backup/pre-merge/*' | head -10`
Expected: 8 entries.

### Task 1.4: Generate human-readable backup manifest

A markdown file summarizing what each backup ref contains. Future-you will thank you.

**Files:**
- Create: `docs/superpowers/plans/2026-05-06-backup-manifest.md`

- [ ] **Step 1: Write the manifest**

```bash
cat > docs/superpowers/plans/2026-05-06-backup-manifest.md <<'EOF'
# Pre-upstream-merge backup manifest (2026-05-06)

Snapshot taken before resetting `main` to `upstream/main` and porting features.

## Branches
- `backup/pre-upstream-merge` → tip `3e809e2` (full local main as of 2026-05-06)

## Tags (per-commit reference)
| Tag | Commit | Subject |
|---|---|---|
| backup/pre-merge/01-extend-api-session-mgmt | 0335af7 | feat: extend api capabilities to include the session management |
| backup/pre-merge/02-codex-canonical-ids     | c6f0ef2 | fix: preserve canonical Codex session ids |
| backup/pre-merge/03-usage-limits-endpoint   | 7a89d08 | feat: add authenticated usage-limits inspection endpoint |
| backup/pre-merge/04-api-docs                | 1c4f546 | docs: update api documentation to cover the session management changes |
| backup/pre-merge/05-demo-ui                 | 1707a7c | feat: add demo ui to test session management features |
| backup/pre-merge/06-run-script              | f3da5e4 | chore: add script to easily run |
| backup/pre-merge/07-gitignore-graphify      | 7a016a5 | chore: update gitignore to cover graphify files |
| backup/pre-merge/08-gitignore-extra         | 3e809e2 | chore: ignore generated graphify and OMX artifacts |

## Common ancestor with upstream
- Merge-base: `25b00b58de907142408da292b9640dcdf7746242`

## How to inspect a feature
```bash
git show backup/pre-merge/01-extend-api-session-mgmt --stat
git diff 25b00b58de907142408da292b9640dcdf7746242 backup/pre-merge/01-extend-api-session-mgmt -- server/routes/agent.js
```

## How to roll back the entire reset
```bash
git checkout main
git reset --hard backup/pre-upstream-merge
git push --force origin main   # only if we already force-pushed the reset
```
EOF
```

- [ ] **Step 2: Stage and commit on a temporary branch (NOT main)**

We don't want to commit this on main yet because main is about to be hard-reset. Stash it instead.

Run:
```bash
git stash push docs/superpowers/plans/2026-05-06-backup-manifest.md -m "manifest: pre-upstream-merge backup"
git stash list
```
Expected: one stash entry with the manifest. (We'll restore it in Phase 2 onto the new main.)

The plan file you are reading right now is *also* in `docs/superpowers/plans/`. Stash it the same way:

Run:
```bash
git stash push docs/superpowers/plans/2026-05-06-sync-fork-with-upstream-and-port-features.md -m "plan: sync-fork-with-upstream"
git stash list
```
Expected: two stash entries.

---

## Phase 2: Reset main to upstream/main

### Task 2.1: Hard-reset local main

**Files:** none

- [ ] **Step 1: Confirm we are on main**

Run: `git rev-parse --abbrev-ref HEAD`
Expected: `main`.

- [ ] **Step 2: Confirm upstream/main HEAD is what we expect**

Run: `git log --oneline upstream/main -1`
Expected: `beb0a50 fix: enhance regex to correctly parse wrapper file paths for claude.exe (#741)` (or whatever the latest upstream tip is — record it).

- [ ] **Step 3: Hard-reset main**

Run: `git reset --hard upstream/main`
Expected: HEAD now at upstream tip; working tree reflects upstream's structure (you should see `server/modules/`, `server/shared/`, etc. exist; `server/projects.js` and `server/providers/` no longer exist).

- [ ] **Step 4: Verify the reset**

Run:
```bash
git log --oneline -3
ls server/modules/providers/list/ 2>&1
ls server/projects.js 2>&1 || echo "deleted (expected)"
```
Expected: top commit matches upstream tip, `server/modules/providers/list/` lists `claude codex cursor gemini`, `server/projects.js` reports "No such file" or "deleted (expected)".

### Task 2.2: Force-push reset to origin

**Files:** none

- [ ] **Step 1: Force-push with lease (safer than `--force` — fails if origin moved unexpectedly)**

Run: `git push --force-with-lease origin main`
Expected: `+ 3e809e2...beb0a50 main -> main (forced update)`.

- [ ] **Step 2: Verify origin matches local**

Run: `git rev-parse main origin/main upstream/main`
Expected: all three SHAs identical.

### Task 2.3: Restore plan + manifest onto fresh main

**Files:**
- Restore: `docs/superpowers/plans/2026-05-06-backup-manifest.md`
- Restore: `docs/superpowers/plans/2026-05-06-sync-fork-with-upstream-and-port-features.md`

- [ ] **Step 1: Pop both stashes (most recent first — the plan, then the manifest)**

Run:
```bash
git stash pop  # restores the plan
git stash pop  # restores the manifest
git status
```
Expected: both files appear as untracked under `docs/superpowers/plans/`.

- [ ] **Step 2: Commit them on main**

Run:
```bash
mkdir -p docs/superpowers/plans
git add docs/superpowers/plans/
git commit -m "docs: archive pre-upstream-merge backup manifest and porting plan"
```
Expected: one commit on main.

- [ ] **Step 3: Push to origin**

Run: `git push origin main`
Expected: fast-forward, no force.

---

## Phase 3: Create porting branch + re-apply trivial features (F1–F6)

All trivial features in one branch, one commit per feature for clean history.

### Task 3.1: Create the porting branch

**Files:** none

- [ ] **Step 1: Branch off main**

Run:
```bash
git checkout -b feat/port-from-pre-merge-backup
git status
```
Expected: on the new branch, working tree clean.

### Task 3.2: F1 — Re-apply `.gitignore` additions

**Files:**
- Modify: `.gitignore`

Source of truth: `git show backup/pre-merge/07-gitignore-graphify -- .gitignore` and `git show backup/pre-merge/08-gitignore-extra -- .gitignore`.

- [ ] **Step 1: Inspect what was added in each commit**

Run:
```bash
git show backup/pre-merge/07-gitignore-graphify -- .gitignore
git show backup/pre-merge/08-gitignore-extra -- .gitignore
```
Expected: small additions (graphify outputs, OMX artifacts).

- [ ] **Step 2: Append the same lines to current `.gitignore`**

Open `.gitignore`. At the end of the file, add the lines from those two diffs (verbatim, preserving any blank-line separators they used). Do NOT duplicate any line that already exists in upstream's `.gitignore` — diff against current contents first:
```bash
grep -E "graphify|OMX" .gitignore || echo "(no existing matches; safe to append)"
```

- [ ] **Step 3: Verify**

Run: `git diff .gitignore`
Expected: 6 line additions (or fewer, if upstream already covers any of them).

- [ ] **Step 4: Commit**

```bash
git add .gitignore
git commit -m "chore: re-apply gitignore additions for graphify and OMX artifacts

Restored from backup/pre-merge/07-gitignore-graphify and 08-gitignore-extra
after resetting main to upstream/main."
```

### Task 3.3: F2 — Re-apply `run.sh`

**Files:**
- Create: `run.sh`

- [ ] **Step 1: Restore exactly from backup tag**

Run:
```bash
git checkout backup/pre-merge/06-run-script -- run.sh
ls -la run.sh
```
Expected: file exists, ~16 lines.

- [ ] **Step 2: Verify it still works against upstream's package.json scripts**

Open `run.sh`, read its contents. Cross-check any `npm run <script>` calls against `package.json` scripts to confirm they still exist post-upstream-merge:
```bash
grep -E "npm run|yarn|pnpm" run.sh
node -e "console.log(Object.keys(require('./package.json').scripts).join('\n'))"
```
Expected: every script `run.sh` invokes appears in `package.json`. If a referenced script was renamed upstream, update `run.sh` accordingly.

- [ ] **Step 3: Make executable**

Run: `chmod +x run.sh`

- [ ] **Step 4: Commit**

```bash
git add run.sh
git commit -m "chore: re-apply run.sh dev-server helper

Restored from backup/pre-merge/06-run-script."
```

### Task 3.4: F3 — Re-apply `docs/API_INTEGRATION.md`

**Files:**
- Create: `docs/API_INTEGRATION.md`

- [ ] **Step 1: Restore from backup tag**

Run: `git checkout backup/pre-merge/03-usage-limits-endpoint -- docs/API_INTEGRATION.md`
(Note: this file was added in the usage-limits commit alongside the route. It documents the route, but the document itself doesn't depend on code paths, so it's safe to restore now.)

Expected: file exists, ~652 lines.

- [ ] **Step 2: Quick sanity-read for stale references**

Run: `grep -nE "server/(projects|providers/registry|database/db)\.js|require\\(['\"]\\.\\./database/db" docs/API_INTEGRATION.md || echo "no stale refs"`
Expected: `no stale refs`. If any appear, note them as TODOs to fix in the F10 task (since they describe the usage-limits route which is being rewritten anyway).

- [ ] **Step 3: Commit**

```bash
git add docs/API_INTEGRATION.md
git commit -m "docs: re-apply API integration guide

Restored from backup/pre-merge/03-usage-limits-endpoint. Code paths
referenced in this guide are re-implemented in later commits."
```

### Task 3.5: F4 — Re-apply `public/session-api-demo.html`

**Files:**
- Create: `public/session-api-demo.html`

- [ ] **Step 1: Restore from backup tag**

Run: `git checkout backup/pre-merge/05-demo-ui -- public/session-api-demo.html`
Expected: file exists, ~823 lines.

- [ ] **Step 2: Audit fetch URLs for stale endpoints**

The demo UI calls `/api/agent/...` endpoints. After F9, those endpoints will be re-implemented; the URLs themselves should be unchanged. But it may also call `/api/usage-limits/...` (re-implemented in F10) or anything that no longer exists.

Run: `grep -nE "fetch\\(|/api/" public/session-api-demo.html | head -30`

Document any endpoint the demo calls so we cross-check during F9/F10 that the endpoint path matches.

- [ ] **Step 3: Commit**

```bash
git add public/session-api-demo.html
git commit -m "feat: re-apply session-api demo UI

Restored from backup/pre-merge/05-demo-ui. Backend endpoints it calls
are re-implemented in feat/port-from-pre-merge-backup later commits."
```

### Task 3.6: F5 — Re-apply `public/api-docs.html` updates

**Files:**
- Modify: `public/api-docs.html`

This is *modifications* to an existing file, not a fresh add. Risk: upstream may have updated `api-docs.html` independently. Strategy: cherry-pick the commit and resolve any conflicts.

- [ ] **Step 1: Cherry-pick the docs commit**

Run: `git cherry-pick backup/pre-merge/04-api-docs`
Expected: clean apply, OR conflict in `public/api-docs.html`.

- [ ] **Step 2: If conflicts arise, resolve**

If conflict: open `public/api-docs.html`, locate `<<<<<<<` markers, keep both upstream's structure and our additions (additive merge — we documented new routes; upstream may have added other routes). After resolving:
```bash
git add public/api-docs.html
git cherry-pick --continue
```

- [ ] **Step 3: Verify the file renders without obvious breakage**

Run: `grep -c "</html>\\|</body>" public/api-docs.html`
Expected: at least one of each closing tag. (Optional: open the file in a browser if a dev server is running.)

(Commit is created automatically by cherry-pick; no extra commit step.)

### Task 3.7: F6 — Re-apply frontend types

**Files:**
- Modify: `src/types/app.ts`

- [ ] **Step 1: Look at what was added**

Run: `git show backup/pre-merge/01-extend-api-session-mgmt -- src/types/app.ts`
Expected: 7 lines added inside the `ProjectSession` interface (provider, providerLabel, providerIcon, providerIconDark, model, modelLabel, modelProvider).

- [ ] **Step 2: Inspect upstream's current `ProjectSession` interface**

Run: `grep -n "ProjectSession\\|provider\\|model" src/types/app.ts | head -40`

Determine whether upstream has already added equivalent fields. If yes, this feature is already covered — skip steps 3–4. If no, proceed.

- [ ] **Step 3: Edit `src/types/app.ts` to add the seven optional fields**

Inside `interface ProjectSession`, before the `__provider` line (or wherever the trailing properties live), add:

```typescript
  provider?: LLMProvider;
  providerLabel?: string;
  providerIcon?: string;
  providerIconDark?: string;
  model?: string | null;
  modelLabel?: string | null;
  modelProvider?: string | null;
```

Confirm `LLMProvider` is the correct type name in upstream (it should still exist; if renamed, use the new name).

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -20` (or whatever the project's typecheck command is — check `package.json` scripts for `typecheck`/`tsc`).
Expected: no new errors introduced by these additions.

- [ ] **Step 5: Commit**

```bash
git add src/types/app.ts
git commit -m "feat(types): add provider and model fields to ProjectSession

Mirrors upstream's session decoration shape so frontend can render
provider icons and model labels supplied by the API."
```

---

## Phase 4: Port F7 — Codex canonical session ID preservation

Two source-side changes need re-applying:
1. `server/openai-codex.js` — handle `thread.started` event so the in-memory session map keys on the canonical thread id.
2. `server/providers/codex/adapter.js` — emit a `session_created` normalized message when `thread_started` arrives. Adapter logic now lives in `server/modules/providers/list/codex/codex.provider.ts`.

### Task 4.1: Re-apply the `server/openai-codex.js` change

**Files:**
- Modify: `server/openai-codex.js`

- [ ] **Step 1: Inspect the original change**

Run: `git show backup/pre-merge/02-codex-canonical-ids -- server/openai-codex.js`
Expected: 9-line addition handling `event.type === 'thread.started'` and re-keying `activeCodexSessions` from the placeholder id to `event.id`.

- [ ] **Step 2: Locate the equivalent insertion point in current `server/openai-codex.js`**

Run: `grep -n "activeCodexSessions\\|currentSessionId\\|thread.started\\|item.started" server/openai-codex.js | head -20`
Expected: find the `for await (const event of ...)` loop where events are processed; the new branch goes near the top of the loop body, before the `item.started`/`item.updated` continue branch.

- [ ] **Step 3: Edit `server/openai-codex.js` to add the same branch**

In the event-handling loop, immediately before the `if (event.type === 'item.started' ...)` branch, insert:

```javascript
      if (event.type === 'thread.started' && event.id && event.id !== currentSessionId) {
        const activeSession = activeCodexSessions.get(currentSessionId);
        if (activeSession) {
          activeCodexSessions.delete(currentSessionId);
          activeCodexSessions.set(event.id, activeSession);
        }
        currentSessionId = event.id;
      }
```

If upstream renamed `activeCodexSessions` or `currentSessionId`, use the new names.

- [ ] **Step 4: Lint / smoke-check**

Run: `node --check server/openai-codex.js`
Expected: no syntax errors.

### Task 4.2: Add a TS adapter branch for `thread_started`

**Files:**
- Modify: `server/modules/providers/list/codex/codex.provider.ts`
- Test: `server/modules/providers/list/codex/codex.provider.test.ts` (create if missing)

- [ ] **Step 1: Find the normalize / message-mapping function in the new TS adapter**

Run: `grep -n "thread_started\\|threadId\\|normalizeMessage\\|session_created\\|newSessionId" server/modules/providers/list/codex/codex.provider.ts`

Expected: locate the function that converts raw Codex events into normalized messages. If upstream's structure differs significantly, the equivalent logic may live in `codex-sessions.provider.ts` or `codex-session-synchronizer.provider.ts` instead — search those:

```bash
grep -rn "thread_started\\|newSessionId\\|session_created" server/modules/providers/list/codex/
```

Identify the correct file and the correct insertion point.

- [ ] **Step 2: Write a failing test** (`server/modules/providers/list/codex/codex.provider.test.ts`, new file)

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
// Import the actual normalize function from wherever it lives in upstream.
// Adjust this import after Step 1 reveals the correct module/function name.
import { normalizeMessage } from './codex.provider.js'; // or codex-sessions.provider.js, etc.

test('normalizeMessage emits session_created when thread_started arrives with threadId', () => {
  const raw = {
    type: 'thread_started',
    threadId: 'thread_abc123',
  };
  const placeholderSessionId = 'placeholder-id';

  const result = normalizeMessage(raw, placeholderSessionId);

  assert.ok(Array.isArray(result), 'normalizeMessage should return an array');
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, 'session_created');
  assert.equal(result[0].newSessionId, 'thread_abc123');
  assert.equal(result[0].sessionId, 'thread_abc123');
});

test('normalizeMessage ignores thread_started without threadId', () => {
  const raw = { type: 'thread_started' };
  const result = normalizeMessage(raw, 'session-1');
  assert.equal(result.length, 0); // or whatever the "no-op" return shape is — adjust after reading the function
});
```

- [ ] **Step 3: Run the test to confirm it fails**

Run: `node --test --import tsx server/modules/providers/list/codex/codex.provider.test.ts`

(If the project uses a different runner invocation, check `package.json` `scripts.test`. Upstream's test files use `import test from 'node:test'` so `node --test` should work; the `--import tsx` flag enables TypeScript execution. Confirm by running an existing test file first:
`node --test --import tsx server/modules/projects/tests/project-clone.service.test.ts`
to verify the runner works, then come back.)

Expected: the new test fails because the `thread_started` branch doesn't exist yet.

- [ ] **Step 4: Add the branch in the TS adapter**

In the normalize function (path determined in Step 1), add:

```typescript
  if (raw.type === 'thread_started' && raw.threadId) {
    return [createNormalizedMessage({
      id: baseId,
      sessionId: raw.threadId,
      timestamp: ts,
      provider: PROVIDER,
      kind: 'session_created',
      newSessionId: raw.threadId,
    })];
  }
```

Adjust types: if `createNormalizedMessage` signature differs in TS (e.g., requires explicit literal types), satisfy the compiler. If `kind: 'session_created'` is not a valid union member in upstream's `NormalizedMessageKind` type, you have two choices:
1. (Preferred) Extend the type union in `server/shared/types.ts` or wherever the union lives, AND update the consumer code that pattern-matches on `kind` to handle the new variant.
2. Use the closest existing kind (likely `'session_created'` already exists in upstream — verify via `grep -rn "session_created" server/shared server/modules/`).

- [ ] **Step 5: Re-run the test**

Run: `node --test --import tsx server/modules/providers/list/codex/codex.provider.test.ts`
Expected: PASS.

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit` (or the project's typecheck command)
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add server/openai-codex.js \
        server/modules/providers/list/codex/codex.provider.ts \
        server/modules/providers/list/codex/codex.provider.test.ts
git commit -m "fix(codex): preserve canonical Codex session ids on thread.started

Re-apply the change from backup/pre-merge/02-codex-canonical-ids onto
upstream's new module-based Codex adapter. Adds a normalize branch that
emits a session_created message when the SDK announces a thread, and
re-keys the in-memory session map from the placeholder id to the
canonical thread id."
```

---

## Phase 5: Port F8 — Provider model tracking

Goal: capture the model name for each provider's session and surface it through the session shape returned by the four `*-sessions.provider.ts` files. Also re-apply the SessionManager metadata changes.

### Task 5.1: Re-apply `server/sessionManager.js` changes

**Files:**
- Modify: `server/sessionManager.js`

- [ ] **Step 1: Inspect original change**

Run: `git show backup/pre-merge/01-extend-api-session-mgmt -- server/sessionManager.js`
Expected: `createSession` accepts a `metadata` argument, spreads it onto the session object; `getActiveSessions` (or wherever the listing lives) includes `provider` and `model` fields.

- [ ] **Step 2: Inspect current upstream version**

Run: `grep -n "createSession\\|provider\\|model\\|metadata" server/sessionManager.js | head -30`

Verify the function signatures haven't changed upstream. If upstream has already added `metadata` support, this task may be a no-op — skip to step 5.

- [ ] **Step 3: Edit `server/sessionManager.js`**

Change the `createSession` signature from:
```javascript
createSession(sessionId, projectPath) {
```
to:
```javascript
createSession(sessionId, projectPath, metadata = {}) {
```

In the session object construction, add `...metadata` after `lastActivity`.

In the active-session listing (whatever method enumerates sessions for the API), add:
```javascript
provider: session.provider || 'gemini',
model: session.model || null,
```
to the returned object shape. (Note: `'gemini'` as default reflects the original code; reconsider whether that default still makes sense in the new architecture — it may be safer to default to `null` or to require the caller to specify.)

- [ ] **Step 4: Smoke-check**

Run: `node --check server/sessionManager.js`
Expected: no syntax errors.

- [ ] **Step 5: Commit (deferred — combine with Task 5.2 since they ship together)**

### Task 5.2: Re-apply `server/gemini-cli.js` changes

**Files:**
- Modify: `server/gemini-cli.js`

- [ ] **Step 1: Inspect original change**

Run: `git show backup/pre-merge/01-extend-api-session-mgmt -- server/gemini-cli.js`
Expected: a `modelToUse` const hoisted to the top of `spawnGemini`; session metadata writes (`session.model`, `session.provider`) at three call sites.

- [ ] **Step 2: Apply analogous edits**

Locate `async function spawnGemini(command, options = {}, ws)` in current `server/gemini-cli.js`. At the top (after the `defaults`/`config` block), add:
```javascript
const modelToUse = options.model || 'gemini-2.5-flash';
```

Find the existing line `let modelToUse = options.model || 'gemini-2.5-flash';` further down and DELETE it.

In the resume block (where existing sessions are looked up via `sessionManager.getSession`), add:
```javascript
session.model = session.model || modelToUse;
session.provider = 'gemini';
sessionManager.saveSession(sessionId);
```

In the new-session creation block where `sessionManager.createSession` is called, change:
```javascript
sessionManager.createSession(capturedSessionId, cwd || process.cwd());
```
to:
```javascript
sessionManager.createSession(capturedSessionId, cwd || process.cwd(), {
  provider: 'gemini',
  model: modelToUse
});
```

Add the same `sess.model`/`sess.provider`/`saveSession` block at the post-creation update site (where `sess.cliSessionId = event.session_id` is set).

- [ ] **Step 3: Smoke-check**

Run: `node --check server/gemini-cli.js`
Expected: no syntax errors.

- [ ] **Step 4: Commit (combine sessionManager + gemini-cli)**

```bash
git add server/sessionManager.js server/gemini-cli.js
git commit -m "feat(sessions): track provider and model in SessionManager metadata

Restore the metadata-aware createSession path and Gemini's model
defaulting + writeback pattern from
backup/pre-merge/01-extend-api-session-mgmt onto upstream main."
```

### Task 5.3: Port model extraction to `claude-sessions.provider.ts`

**Files:**
- Modify: `server/modules/providers/list/claude/claude-sessions.provider.ts`
- Test: `server/modules/providers/list/claude/claude-sessions.provider.test.ts` (create if missing)

- [ ] **Step 1: Inspect the legacy logic to port**

Run: `git show backup/pre-merge/01-extend-api-session-mgmt -- server/projects.js | grep -A 5 "model\\|<synthetic>"`

Key behavior to preserve (from `parseJsonlSessions`):
- Initialize each session entry with `model: null`.
- When iterating assistant messages, if `entry.message.model` is a non-empty string AND not equal to `'<synthetic>'`, set `session.model = entry.message.model`. (Last assistant model wins, since the loop overwrites.)

- [ ] **Step 2: Locate the JSONL parsing in upstream's TS file**

Run: `grep -n "model\\|message?.role\\|assistant" server/modules/providers/list/claude/claude-sessions.provider.ts | head -20`

Find the function that reads JSONL session files and constructs session summaries. Identify where new session entries are built (initialize `model`) and where assistant messages are processed (update `model`).

- [ ] **Step 3: Write a failing test**

Test fixture approach: feed a minimal JSONL string to the parser and assert the returned session has `model` set correctly.

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
// Import the parsing function (name and path determined in Step 2).
// If the parsing function is not directly exported, refactor the module
// to export it OR write the test against a higher-level public method.

test('parseJsonlSessions extracts assistant model from messages', async () => {
  const lines = [
    JSON.stringify({ sessionId: 's1', cwd: '/tmp', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ sessionId: 's1', message: { role: 'assistant', model: 'claude-opus-4-7', content: 'hello' } }),
  ].join('\n');
  // Either pass `lines` to a parser that takes a string, or write to a temp file
  // and pass the path. Mirror upstream's existing test style for parser fixtures.
  const result = await parseJsonlSessionsFromString(lines); // pseudocode
  assert.equal(result[0].model, 'claude-opus-4-7');
});

test('parseJsonlSessions ignores <synthetic> model marker', async () => {
  const lines = [
    JSON.stringify({ sessionId: 's2', cwd: '/tmp', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ sessionId: 's2', message: { role: 'assistant', model: '<synthetic>', content: 'x' } }),
    JSON.stringify({ sessionId: 's2', message: { role: 'assistant', model: 'claude-sonnet-4-6', content: 'y' } }),
  ].join('\n');
  const result = await parseJsonlSessionsFromString(lines);
  assert.equal(result[0].model, 'claude-sonnet-4-6'); // <synthetic> skipped, real model wins
});
```

If the parsing function isn't directly testable as a unit, fall back to a black-box integration test: write a JSONL file to a temp dir, point the upstream's higher-level "load sessions for project" function at it, assert the returned session shape includes `model`.

- [ ] **Step 4: Run test → confirm fail**

Run: `node --test --import tsx server/modules/providers/list/claude/claude-sessions.provider.test.ts`
Expected: failure on `model` field assertion.

- [ ] **Step 5: Implement the change**

In the session-construction code path, where new session entries are initialized, add `model: null`.

In the message-processing loop, add (inside the assistant branch):
```typescript
if (typeof entry.message?.model === 'string'
    && entry.message.model.trim()
    && entry.message.model !== '<synthetic>') {
  session.model = entry.message.model;
}
```

Adjust types: if the session struct's TypeScript type doesn't yet include `model`, add it (likely lives in `server/shared/types.ts` or `server/shared/interfaces.ts`).

- [ ] **Step 6: Run test → confirm pass**

Same command. Expected: PASS.

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

### Task 5.4: Port model extraction to `cursor-sessions.provider.ts`

**Files:**
- Modify: `server/modules/providers/list/cursor/cursor-sessions.provider.ts`
- Test: `server/modules/providers/list/cursor/cursor-sessions.provider.test.ts`

Pattern to port (from `getCursorSessions` in legacy `projects.js`):
- After reading session metadata, derive `sessionModel` via:
  ```javascript
  const sessionModel =
    metadata.model ||
    metadata.modelName ||
    metadata.aiModel ||
    metadata.chatModel ||
    metadata.lastModel ||
    metadata.defaultModel ||
    metadata.modelSlug ||
    null;
  ```
- Include in returned session: `model: typeof sessionModel === 'string' ? sessionModel : null`, and `provider: 'cursor'`.

- [ ] **Step 1: Locate equivalent upstream code**

Run: `grep -n "metadata\\|sessionTitle\\|cursor\\|model" server/modules/providers/list/cursor/cursor-sessions.provider.ts | head -30`

- [ ] **Step 2: Write failing test (mirror Task 5.3 pattern)**

Provide a metadata fixture with `modelName: 'gpt-5'`, `model` undefined; assert returned session has `model: 'gpt-5'`. Provide a second fixture with `modelSlug: 'opus-4.5'`, all higher-priority fields undefined; assert `model: 'opus-4.5'`.

- [ ] **Step 3: Run test → confirm fail**

- [ ] **Step 4: Implement using same fallback chain**

Insert into the cursor-session-decoration code path. Match TypeScript types in upstream (likely the metadata object is typed; you may need to extend that type to include the alt model fields, OR cast to `any` if they're not type-checked at this layer — prefer extending the type).

- [ ] **Step 5: Run test → confirm pass**

- [ ] **Step 6: Type-check**

### Task 5.5: Port model extraction to `codex-sessions.provider.ts`

**Files:**
- Modify: `server/modules/providers/list/codex/codex-sessions.provider.ts`
- Test: `server/modules/providers/list/codex/codex-sessions.provider.test.ts`

Pattern to port (from `parseCodexSessionFile`):
- Initialize `let currentModel = null;` outside the loop.
- When processing entries, if `entry.type === 'turn_context'` and `entry.payload.model` is a non-empty string, update `currentModel`.
- On the session-meta entry, capture `modelProvider: entry.payload.model_provider || null`.
- In the final returned session object, set `model: currentModel || sessionMeta.model || null`.

- [ ] **Step 1: Locate equivalent upstream code path** (same `grep` strategy as before)

- [ ] **Step 2: Write failing test**

Fixture: JSONL with one `session_meta` entry (model `gpt-5`, model_provider `openai`) and one `turn_context` entry (model `gpt-5.2`). Assert returned session has `model: 'gpt-5.2'` (turn_context wins) and `modelProvider: 'openai'`.

- [ ] **Step 3: Run test → fail**

- [ ] **Step 4: Implement**

- [ ] **Step 5: Run test → pass**

- [ ] **Step 6: Type-check**

### Task 5.6: Port model extraction to `gemini-sessions.provider.ts`

**Files:**
- Modify: `server/modules/providers/list/gemini/gemini-sessions.provider.ts`
- Test: `server/modules/providers/list/gemini/gemini-sessions.provider.test.ts`

Pattern (from `getGeminiCliSessions`):
- In the returned session object, set `model: session.model || session.modelName || session.config?.model || session.metadata?.model || null` and `provider: 'gemini'`.

- [ ] **Step 1: Locate equivalent code**

- [ ] **Step 2: Write failing test** — fixture with `config.model = 'gemini-2.5-flash'`; expect `model: 'gemini-2.5-flash'`.

- [ ] **Step 3–6: fail → implement → pass → typecheck**

### Task 5.7: Single combined commit for all four providers

After Tasks 5.3 through 5.6 all have passing tests:

- [ ] **Step 1: Stage all four provider TS files and their tests**

```bash
git add server/modules/providers/list/claude/claude-sessions.provider.ts \
        server/modules/providers/list/claude/claude-sessions.provider.test.ts \
        server/modules/providers/list/cursor/cursor-sessions.provider.ts \
        server/modules/providers/list/cursor/cursor-sessions.provider.test.ts \
        server/modules/providers/list/codex/codex-sessions.provider.ts \
        server/modules/providers/list/codex/codex-sessions.provider.test.ts \
        server/modules/providers/list/gemini/gemini-sessions.provider.ts \
        server/modules/providers/list/gemini/gemini-sessions.provider.test.ts \
        server/shared/types.ts server/shared/interfaces.ts  # if you extended these
```

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(providers): track model and provider on every session

Re-apply the per-provider model-extraction logic from
backup/pre-merge/01-extend-api-session-mgmt onto upstream's new
TypeScript provider modules. Each provider's session loader now
returns a 'model' field (with provider-appropriate fallback chain)
and an explicit 'provider' tag, so downstream UI can render model
labels and provider icons consistently."
```

---

## Phase 6: Port F9 — Agent API session-management routes

This is the largest port. The `0335af7` commit added 289 lines to `server/routes/agent.js`: helpers and 3 new routes. The helpers can largely be copied verbatim. The route handler bodies need rewiring to upstream's new module APIs.

### Task 6.1: Add helpers to `server/routes/agent.js` (no behavior change yet)

**Files:**
- Modify: `server/routes/agent.js`

These are pure functions. Copy them as-is.

- [ ] **Step 1: Extract the helpers from the backup**

Run:
```bash
git show backup/pre-merge/01-extend-api-session-mgmt -- server/routes/agent.js > /tmp/agent-diff.patch
```
Inspect `/tmp/agent-diff.patch`. Identify these added blocks and copy them into the current `server/routes/agent.js` (placement: after the existing imports/constants, before the route definitions):

- `const VALID_PROVIDERS = ['claude', 'cursor', 'codex', 'gemini'];`
- `const SAFE_SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,200}$/;`
- `const PROVIDER_METADATA = { … };` (4-key object)
- `const MODEL_REGISTRIES = { … };` (4-key object)
- `function parseOptionalPositiveInt(...)`
- `function validateProvider(...)`
- `function getProjectSessionsForProvider(...)`
- `function inferModelProvider(...)`
- `function formatModelLabelFallback(...)`
- `function resolveModelLabel(...)`
- `function decorateSession(...)`
- `function decorateProject(...)`

(Total ~150 lines of pure helpers; safe to copy verbatim.)

If `VALID_PROVIDERS` already exists in the file post-merge, do NOT redeclare it.

- [ ] **Step 2: Smoke-check**

Run: `node --check server/routes/agent.js`
Expected: no syntax errors.

- [ ] **Step 3: Don't commit yet** — combine with the route additions in Task 6.4 for atomicity.

### Task 6.2: Identify upstream's session-fetching service APIs

**Files:** none (research)

The new routes need three legacy calls replaced. Find their upstream equivalents:

| Legacy call | Upstream replacement (probable) |
|---|---|
| `getProjects()` | `server/modules/projects/services/projects-with-sessions-fetch.service.ts` (export `fetchProjectsWithSessions` or similar) |
| `getSessions(projectName, limit, offset)` (Claude only) | `server/modules/providers/services/sessions.service.ts` (export `listClaudeSessions` or generic `listSessions(provider, projectName, opts)`) |
| `getProvider(provider).fetchHistory(sessionId, opts)` | `server/modules/providers/services/sessions.service.ts` or `session-conversations-search.service.ts` |
| `getAllProviders()` | `server/modules/providers/provider.registry.ts` (export `getRegisteredProviders` or constant `PROVIDERS`) |

- [ ] **Step 1: Read each candidate file's exports**

Run:
```bash
grep -nE "^export " server/modules/projects/services/projects-with-sessions-fetch.service.ts
grep -nE "^export " server/modules/providers/services/sessions.service.ts
grep -nE "^export " server/modules/providers/services/session-conversations-search.service.ts
grep -nE "^export " server/modules/providers/provider.registry.ts
```

Document the exact exported function names + their signatures into a scratch note (e.g., a comment block at the top of the new route handlers — to be removed before committing).

- [ ] **Step 2: Cross-reference with usage elsewhere in upstream**

Run:
```bash
grep -rn "fetchProjectsWithSessions\\|projectsWithSessions\\|listSessions\\|fetchHistory" server/modules/ server/routes/ | head -20
```

This shows real call sites — copy their usage patterns rather than guessing the API.

- [ ] **Step 3: If no equivalent exists** for any of the three calls, raise a flag — that means upstream's API surface is genuinely smaller, and you'll need to either expose a new helper from a service file or implement the read directly. Document this finding before continuing.

### Task 6.3: Port the three new routes (TDD-light)

**Files:**
- Modify: `server/routes/agent.js`
- Test: `server/routes/agent.routes.test.ts` (new — Express integration test)

Routes to add:
1. `GET /api/agent/projects` — list all projects with decorated sessions.
2. `GET /api/agent/projects/:projectName/sessions` — list sessions for a project, paginated, per-provider.
3. `GET /api/agent/sessions/:sessionId/messages` — fetch session message history.

- [ ] **Step 1: Write a failing integration test for the projects endpoint**

Use `node:test` + a lightweight HTTP harness (e.g., `supertest` if upstream uses it; otherwise, a manual `http.request` against an Express app). Check what upstream uses:

```bash
grep -rn "supertest\\|fetch.*localhost\\|http.request" server/ --include='*.test.ts' | head -10
```

If upstream uses `supertest`, mirror that. If upstream has no HTTP-level tests, write a unit-level test of the route handlers by calling them with mocked `req`/`res` objects.

A skeleton:
```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import agentRouter from '../routes/agent.js';

test('GET /agent/projects returns decorated projects', async () => {
  const app = express();
  app.use((req, _res, next) => { req.user = { id: 1 }; next(); }); // bypass auth in test
  app.use('/agent', agentRouter);

  const res = await request(app).get('/agent/projects').set('x-api-key', 'fake-test-key');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.projects));
  if (res.body.projects.length > 0) {
    const sess = res.body.projects[0].sessions?.[0];
    if (sess) {
      assert.ok('provider' in sess && 'modelLabel' in sess, 'sessions should be decorated');
    }
  }
});
```

NOTE: the test relies on a real DB / real session files. Two options:
- Mock the service layer (cleaner — replace `fetchProjectsWithSessions` with a stub).
- Use a temp-dir fixture (more realistic but heavier).

Pick the approach that matches upstream's testing conventions for routes.

- [ ] **Step 2: Run test → confirm fail (route doesn't exist yet)**

- [ ] **Step 3: Implement `GET /agent/projects`**

```javascript
router.get('/projects', validateExternalApiKey, async (req, res) => {
  try {
    // Replace getProjects() with the upstream equivalent identified in Task 6.2
    const rawProjects = await fetchProjectsWithSessions(req.user.id /* if scoped */);
    const projects = rawProjects.map(decorateProject);
    res.json({ success: true, projects });
  } catch (error) {
    console.error('Error fetching external API projects:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch projects' });
  }
});
```

If `fetchProjectsWithSessions` lives in a TS module and the calling file is JS, ensure the export is consumable (upstream's build setup using `tsx` or similar should handle this — verify by running the test).

- [ ] **Step 4: Run test → pass**

- [ ] **Step 5: Repeat steps 1–4 for `GET /projects/:projectName/sessions`**

Translate the legacy logic:
- For `provider === 'claude'`: legacy called `getSessions(projectName, limit ?? 20, offset)` and returned `{ sessions, total, offset, limit, hasMore }`.
  → Replace with the upstream paginated session loader for Claude. If a paginated-by-provider helper doesn't exist, you may need to load the full list and paginate in the route. Prefer adding a helper to `sessions.service.ts` if the heavy filter is non-trivial.
- For other providers: legacy called `getProjects()` and pulled the matching project's session array, then sliced. Same approach against upstream's projects-with-sessions service.

- [ ] **Step 6: Repeat for `GET /sessions/:sessionId/messages`**

Legacy used `getProvider(provider).fetchHistory(sessionId, opts)`. Find upstream's "load conversation/messages for sessionId" function — likely in `session-conversations-search.service.ts` or per-provider in `*-session-synchronizer.provider.ts`. Replace the call.

- [ ] **Step 7: Combined commit**

```bash
git add server/routes/agent.js server/routes/agent.routes.test.ts
git commit -m "feat(agent-api): expose project, session, and message routes

Re-apply the three GET routes (and supporting helpers) from
backup/pre-merge/01-extend-api-session-mgmt onto upstream's new
service-based architecture. Routes now delegate to
fetchProjectsWithSessions / sessions.service / session-conversations
instead of the legacy projects.js + providers/registry.js calls."
```

---

## Phase 7: Port F10 — Authenticated usage-limits endpoint

`server/routes/usage-limits.js` is 895 lines and imports `{ getAllProviders, getStatusChecker }` from `'../providers/registry.js'` — both deleted. Need to rewrite the import + adjust call sites.

### Task 7.1: Restore the file from the backup tag (as a starting point)

**Files:**
- Create: `server/routes/usage-limits.js`

- [ ] **Step 1: Restore**

Run: `git checkout backup/pre-merge/03-usage-limits-endpoint -- server/routes/usage-limits.js`
Expected: file restored at 895 lines, but it WILL fail to start because of the broken import.

- [ ] **Step 2: Don't commit yet — fix imports first.**

### Task 7.2: Rewire imports to upstream's registry/services

**Files:**
- Modify: `server/routes/usage-limits.js`

- [ ] **Step 1: Identify upstream's replacements**

```bash
grep -nE "^export " server/modules/providers/provider.registry.ts
grep -rn "getStatusChecker\\|statusChecker\\|provider.*status" server/modules/ | head -20
```

Find:
- `getAllProviders()` equivalent → likely a constant array or factory in `provider.registry.ts`
- `getStatusChecker(provider)` equivalent → likely a method on the new provider class (e.g., `claudeProvider.checkStatus()`) or a service in `provider-auth.service.ts`

- [ ] **Step 2: Rewrite the import**

Replace:
```javascript
import { getAllProviders, getStatusChecker } from '../providers/registry.js';
```
with the equivalent imports from `server/modules/providers/`. Likely:
```javascript
import { providerRegistry } from '../modules/providers/provider.registry.js';
// or
import { listProviders, getProviderById } from '../modules/providers/provider.registry.js';
```

The exact form depends on Step 1's findings.

- [ ] **Step 3: Update every call site**

Every `getAllProviders()` call → use the new listing function.
Every `getStatusChecker(providerName)` call → use the new status-check method (likely `provider.checkStatus()` or `provider.getAuthStatus()`).

```bash
grep -n "getAllProviders\\|getStatusChecker" server/routes/usage-limits.js
```

Walk through each line and substitute. Where the legacy `getStatusChecker` returned a function, the new shape may return an object — adjust call patterns accordingly.

- [ ] **Step 4: Smoke-check**

Run: `node --check server/routes/usage-limits.js`
Expected: no syntax errors. (Note: `node --check` won't catch import-resolution errors against `.ts` modules; the next step does.)

- [ ] **Step 5: Manual import-resolution check**

Try to start the server briefly:
```bash
# Use the project's actual dev command from package.json:
npm run server 2>&1 | head -30
# or
npm run dev 2>&1 | head -30
```
Expected: server starts (or fails for unrelated reasons, but does NOT throw a "module not found" or "X is not a function" error mentioning provider registry / status checker).

If it fails: read the error, fix the call site, re-run.

### Task 7.3: Re-register the route in `server/index.js`

**Files:**
- Modify: `server/index.js`

- [ ] **Step 1: Confirm upstream already added the route registration line**

Run: `grep -n "usage-limits\\|usageLimitsRoutes" server/index.js`
Expected: a `app.use('/api/usage-limits', authenticateToken, usageLimitsRoutes);` line already exists in upstream's main (it was added in the shared region during the earlier merge attempt).

If it does NOT exist (upstream changed its mind), add it next to the other route registrations.

- [ ] **Step 2: Confirm the import is missing and add it**

Run: `grep -n "import usageLimitsRoutes" server/index.js`
Expected: NO results (this is the missing piece).

Add at the top of the file, alongside the other `import xRoutes from './routes/x.js';` block:
```javascript
import usageLimitsRoutes from './routes/usage-limits.js';
```

- [ ] **Step 3: Smoke-check**

Run: `node --check server/index.js`
Expected: no syntax errors.

### Task 7.4: Manual end-to-end verification

**Files:** none

- [ ] **Step 1: Start the server**

Run the project's dev command (from `package.json`).

- [ ] **Step 2: Hit the new endpoint**

Run: `curl -s -H "x-api-key: $TEST_API_KEY" http://localhost:3001/api/usage-limits | head -40`
(Replace port if upstream uses a different default — check `package.json` or `server/constants/config.js`.)

Expected: a JSON response with provider status data, NOT a 404 or 500.

- [ ] **Step 3: Stop the server**

### Task 7.5: Commit F10

- [ ] **Step 1: Stage and commit**

```bash
git add server/routes/usage-limits.js server/index.js
git commit -m "feat(usage-limits): re-apply authenticated usage-limits route

Restore the 895-line route from
backup/pre-merge/03-usage-limits-endpoint and rewire its
provider/status-checker imports onto upstream's new
modules/providers/provider.registry surface. Adds the missing
import line in server/index.js (the route registration was
already present in upstream's tree)."
```

---

## Phase 8: Final verification

### Task 8.1: Type-check everything

- [ ] **Step 1: Run typecheck**

Run: `npx tsc --noEmit` (or whatever the project's lint command is)
Expected: zero new errors compared to fresh upstream/main.

If errors remain: fix at the source. Don't suppress.

### Task 8.2: Run the full test suite

- [ ] **Step 1: Identify the test command**

Run: `node -e "console.log(require('./package.json').scripts.test || 'no test script')"`

- [ ] **Step 2: Run all tests**

Run: the project's test command (likely `node --test --import tsx 'server/**/*.test.ts'` or `npm test`).
Expected: all green. Pay attention to the four new `*-sessions.provider.test.ts` and the `agent.routes.test.ts` files.

- [ ] **Step 3: If tests fail**, debug and fix. Do NOT proceed to the next task with red tests.

### Task 8.3: Manual smoke test of the running app

- [ ] **Step 1: Start the dev server (frontend + backend)**

Run the project's dev command.

- [ ] **Step 2: Open the app in a browser**

Navigate to `http://localhost:3000` (or whatever port Vite uses).

- [ ] **Step 3: Verify these flows work**

- Open a project, see its sessions listed.
- Sessions show provider icons + model labels (F8 + F6 verification).
- Open the demo UI: `http://localhost:3001/session-api-demo.html` (F4 verification).
- Hit the API docs: `http://localhost:3001/api-docs.html` (F5 verification, look for the new sections).
- Hit `/api/agent/projects` with a valid API key (F9 verification).
- Hit `/api/usage-limits` with a valid token (F10 verification).
- Start a new Codex session, observe that the session ID in the URL/UI matches the canonical thread id (F7 verification).
- Start a new Gemini session, verify the model is captured in the session metadata (F8 + F2 verification).

- [ ] **Step 4: Document any issues found** in a scratch note. Fix them before merging.

### Task 8.4: Final review of the porting branch

- [ ] **Step 1: Look at every commit**

Run: `git log --oneline main..feat/port-from-pre-merge-backup`
Expected: 8–10 atomic commits, one per feature, each with a clear message.

- [ ] **Step 2: Check the cumulative diff against main**

Run: `git diff main..feat/port-from-pre-merge-backup --stat`
Expected: roughly mirrors the file count we ported (a dozen-ish files).

- [ ] **Step 3: Self-review for forgotten pieces**

Cross-reference the feature inventory table at the top of this plan against the porting-branch commit messages. Every row should map to at least one commit.

---

## Phase 9: Merge porting branch into main

### Task 9.1: Fast-forward main

- [ ] **Step 1: Check out main**

Run: `git checkout main`

- [ ] **Step 2: Fast-forward**

Run: `git merge --ff-only feat/port-from-pre-merge-backup`
Expected: clean fast-forward.

If non-FF (because main moved during the porting work): rebase the porting branch onto main first:
```bash
git checkout feat/port-from-pre-merge-backup
git rebase main
git checkout main
git merge --ff-only feat/port-from-pre-merge-backup
```

- [ ] **Step 3: Push to origin**

Run: `git push origin main`
Expected: fast-forward, no force.

### Task 9.2: Optionally delete the porting branch

- [ ] **Step 1: Local delete**

Run: `git branch -d feat/port-from-pre-merge-backup`

- [ ] **Step 2: Remote delete (if you pushed it during porting)**

Run: `git push origin --delete feat/port-from-pre-merge-backup` (only if it was pushed)

---

## Phase 10: Cleanup & long-term maintenance hygiene

### Task 10.1: Decide on the umbrella backup branch's fate

The `backup/pre-upstream-merge` branch is now redundant if all features were ported successfully. Two options:

- **Keep it for 30 days, then delete** — safest. Add a calendar reminder.
- **Delete it now** — cleaner. Tags `backup/pre-merge/01-08` already capture the per-commit history.

- [ ] **Step 1: Choose, document the decision in `docs/superpowers/plans/2026-05-06-backup-manifest.md`.**

- [ ] **Step 2: If deleting**, run:
```bash
git branch -D backup/pre-upstream-merge
git push origin --delete backup/pre-upstream-merge
```

### Task 10.2: Document the upstream-sync workflow for next time

Now that we have the muscle memory, capture it:

**Files:**
- Create: `docs/upstream-sync-runbook.md`

- [ ] **Step 1: Write a short runbook** capturing the steps used in this plan, distilled into ~50 lines so future-us can sync without re-deriving the strategy.

Sections:
- "When to sync" (when local divergence becomes painful, or when a CVE/important fix lands upstream).
- "Pre-flight checklist" (clean tree, all local commits squashed-or-tagged-or-noted, decide preserve vs. abandon for each).
- "Mechanics" (backup tags → reset → push --force-with-lease → port branch → atomic commits → merge).
- "Pitfalls observed in 2026-05-06 sync" (huge upstream refactor moved files around; legacy import paths broke; modify/delete conflicts required porting-not-merging).

### Task 10.3: Final commit

- [ ] **Step 1: Commit the runbook + final manifest update**

```bash
git add docs/upstream-sync-runbook.md docs/superpowers/plans/2026-05-06-backup-manifest.md
git commit -m "docs: capture upstream-sync runbook learned from 2026-05-06"
git push origin main
```

---

## Risk register & rollback playbook

### What can go wrong + how to recover

| Risk | Likelihood | Recovery |
|---|---|---|
| Force-push to fork main wipes a teammate's work | low (solo fork) | Recover via `backup/pre-upstream-merge` branch on origin: `git checkout main && git reset --hard backup/pre-upstream-merge && git push --force-with-lease origin main`. |
| Porting introduces a regression that's hard to debug | medium | Each feature is its own commit. `git revert <sha>` removes one feature without losing the rest. |
| Upstream service exports something we don't expect (e.g., async generator instead of array) | medium | Caught early in Task 6.2 (research before implement). If discovered later, write an adapter layer in the route handler. |
| `node:test` runner doesn't pick up our `*.test.ts` files because of a glob mismatch | low | Verify with `node --test --import tsx server/modules/providers/list/codex/codex.provider.test.ts` directly before relying on the broad test command. |
| Cherry-pick of `backup/pre-merge/04-api-docs` produces deeply tangled conflicts | medium | Fall back to manual merge: `git checkout backup/pre-merge/04-api-docs -- public/api-docs.html` then resolve manually against the upstream version, then commit. |

### Hard-stop signals

If any of these happen, pause and re-plan:
- Typecheck failures grow past 5 in a single task — likely a deeper API change in upstream that needs a wider rewrite.
- The `agent.js` route bodies need >50 lines of glue code per route — likely the upstream service surface is too narrow; consider proposing a service-layer change first.
- The `node:test` runner can't load TypeScript test files — fall back to plain `.test.js` files (lose type safety in tests, but unblock the work).

---

## Self-review checklist (run before handing off to executor)

- [ ] Every feature in the inventory table has at least one task in Phases 3–7.
- [ ] No "TBD" / "implement later" / "appropriate validation" placeholders exist.
- [ ] Every code block in a step shows real code (or, where the code depends on Task 6.2 research, says so explicitly with a clear lookup command).
- [ ] Function names referenced in later tasks match definitions in earlier tasks (`decorateSession`, `decorateProject`, `parseOptionalPositiveInt`, `validateProvider`, `getProjectSessionsForProvider`, `inferModelProvider`, `formatModelLabelFallback`, `resolveModelLabel`, `fetchProjectsWithSessions` — last one is upstream's, verified in 6.2).
- [ ] Every commit message is conventional-commit style and references the source backup tag where the change came from.
- [ ] Rollback path is documented for each phase.
