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
