# OpenAI-Compatible Chat Completions Proxy

## Overview

Add a `/v1/chat/completions` endpoint to claudecodeui-api that translates OpenAI-format requests into CLI agent calls (Claude SDK, Codex SDK, Gemini CLI) and returns OpenAI-format responses. This allows any OpenAI-compatible client (e.g. Resume-Matcher, LiteLLM consumers) to use claudecodeui-api as a proxy.

## Scope

- Simple chat proxy only — text in, text out
- No file editing, tool use forwarding, or project-aware agent mode
- Stateless — no session resumption between requests

## Endpoint

`POST /v1/chat/completions`

## Authentication

Reuse existing API key system. Accepts:
- `Authorization: Bearer ck_...` header (standard OpenAI client format)
- `X-API-Key: ck_...` header (existing internal format)

Validated against `apiKeysDb` (same as `/api/agent`).

## Model Format

`provider:model` prefix scheme:

| Prefix | Provider | Examples |
|--------|----------|----------|
| `claude:` | Claude (SDK) | `claude:sonnet`, `claude:opus`, `claude:haiku` |
| `codex:` | Codex (SDK) | `codex:gpt-5-nano`, `codex:o3`, `codex:o4-mini` |
| `gemini:` | Gemini (CLI) | `gemini:gemini-3-flash`, `gemini:gemini-3-pro` |

No prefix → 400 error with guidance.

## Request Format

Standard OpenAI chat completions request:

```json
{
  "model": "claude:sonnet",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Hello"}
  ],
  "stream": false,
  "temperature": 0.7,
  "max_tokens": 4096
}
```

### Messages → Prompt Translation

CLI agents accept a single prompt string. The `messages` array is concatenated:

```
[System] You are a helpful assistant.

[User] Hello

[Assistant] Hi there!

[User] How are you?
```

- `system` messages → `[System] content` at the top
- `user` messages → `[User] content`
- `assistant` messages → `[Assistant] content`
- Separated by blank lines
- Only the concatenated string is passed to the agent; `temperature` and `max_tokens` are not forwarded (CLI agents don't support these parameters)

## Response Format

### Non-Streaming (`stream: false`)

```json
{
  "id": "chatcmpl-<uuid>",
  "object": "chat.completion",
  "created": 1700000000,
  "model": "claude:sonnet",
  "choices": [{
    "index": 0,
    "message": {"role": "assistant", "content": "..."},
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 150,
    "completion_tokens": 50,
    "total_tokens": 200
  }
}
```

### Streaming (`stream: true`)

SSE with `Content-Type: text/event-stream`:

```
data: {"id":"chatcmpl-<uuid>","object":"chat.completion.chunk","created":1700000000,"model":"claude:sonnet","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-<uuid>","object":"chat.completion.chunk","created":1700000000,"model":"claude:sonnet","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}

data: {"id":"chatcmpl-<uuid>","object":"chat.completion.chunk","created":1700000000,"model":"claude:sonnet","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

## Error Format

OpenAI-style error responses:

```json
{
  "error": {
    "message": "Invalid model format. Use provider:model (e.g. claude:sonnet)",
    "type": "invalid_request_error",
    "code": 400
  }
}
```

Error codes:
- 400: Invalid request (bad model format, missing messages)
- 401: Invalid or missing API key
- 500: Agent execution failure

## Architecture

### Files

- **New:** `server/routes/openai-compat.js` — route handler + writer adapter
- **Modified:** `server/index.js` — mount router at `/v1`

### Data Flow

```
Client → POST /v1/chat/completions
  → Validate API key (apiKeysDb)
  → Parse model string → provider + model
  → Concatenate messages[] → single prompt
  → Call provider function:
      Claude:  queryClaudeSDK(prompt, { cwd: tmpdir, model, permissionMode: 'bypassPermissions' })
      Codex:   queryCodex(prompt, { cwd: tmpdir, model, permissionMode: 'bypassPermissions' })
      Gemini:  spawnGemini(prompt, { cwd: tmpdir, model, skipPermissions: true })
  → OpenAICompatWriter receives NormalizedMessage stream
  → Translate to OpenAI format → respond
```

### OpenAICompatWriter

Implements the writer interface used by all agent functions:

```
send(data)        — receives NormalizedMessage objects
setSessionId(id)  — called on session init
getSessionId()    — returns current session ID
```

**Non-streaming:** Collects text from messages where `kind === 'text'` and `role === 'assistant'`, concatenates content. Returns full response on agent completion.

**Streaming:** Emits SSE chunks on:
- `kind === 'stream_delta'` → `delta.content` chunk
- `kind === 'text'` with `role === 'assistant'` → `delta.content` chunk
- Agent completes → `finish_reason: "stop"` + `data: [DONE]`

All other message kinds (tool_use, tool_result, thinking, status) are silently skipped.

### Token Usage

Provider-specific extraction from NormalizedMessage data:
- Claude: `modelUsage.cumulativeInputTokens` / `cumulativeOutputTokens`
- Codex: `usage.input_tokens` / `output_tokens` (from `turn.completed` events)
- Gemini: No token data emitted — always returns `usage: null`

Returns `usage: null` if no token data available.

### Client Disconnect Handling

Uses `AbortController` + `req.on('close')` listener. When the client disconnects mid-stream, the abort signal propagates to the provider to stop agent execution and prevent orphaned processes.

### Working Directory

Uses `os.tmpdir()` as cwd. Agents require a working directory but nothing is written for pure chat. Gemini CLI is invoked with `--skip-trust` to avoid workspace trust prompts on temp directories.

## Client Configuration (Resume-Matcher Example)

```env
LLM_PROVIDER=openai_compatible
LLM_MODEL=claude:sonnet
LLM_API_KEY=ck_9f09b9a3fa0bd9b75c8e3cd41bedd5e99896d62a16eee66a0cfe0823af2daa3c
LLM_API_BASE=http://localhost:3001/v1
```

## Out of Scope

- Tool use / function calling forwarding
- File editing or project-aware agent mode
- Session resumption / conversation state
- Forwarding `temperature`, `max_tokens`, or other sampling parameters
- `/v1/models` listing endpoint (can be added later)
