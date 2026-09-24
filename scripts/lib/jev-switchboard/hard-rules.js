'use strict';

// Hard rules for the JEV capability switchboard — the deterministic policy
// layer that sits beyond Jev's reach. Contract: docs/JEV-SWITCHBOARD.md
// ("hard-rules.js").
//
// collectHardRules({registry, promptText, config, env}) -> {locked, forcedOff, passThrough}
//
// Rules, in precedence order (all evaluation is deterministic; both output
// buckets are sorted by id):
//   (a) kill switch — config.enabled === false or env.ECC_JEV_ENABLED in
//       {'false','0'} -> passThrough true and nothing else (dominates all).
//   (b) explicit user request — word-boundary, case-insensitive match of the
//       capability name or id in promptText -> locked, source
//       'explicit-request'. Word boundaries keep 'git' from matching inside
//       'digit'.
//   (c) alwaysLocked overlay set (config.alwaysLocked, falling back to
//       registry.alwaysLocked) -> locked, source 'security-policy'. An id
//       already locked by explicit request keeps the 'explicit-request'
//       source (rule (b) outranks rule (c)).
//   (d) registry entry available === false -> forcedOff, reason 'unavailable'.

const EXPLICIT_REQUEST_SOURCE = 'explicit-request';
const SECURITY_POLICY_SOURCE = 'security-policy';
const UNAVAILABLE_REASON = 'unavailable';
const KILL_SWITCH_ENV_VAR = 'ECC_JEV_ENABLED';

function compareIds(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

// Same registry normalization as the controller: a bare entry array or
// {entries|capabilities: [...]}, filtered to usable ids and sorted by id so
// every rule evaluates in sorted-id order.
function toSortedEntries(registry) {
  let list = [];
  if (Array.isArray(registry)) {
    list = registry;
  } else if (registry && typeof registry === 'object') {
    if (Array.isArray(registry.entries)) list = registry.entries;
    else if (Array.isArray(registry.capabilities)) list = registry.capabilities;
  }
  return list.filter(entry => entry && typeof entry.id === 'string').sort((a, b) => compareIds(a.id, b.id));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word-boundary, case-insensitive containment test. Boundaries are computed
// with an explicit [A-Za-z0-9_] class (not \b) so terms that themselves start
// or end with non-word characters (ids like 'mcp:github') still anchor safely.
function matchesWordBoundary(text, term) {
  const trimmed = term.trim();
  if (trimmed === '') return false;
  const pattern = new RegExp('(^|[^A-Za-z0-9_])' + escapeRegExp(trimmed) + '($|[^A-Za-z0-9_])', 'i');
  return pattern.test(text);
}

function isKillSwitchOn(config, env) {
  if (config && typeof config === 'object' && config.enabled === false) return true;
  const flag = env ? env[KILL_SWITCH_ENV_VAR] : undefined;
  return typeof flag === 'string' && (flag.toLowerCase() === 'false' || flag === '0');
}

// The alwaysLocked overlay set may ride on config or on the registry build.
function readAlwaysLocked(config, registry) {
  const source = config && Array.isArray(config.alwaysLocked) ? config.alwaysLocked : registry && Array.isArray(registry.alwaysLocked) ? registry.alwaysLocked : [];
  return source.filter(item => typeof item === 'string').sort(compareIds);
}

function collectHardRules({ registry, promptText, config, env } = {}) {
  const entries = toSortedEntries(registry);

  // (a) kill switch: pass-through with nothing else — checked first so it
  // dominates every other rule.
  if (isKillSwitchOn(config, env)) {
    return { locked: [], forcedOff: [], passThrough: true };
  }

  const text = typeof promptText === 'string' ? promptText : '';
  const lockedById = new Map();
  const forcedOffById = new Map();

  // (b) explicit user request: name or id appearing as a whole word.
  for (const entry of entries) {
    const terms = [entry.name, entry.id].filter(term => typeof term === 'string' && term.trim() !== '');
    if (terms.some(term => matchesWordBoundary(text, term))) {
      lockedById.set(entry.id, { id: entry.id, source: EXPLICIT_REQUEST_SOURCE });
    }
  }

  // (c) alwaysLocked security controls; explicit-request wins on overlap.
  for (const id of readAlwaysLocked(config, registry)) {
    if (!lockedById.has(id)) lockedById.set(id, { id, source: SECURITY_POLICY_SOURCE });
  }

  // (d) unavailable capabilities are forced off.
  for (const entry of entries) {
    if (entry.available === false) forcedOffById.set(entry.id, { id: entry.id, reason: UNAVAILABLE_REASON });
  }

  return {
    locked: Array.from(lockedById.values()).sort((a, b) => compareIds(a.id, b.id)),
    forcedOff: Array.from(forcedOffById.values()).sort((a, b) => compareIds(a.id, b.id)),
    passThrough: false
  };
}

module.exports = {
  EXPLICIT_REQUEST_SOURCE,
  KILL_SWITCH_ENV_VAR,
  SECURITY_POLICY_SOURCE,
  UNAVAILABLE_REASON,
  collectHardRules,
  matchesWordBoundary
};
