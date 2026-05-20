# OpenAI-Compatible Chat Completions Proxy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/v1/chat/completions` endpoint that translates OpenAI-format requests into CLI agent calls (Claude SDK, Codex SDK, Gemini CLI) and returns OpenAI-format responses, enabling any OpenAI-compatible client to use claudecodeui-api as a proxy.

**Architecture:** A single new route file (`server/routes/openai-compat.js`) implements the endpoint with an `OpenAICompatWriter` adapter class that collects/streams `NormalizedMessage` objects from the existing provider functions and translates them to OpenAI chat completion format. One line added to `server/index.js` to mount the router.

**Tech Stack:** Express.js (ESM), existing provider SDKs (`queryClaudeSDK`, `queryCodex`, `spawnGemini`), existing `apiKeysDb` for auth.

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `server/routes/openai-compat.js` | Route handler, model parser, auth, writer adapter, response formatter |
| Modify | `server/index.js` (~line 193) | Mount `/v1` route |

---

### Task 1: Model Parser & Request Validator

**Files:**
- Create: `server/routes/openai-compat.js`

- [ ] **Step 1: Create the route file with model parsing and request validation**

```js
import express from 'express';
import crypto from 'crypto';
import os from 'os';
import { apiKeysDb } from '../modules/database/index.js';
import { IS_PLATFORM, } from '../constants/config.js';
import { userDb } from '../modules/database/index.js';
import { queryClaudeSDK } from '../claude-sdk.js';
import { queryCodex } from '../openai-codex.js';
import { spawnGemini } from '../gemini-cli.js';

const router = express.Router();

const VALID_PROVIDERS = new Set(['claude', 'codex', 'gemini']);

function parseModel(modelString) {
  if (!modelString || typeof modelString !== 'string') {
    return { error: 'model field is required' };
  }
  const colonIndex = modelString.indexOf(':');
  if (colonIndex === -1) {
    return { error: `Invalid model format "${modelString}". Use provider:model (e.g. claude:sonnet, codex:gpt-5-nano, gemini:gemini-3-flash)` };
  }
  const provider = modelString.slice(0, colonIndex);
  const model = modelString.slice(colonIndex + 1);
  if (!VALID_PROVIDERS.has(provider)) {
    return { error: `Unknown provider "${provider}". Valid providers: ${[...VALID_PROVIDERS].join(', ')}` };
  }
  if (!model) {
    return { error: `Model name is required after provider prefix (e.g. ${provider}:sonnet)` };
  }
  return { provider, model };
}

function formatMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { error: 'messages array is required and must not be empty' };
  }
  const parts = [];
  for (const msg of messages) {
    if (!msg.role || !msg.content) continue;
    const label = msg.role === 'system' ? 'System'
      : msg.role === 'user' ? 'User'
      : msg.role === 'assistant' ? 'Assistant'
      : msg.role;
    parts.push(`[${label}] ${msg.content}`);
  }
  return { prompt: parts.join('\n\n') };
}

function makeErrorResponse(message, type, code) {
  return { error: { message, type, code } };
}

export { router as openaiCompatRouter, parseModel, formatMessages, makeErrorResponse };
```

- [ ] **Step 2: Verify the file is valid syntax**

Run: `node --check server/routes/openai-compat.js`
Expected: No output (clean parse)

- [ ] **Step 3: Commit**

```bash
git add server/routes/openai-compat.js
git commit -m "feat(openai-compat): add model parser and request validation helpers"
```

---

### Task 2: Authentication Middleware

**Files:**
- Modify: `server/routes/openai-compat.js`

- [ ] **Step 1: Add auth middleware that accepts both Bearer and X-API-Key**

Add this function after the imports in `server/routes/openai-compat.js`:

```js
function validateOpenAIAuth(req, res, next) {
  if (IS_PLATFORM) {
    const user = userDb.getFirstUser();
    if (user) {
      req.user = user;
      return next();
    }
    return res.status(401).json(makeErrorResponse('No users configured', 'authentication_error', 401));
  }

  let apiKey = req.headers['x-api-key'];
  if (!apiKey) {
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      apiKey = authHeader.slice(7);
    }
  }
  if (!apiKey) {
    return res.status(401).json(makeErrorResponse('API key required. Use Authorization: Bearer <key> or X-API-Key header', 'authentication_error', 401));
  }
  const user = apiKeysDb.validateApiKey(apiKey);
  if (!user) {
    return res.status(401).json(makeErrorResponse('Invalid API key', 'authentication_error', 401));
  }
  req.user = user;
  next();
}
```

- [ ] **Step 2: Verify syntax**

Run: `node --check server/routes/openai-compat.js`
Expected: No output (clean parse)

