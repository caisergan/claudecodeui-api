import { describe, it } from 'node:test';
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

  it('returns error when all messages are invalid', () => {
    const result = formatMessages([
      { content: 'no role' },
      { role: 'user' },
    ]);
    assert.ok(result.error);
    assert.ok(result.error.includes('No valid messages'));
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
