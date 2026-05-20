import express from 'express';
import crypto from 'crypto';
import os from 'os';
import { apiKeysDb } from '../modules/database/index.js';
import { IS_PLATFORM } from '../constants/config.js';
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

export { router as openaiCompatRouter, parseModel, formatMessages, makeErrorResponse };