- [ ] **Step 3: Commit**

```bash
git add server/routes/openai-compat.js
git commit -m "feat(openai-compat): add API key auth middleware with Bearer token support"
```

---

### Task 3: OpenAICompatWriter — Non-Streaming Mode

**Files:**
- Modify: `server/routes/openai-compat.js`

The writer must implement the interface expected by all three providers: `send(data)`, `setSessionId(id)`, `getSessionId()`.

- [ ] **Step 1: Add the OpenAICompatWriter class for non-streaming**

Add this class after the helper functions in `server/routes/openai-compat.js`:

```js
class OpenAICompatWriter {
  constructor(res, { model, stream = false }) {
    this.res = res;
    this.model = model;
    this.stream = stream;
    this.sessionId = null;
    this.userId = null;
    this.contentParts = [];
    this.tokenUsage = null;
    this.completionId = `chatcmpl-${crypto.randomUUID()}`;
    this.created = Math.floor(Date.now() / 1000);
  }

  send(data) {
    if (!data || typeof data !== 'object') return;

    const kind = data.kind;
    const role = data.role;

    if (data.sessionId && !this.sessionId) {
      this.sessionId = data.sessionId;
    }

    this._extractTokens(data);

    if (kind === 'text' && role === 'assistant' && data.content) {
      this.contentParts.push(data.content);
    }

    if (kind === 'stream_delta' && typeof data.content === 'string') {
      this.contentParts.push(data.content);
    }
  }

  _extractTokens(data) {
    // Claude SDK: modelUsage with cumulativeInputTokens/cumulativeOutputTokens
    if (data.modelUsage) {
      const u = data.modelUsage;
      this.tokenUsage = {
        prompt_tokens: u.cumulativeInputTokens || 0,
        completion_tokens: u.cumulativeOutputTokens || 0,
        total_tokens: (u.cumulativeInputTokens || 0) + (u.cumulativeOutputTokens || 0),
      };
      return;
    }
    // Codex SDK: usage with input_tokens/output_tokens (from turn.completed events)
    if (data.usage) {
      const u = data.usage;
      this.tokenUsage = {
        prompt_tokens: u.input_tokens || 0,
        completion_tokens: u.output_tokens || 0,
        total_tokens: (u.input_tokens || 0) + (u.output_tokens || 0),
      };
      return;
    }
    // Gemini CLI: no token data emitted — usage stays null
  }

  setSessionId(id) {
    this.sessionId = id;
  }

  getSessionId() {
    return this.sessionId;
  }

  end() {
    // non-streaming: no-op, finalize() sends the response
  }

  finalize() {
    const content = this.contentParts.join('');
    const response = {
      id: this.completionId,
      object: 'chat.completion',
      created: this.created,
      model: this.model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      }],
      usage: this.tokenUsage || null,
    };
    this.res.json(response);
  }
}
```

- [ ] **Step 2: Verify syntax**

Run: `node --check server/routes/openai-compat.js`
Expected: No output (clean parse)

- [ ] **Step 3: Commit**

```bash
git add server/routes/openai-compat.js
git commit -m "feat(openai-compat): add OpenAICompatWriter class for non-streaming responses"
```

---

### Task 4: OpenAICompatWriter — Streaming Mode

**Files:**
- Modify: `server/routes/openai-compat.js`

- [ ] **Step 1: Extend the `send()` method to handle streaming**

Replace the existing `send(data)` method in `OpenAICompatWriter` with:

```js
  send(data) {
    if (!data || typeof data !== 'object') return;

    const kind = data.kind;
    const role = data.role;

    if (data.sessionId && !this.sessionId) {
      this.sessionId = data.sessionId;
    }

    this._extractTokens(data);

    if (this.stream) {
      let content = null;
      if (kind === 'stream_delta' && typeof data.content === 'string') {
        content = data.content;
      } else if (kind === 'text' && role === 'assistant' && data.content) {
        content = data.content;
      }
      if (content !== null) {
        if (!this.sentRole) {
          this._writeSSEChunk({ role: 'assistant', content });
          this.sentRole = true;
        } else {
          this._writeSSEChunk({ content });
        }
      }
    } else {
      if (kind === 'text' && role === 'assistant' && data.content) {
        this.contentParts.push(data.content);
      }
      if (kind === 'stream_delta' && typeof data.content === 'string') {
        this.contentParts.push(data.content);
      }
    }
  }
```

- [ ] **Step 2: Add the SSE helper and update `end()` and `finalize()`**

Add `_writeSSEChunk` method and update `end()` and `finalize()`:

