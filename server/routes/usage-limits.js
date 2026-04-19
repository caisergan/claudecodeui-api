import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import express from 'express';

import { getAllProviders, getStatusChecker } from '../providers/registry.js';

const router = express.Router();

const execFileAsync = promisify(execFile);
const CACHE_TTL_MS = 30_000;
const MAX_SCAN_FILES = 25;
const MAX_TAIL_BYTES = 256 * 1024;
const ALL_PROVIDERS = getAllProviders();
const CLAUDE_USAGE_CHECK_ENABLED = false;
const DEFAULT_USAGE_LIMIT_PROVIDERS = CLAUDE_USAGE_CHECK_ENABLED
  ? ALL_PROVIDERS
  : ALL_PROVIDERS.filter(provider => provider !== 'claude');
const usageLimitCache = new Map();

const CLAUDE_LIMIT_PATTERN = /Claude AI usage limit reached\|(\d{10,13})/g;
const CLAUDE_USAGE_API_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_USAGE_BETA_HEADER = 'oauth-2025-04-20';
const CODEX_USAGE_API_URL = 'https://chatgpt.com/backend-api/wham/usage';

function createEmptyLimits() {
  return {
    primary: null,
    secondary: null,
    codeReviewPrimary: null,
    codeReviewSecondary: null,
    additional: [],
  };
}

function createBaseResult(provider, status = {}) {
  return {
    provider,
    installed: Boolean(status.installed),
    authenticated: Boolean(status.authenticated),
    account: status.email || null,
    authMethod: status.method || null,
    authError: status.error || null,
    planType: null,
    organization: null,
    supportLevel: 'unsupported',
    supportsRemainingQuota: false,
    state: 'unsupported',
    limitReached: null,
    resetAt: null,
    lastSeenAt: null,
    scannedFiles: 0,
    source: null,
    message: null,
    limits: createEmptyLimits(),
    credits: null,
    spendControl: null,
    meta: {},
  };
}

function getProviderRoots(provider) {
  const homeDir = os.homedir();

  if (provider === 'claude') {
    return [path.join(homeDir, '.claude', 'projects')];
  }

  return [];
}

function getFileMatcher(provider) {
  if (provider === 'claude') {
    return (entryName) => entryName.endsWith('.jsonl') && !entryName.startsWith('agent-');
  }

  return null;
}

async function collectMatchingFiles(rootPath, fileMatcher, results) {
  let entries;
  try {
    entries = await fs.readdir(rootPath, { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(rootPath, entry.name);

    if (entry.isDirectory()) {
      await collectMatchingFiles(fullPath, fileMatcher, results);
      return;
    }

    if (!entry.isFile() || !fileMatcher(entry.name)) {
      return;
    }

    try {
      const stats = await fs.stat(fullPath);
      results.push({
        path: fullPath,
        mtimeMs: stats.mtimeMs,
      });
    } catch {
      // Ignore files that disappear during scanning.
    }
  }));
}

