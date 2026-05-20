import express from 'express';
import crypto from 'crypto';
import os from 'os';
import { apiKeysDb, userDb } from '../modules/database/index.js';
import { IS_PLATFORM } from '../constants/config.js';
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
  if (parts.length === 0) {
    return { error: 'No valid messages found (each message must have role and content)' };
  }
  return { prompt: parts.join('\n\n') };
}

function makeErrorResponse(message, type, code) {
  return { error: { message, type, code } };
}

function validateOpenAIAuth(req, res, next) {
  if (IS_PLATFORM) {
    try {
      const user = userDb.getFirstUser();
      if (user) {
        req.user = user;
        return next();
      }
      return res.status(500).json(makeErrorResponse('No users configured', 'server_error', 500));
    } catch (err) {
      return res.status(500).json(makeErrorResponse(err.message || 'Failed to retrieve user', 'server_error', 500));
    }
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
    this.sentRole = false;
  }

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

  _extractTokens(data) {
    if (data.modelUsage) {
      const u = data.modelUsage;
      this.tokenUsage = {
        prompt_tokens: u.cumulativeInputTokens || 0,
        completion_tokens: u.cumulativeOutputTokens || 0,
        total_tokens: (u.cumulativeInputTokens || 0) + (u.cumulativeOutputTokens || 0),
      };
      return;
    }
    if (data.usage) {
      const u = data.usage;
      this.tokenUsage = {
        prompt_tokens: u.input_tokens || 0,
        completion_tokens: u.output_tokens || 0,
        total_tokens: (u.input_tokens || 0) + (u.output_tokens || 0),
      };
    }
  }

  setSessionId(id) {
    this.sessionId = id;
  }

  getSessionId() {
    return this.sessionId;
  }

  _writeSSEChunk(delta) {
    if (this.res.writableEnded) return;
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

  end() {}

  finalize() {
    if (this.stream) {
      if (!this.res.writableEnded) {
        const finalChunk = {
          id: this.completionId,
          object: 'chat.completion.chunk',
          created: this.created,
          model: this.model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        };
        this.res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
        this.res.write('data: [DONE]\n\n');
        this.res.end();
      }
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
}

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
    if (!res.writableEnded) {
      res.end();
    }
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
      if (!res.writableEnded) {
        const errorChunk = { error: { message: err.message || 'Agent execution failed', type: 'server_error', code: 500 } };
        res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    } else {
      if (!res.headersSent) {
        res.status(500).json(makeErrorResponse(err.message || 'Agent execution failed', 'server_error', 500));
      }
    }
  }
});

export { router as openaiCompatRouter, parseModel, formatMessages, makeErrorResponse };
