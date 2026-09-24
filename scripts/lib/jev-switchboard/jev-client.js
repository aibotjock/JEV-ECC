/**
 * TypeSafe "System One" (Jev) client for the ECC capability switchboard.
 *
 * One batched POST /v1/systemone call per evaluation: every capability becomes
 * one `noul` question keyed by its id. Raw fetch wrapper with zero new
 * dependencies (repo hooks are dependency-free by design); swap to
 * @typesafe-ai/sdk later if wanted. `fetchImpl` is injectable so unit tests
 * never touch the network.
 *
 * API contract (verified against the official docs - do not deviate):
 *   POST {baseUrl}/v1/systemone
 *   headers: Authorization: Bearer <TYPESAFE_API_KEY>, Content-Type: application/json
 *   request: {"model":"jev-1.13.0","state":<string|object|array>,
 *             "questions":{<id>:{"type":"noul","instructions":"..."}}}
 *   response: {"model":"jev-1.13.0","answers":{<id>:{"type":"noul","noul":0.42}},
 *              "usage":{"input_tokens":N,"output_tokens":N}}
 *   Some answer ids may be absent; they stay absent (never coerced to 0).
 *
 * Retry policy (per official SDK): statuses 408/429/500-599 plus connection
 * errors and timeouts; exponential backoff 500ms doubling to max 5000ms; honor
 * Retry-After / retry-after-ms headers up to 60s; maxRetries retries after the
 * initial attempt. 401 and 422 are never retried. A response body read that
 * rejects mid-response is classified as a retryable connection error (never
 * allowed to escape as a raw non-JevError), and every error cause is redacted
 * before it is attached so no error surface carries the original unredacted
 * message or the Authorization header.
 *
 * The API key is never logged and Authorization is redacted from every error
 * surface. Model is pinned to 'jev-1.13.0' via config defaults; never
 * 'jev-latest' (aliases drift silently). response.model is logged on every call.
 */

'use strict';

const { renderQuestion } = require('./question-render');

const DEFAULT_MODEL = 'jev-1.13.0';
const DEFAULT_BASE_URL = 'https://api.typesafe.ai';
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 5000;
const RETRY_AFTER_MAX_MS = 60000;
const BODY_SNIPPET_CHARS = 200;

class JevError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = options.name || 'JevError';
    this.status = typeof options.status === 'number' ? options.status : null;
    this.code = options.code || null;
    this.retryable = options.retryable === true;
    this.retryAfterMs = typeof options.retryAfterMs === 'number' ? options.retryAfterMs : null;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

class JevAuthError extends JevError {
  constructor(message, options = {}) {
    super(message, { ...options, name: 'JevAuthError', status: 401, retryable: false });
  }
}

class JevRateLimitError extends JevError {
  constructor(message, options = {}) {
    super(message, { ...options, name: 'JevRateLimitError', status: 429, retryable: true });
  }
}

class JevUnprocessableError extends JevError {
  constructor(message, options = {}) {
    super(message, { ...options, name: 'JevUnprocessableError', status: 422, retryable: false });
    this.field = typeof options.field === 'string' && options.field ? options.field : null;
  }
}

class JevUnavailableError extends JevError {
  constructor(message, options = {}) {
    super(message, { ...options, name: 'JevUnavailableError', retryable: false });
  }
}

function redactSecrets(text, apiKey) {
  let out = String(text === undefined || text === null ? '' : text);
  if (apiKey) out = out.split(apiKey).join('[REDACTED]');
  return out
    .replace(/Authorization[^\r\n]*/gi, 'Authorization: [REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
}

function getHeaderValue(headers, name) {
  if (!headers || typeof headers !== 'object') return null;
  if (typeof headers.get === 'function') {
    const value = headers.get(name);
    return value === undefined || value === null ? null : String(value);
  }
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers).sort()) {
    if (key.toLowerCase() === lower) {
      const value = headers[key];
      return value === undefined || value === null ? null : String(value);
    }
  }
  return null;
}