async function getRecentFiles(provider) {
  const roots = getProviderRoots(provider);
  const fileMatcher = getFileMatcher(provider);

  if (!roots.length || !fileMatcher) {
    return [];
  }

  const files = [];
  for (const rootPath of roots) {
    await collectMatchingFiles(rootPath, fileMatcher, files);
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.slice(0, MAX_SCAN_FILES);
}

async function readFileTail(filePath, maxBytes = MAX_TAIL_BYTES) {
  const handle = await fs.open(filePath, 'r');

  try {
    const stats = await handle.stat();
    if (!stats.size) {
      return '';
    }

    const start = Math.max(0, stats.size - maxBytes);
    const length = stats.size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

function parseJsonSafe(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getClaudeConfigDir() {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (typeof configDir === 'string' && configDir.trim()) {
    return configDir.trim();
  }

  return path.join(os.homedir(), '.claude');
}

function shortHashHex(value) {
  const bytes = Buffer.from(value, 'utf8');
  let hash = 2166136261;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }

  const uint = hash >>> 0;
  return uint.toString(16).padStart(8, '0');
}

function getClaudeKeychainServiceName() {
  const base = 'Claude Code-credentials';
  const envPath = process.env.CLAUDE_CONFIG_DIR;

  if (typeof envPath !== 'string' || !envPath.trim()) {
    return base;
  }

  const suffix = shortHashHex(envPath.trim()).slice(0, 8);
  return `${base}-${suffix}`;
}

function extractClaudeOAuthAccessToken(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const parsed = parseJsonSafe(trimmed);
    if (parsed && typeof parsed === 'object') {
      return extractClaudeOAuthAccessToken(parsed);
    }

    return trimmed;
  }

  if (typeof value !== 'object') {
    return null;
  }

  const oauth = value.claudeAiOauth;
  if (oauth && typeof oauth === 'object') {
    const accessToken = oauth.accessToken || oauth.access_token;
    if (typeof accessToken === 'string' && accessToken.trim()) {
      return accessToken.trim();
    }
  }

  return null;
}

async function readClaudeOauthTokenFromKeychain() {
  if (process.platform !== 'darwin') {
    return null;
  }

  try {
    const serviceName = getClaudeKeychainServiceName();
    const { stdout } = await execFileAsync('/usr/bin/security', [
      'find-generic-password',
      '-s',
      serviceName,
      '-w',
    ], {
      timeout: 3_000,
      maxBuffer: 512 * 1024,
    });

    return extractClaudeOAuthAccessToken(stdout);
  } catch {
    return null;
  }
}

async function readClaudeOauthTokenFromCredentialsFile() {
  try {
    const configDir = getClaudeConfigDir();
    const credentialsPath = path.join(configDir, '.credentials.json');
    const content = await fs.readFile(credentialsPath, 'utf8');
    const parsed = parseJsonSafe(content);
    return extractClaudeOAuthAccessToken(parsed);
  } catch {
    return null;
  }
}

async function getClaudeOauthToken() {
  const keychainToken = await readClaudeOauthTokenFromKeychain();
  if (keychainToken) {
    return {
      token: keychainToken,
      source: 'keychain',
    };
  }

  const fileToken = await readClaudeOauthTokenFromCredentialsFile();
  if (fileToken) {
    return {
      token: fileToken,
      source: 'credentials_file',
    };
  }

  return {
    token: null,
    source: null,
  };
}

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeTimestamp(value) {
  if (value == null || value === '') {
    return null;
  }

  if (typeof value === 'number') {
    const timestampMs = value < 1e12 ? value * 1000 : value;
    const date = new Date(timestampMs);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  if (typeof value === 'string' && /^\d{10,13}$/.test(value)) {
    const numeric = Number.parseInt(value, 10);
    return normalizeTimestamp(numeric);
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeWindow(window) {
  if (!window || typeof window !== 'object') {
    return null;
  }

  const usedPercent = toFiniteNumber(window.used_percent);
  const remainingPercent = usedPercent === null
    ? null
    : Math.max(0, Math.min(100, Math.round(100 - usedPercent)));

  return {
    usedPercent,
    remainingPercent,
    limitWindowSeconds: toFiniteNumber(window.limit_window_seconds),
    resetAfterSeconds: toFiniteNumber(window.reset_after_seconds),
    resetAt: normalizeTimestamp(window.reset_at),
  };
}

function normalizeClaudeUsageBucket(bucket) {
  if (!bucket || typeof bucket !== 'object') {
    return null;
  }

  const utilization = toFiniteNumber(bucket.utilization);
  const usedPercent = utilization === null
    ? null
    : Math.max(0, Math.min(
      100,
      Math.round((utilization <= 1 ? utilization * 100 : utilization) * 10) / 10,
    ));
  const remainingPercent = usedPercent === null ? null : Math.max(0, Math.min(100, Math.round(1000 - (usedPercent * 10)) / 10));

  return {
    usedPercent,
    remainingPercent,
    limitWindowSeconds: null,
    resetAfterSeconds: null,
    resetAt: normalizeTimestamp(bucket.resets_at),
  };
}

function normalizeCredits(credits) {
  if (!credits || typeof credits !== 'object') {
    return null;
  }

  return {
    hasCredits: Boolean(credits.has_credits),
    unlimited: Boolean(credits.unlimited),
    overageLimitReached: Boolean(credits.overage_limit_reached),
    balance: toFiniteNumber(credits.balance),
    approxLocalMessages: toFiniteNumber(credits.approx_local_messages),
    approxCloudMessages: toFiniteNumber(credits.approx_cloud_messages),
  };
}

function selectResetAtFromLimits(limits) {
  const candidates = [
    limits.primary?.resetAt,
    limits.secondary?.resetAt,
    limits.codeReviewPrimary?.resetAt,
    limits.codeReviewSecondary?.resetAt,
    ...limits.additional.map(limit => limit.resetAt).filter(Boolean),
  ].filter(Boolean).sort();

  return candidates[0] || null;
}

function parseClaudeLimitSignal(fileContent) {
  CLAUDE_LIMIT_PATTERN.lastIndex = 0;
  let match;
  let latestResetAt = null;

  while ((match = CLAUDE_LIMIT_PATTERN.exec(fileContent)) !== null) {
    const normalized = normalizeTimestamp(match[1]);
    if (!normalized) {
      continue;
    }

    if (!latestResetAt || normalized > latestResetAt) {
      latestResetAt = normalized;
    }
  }

  return latestResetAt;
}

async function getClaudeCliAuthStatus() {
  try {
    const { stdout } = await execFileAsync('claude', ['auth', 'status'], {
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });

    const parsed = parseJsonSafe(stdout.trim());
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function fetchClaudeUsageReport(accessToken) {
  const response = await fetch(CLAUDE_USAGE_API_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Anthropic-Beta': CLAUDE_USAGE_BETA_HEADER,
      'User-Agent': 'claudecodeui-api',
    },
  });

  const bodyText = await response.text();
  const parsed = parseJsonSafe(bodyText);

  return {
    ok: response.ok,
    status: response.status,
    data: parsed,
    rawBody: parsed ? null : bodyText,
  };
}

async function getCodexCliLoginStatus() {
  try {
    const { stdout } = await execFileAsync('codex', ['login', 'status'], {
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });

    const output = stdout.trim();
    return {
      available: true,
      loggedIn: /^logged in/i.test(output),
      description: output || null,
    };
  } catch (error) {
    return {
      available: false,
      loggedIn: false,
      description: error?.message || null,
    };
  }
}

async function readCodexAuth() {
  try {
    const authPath = path.join(os.homedir(), '.codex', 'auth.json');
    const content = await fs.readFile(authPath, 'utf8');
    return parseJsonSafe(content);
  } catch {
    return null;
  }
}

function extractCodexAccessToken(auth) {
  const token = auth?.tokens?.access_token;
  return typeof token === 'string' && token.trim() ? token.trim() : null;
}

function extractCodexAccountId(auth) {
  const accountId = auth?.tokens?.account_id;
  return typeof accountId === 'string' && accountId.trim() ? accountId.trim() : null;
}

function decodeCodexPlanType(idToken) {
  if (typeof idToken !== 'string' || !idToken.trim()) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'),
    );
    return payload?.['https://api.openai.com/auth']?.chatgpt_plan_type || null;
  } catch {
    return null;
  }
}

async function fetchCodexUsageReport(accessToken, accountId) {
  const response = await fetch(CODEX_USAGE_API_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'ChatGPT-Account-Id': accountId,
      'Content-Type': 'application/json',
      'User-Agent': 'codex-cli',
    },
  });

  const bodyText = await response.text();
  const parsed = parseJsonSafe(bodyText);

  return {
    ok: response.ok,
    status: response.status,
    data: parsed,
    rawBody: parsed ? null : bodyText,
  };
}

async function detectClaudeUsageLimit(status) {
  const result = createBaseResult('claude', status);
  result.supportLevel = 'partial';
  result.source = 'claude_oauth_usage_api';

  const cliStatus = await getClaudeCliAuthStatus();
  if (cliStatus) {
    result.account = cliStatus.email || result.account;
    result.authMethod = cliStatus.authMethod || result.authMethod;
    result.planType = cliStatus.subscriptionType || null;
    result.organization = cliStatus.orgName || null;
    result.meta = {
      apiProvider: cliStatus.apiProvider || null,
      orgId: cliStatus.orgId || null,
    };
  }

  if (status.method === 'api_key') {
    result.state = 'api_key_mode_unsupported';
    result.message = 'Claude is configured for direct API-key auth. Claude.ai quota windows are unavailable in this mode.';
    result.meta = {
      ...result.meta,
      apiProvider: cliStatus?.apiProvider || null,
    };
    return result;
  }

  const { token: claudeOauthToken, source: tokenSource } = await getClaudeOauthToken();
  if (claudeOauthToken) {
    try {
      const usageReport = await fetchClaudeUsageReport(claudeOauthToken);

      if (usageReport.ok && usageReport.data && typeof usageReport.data === 'object') {
        const data = usageReport.data;
        result.supportLevel = 'direct_api';
        result.supportsRemainingQuota = true;
        result.source = 'claude_oauth_usage_api';
        result.lastSeenAt = new Date().toISOString();
        result.meta = {
          ...result.meta,
          tokenSource,
          apiStatus: usageReport.status,
        };

        result.limits.primary = normalizeClaudeUsageBucket(data.five_hour);
        result.limits.secondary = normalizeClaudeUsageBucket(data.seven_day);

        const additionalBuckets = [
          ['seven_day_opus', data.seven_day_opus],
          ['seven_day_sonnet', data.seven_day_sonnet],
          ['seven_day_oauth_apps', data.seven_day_oauth_apps],
          ['seven_day_cowork', data.seven_day_cowork],
        ]
          .map(([name, bucket]) => {
            const window = normalizeClaudeUsageBucket(bucket);
            if (!window) {
              return null;
            }

            return {
              ...window,
              name,
              limitId: name,
            };
          })
          .filter(Boolean);

        result.limits.additional = additionalBuckets;
        result.resetAt = selectResetAtFromLimits(result.limits);

        const extraUsage = data.extra_usage && typeof data.extra_usage === 'object' ? data.extra_usage : null;
        if (extraUsage) {
          result.credits = {
            hasCredits: Boolean(extraUsage.is_enabled),
            unlimited: false,
            overageLimitReached: toFiniteNumber(extraUsage.utilization) !== null
              ? toFiniteNumber(extraUsage.utilization) >= 1
              : false,
            balance: toFiniteNumber(extraUsage.monthly_limit),
            approxLocalMessages: null,
            approxCloudMessages: null,
          };

          result.spendControl = {
            reached: Boolean(result.credits.overageLimitReached),
          };
        }

        const allWindows = [
          result.limits.primary,
          result.limits.secondary,
          ...result.limits.additional,
        ].filter(Boolean);
        const anyWindowReached = allWindows.some(window => toFiniteNumber(window.usedPercent) !== null && window.usedPercent >= 100);
        const overageReached = Boolean(result.spendControl?.reached);
        result.limitReached = anyWindowReached || overageReached;
        result.state = result.limitReached ? 'limit_reached' : 'available';
        result.message = result.limitReached
          ? 'Claude usage data was fetched successfully and indicates an active limit.'
          : 'Claude usage data was fetched successfully.';

        return result;
      }

      result.meta = {
        ...result.meta,
        tokenSource,
        apiStatus: usageReport.status,
        apiBody: usageReport.rawBody ? usageReport.rawBody.slice(0, 200) : null,
      };

      if (usageReport.status === 401 || usageReport.status === 403) {
        result.state = 'auth_expired';
        result.message = 'Claude usage request was rejected. Re-authenticate with Claude CLI and try again.';
      } else {
        result.state = 'error';
        result.message = `Claude usage API returned ${usageReport.status}. Falling back to log-based detection.`;
      }
    } catch (error) {
      result.state = 'error';
      result.message = `Failed to fetch Claude usage API data: ${error.message}. Falling back to log-based detection.`;
      result.meta = {
        ...result.meta,
        tokenSource,
      };
    }
  } else {
    result.state = 'auth_required';
    result.message = 'Claude OAuth token not found. Falling back to log-based detection.';
  }

  result.supportLevel = 'best_effort';
  result.source = 'session_logs';

  const recentFiles = await getRecentFiles('claude');
  result.scannedFiles = recentFiles.length;

  if (!recentFiles.length) {
    result.state = 'unknown';
    result.limitReached = null;
    result.message = 'No Claude session logs were found to inspect.';
    return result;
  }

  for (const file of recentFiles) {
    try {
      const fileTail = await readFileTail(file.path);
      const resetAt = parseClaudeLimitSignal(fileTail);

      if (!resetAt) {
        continue;
      }

      result.resetAt = resetAt;
      result.lastSeenAt = new Date(file.mtimeMs).toISOString();
      result.limitReached = new Date(resetAt).getTime() > Date.now();
      result.state = result.limitReached ? 'limit_reached' : 'historical_limit_signal';
      result.message = result.limitReached
        ? 'Claude reported an active usage-limit reset time in recent session logs.'
        : 'Claude reported a usage-limit reset time in recent session logs, but it is now in the past.';
      return result;
    } catch {
      // Ignore unreadable files and keep scanning newer matches.
    }
  }

  result.state = 'no_limit_signal_detected';
  result.limitReached = false;
  result.message = 'No Claude usage-limit signal was detected in recent session logs.';
  return result;
}

async function detectCodexUsageLimit(status) {
  const result = createBaseResult('codex', status);
  const auth = await readCodexAuth();
  const accessToken = extractCodexAccessToken(auth);
  const accountId = extractCodexAccountId(auth);
  const authMode = typeof auth?.auth_mode === 'string' ? auth.auth_mode : null;

  result.meta = {
    authMode,
  };

  if (!auth?.tokens?.access_token && auth?.OPENAI_API_KEY) {
    result.state = 'api_key_mode_unsupported';
    result.supportLevel = 'partial';
    result.message = 'Codex is configured with an API key. ChatGPT plan usage windows are not available in this mode.';
    return result;
  }

  if (!accessToken || !accountId) {
    const loginStatus = await getCodexCliLoginStatus();
    if (loginStatus.loggedIn) {
      result.state = 'credential_store_unsupported';
      result.supportLevel = 'partial';
      result.message = 'Codex is logged in, but the local auth token is not readable from ~/.codex/auth.json. Usage cannot be fetched from this credential store yet.';
      result.meta = {
        ...result.meta,
        loginStatus: loginStatus.description,
      };
      return result;
    }

    result.state = 'auth_required';
    result.message = 'Codex is not authenticated. Run codex login first.';
    result.meta = {
      ...result.meta,
      loginStatus: loginStatus.description,
    };
    return result;
  }

  let usageReport;
  try {
    usageReport = await fetchCodexUsageReport(accessToken, accountId);
  } catch (error) {
    result.state = 'error';
    result.supportLevel = 'partial';
    result.message = `Failed to fetch Codex usage: ${error.message}`;
    return result;
  }

  if (!usageReport.ok || !usageReport.data || typeof usageReport.data !== 'object') {
    result.state = usageReport.status === 401 || usageReport.status === 403 ? 'auth_expired' : 'error';
    result.supportLevel = 'partial';
    result.message = usageReport.status === 401 || usageReport.status === 403
      ? 'Codex usage request was rejected. Re-run codex login and try again.'
      : `Codex usage API returned ${usageReport.status}.`;
    result.meta = {
      ...result.meta,
      apiStatus: usageReport.status,
      apiBody: usageReport.rawBody ? usageReport.rawBody.slice(0, 200) : null,
    };
    return result;
  }

  const data = usageReport.data;
  result.supportLevel = 'direct_api';
  result.supportsRemainingQuota = true;
  result.source = 'codex_wham_usage_api';
  result.planType = data.plan_type || decodeCodexPlanType(auth?.tokens?.id_token) || null;
  result.account = data.email || result.account;
  result.lastSeenAt = new Date().toISOString();

  result.limits.primary = normalizeWindow(data.rate_limit?.primary_window);
  result.limits.secondary = normalizeWindow(data.rate_limit?.secondary_window);
  result.limits.codeReviewPrimary = normalizeWindow(data.code_review_rate_limit?.primary_window);
  result.limits.codeReviewSecondary = normalizeWindow(data.code_review_rate_limit?.secondary_window);
  result.limits.additional = Array.isArray(data.additional_rate_limits)
    ? data.additional_rate_limits
      .map(limit => ({
        name: typeof limit?.name === 'string' ? limit.name : null,
        limitId: typeof limit?.limit_id === 'string' ? limit.limit_id : null,
        window: normalizeWindow(limit?.primary_window || limit?.window || limit),
      }))
      .filter(limit => limit.window)
      .map(limit => ({
        ...limit.window,
        name: limit.name,
        limitId: limit.limitId,
      }))
    : [];

  result.credits = normalizeCredits(data.credits);
  result.spendControl = {
    reached: Boolean(data.spend_control?.reached),
  };
  result.resetAt = selectResetAtFromLimits(result.limits);

  const hardLimitReached = Boolean(data.rate_limit?.limit_reached) || Boolean(data.spend_control?.reached);
  const notAllowed = data.rate_limit?.allowed === false;
  result.limitReached = hardLimitReached || notAllowed;
  result.state = notAllowed
    ? 'not_allowed'
    : result.limitReached
      ? 'limit_reached'
      : 'available';
  result.message = result.limitReached
    ? 'Codex usage data was fetched successfully and indicates an active limit.'
    : 'Codex usage data was fetched successfully.';

  result.meta = {
    ...result.meta,
    rateLimitAllowed: data.rate_limit?.allowed ?? null,
    rateLimitReachedType: data.rate_limit_reached_type || null,
  };

  return result;
}

function buildUnsupportedResult(provider, status) {
  const result = createBaseResult(provider, status);
  result.message = provider === 'cursor'
    ? 'Cursor usage-limit detection is not supported in this app.'
    : `${provider[0].toUpperCase()}${provider.slice(1)} usage-limit detection is not supported in this app yet.`;
  return result;
}

function buildClaudeUsagePolicyDisabledResult() {
  const result = createBaseResult('claude');
  result.state = 'policy_disabled';
  result.supportLevel = 'unsupported';
  result.message = 'Claude usage checks are temporarily disabled to comply with Anthropic OAuth policy.';
  return result;
}

async function computeProviderUsageLimit(provider) {
  if (provider === 'claude' && !CLAUDE_USAGE_CHECK_ENABLED) {
    return buildClaudeUsagePolicyDisabledResult();
  }

  const checker = getStatusChecker(provider);
  const status = checker ? await checker.checkStatus() : {
    installed: false,
    authenticated: false,
    email: null,
    method: null,
    error: 'No status checker registered',
  };

  if (provider === 'claude') {
    return detectClaudeUsageLimit(status);
  }

  if (provider === 'codex') {
    return detectCodexUsageLimit(status);
  }

  return buildUnsupportedResult(provider, status);
}

async function getProviderUsageLimit(provider, { refresh = false } = {}) {
  if (!refresh) {
    const cached = usageLimitCache.get(provider);
    if (cached && (Date.now() - cached.cachedAt) < CACHE_TTL_MS) {
      return cached.value;
    }
  }

  const value = await computeProviderUsageLimit(provider);
  usageLimitCache.set(provider, {
    cachedAt: Date.now(),
    value,
  });
  return value;
}

router.get('/', async (req, res) => {
  try {
    const providerQuery = typeof req.query.provider === 'string'
      ? req.query.provider.trim().toLowerCase()
      : '';
    const refresh = req.query.refresh === 'true';

    const providers = providerQuery
      ? [providerQuery]
      : DEFAULT_USAGE_LIMIT_PROVIDERS;

    const unknownProviders = providers.filter(provider => !ALL_PROVIDERS.includes(provider));
    if (unknownProviders.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Unknown provider: ${unknownProviders.join(', ')}`,
        availableProviders: ALL_PROVIDERS,
      });
    }

    const results = await Promise.all(
      providers.map(async (provider) => [provider, await getProviderUsageLimit(provider, { refresh })]),
    );

    res.json({
      success: true,
      checkedAt: new Date().toISOString(),
      providers: Object.fromEntries(results),
    });
  } catch (error) {
    console.error('Error checking usage limits:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to check usage limits',
    });
  }
});

export default router;
