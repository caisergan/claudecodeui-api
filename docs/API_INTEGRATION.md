# ClaudecodeUI API Integration Documentation

This document is the integration reference for all backend REST endpoints currently mounted in `server/index.js`.

## Base URL and Auth

- Base URL (local): `http://localhost:<SERVER_PORT>`
- Health check: `GET /health` (no auth)
- Most endpoints are under `/api/*`.

### Auth Layers

1. Global API key guard (optional):
- Enabled only if server `API_KEY` env var is set.
- Applies to all `/api/*` routes.
- Header: `x-api-key: <API_KEY>`

2. JWT auth (`authenticateToken`) for app endpoints:
- Header: `Authorization: Bearer <jwt>`
- JWT obtained from `/api/auth/login` or `/api/auth/register`.

3. External Agent API auth (`/api/agent/*`):
- Uses API keys from app settings (not JWT).
- Header: `x-api-key: <user_api_key>` (or query `?apiKey=...`).

## Common Response Patterns

- Success often returns `200` with JSON.
- Errors generally return:
  - `400` bad input
  - `401/403` auth issues
  - `404` not found
  - `409` conflict
  - `500` server/runtime errors

## 1) Core / Utility Endpoints

### `GET /health`
- Auth: none
- Response: `{ status: "ok", ... }` (basic service health)
- Local-only extra field:
  - `appInstallPath` is included for loopback requests and points to the server install root. This is useful for local tools that need a valid server-side `projectPath`.

### `POST /api/system/update`
- Auth: JWT
- Purpose: trigger system update workflow.
- Response: `{ success: true, ... }` or `{ success: false, error }`.

### `GET /api/search/conversations`
- Auth: JWT
- Query:
  - `q` (required, min 2 chars)
  - `limit` (optional)
- Response: search result list across conversations.

### `GET /api/browse-filesystem`
- Auth: JWT
- Query:
  - `path` (required; validated)
- Response: directory entries and metadata.

### `POST /api/create-folder`
- Auth: JWT
- Body:
  - `path` (required)
- Response: `{ success: true, path }`.

## 2) Auth Endpoints (`/api/auth`)

### `GET /api/auth/status`
- Auth: none
- Response: auth bootstrap status (e.g., user existence / setup state).

### `POST /api/auth/register`
- Auth: none
- Body:
  - `username` (min 3)
  - `password` (min 6)
- Response:
  - Success: `{ success: true, token, user }`
  - Errors: single-user conflict (`403`), duplicate (`409`), validation (`400`)

### `POST /api/auth/login`
- Auth: none
- Body:
  - `username`
  - `password`
- Response: `{ success: true, token, user }`.

### `GET /api/auth/user`
- Auth: JWT
- Response: current user info.

### `POST /api/auth/logout`
- Auth: JWT
- Response: `{ success: true, message }`.

## 3) Project and Session Endpoints (Index-level)

### `GET /api/projects`
- Auth: JWT
- Response: project list.

### `POST /api/projects/create`
- Auth: JWT
- Body:
  - `path` (project path, required)
- Response: `{ success: true, project }`.

### `PUT /api/projects/:projectName/rename`
- Auth: JWT
- Body:
  - `displayName` (required)
- Response: `{ success: true }`.

### `DELETE /api/projects/:projectName`
- Auth: JWT
- Query:
  - `force` (`true|false`)
  - `deleteData` (`true|false`)
- Response: `{ success: true }`.

### `GET /api/projects/:projectName/sessions`
- Auth: JWT
- Query:
  - `limit` (optional)
  - `offset` (optional)
- Response: paginated sessions object.

### `DELETE /api/projects/:projectName/sessions/:sessionId`
- Auth: JWT
- Response: `{ success: true }`.

### `PUT /api/sessions/:sessionId/rename`
- Auth: JWT
- Body:
  - `summary` (required, <=500 chars)
  - `provider` (`claude|codex|cursor|gemini`, required)
