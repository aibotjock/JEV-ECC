'use strict';

// Calibration summary for the JEV capability switchboard.
// Contract: docs/JEV-SWITCHBOARD.md (CLI: calibrate).
//
// Pure function over parsed telemetry.jsonl rows (telemetry.appendEvent shape):
// routing events {event: 'user-prompt'|'stop'|'tool-failure', sessionKey,
// probabilities, decisions, latencyMs, model} and {event: 'eval-error'} rows.
// No clock, no randomness, no IO — every iteration runs in sorted-id order so
// the summary is bit-for-bit deterministic for the same rows.
//
// Per capability: samples / meanP / minP / maxP come from the probabilities it
// appeared in; onCount/offCount/lockedCount and flips come from the decisions
// change rows ({id, from, to}). A flip is an ON<->OFF transition — changes into
// LOCKED are terminal (the controller never unlocks) and do not count. Stock
// change rows carry no reason; explicitLocks counts decision rows that DO carry
// one matching /explicit-request|hard-rule:lock/ (e.g. from a richer emitter).

const DEFAULT_ACTIVATION_THRESHOLD = 0.65;
const DEFAULT_DEACTIVATION_THRESHOLD = 0.35;

const ROUTING_EVENTS = new Set(['user-prompt', 'stop', 'tool-failure']);
const EVAL_ERROR_EVENT = 'eval-error';
const EXPLICIT_LOCK_PATTERN = /explicit-request|hard-rule:lock/;

const FLIP_ADVICE_MIN_FLIPS = 3;
const THRESHOLD_ADVICE_MIN_SAMPLES = 5;
const EXPLICIT_LOCK_ADVICE_MIN_LOCKS = 2;
const SAMPLE_SIZE_WARNING_MIN_EVENTS = 10;
const SAMPLE_SIZE_WARNING_TEXT = 'sample size too small to act on — collect more routing events';

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function compareIds(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Summarize parsed telemetry rows into per-capability calibration stats plus
 * actionable recommendations.
 *
 * @param {Array<object>} rows - parsed telemetry.jsonl rows (unparsed/foreign rows are ignored)
 * @param {object} [options] - {activationThreshold=0.65, deactivationThreshold=0.35}
 * @returns {{events: number, evalErrors: number, rowsConsidered: number,
 *   capabilities: Array<object>, recommendations: string[], sampleSizeWarning: boolean}}
 *   rowsConsidered = routing events + eval errors (the rows that fed the summary).
 */
function summarizeCalibration(rows, options = {}) {
  const activationThreshold = isFiniteNumber(options.activationThreshold) ? options.activationThreshold : DEFAULT_ACTIVATION_THRESHOLD;
  const deactivationThreshold = isFiniteNumber(options.deactivationThreshold) ? options.deactivationThreshold : DEFAULT_DEACTIVATION_THRESHOLD;
  const list = Array.isArray(rows) ? rows : [];

  const byId = new Map();
  const entryFor = id => {
    let entry = byId.get(id);
    if (!entry) {
      entry = { id, samples: 0, pSum: 0, minP: null, maxP: null, onCount: 0, offCount: 0, lockedCount: 0, bandCount: 0, flips: 0, explicitLocks: 0 };
      byId.set(id, entry);
    }
    return entry;
  };

  let events = 0;
  let evalErrors = 0;
  for (const row of list) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    if (row.event === EVAL_ERROR_EVENT) {
      evalErrors += 1;
      continue;
    }
    if (!ROUTING_EVENTS.has(row.event)) continue; // foreign event types never skew the summary
    events += 1;

    const probabilities = row.probabilities && typeof row.probabilities === 'object' && !Array.isArray(row.probabilities) ? row.probabilities : {};
    for (const id of Object.keys(probabilities).sort(compareIds)) {
      const p = probabilities[id];
      if (!isFiniteNumber(p)) continue;
      const entry = entryFor(id);
      entry.samples += 1;
      entry.pSum += p;
      entry.minP = entry.minP === null ? p : Math.min(entry.minP, p);
      entry.maxP = entry.maxP === null ? p : Math.max(entry.maxP, p);
      if (p > deactivationThreshold && p < activationThreshold) entry.bandCount += 1;
    }

    const decisions = Array.isArray(row.decisions) ? row.decisions : [];
    for (const change of decisions) {
      if (!change || typeof change !== 'object' || typeof change.id !== 'string' || !change.id) continue;
      const entry = entryFor(change.id);
      if (change.to === 'ON') entry.onCount += 1;
      else if (change.to === 'OFF') entry.offCount += 1;
      else if (change.to === 'LOCKED') entry.lockedCount += 1;
      // Only ON<->OFF movement is a flip; LOCKED is terminal.
      if ((change.from === 'ON' || change.from === 'OFF') && (change.to === 'ON' || change.to === 'OFF')) entry.flips += 1;
      if (typeof change.reason === 'string' && EXPLICIT_LOCK_PATTERN.test(change.reason)) entry.explicitLocks += 1;
    }
  }

  const capabilities = Array.from(byId.values())
    .map(entry => ({
      id: entry.id,
      samples: entry.samples,
      meanP: entry.samples > 0 ? entry.pSum / entry.samples : null,
      minP: entry.minP,
      maxP: entry.maxP,
      onCount: entry.onCount,
      offCount: entry.offCount,
      lockedCount: entry.lockedCount,
      bandCount: entry.bandCount,
      flips: entry.flips,
      explicitLocks: entry.explicitLocks
    }))
    .sort((a, b) => compareIds(a.id, b.id));

  const recommendations = [];
  for (const capability of capabilities) {
    if (capability.flips >= FLIP_ADVICE_MIN_FLIPS) {
      recommendations.push(`widen hysteresis band for ${capability.id} (${capability.flips} flips)`);
    }
    if (
      capability.samples >= THRESHOLD_ADVICE_MIN_SAMPLES &&
      isFiniteNumber(capability.meanP) &&
      capability.meanP > deactivationThreshold &&
      capability.meanP < activationThreshold
    ) {
      recommendations.push(`review activation threshold for ${capability.id} (mean P=${capability.meanP.toFixed(2)} sits in the hysteresis band)`);
    }
    if (capability.explicitLocks >= EXPLICIT_LOCK_ADVICE_MIN_LOCKS && capability.samples >= THRESHOLD_ADVICE_MIN_SAMPLES) {
      recommendations.push(`triggers for ${capability.id} may be too weak (locked on by explicit request ${capability.explicitLocks} times)`);
    }
  }

  return {
    events,
    evalErrors,
    rowsConsidered: events + evalErrors,
    capabilities,
    recommendations,
    sampleSizeWarning: events < SAMPLE_SIZE_WARNING_MIN_EVENTS
  };
}

module.exports = {
  DEFAULT_ACTIVATION_THRESHOLD,
  DEFAULT_DEACTIVATION_THRESHOLD,
  SAMPLE_SIZE_WARNING_MIN_EVENTS,
  SAMPLE_SIZE_WARNING_TEXT,
  summarizeCalibration
};