function clampRetryDelayMs(ms) {
  return Math.min(RETRY_AFTER_MAX_MS, Math.max(0, ms));
}

function parseRetryAfterMs(headers) {
  const msRaw = getHeaderValue(headers, 'retry-after-ms');
  if (msRaw !== null) {
    const ms = Number(msRaw);
    if (Number.isFinite(ms)) return clampRetryDelayMs(ms);
  }
  const secondsRaw = getHeaderValue(headers, 'retry-after');
  if (secondsRaw !== null) {
    const seconds = Number(secondsRaw);
    if (Number.isFinite(seconds)) return clampRetryDelayMs(seconds * 1000);
  }
  return null;
}

function parseBodyJson(text) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

function extractFieldFromBody(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const error = parsed.error;
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    for (const key of ['field', 'param']) {
      if (typeof error[key] === 'string' && error[key].trim()) return error[key].trim();
    }
    for (const listName of ['details', 'errors']) {
      if (!Array.isArray(error[listName])) continue;
      for (const item of error[listName]) {
        if (!item || typeof item !== 'object') continue;
        for (const key of ['field', 'param', 'path']) {
          if (typeof item[key] === 'string' && item[key].trim()) return item[key].trim();
        }
      }
    }
  }
  if (Array.isArray(parsed.detail) && parsed.detail.length > 0) {
    const first = parsed.detail[0];
    if (first && typeof first === 'object' && Array.isArray(first.loc)) {
      const loc = first.loc.filter(segment => typeof segment === 'string' || typeof segment === 'number');
      if (loc.length > 0) return loc.join('.');
    }
  }
  if (typeof parsed.field === 'string' && parsed.field.trim()) return parsed.field.trim();
  return null;
}

function normalizeConfig(config) {
  const cfg = config && typeof config === 'object' ? config : {};
  const timeoutMs = Number(cfg.timeoutMs);
  const maxRetries = Number(cfg.maxRetries);
  return {
    apiKey: String(cfg.apiKey || '').trim(),
    baseUrl: String(cfg.baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '') || DEFAULT_BASE_URL,
    model: String(cfg.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    timeoutMs: Math.max(1, Math.round(Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS)),
    maxRetries: Math.max(0, Math.round(Number.isFinite(maxRetries) ? maxRetries : DEFAULT_MAX_RETRIES)),
  };
}

async function readBodyText(response) {
  if (response && typeof response.text === 'function') return response.text();
  if (response && typeof response.json === 'function') return JSON.stringify(await response.json());
  return '';
}

function isSuccessResponse(response) {
  if (!response) return false;
  if (typeof response.status === 'number') return response.status >= 200 && response.status < 300;
  return response.ok === true;
}

function bodySnippet(bodyText, apiKey) {
  return redactSecrets(String(bodyText || '').slice(0, BODY_SNIPPET_CHARS), apiKey).trim();
}

function classifyResponse(response, bodyText, apiKey) {
  const status = typeof response.status === 'number' ? response.status : 0;
  const suffix = bodySnippet(bodyText, apiKey) ? `: ${bodySnippet(bodyText, apiKey)}` : '';
  if (status === 401) {
    return new JevAuthError(`Jev authentication failed (HTTP 401). Check TYPESAFE_API_KEY${suffix}`);
  }
  if (status === 422) {
    const field = extractFieldFromBody(parseBodyJson(bodyText));
    return new JevUnprocessableError(
      `Jev rejected the request as unprocessable (HTTP 422)${field ? ` for field "${field}"` : ''}${suffix}`,
      { field }
    );
  }
  if (status === 429) {
    return new JevRateLimitError(`Jev rate limited the request (HTTP 429)${suffix}`, {
      retryAfterMs: parseRetryAfterMs(response.headers),
    });
  }
  if (status === 408 || status >= 500) {
    return new JevError(`Jev request failed (HTTP ${status})${suffix}`, { status, retryable: true, code: 'http' });
  }
  return new JevError(`Jev request failed (HTTP ${status})${suffix}`, { status, retryable: false, code: 'http' });
}

// The raw underlying error can echo the request (Authorization header and all)
// from deep inside the fetch stack, so only this redacted shallow copy may ride
// along as a cause; the original is never attached to any error surface.
function redactedCause(error, apiKey) {
  const message = redactSecrets(error && error.message ? error.message : String(error), apiKey);
  const cause = new Error(message);
  if (error && typeof error.name === 'string' && error.name) cause.name = error.name;
  return cause;
}

function classifyNetworkError(error, apiKey) {
  if (error instanceof JevError) return error;
  const raw = error && error.message ? error.message : String(error);
  return new JevError(`Jev request failed before a response was received: ${redactSecrets(raw, apiKey)}`, {
    code: 'connection',
    retryable: true,
    cause: redactedCause(error, apiKey),
  });
}

function backoffDelayMs(classified, retriesUsed) {
  if (typeof classified.retryAfterMs === 'number' && classified.retryAfterMs !== null) {
    return clampRetryDelayMs(classified.retryAfterMs);
  }
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** retriesUsed);
}