- Response: `{ success: true }`.

## 4) Filesystem-in-Project Endpoints

### `GET /api/projects/:projectName/files`
- Auth: JWT
- Purpose: list files/tree for project.
- Response: file list/tree.

### `GET /api/projects/:projectName/file`
- Auth: JWT
- Query:
  - `filePath` (required)
- Response: `{ content, path }`.

### `GET /api/projects/:projectName/files/content`
- Auth: JWT
- Query:
  - `path` (required)
- Response: file content payload.

### `PUT /api/projects/:projectName/file`
- Auth: JWT
- Body:
  - `filePath` (required)
  - `content` (required)
- Response: save result with file path.

### `POST /api/projects/:projectName/files/create`
- Auth: JWT
- Body:
  - `path` (parent path)
  - `type` (`file|directory`, required)
  - `name` (required, validated)
- Response: creation result with target path.

### `PUT /api/projects/:projectName/files/rename`
- Auth: JWT
- Body:
  - `oldPath` (required)
  - `newName` (required)
- Response: rename result.

### `DELETE /api/projects/:projectName/files`
- Auth: JWT
- Body:
  - `path` (required)
  - `type` (optional; file/directory hint)
- Response: deletion result.

### `POST /api/projects/:projectName/files/upload`
- Auth: JWT
- Multipart upload endpoint.
- Limits (from handler):
  - max file size ~50MB/file
  - max file count ~20
- Body/form:
  - files + optional target path metadata
- Response: uploaded files summary.

### `POST /api/projects/:projectName/upload-images`
- Auth: JWT
- Multipart images upload + processing.
- Response: `{ images: [...] }`.

## 5) Session Analytics

### `GET /api/projects/:projectName/sessions/:sessionId/token-usage`
- Auth: JWT
- Query:
  - `provider` (optional, default `claude`)
- Response: token usage summary for session (provider-specific parser).

## 6) Workspace Endpoints (`/api/projects` router module)

### `POST /api/projects/create-workspace`
- Auth: JWT
- Body:
  - `workspaceType` (`existing|new`, required)
  - `path` (required)
  - `githubUrl` (optional)
  - `githubTokenId` (optional)
  - `newGithubToken` (optional)
- Response: workspace creation/clone result and metadata.

### `GET /api/projects/clone-progress`
- Auth: JWT
- Query:
  - `path`
  - `githubUrl`
  - `githubTokenId`
  - `newGithubToken`
- Response: live/step clone progress.

## 7) Settings Endpoints (`/api/settings`)

### API Keys

#### `GET /api/settings/api-keys`
- Auth: JWT
- Response: `{ apiKeys: [...] }` (sanitized).

#### `POST /api/settings/api-keys`
- Auth: JWT
- Body:
  - `keyName` (required)
- Response: created key metadata + plaintext key (on create).

#### `DELETE /api/settings/api-keys/:keyId`
- Auth: JWT
- Response: `{ success: true }`.

#### `PATCH /api/settings/api-keys/:keyId/toggle`
- Auth: JWT
- Body:
  - `isActive` (boolean, required)
- Response: `{ success: true }`.

### Credentials

#### `GET /api/settings/credentials`
- Auth: JWT
- Query:
  - `type` (optional filter)
- Response: `{ credentials: [...] }`.

#### `POST /api/settings/credentials`
- Auth: JWT
- Body:
  - `credentialName` (required)
  - `credentialType` (required)
  - `credentialValue` (required)
  - `description` (optional)
- Response: created credential metadata.

#### `DELETE /api/settings/credentials/:credentialId`
- Auth: JWT
- Response: `{ success: true }`.

#### `PATCH /api/settings/credentials/:credentialId/toggle`
- Auth: JWT
- Body:
  - `isActive` (boolean, required)
- Response: `{ success: true }`.

### Notifications / Web Push

#### `GET /api/settings/notification-preferences`
- Auth: JWT
- Response: `{ success: true, preferences }`.

