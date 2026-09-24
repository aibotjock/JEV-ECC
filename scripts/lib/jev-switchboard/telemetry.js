'use strict';

// Append-only telemetry for the JEV capability switchboard.
// Contract: docs/JEV-SWITCHBOARD.md ("state.js / telemetry.js").
//
// Telemetry is strictly separate from policy: nothing here ever feeds a gate
// decision directly. appendEvent() writes one JSON object per line to
// <telemetryPath> (default ~/.claude/ecc/jev-switchboard/telemetry.jsonl),
// creates the directory when missing, and never throws - a full disk must not
// break routing. readRecentFailures() scans backwards for rows carrying
// failure signals (tool-failure / eval-error events) to feed the task state.

const fs = require('fs');
const path = require('path');

const FAILURE_EVENTS = new Set(['tool-failure', 'eval-error']);
const MAX_STRING_CHARS = 500;
const TRUNCATION_MARKER = '...[truncated]';
const MAX_SCAN_CHARS = 256 * 1024;

function compactValue(value) {
  if (value === undefined || value === null) return null;
  const type = typeof value;
  if (type === 'string') {
    const text = value.length > MAX_STRING_CHARS ? value.slice(0, MAX_STRING_CHARS - TRUNCATION_MARKER.length) + TRUNCATION_MARKER : value;
    return text;
  }
  if (type === 'number') return Number.isFinite(value) ? value : null;
  if (type === 'boolean') return value;
  if (Array.isArray(value)) {
    const items = value.slice(0, 50).map(compactValue).filter(item => item !== null);
    return items;
  }
  if (type === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const compacted = compactValue(value[key]);
      if (compacted !== null) out[key] = compacted;
    }
    return out;
  }
  return null;
}

/**
 * Append one telemetry event as a single JSON line. Never throws.
 *
 * @param {object} options {config, event} - event fields are compacted
 * @returns {boolean} true when the row was appended
 */
function appendEvent({ config, event }) {
  try {
    const target = config && config.telemetryPath ? config.telemetryPath : '';
    if (!target) return false;
    fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
    const row = compactValue({ ...event, ts: new Date().toISOString() });
    if (!row || typeof row !== 'object') return false;
    fs.appendFileSync(target, `${JSON.stringify(row)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read recent failure-signal events, scanning backwards (most recent first).
 * Missing or unreadable file => []. Never throws.
 *
 * @param {object} options {config, limit=5}
 * @returns {Array<object>} [{event, toolName, errorMessage, message, ts}]
 */
function readRecentFailures({ config, limit = 5 } = {}) {
  const maxRows = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 5;
  const target = config && config.telemetryPath ? config.telemetryPath : '';
  if (!target) return [];
  let raw;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch {
    return [];
  }
  // Only the tail matters for "recent"; cap the scan cost on grown files.
  const scanWindow = raw.length > MAX_SCAN_CHARS ? raw.slice(raw.length - MAX_SCAN_CHARS) : raw;
  const lines = scanWindow.split('\n');
  const failures = [];
  for (let i = lines.length - 1; i >= 0 && failures.length < maxRows; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // torn tail line from a concurrent append - skip, never throw
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    if (!FAILURE_EVENTS.has(parsed.event)) continue;
    failures.push({
      event: parsed.event,
      toolName: typeof parsed.toolName === 'string' ? parsed.toolName : '',
      errorMessage: typeof parsed.errorMessage === 'string' ? parsed.errorMessage : '',
      message: typeof parsed.message === 'string' ? parsed.message : '',
      ts: typeof parsed.ts === 'string' ? parsed.ts : ''
    });
  }
  return failures;
}

module.exports = {
  FAILURE_EVENTS,
  appendEvent,
  readRecentFailures
};