```js
  _writeSSEChunk(delta) {
    const chunk = {
      id: this.completionId,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{
        index: 0,
        delta,
        finish_reason: null,
      }],
    };
    this.res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }

  end() {
    // no-op — finalize() handles both modes
  }

  finalize() {
    if (this.stream) {
      this._writeSSEChunk({ finish_reason: 'stop' });
      this.res.write('data: [DONE]\n\n');
      this.res.end();
    } else {
      const content = this.contentParts.join('');
      const response = {
        id: this.completionId,
        object: 'chat.completion',
        created: this.created,
        model: this.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        }],
        usage: this.tokenUsage || null,
      };
      this.res.json(response);
    }
  }
```

- [ ] **Step 3: Add `sentRole` to constructor**

In the constructor, add after `this.created`:

```js
    this.sentRole = false;
```

- [ ] **Step 4: Verify syntax**

Run: `node --check server/routes/openai-compat.js`
Expected: No output (clean parse)

- [ ] **Step 5: Commit**

```bash
git add server/routes/openai-compat.js
git commit -m "feat(openai-compat): add streaming SSE support to OpenAICompatWriter"
```

---

### Task 5: Route Handler — POST /chat/completions

**Files:**
- Modify: `server/routes/openai-compat.js`

- [ ] **Step 1: Add the main route handler**

Add before the export line at the bottom of the file:

```js
router.post('/chat/completions', validateOpenAIAuth, async (req, res) => {
  const { model: modelString, messages, stream = false } = req.body;

  const parsed = parseModel(modelString);
  if (parsed.error) {
    return res.status(400).json(makeErrorResponse(parsed.error, 'invalid_request_error', 400));
  }

  const formatted = formatMessages(messages);
  if (formatted.error) {
    return res.status(400).json(makeErrorResponse(formatted.error, 'invalid_request_error', 400));
  }

  const { provider, model } = parsed;
  const { prompt } = formatted;

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
  }

  const abortController = new AbortController();
  const writer = new OpenAICompatWriter(res, { model: modelString, stream });
  writer.userId = req.user?.id;

  req.on('close', () => {
    abortController.abort();
  });

  const cwd = os.tmpdir();
  const agentOptions = {
    cwd,
    model,
    permissionMode: 'bypassPermissions',
    skipPermissions: true,
    signal: abortController.signal,
  };

  try {
    if (provider === 'claude') {
      await queryClaudeSDK(prompt, agentOptions, writer);
    } else if (provider === 'codex') {
      await queryCodex(prompt, agentOptions, writer);
    } else if (provider === 'gemini') {
      await spawnGemini(prompt, agentOptions, writer);
    }
    if (!abortController.signal.aborted) {
      writer.finalize();
    }
  } catch (err) {
    if (abortController.signal.aborted) return;
    if (stream) {
      const errorChunk = { error: { message: err.message || 'Agent execution failed', type: 'server_error', code: 500 } };
      res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      if (!res.headersSent) {
        res.status(500).json(makeErrorResponse(err.message || 'Agent execution failed', 'server_error', 500));
      }
    }
  }
});
```

- [ ] **Step 2: Verify syntax**

Run: `node --check server/routes/openai-compat.js`
Expected: No output (clean parse)

- [ ] **Step 3: Commit**

```bash
git add server/routes/openai-compat.js
git commit -m "feat(openai-compat): add POST /chat/completions route handler"
```

---

### Task 6: Mount Route in Server

**Files:**
- Modify: `server/index.js` (~line 193)

- [ ] **Step 1: Add import for openai-compat router**

In `server/index.js`, add this import alongside the other route imports (around line 14-68):

```js
import { openaiCompatRouter } from './routes/openai-compat.js';
```

- [ ] **Step 2: Mount the router at /v1**

In `server/index.js`, add this line after the agent route mount (after line 193 `app.use('/api/agent', agentRoutes);`):

```js
app.use('/v1', openaiCompatRouter);
```

Note: Mount at `/v1` (not `/api/v1`) so the full path is `/v1/chat/completions`, matching the OpenAI convention. This route sits outside the `/api` prefix intentionally — it uses its own auth middleware.

- [ ] **Step 3: Verify syntax**

Run: `node --check server/index.js`
Expected: No output (clean parse)

- [ ] **Step 4: Commit**

```bash
git add server/index.js server/routes/openai-compat.js
git commit -m "feat(openai-compat): mount /v1 route in server"
```

---

### Task 7: Integration Test — Non-Streaming

**Files:**
- Create: `server/routes/__tests__/openai-compat.test.js`

- [ ] **Step 1: Write integration test for non-streaming completions**

First check the test framework: `ls server/**/*.test.* tests/ 2>/dev/null` to confirm the project's test runner and pattern. The project uses Node.js native test runner (`node:test`).