#### `PUT /api/settings/notification-preferences`
- Auth: JWT
- Body: preferences object (partial/full).
- Response: `{ success: true, preferences }`.

#### `GET /api/settings/push/vapid-public-key`
- Auth: JWT
- Response: `{ publicKey }`.

#### `POST /api/settings/push/subscribe`
- Auth: JWT
- Body:
  - `endpoint` (required)
  - `keys` (required)
- Response: `{ success: true }`.

#### `POST /api/settings/push/unsubscribe`
- Auth: JWT
- Body:
  - `endpoint` (required)
- Response: `{ success: true }`.

## 8) User Endpoints (`/api/user`)

### `GET /api/user/git-config`
- Auth: JWT
- Response: git name/email and status.

### `POST /api/user/git-config`
- Auth: JWT
- Body:
  - `gitName` (required)
  - `gitEmail` (required, validated)
- Response: `{ success: true, ... }`.

### `POST /api/user/complete-onboarding`
- Auth: JWT
- Response: onboarding completion status.

### `GET /api/user/onboarding-status`
- Auth: JWT
- Response: onboarding status flags.

## 9) CLI Auth Status (`/api/cli`)

Provider status checks:

- `GET /api/cli/claude/status`
- `GET /api/cli/cursor/status`
- `GET /api/cli/codex/status`
- `GET /api/cli/gemini/status`

Auth: JWT  
Response: provider installation/auth state:
- `installed`
- `authenticated`
- `email`
- `method`
- `error`

## 10) Messages Endpoint (`/api/sessions`)

### `GET /api/sessions/:sessionId/messages`
- Auth: JWT
- Query:
  - `provider` (default `claude`)
  - `projectName` (required for some providers)
  - `projectPath` (required for some providers)
  - `limit` (optional)
  - `offset` (optional)
- Response: normalized message history payload.

## 11) Usage Limits Endpoint (`/api/usage-limits`)

### `GET /api/usage-limits`
- Auth: JWT
- Query:
  - `provider` (optional; one of `claude|codex|cursor|gemini`)
  - `refresh` (`true` to bypass 30s cache)
- Response:
  - `{ success, checkedAt, providers: { [provider]: ProviderUsageResult } }`

See provider result contract in detail:
- `provider`, `installed`, `authenticated`, `account`, `authMethod`
- `planType`, `organization`
- `supportLevel`: `unsupported|best_effort|partial|direct_api`
- `supportsRemainingQuota`
- `state` (e.g. `available`, `limit_reached`, `auth_required`, ...)
- `limitReached`, `resetAt`, `lastSeenAt`, `source`, `message`
- `limits` buckets (`primary`, `secondary`, code-review, `additional`)
- `credits`, `spendControl`, `meta`

## 12) Git Endpoints (`/api/git`)

All require JWT.

### Read / Status
- `GET /api/git/status?project=<name>`
- `GET /api/git/diff?project=<name>&file=<path>`
- `GET /api/git/file-with-diff?project=<name>&file=<path>`
- `GET /api/git/branches?project=<name>`
- `GET /api/git/commits?project=<name>&limit=<n>`
- `GET /api/git/commit-diff?project=<name>&commit=<sha>`
- `GET /api/git/remote-status?project=<name>`

### Write / Mutations
- `POST /api/git/initial-commit`
  - Body: `{ project }`
- `POST /api/git/commit`
  - Body: `{ project, message, files }`
- `POST /api/git/revert-local-commit`
  - Body: `{ project }`
- `POST /api/git/checkout`
  - Body: `{ project, branch }`
- `POST /api/git/create-branch`
  - Body: `{ project, branch }`
- `POST /api/git/delete-branch`
  - Body: `{ project, branch }`
- `POST /api/git/generate-commit-message`
  - Body: `{ project, files, provider }` where provider is `claude|cursor`
- `POST /api/git/fetch`
  - Body: `{ project }`
