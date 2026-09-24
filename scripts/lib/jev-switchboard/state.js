'use strict';

// Per-session capability state for the JEV switchboard.
// Contract: docs/JEV-SWITCHBOARD.md ("state.js / telemetry.js").
//
// One JSON file per session at <stateDir>/state-<sessionKey>.json (the
// gateguard per-session state pattern), written atomically with 0600 perms
// via scripts/lib/atomic-write.js. Shape:
//
//   { seq, event, updatedAt, objective?, states: { <id>: {
//       state, reason, lastProbability, lastEvent, changedAtSeq } } }
//
// No hot-path history: only the latest decision per capability is kept, plus
// the monotonically increasing seq that stamps when each capability last
// moved (changedAtSeq). Readers never throw - a missing file is null (gates
// pass through: fail-open on never-evaluated sessions) and a corrupt file is
// null plus a collected stderr warning (never a broken agent).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('../atomic-write');

const STATE_SCHEMA_VERSION = 'ecc.jev-state.v1';
const VALID_STATE_VALUES = new Set(['ON', 'OFF', 'LOCKED']);
const SANITIZED_KEY_MAX = 64;

function warn(message) {
  try {
    process.stderr.write(`[jev-switchboard] Warning: ${String(message).replace(/[^\x20-\x7E]/g, '?')}\n`);
  } catch {
    // stderr is best-effort; never throw from a read path
  }
}

function hashKey(prefix, value) {
  return `${prefix}-${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24)}`;
}

// gateguard-fact-force.js session-key pattern: direct ids first, then a
// transcript-path hash, then a project fingerprint. Sanitized so the value is
// always safe as a filename component.
function sanitizeSessionKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (sanitized && sanitized.length <= SANITIZED_KEY_MAX) return sanitized;
  return hashKey('sid', raw);
}

function resolveSessionKey(data, env = process.env) {
  const source = data && typeof data === 'object' ? data : {};
  const directCandidates = [source.session_id, source.sessionId, source.session && source.session.id, env.CLAUDE_SESSION_ID, env.ECC_SESSION_ID];
  for (const candidate of directCandidates) {
    const sanitized = sanitizeSessionKey(candidate);
    if (sanitized) return sanitized;
  }
  const transcriptPath = source.transcript_path || source.transcriptPath || env.CLAUDE_TRANSCRIPT_PATH;
  if (transcriptPath && String(transcriptPath).trim()) {
    return hashKey('tx', path.resolve(String(transcriptPath).trim()));
  }
  const projectFingerprint = env.CLAUDE_PROJECT_DIR || process.cwd();
  return hashKey('proj', path.resolve(projectFingerprint));
}

function stateFilePath({ config, sessionKey }) {
  return path.join(config.stateDir, `state-${sessionKey}.json`);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Read the per-session state file. Missing file => null (quiet). Corrupt or
 * wrong-shaped file => null with a collected warning. Never throws.
 *
 * @param {object} options {config, sessionKey}
 * @returns {object|null} parsed state document, or null
 */
function readState({ config, sessionKey }) {
  const filePath = stateFilePath({ config, sessionKey });
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    warn(`cannot read state file ${filePath} (${error.code || error.message})`);
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    warn(`state file is not valid JSON at ${filePath} (${error.message}) - treating session as never evaluated`);
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.states || typeof parsed.states !== 'object' || Array.isArray(parsed.states)) {
    warn(`state file has an unexpected shape at ${filePath} - treating session as never evaluated`);
    return null;
  }
  return parsed;
}

/**
 * Write the per-session state file atomically with 0600 permissions.
 *
 * @param {object} options
 * @param {object} options.config - loadJevConfig() output
 * @param {string} options.sessionKey
 * @param {object} options.states - controller output: {<id>: {state, reason, lastProbability, changedAtSeq}}
 * @param {object} [options.meta] - {seq, event, objective}
 * @returns {object} the persisted document
 */
function writeState({ config, sessionKey, states, meta = {} }) {
  const source = states && typeof states === 'object' && !Array.isArray(states) ? states : {};
  const event = typeof meta.event === 'string' ? meta.event : '';
  const normalized = {};
  for (const id of Object.keys(source).sort()) {
    const entry = source[id] && typeof source[id] === 'object' ? source[id] : {};
    normalized[id] = {
      state: VALID_STATE_VALUES.has(entry.state) ? entry.state : 'OFF',
      reason: typeof entry.reason === 'string' ? entry.reason : '',
      lastProbability: isFiniteNumber(entry.lastProbability) ? entry.lastProbability : null,
      lastEvent: event || (typeof entry.lastEvent === 'string' ? entry.lastEvent : ''),
      changedAtSeq: isFiniteNumber(entry.changedAtSeq) ? entry.changedAtSeq : null
    };
  }
  const document = {
    schemaVersion: STATE_SCHEMA_VERSION,
    seq: isFiniteNumber(meta.seq) ? meta.seq : 0,
    event,
    updatedAt: new Date().toISOString(),
    ...(typeof meta.objective === 'string' && meta.objective.trim() ? { objective: meta.objective.trim() } : {}),
    states: normalized
  };
  writeFileAtomic(stateFilePath({ config, sessionKey }), `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  return document;
}

/**
 * Fast gate lookup: {id -> state entry} for the session, or null when no
 * state file exists (fail-open pass-through).
 *
 * @param {object} options {config, sessionKey}
 * @returns {object|null}
 */
function readStatesForGate({ config, sessionKey }) {
  const state = readState({ config, sessionKey });
  if (!state) return null;
  const map = {};
  for (const [id, entry] of Object.entries(state.states)) {
    map[id] = entry;
  }
  return map;
}

// Capability ids currently active (ON/LOCKED) - feeds task-state's
// activeCapabilities signal.
function activeCapabilityIds(state) {
  if (!state || !state.states || typeof state.states !== 'object') return [];
  return Object.keys(state.states).filter(id => {
    const value = state.states[id] && state.states[id].state;
    return value === 'ON' || value === 'LOCKED';
  });
}

module.exports = {
  STATE_SCHEMA_VERSION,
  stateFilePath,
  resolveSessionKey,
  sanitizeSessionKey,
  readState,
  writeState,
  readStatesForGate,
  activeCapabilityIds
};