```js
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseModel, formatMessages, makeErrorResponse } from '../openai-compat.js';

describe('parseModel', () => {
  it('parses valid provider:model string', () => {
    const result = parseModel('claude:sonnet');
    assert.deepStrictEqual(result, { provider: 'claude', model: 'sonnet' });
  });

  it('parses codex provider', () => {
    const result = parseModel('codex:gpt-5-nano');
    assert.deepStrictEqual(result, { provider: 'codex', model: 'gpt-5-nano' });
  });

  it('parses gemini provider', () => {
    const result = parseModel('gemini:gemini-3-flash');
    assert.deepStrictEqual(result, { provider: 'gemini', model: 'gemini-3-flash' });
  });

  it('returns error for missing colon', () => {
    const result = parseModel('claude-sonnet');
    assert.ok(result.error);
    assert.ok(result.error.includes('Invalid model format'));
  });

  it('returns error for unknown provider', () => {
    const result = parseModel('openai:gpt-4');
    assert.ok(result.error);
    assert.ok(result.error.includes('Unknown provider'));
  });

  it('returns error for empty model after colon', () => {
    const result = parseModel('claude:');
    assert.ok(result.error);
    assert.ok(result.error.includes('Model name is required'));
  });

  it('returns error for null input', () => {
    const result = parseModel(null);
    assert.ok(result.error);
  });
});

describe('formatMessages', () => {
  it('formats a single user message', () => {
    const result = formatMessages([{ role: 'user', content: 'Hello' }]);
    assert.strictEqual(result.prompt, '[User] Hello');
  });

  it('formats system + user messages', () => {
    const result = formatMessages([
      { role: 'system', content: 'Be helpful' },
      { role: 'user', content: 'Hi' },
    ]);
    assert.strictEqual(result.prompt, '[System] Be helpful\n\n[User] Hi');
  });

  it('formats multi-turn conversation', () => {
    const result = formatMessages([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
      { role: 'user', content: 'How are you?' },
    ]);
    assert.strictEqual(result.prompt, '[User] Hello\n\n[Assistant] Hi there\n\n[User] How are you?');
  });

  it('returns error for empty array', () => {
    const result = formatMessages([]);
    assert.ok(result.error);
  });

  it('returns error for non-array', () => {
    const result = formatMessages('not an array');
    assert.ok(result.error);
  });

  it('skips messages without role or content', () => {
    const result = formatMessages([
      { role: 'user', content: 'Hello' },
      { content: 'no role' },
      { role: 'user' },
    ]);
    assert.strictEqual(result.prompt, '[User] Hello');
  });
});

describe('makeErrorResponse', () => {
  it('returns structured error object', () => {
    const result = makeErrorResponse('bad input', 'invalid_request_error', 400);
    assert.deepStrictEqual(result, {
      error: { message: 'bad input', type: 'invalid_request_error', code: 400 },
    });
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `node --test server/routes/__tests__/openai-compat.test.js`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add server/routes/__tests__/openai-compat.test.js
git commit -m "test(openai-compat): add unit tests for model parser and message formatter"
```

---

### Task 8: Manual Smoke Test

**Files:** None (verification only)

- [ ] **Step 1: Start the server**

Run: `npm run dev` (or however the project starts — check `package.json` scripts)

- [ ] **Step 2: Test 400 — missing model prefix**

Run:
```bash
curl -s http://localhost:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"hi"}]}' | jq .
```
Expected: `{ "error": { "message": "Invalid model format...", "type": "invalid_request_error", "code": 400 } }`

- [ ] **Step 3: Test 401 — bad API key**

Run:
```bash
curl -s http://localhost:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer bad_key" \
  -d '{"model":"claude:sonnet","messages":[{"role":"user","content":"hi"}]}' | jq .
```
Expected: `{ "error": { "message": "Invalid API key", "type": "authentication_error", "code": 401 } }`

- [ ] **Step 4: Test non-streaming completion with Claude**

Run:
```bash
curl -s http://localhost:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{"model":"claude:sonnet","messages":[{"role":"user","content":"Say hello in one word"}],"stream":false}' | jq .
```
Expected: OpenAI-format response with `choices[0].message.content` containing a response.

- [ ] **Step 5: Test streaming completion with Claude**

Run:
```bash
curl -s -N http://localhost:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{"model":"claude:sonnet","messages":[{"role":"user","content":"Say hello in one word"}],"stream":true}'
```
Expected: SSE stream with `data: {...}` chunks ending with `data: [DONE]`

- [ ] **Step 6: Commit any fixes found during smoke testing**

If smoke testing reveals issues, fix them and commit:
```bash
git add server/routes/openai-compat.js
git commit -m "fix(openai-compat): fixes from smoke testing"
```