- `POST /api/git/pull`
  - Body: `{ project }`
- `POST /api/git/push`
  - Body: `{ project }`
- `POST /api/git/publish`
  - Body: `{ project, branch }`
- `POST /api/git/discard`
  - Body: `{ project, file }`
- `POST /api/git/delete-untracked`
  - Body: `{ project, file }`

Responses are command-result style JSON with `success`, `output`, and/or structured git metadata.

## 13) MCP Endpoints (Claude CLI) (`/api/mcp`)

All require JWT.

### `GET /api/mcp/cli/list`
- Response: parsed list of Claude MCP servers.

### `POST /api/mcp/cli/add`
- Body:
  - `name` (required)
  - `type` (`stdio|sse|http`, default `stdio`)
  - `command`, `args`, `url`, `headers`, `env`
  - `scope` (`user|project`, default `user`)
  - `projectPath` (required when `scope=project`)

### `POST /api/mcp/cli/add-json`
- Body:
  - `name` (required)
  - `jsonConfig` (required JSON string/object)
  - `scope` (`user|project`)
  - `projectPath` if project scope

### `DELETE /api/mcp/cli/remove/:name`
- Query:
  - `scope` (optional)

### `GET /api/mcp/cli/get/:name`
- Response: parsed single server details.

### `GET /api/mcp/config/read`
- Response: merged/readable config + source metadata.

## 14) MCP Utils Endpoints (`/api/mcp-utils`)

All require JWT.

- `GET /api/mcp-utils/taskmaster-server`
- `GET /api/mcp-utils/all-servers`

Return combined MCP utility data for UI consumption.

## 15) Cursor Endpoints (`/api/cursor`)

All require JWT.

- `GET /api/cursor/config`
- `POST /api/cursor/config`
  - Body: `{ permissions, model }`
- `GET /api/cursor/mcp`
- `POST /api/cursor/mcp/add`
  - Body: `{ name, type, command, args, url, headers, env }`
- `DELETE /api/cursor/mcp/:name`
- `POST /api/cursor/mcp/add-json`
  - Body: `{ name, jsonConfig }`
- `GET /api/cursor/sessions?projectPath=<path>`

## 16) Codex Endpoints (`/api/codex`)

All require JWT.

- `GET /api/codex/config`
- `GET /api/codex/sessions?projectPath=<path>`
- `DELETE /api/codex/sessions/:sessionId`

Codex MCP management:
- `GET /api/codex/mcp/cli/list`
- `POST /api/codex/mcp/cli/add`
  - Body: `{ name, command, args?, env? }`
- `DELETE /api/codex/mcp/cli/remove/:name`
- `GET /api/codex/mcp/cli/get/:name`
- `GET /api/codex/mcp/config/read`

## 17) Gemini Endpoints (`/api/gemini`)

All require JWT.

- `DELETE /api/gemini/sessions/:sessionId`

## 18) Commands Endpoints (`/api/commands`)

All require JWT.

### `POST /api/commands/list`
- Body:
  - `projectPath` (required)
- Response: list of command files and metadata.

### `POST /api/commands/load`
- Body:
  - `commandPath` (required)
- Response: parsed command details.

### `POST /api/commands/execute`
- Body:
  - `commandName` or `commandPath` (at least one required)
  - `args` (optional array)
  - `context` (optional object)
- Response: execution result and output payload.

## 19) Taskmaster Endpoints (`/api/taskmaster`)

All require JWT.

Installation/detection:
- `GET /api/taskmaster/installation-status`
- `GET /api/taskmaster/detect/:projectName`
- `GET /api/taskmaster/detect-all`

Initialization / workflow:
- `POST /api/taskmaster/initialize/:projectName`
  - Body: `{ rules? }`
- `POST /api/taskmaster/init/:projectName`
- `GET /api/taskmaster/next/:projectName`