function finalizeExhausted(classified, maxRetries) {
  const attempts = maxRetries + 1;
  if (classified instanceof JevRateLimitError) {
    return new JevRateLimitError(`Jev rate limit persisted after ${attempts} attempts: ${classified.message}`, {
      cause: classified,
      retryAfterMs: classified.retryAfterMs,
    });
  }
  return new JevUnavailableError(`Jev unavailable after ${attempts} attempts: ${classified.message}`, {
    status: classified.status,
    code: classified.code,
    cause: classified,
  });
}

function defaultSleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

async function attemptFetch({ url, headers, body, cfg, fetcher }) {
  const controller = typeof globalThis.AbortController === 'function' ? new globalThis.AbortController() : null;
  let timer = null;
  let rejectOnTimeout;
  const timeoutPromise = new Promise((_resolve, reject) => {
    rejectOnTimeout = reject;
  });
  try {
    const fetchPromise = Promise.resolve(
      fetcher(url, {
        method: 'POST',
        headers,
        body,
        signal: controller ? controller.signal : undefined,
      })
    );
    timer = setTimeout(() => {
      if (controller) controller.abort();
      rejectOnTimeout(new JevError(`Jev request timed out after ${cfg.timeoutMs}ms`, { code: 'timeout', retryable: true }));
    }, cfg.timeoutMs);
    return await Promise.race([fetchPromise, timeoutPromise]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function requestWithRetries({ url, headers, body, cfg, fetcher, sleeper }) {
  let retriesUsed = 0;
  for (;;) {
    let response;
    try {
      response = await attemptFetch({ url, headers, body, cfg, fetcher });
    } catch (error) {
      const classified = classifyNetworkError(error, cfg.apiKey);
      if (!classified.retryable) throw classified;
      if (retriesUsed >= cfg.maxRetries) throw finalizeExhausted(classified, cfg.maxRetries);
      await sleeper(backoffDelayMs(classified, retriesUsed));
      retriesUsed += 1;
      continue;
    }
    if (isSuccessResponse(response)) return response;
    let bodyText;
    try {
      bodyText = await readBodyText(response);
    } catch (error) {
      // A body-read rejection mid-response is treated exactly like a connection
      // failure: typed, redacted, retryable per the existing policy.
      const classified = classifyNetworkError(error, cfg.apiKey);
      if (!classified.retryable) throw classified;
      if (retriesUsed >= cfg.maxRetries) throw finalizeExhausted(classified, cfg.maxRetries);
      await sleeper(backoffDelayMs(classified, retriesUsed));
      retriesUsed += 1;
      continue;
    }
    const classified = classifyResponse(response, bodyText, cfg.apiKey);
    if (!classified.retryable) throw classified;
    if (retriesUsed >= cfg.maxRetries) throw finalizeExhausted(classified, cfg.maxRetries);
    await sleeper(backoffDelayMs(classified, retriesUsed));
    retriesUsed += 1;
  }
}

/**
 * Evaluate every capability in one batched Jev call.
 * @param {object} options
 * @param {string|object|array} options.state - task state passed through to the API
 * @param {Array<object>} options.capabilities - registry entries with {id, type, name, ...}
 * @param {object} options.config - loadJevConfig() output (or partial; defaults applied)
 * @param {Function} [options.fetchImpl] - injectable fetch (default: global fetch, Node 18+)
 * @param {Function} [options.sleepImpl] - injectable backoff sleep (tests)
 * @returns {Promise<{model: string, probabilities: Object<string, number>, usage: object, latencyMs: number}>}
 */
async function evaluateCapabilities({ state, capabilities, config, fetchImpl, sleepImpl } = {}) {
  const cfg = normalizeConfig(config);
  if (!cfg.apiKey) {
    throw new JevAuthError('Jev client called without an API key (TYPESAFE_API_KEY missing)');
  }
  const fetcher = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof fetcher !== 'function') {
    throw new JevError('No fetch implementation available (need Node 18+ global fetch or an injected fetchImpl)', {
      code: 'no-fetch',
    });
  }
  const sleeper = typeof sleepImpl === 'function' ? sleepImpl : defaultSleep;

  const questions = {};
  const caps = Array.isArray(capabilities) ? capabilities : [];
  for (const cap of caps) {
    if (!cap || typeof cap !== 'object') continue;
    const id = String(cap.id || '').trim();
    if (!id) continue;
    questions[id] = renderQuestion(cap);
  }
  const askedIds = Object.keys(questions).sort();
  const sortedQuestions = {};
  for (const id of askedIds) {
    sortedQuestions[id] = questions[id];
  }

  const startedAt = Date.now();
  if (askedIds.length === 0) {
    return { model: cfg.model, probabilities: {}, usage: {}, latencyMs: 0 };
  }

  const url = `${cfg.baseUrl}/v1/systemone`;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` };
  const body = JSON.stringify({ model: cfg.model, state, questions: sortedQuestions });

  const response = await requestWithRetries({ url, headers, body, cfg, fetcher, sleeper });
  let bodyText;
  try {
    bodyText = await readBodyText(response);
  } catch (error) {
    // 2xx but the body will not read (connection died mid-response): classify
    // like the connection-failure path, then surface the typed unavailable
    // error — the response is already consumed, so there is nothing to retry.
    throw finalizeExhausted(classifyNetworkError(error, cfg.apiKey), 0);
  }
  const parsed = parseBodyJson(bodyText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const status = typeof response.status === 'number' ? response.status : 0;
    throw new JevError(`Jev returned a non-JSON response (HTTP ${status}): ${bodySnippet(bodyText, cfg.apiKey)}`, {
      status,
      code: 'invalid-response',
      retryable: false,
    });
  }

  const echoedModel = typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : cfg.model;
  const probabilities = {};
  const answers = parsed.answers && typeof parsed.answers === 'object' && !Array.isArray(parsed.answers) ? parsed.answers : {};
  for (const id of askedIds) {
    const answer = answers[id];
    const noul = answer && typeof answer === 'object' && !Array.isArray(answer) ? answer.noul : undefined;
    if (typeof noul === 'number' && Number.isFinite(noul)) {
      probabilities[id] = noul;
    }
    // Missing or malformed answer ids simply stay absent - never coerced to 0.
  }
  const usageSource = parsed.usage && typeof parsed.usage === 'object' && !Array.isArray(parsed.usage) ? parsed.usage : {};
  const usage = {};
  for (const key of ['input_tokens', 'output_tokens']) {
    if (typeof usageSource[key] === 'number' && Number.isFinite(usageSource[key])) {
      usage[key] = usageSource[key];
    }
  }

  const latencyMs = Math.max(0, Date.now() - startedAt);
  process.stderr.write(`[jev-switchboard] jev model=${echoedModel} latency_ms=${latencyMs} capabilities=${askedIds.length}\n`);
  return { model: echoedModel, probabilities, usage, latencyMs };
}

module.exports = {
  JevError,
  JevAuthError,
  JevRateLimitError,
  JevUnprocessableError,
  JevUnavailableError,
  evaluateCapabilities,
};
