'use strict';

// Task-state builder for the JEV capability switchboard.
// Contract: docs/JEV-SWITCHBOARD.md ("question-render.js / task-state.js").
//
// buildTaskState({event, prompt, sessionKey, recentFailures, repoContext,
//                 activeCapabilities, priorObjective}) -> compact JSON state
//
// The routing question is always "which capabilities are needed now", never
// "how should the task be solved", so the state carries routing signals only:
// a capped objective line, a phase derived from the routing event, repo
// context, currently active capability ids, explicit requests pulled out of
// the prompt (slash commands, backtick-quoted spans), and failure signals
// from telemetry. No transcript dumps: compaction is delegated to
// question-render.renderState (arrays capped at 5, strings at 400 chars,
// empty fields dropped, keys sorted for deterministic serialization).

const { renderState, MAX_STATE_ARRAY_ITEMS } = require('./question-render');

const MAX_OBJECTIVE_CHARS = 400;
const ROUTING_EVENTS = new Set(['user-prompt', 'stop', 'tool-failure']);
const PHASE_BY_EVENT = {
  'user-prompt': 'planning',
  stop: 'closing',
  'tool-failure': 'recovering',
};

function isBlankString(value) {
  return typeof value !== 'string' || value.trim() === '';
}

function collapseWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

// First sentence (or first line) of the prompt, capped. The objective is a
// routing signal for Jev, not a transcript: one bounded line is enough for
// "which capabilities are needed now".
function deriveObjective(event, prompt, priorObjective) {
  const text = collapseWhitespace(prompt);
  if (text) {
    const firstSentence = text.split(/(?<=[.!?])\s/)[0] || text;
    const line = firstSentence.length > 0 ? firstSentence : text;
    return capWithMarker(line, MAX_OBJECTIVE_CHARS);
  }
  // Stop re-evaluations arrive without prompt text; carry the objective the
  // prior state file already recorded so the router keeps its bearings.
  if (event === 'stop' && !isBlankString(priorObjective)) {
    return capWithMarker(collapseWhitespace(priorObjective), MAX_OBJECTIVE_CHARS);
  }
  return undefined;
}

function capWithMarker(text, maxChars) {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - '...[truncated]'.length) + '...[truncated]';
}

// Explicit requests the user made in their own words: slash commands and
// backtick-quoted spans. These feed hard-rule explicit-request locking only
// indirectly (locking itself matches against the prompt); here they orient
// Jev toward what the user asked for by name.
function extractExplicitRequests(prompt) {
  const text = String(prompt || '');
  if (!text.trim()) return undefined;
  // Collect slash commands and backtick spans with their positions, then emit
  // in order of appearance (deduped, capped).
  const candidates = [];
  for (const match of text.matchAll(/(^|\s)(\/[A-Za-z0-9][A-Za-z0-9._:-]*)/g)) {
    candidates.push({ index: match.index + match[1].length, value: match[2] });
  }
  for (const match of text.matchAll(/`([^`\r\n]{1,80})`/g)) {
    candidates.push({ index: match.index, value: match[1] });
  }
  candidates.sort((a, b) => a.index - b.index);
  const found = [];
  for (const candidate of candidates) {
    const trimmed = String(candidate.value || '').trim();
    if (trimmed && !found.includes(trimmed)) found.push(trimmed);
  }
  return found.length > 0 ? found.slice(0, MAX_STATE_ARRAY_ITEMS) : undefined;
}

function normalizeFailureSignals(recentFailures) {
  if (!Array.isArray(recentFailures)) return undefined;
  const signals = [];
  for (const failure of recentFailures) {
    if (signals.length >= MAX_STATE_ARRAY_ITEMS) break;
    if (typeof failure === 'string' && failure.trim()) {
      signals.push(failure.trim());
      continue;
    }
    if (!failure || typeof failure !== 'object') continue;
    const toolName = collapseWhitespace(failure.toolName || failure.tool_name);
    const message = collapseWhitespace(failure.errorMessage || failure.message || failure.error);
    if (!toolName && !message) continue;
    signals.push([toolName || 'tool', message || 'failed'].join(': '));
  }
  return signals.length > 0 ? signals : undefined;
}

function normalizeActiveCapabilities(activeCapabilities) {
  if (!Array.isArray(activeCapabilities)) return undefined;
  const ids = activeCapabilities
    .filter(id => typeof id === 'string' && id.trim())
    .map(id => id.trim())
    .sort();
  return ids.length > 0 ? Array.from(new Set(ids)).slice(0, MAX_STATE_ARRAY_ITEMS) : undefined;
}

function normalizeRepoContext(repoContext) {
  if (!repoContext || typeof repoContext !== 'object') return undefined;
  const out = {};
  if (!isBlankString(repoContext.cwd)) out.cwd = collapseWhitespace(repoContext.cwd);
  if (!isBlankString(repoContext.projectRoot)) out.projectRoot = collapseWhitespace(repoContext.projectRoot);
  if (Array.isArray(repoContext.languages)) {
    const languages = repoContext.languages.filter(item => typeof item === 'string' && item.trim());
    if (languages.length > 0) out.languages = languages.slice(0, MAX_STATE_ARRAY_ITEMS);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Build the compact task state handed to Jev as the `state` of the batched
 * noul evaluation.
 *
 * @param {object} options
 * @param {string} options.event - routing event: 'user-prompt' | 'stop' | 'tool-failure'
 * @param {string} [options.prompt] - prompt text for user-prompt events
 * @param {string} [options.sessionKey] - resolved per-session key
 * @param {Array} [options.recentFailures] - telemetry failure rows (objects or strings)
 * @param {object} [options.repoContext] - {cwd, projectRoot, languages}
 * @param {Array<string>} [options.activeCapabilities] - ids currently ON/LOCKED
 * @param {string} [options.priorObjective] - objective carried from the prior state file
 * @returns {object} compact JSON-ready task state (renderState conventions)
 */
function buildTaskState(options = {}) {
  const event = ROUTING_EVENTS.has(options.event) ? options.event : 'user-prompt';
  const prompt = typeof options.prompt === 'string' ? options.prompt : '';
  const sessionKey = collapseWhitespace(options.sessionKey);

  return renderState({
    objective: deriveObjective(event, prompt, options.priorObjective),
    phase: PHASE_BY_EVENT[event],
    repoContext: normalizeRepoContext(options.repoContext),
    activeCapabilities: normalizeActiveCapabilities(options.activeCapabilities),
    explicitRequests: extractExplicitRequests(prompt),
    failureSignals: normalizeFailureSignals(options.recentFailures),
    ...(sessionKey ? { sessionKey } : {})
  });
}

module.exports = {
  MAX_OBJECTIVE_CHARS,
  PHASE_BY_EVENT,
  ROUTING_EVENTS,
  buildTaskState,
  deriveObjective,
  extractExplicitRequests,
  normalizeFailureSignals
};