Tasks:
- `GET /api/taskmaster/tasks/:projectName`
- `POST /api/taskmaster/add-task/:projectName`
  - Body: `{ prompt?, title?, description?, priority?, dependencies? }`
- `PUT /api/taskmaster/update-task/:projectName/:taskId`
  - Body: `{ title?, description?, status?, priority?, details? }`

PRD:
- `GET /api/taskmaster/prd/:projectName`
- `POST /api/taskmaster/prd/:projectName`
  - Body: `{ fileName, content }`
- `GET /api/taskmaster/prd/:projectName/:fileName`
- `DELETE /api/taskmaster/prd/:projectName/:fileName`
- `POST /api/taskmaster/parse-prd/:projectName`
  - Body: `{ fileName?, numTasks?, append? }`
- `GET /api/taskmaster/prd-templates`
- `POST /api/taskmaster/apply-template/:projectName`
  - Body: `{ templateId, fileName?, customizations? }`

## 20) Plugin Endpoints (`/api/plugins`)

All require JWT.

### Plugin management
- `GET /api/plugins/`
- `GET /api/plugins/:name/manifest`
- `GET /api/plugins/:name/assets/*`
- `PUT /api/plugins/:name/enable`
  - Body: `{ enabled: boolean }`
- `POST /api/plugins/install`
  - Body: `{ url }`
- `POST /api/plugins/:name/update`
- `DELETE /api/plugins/:name`

### Plugin RPC proxy
- `ALL /api/plugins/:name/rpc/*`
- Purpose: forward request to plugin subprocess HTTP server.
- Notes:
  - Forwards method and query.
  - Forwards JSON body when present.
  - Injects plugin secrets as `x-plugin-secret-*` headers.

## 21) Agent API Endpoints (`/api/agent`)

Auth: **External API key** (`x-api-key`), not JWT.

### `GET /api/agent/projects`
- Response: `{ success, projects }` (decorated with provider/model metadata).

### `GET /api/agent/projects/:projectName/sessions`
- Query:
  - `provider` (`claude|cursor|codex|gemini`, default `claude`)
  - `offset` (optional)
  - `limit` (optional)
- Response: provider-specific paginated sessions.

### `GET /api/agent/sessions/:sessionId/messages`
- Query:
  - `provider` (default `claude`)
  - `projectName` / `projectPath` (provider-dependent)
  - `offset`, `limit`
- Response: normalized messages payload.

### `POST /api/agent`
- Purpose: run agent task against existing project path or cloned GitHub repo.
- Body:
  - `message` (required)
  - `provider` (`claude|cursor|codex|gemini`, default `claude`)
  - `model` (optional)
  - `sessionId` (optional, continue existing)
  - `githubUrl` OR `projectPath` (at least one required)
  - `githubToken` (optional)
  - `stream` (optional, default `true`)
  - `cleanup` (optional, default `true`)
  - `createBranch` (optional)
  - `branchName` (optional; implies createBranch)
  - `createPR` (optional)

#### Streaming mode (`stream=true`)
- Content-Type: `text/event-stream`
- Event payloads include:
  - `status`
  - `assistant-message`
  - `github-branch`
  - `github-pr`
  - `github-error`
  - `error`

#### Non-stream mode (`stream=false`)
- Response JSON:
  - `success`
  - `sessionId`
  - `messages` (assistant outputs)
  - `tokens` summary
  - `projectPath`
  - optional `branch` / `pullRequest`

## Integration Recommendations

1. Build one shared HTTP client that auto-applies:
- `Authorization: Bearer ...` for app endpoints.
- `x-api-key` for `/api/agent/*`.

2. Handle long-running endpoints with:
- request timeout >60s for non-stream
- SSE client for `/api/agent` streaming mode

3. For user-facing errors, show server `error` and optional `details`.

4. Treat `/api/usage-limits` and `/api/cli/*/status` as readiness/guard rails before launching expensive model operations.

---

Last updated against current code on: `2026-04-19`
