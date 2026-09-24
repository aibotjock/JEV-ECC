'use strict';

// Deterministic threshold controller for the JEV capability switchboard.
// Contract: docs/JEV-SWITCHBOARD.md ("controller.js — PURE").
//
// decide({registry, probabilities, currentStates, hardRules}) -> {states, changes, warnings}
//
// Pure: no clock, no randomness, no IO. Bit-for-bit deterministic — every
// iteration runs in sorted-id order. Fixed pipeline:
//   1. pass-through short-circuit (kill switch): every state is returned
//      unchanged; a missing current state defaults to OFF.
//   2. threshold pass: LOCKED stays LOCKED; otherwise p >= activation -> ON,
//      p <= deactivation -> OFF, strictly between -> KEEP current, absent
//      probability -> KEEP current. A missing current defaults to OFF.
//   3. dependency closure to fixpoint: an active (ON/LOCKED) capability forces
//      its dependencies ON (reason "dependency-of:<id>"). Cycle-safe via a
//      visited set; cycles are collected as warnings, never infinite loops.
//   4. mutual conflicts: when two active capabilities each list the other in
//      conflicts, the higher probability wins (a missing probability loses to
//      any present one); a tie goes to the lexicographically smaller id. The
//      loser goes OFF with reason "conflict-with:<winner>". LOCKED never loses.
//   5. hard rules apply LAST and override everything: locked ids -> LOCKED
//      ("hard-rule:lock:<source>"), then forcedOff ids -> OFF
//      ("hard-rule:<reason>"). forcedOff runs after locked so an unavailable
//      capability cannot run even when explicitly requested.
//   6. post-override reconciliation: conflicts and hard rules run after the
//      dependency closure, so (a) a capability activated as
//      "dependency-of:X" is demoted to OFF ("dependency-demoted") once X is no
//      longer active, iterating to fixpoint in sorted order so chains
//      collapse; and (b) when a hard rule forces OFF a capability that an ON
//      capability declares as a dependency, the hard rule wins (the dependency
//      stays OFF) and the dependent stays ON — v1 policy is warn-only: a
//      {type: 'broken-dependency', id, dependency} object is appended to
//      `warnings` for the applier/gate to surface; the dependent is never
//      auto-disabled here. A current ON granted by dependency activation is
//      contingent: the threshold pass does not keep it ON through a missing
//      probability or the hysteresis band — the closure pass must re-earn it
//      every round, which is what makes demotion work across decide() calls.
//
// `changes` lists net movement relative to the incoming current states
// ({id, from, to}, sorted by id); intermediate moves inside the pipeline are
// not reported. `changedAtSeq` is the incoming meta.seq + 1 for entries whose
// state moved, and is preserved otherwise. Unknown ids in `probabilities` are
// ignored — the registry defines the capability universe.

const DEFAULT_ACTIVATION_THRESHOLD = 0.65;
const DEFAULT_DEACTIVATION_THRESHOLD = 0.35;

const STATE_ON = 'ON';
const STATE_OFF = 'OFF';
const STATE_LOCKED = 'LOCKED';

function compareIds(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// Accepts a bare entry array or {entries|capabilities: [...]} and returns the
// entries with usable ids, sorted by id (the canonical processing order).
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

function sortedStrings(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(item => typeof item === 'string').sort(compareIds);
}

function readSeq(currentStates) {
  if (!currentStates || typeof currentStates !== 'object') return 0;
  if (currentStates.meta && isFiniteNumber(currentStates.meta.seq)) return currentStates.meta.seq;
  if (isFiniteNumber(currentStates.seq)) return currentStates.seq;
  return 0;
}

// Accepts the state-file shape ({meta:{seq}, states:{...}} or {seq, states:{...}})
// or a bare {id: entry} map.
function currentStateMap(currentStates) {
  const map = new Map();
  if (!currentStates || typeof currentStates !== 'object') return map;
  const source = currentStates.states && typeof currentStates.states === 'object' && !Array.isArray(currentStates.states) ? currentStates.states : currentStates;
  for (const key of Object.keys(source)) {
    if (key === 'meta' || key === 'seq' || key === 'event' || key === 'states') continue;
    const value = source[key];
    if (value && typeof value === 'object') map.set(key, value);
  }
  return map;
}

function isActiveEntry(working, id) {
  const entry = working.get(id);
  return Boolean(entry) && (entry.state === STATE_ON || entry.state === STATE_LOCKED);
}

// A reason of the form "dependency-of:<id>" marks a capability whose ON state
// was granted purely by the dependency closure, not by its own signal.
function dependencyActivatorId(reason) {
  if (typeof reason !== 'string') return null;
  const match = reason.match(/^dependency-of:(.+)$/);
  return match ? match[1] : null;
}

// Step 2: threshold pass in sorted-id order.
function applyThresholds(sortedIds, byId, probabilities, currents, working) {
  for (const id of sortedIds) {
    const entry = byId.get(id) || {};
    const current = currents.get(id);
    const p = probabilities[id];
    const hasP = isFiniteNumber(p);
    const lastProbability = hasP ? p : isFiniteNumber(current && current.lastProbability) ? current.lastProbability : null;

    let state;
    let reason;
    if (current && current.state === STATE_LOCKED) {
      // LOCKED remains LOCKED: thresholds, dependencies, and conflicts never
      // unlock it. Only hard rules (applied last) may override.
      state = STATE_LOCKED;
      reason = typeof current.reason === 'string' ? current.reason : 'locked';
    } else if (!hasP) {
      // Missing answer -> KEEP (never punish on a partial Jev response).
      // Exception: an ON granted by dependency activation is contingent — the
      // closure pass must re-earn it every round, so it is not kept through a
      // missing probability once its activator goes away (step 6 demotes it).
      state = current && current.state === STATE_ON && dependencyActivatorId(current.reason) === null ? STATE_ON : STATE_OFF;
      reason = 'keep:no-probability';
    } else {
      const activation = isFiniteNumber(entry.activationThreshold) ? entry.activationThreshold : DEFAULT_ACTIVATION_THRESHOLD;
      const deactivation = isFiniteNumber(entry.deactivationThreshold) ? entry.deactivationThreshold : DEFAULT_DEACTIVATION_THRESHOLD;
      if (p >= activation) {
        state = STATE_ON;
        reason = 'threshold:on';
      } else if (p <= deactivation) {
        state = STATE_OFF;
        reason = 'threshold:off';
      } else {
        state = current && current.state === STATE_ON && dependencyActivatorId(current.reason) === null ? STATE_ON : STATE_OFF;
        reason = 'keep:hysteresis-band';
      }
    }
    working.set(id, { state, reason, lastProbability });
  }
}

// Step 3: dependency closure to fixpoint, cycle-safe. Traversals restart per
// active root (sorted), each guarded by its own visited set, so the closure is
// monotone and terminates. Cycles are appended to `warnings` (deduped).
function applyDependencyClosure(sortedIds, byId, working, warnings, warningSeen) {
  const visit = (node, stack, onStack, visited) => {
    const entry = byId.get(node) || {};
    for (const dep of sortedStrings(entry.dependencies)) {
      if (!byId.has(dep)) continue; // unknown dependency ids are ignored
      if (onStack.has(dep)) {
        const cycle = stack.slice(stack.indexOf(dep)).concat(dep).join('->');
        const warning = 'dependency-cycle:' + cycle;
        if (!warningSeen.has(warning)) {
          warningSeen.add(warning);
          warnings.push(warning);
        }
        continue;
      }
      if (!isActiveEntry(working, dep)) {
        const depEntry = working.get(dep);
        depEntry.state = STATE_ON;
        depEntry.reason = 'dependency-of:' + node;
      }
      if (visited.has(dep)) continue;
      visited.add(dep);
      stack.push(dep);
      onStack.add(dep);
      visit(dep, stack, onStack, visited);
      stack.pop();
      onStack.delete(dep);
    }
  };

  for (const root of sortedIds) {
    if (!isActiveEntry(working, root)) continue;
    visit(root, [root], new Set([root]), new Set([root]));
  }
}

// Step 4: mutual-conflict resolution. Both capabilities must list each other;
// a one-directional listing does not fire. LOCKED entries never lose (a locked
// capability beats a merely-ON opponent; two locked opponents both stay).
function applyConflicts(sortedIds, byId, working, probabilities) {
  const effectiveProbability = id => (isFiniteNumber(probabilities[id]) ? probabilities[id] : -1);

  const pairs = [];
  for (let i = 0; i < sortedIds.length; i++) {
    for (let j = i + 1; j < sortedIds.length; j++) {
      const a = sortedIds[i];
      const b = sortedIds[j];
      const entryA = byId.get(a) || {};
      const entryB = byId.get(b) || {};
      if (!sortedStrings(entryA.conflicts).includes(b)) continue;
      if (!sortedStrings(entryB.conflicts).includes(a)) continue;
      pairs.push([a, b]);
    }
  }

  const forceOff = (id, reason) => {
    const entry = working.get(id);
    entry.state = STATE_OFF;
    entry.reason = reason;
  };

  for (const [a, b] of pairs) {
    const entryA = working.get(a);
    const entryB = working.get(b);
    if (!entryA || !entryB) continue;
    const aActive = entryA.state === STATE_ON || entryA.state === STATE_LOCKED;
    const bActive = entryB.state === STATE_ON || entryB.state === STATE_LOCKED;
    if (!aActive || !bActive) continue; // conflicts only matter between active capabilities
    if (entryA.state === STATE_LOCKED && entryB.state === STATE_LOCKED) continue;
    if (entryA.state === STATE_LOCKED) {
      forceOff(b, 'conflict-with:' + a);
      continue;
    }
    if (entryB.state === STATE_LOCKED) {
      forceOff(a, 'conflict-with:' + b);
      continue;
    }
    const pA = effectiveProbability(a);
    const pB = effectiveProbability(b);
    let winner;
    let loser;
    if (pA > pB) {
      winner = a;
      loser = b;
    } else if (pB > pA) {
      winner = b;
      loser = a;
    } else {
      winner = a < b ? a : b; // tie -> lexicographically smaller id wins
      loser = a < b ? b : a;
    }
    forceOff(loser, 'conflict-with:' + winner);
  }
}

// Step 5: hard rules, applied last, overriding everything before them.
function applyHardRules(byId, working, hardRules) {
  if (!hardRules || typeof hardRules !== 'object') return;
  const locked = (Array.isArray(hardRules.locked) ? hardRules.locked : [])
    .filter(item => item && typeof item.id === 'string' && byId.has(item.id))
    .sort((a, b) => compareIds(a.id, b.id));
  for (const item of locked) {
    const entry = working.get(item.id);
    entry.state = STATE_LOCKED;
    entry.reason = 'hard-rule:lock:' + (typeof item.source === 'string' ? item.source : 'unknown');
  }
  const forcedOff = (Array.isArray(hardRules.forcedOff) ? hardRules.forcedOff : [])
    .filter(item => item && typeof item.id === 'string' && byId.has(item.id))
    .sort((a, b) => compareIds(a.id, b.id));
  for (const item of forcedOff) {
    const entry = working.get(item.id);
    entry.state = STATE_OFF;
    entry.reason = 'hard-rule:' + (typeof item.reason === 'string' ? item.reason : 'unknown');
  }
}

// Step 6: post-override reconciliation (see the pipeline comment above).
// (a) Demote dependency-activated capabilities whose activator is no longer
//     active, iterating to fixpoint in sorted order so chains collapse.
// (b) When a hard rule forces OFF a capability that an ON capability declares
//     as a dependency, keep the forced-off state (hard rules win) and collect
//     a {type: 'broken-dependency', id, dependency} warning. v1 policy is
//     warn-only: the dependent is NOT auto-disabled here; the applier/gate
//     surfaces the warning.
function applyPostOverrideReconciliation(sortedIds, byId, working, warnings, warningSeen) {
  for (;;) {
    let demotedAny = false;
    for (const id of sortedIds) {
      const entry = working.get(id);
      if (!entry || entry.state !== STATE_ON) continue;
      const activator = dependencyActivatorId(entry.reason);
      if (activator === null) continue;
      if (isActiveEntry(working, activator)) continue;
      entry.state = STATE_OFF;
      entry.reason = 'dependency-demoted';
      demotedAny = true;
    }
    if (!demotedAny) break;
  }

  for (const id of sortedIds) {
    const entry = working.get(id);
    if (!entry || entry.state !== STATE_ON) continue;
    for (const dependency of sortedStrings((byId.get(id) || {}).dependencies)) {
      const depEntry = working.get(dependency);
      if (!depEntry || depEntry.state !== STATE_OFF) continue;
      if (typeof depEntry.reason !== 'string' || !depEntry.reason.startsWith('hard-rule:')) continue;
      const key = `broken-dependency:${id}:${dependency}`;
      if (warningSeen.has(key)) continue;
      warningSeen.add(key);
      warnings.push({ type: 'broken-dependency', id, dependency });
    }
  }
}

/**
 * Run the fixed decision pipeline over one Jev evaluation.
 *
 * After the conflicts and hard-rule override steps, a post-override
 * reconciliation pass restores the dependency invariants:
 * - A capability that is ON only because it was activated as
 *   "dependency-of:X" is demoted to OFF with reason "dependency-demoted" when
 *   its activator X is no longer active (forced OFF by a hard rule or a lost
 *   conflict), iterating to fixpoint in sorted-id order so A->B->C chains
 *   collapse when A goes away. Supporting this across decide() calls, the
 *   threshold pass never keeps a dependency-activated ON through a missing
 *   probability or the hysteresis band: the closure pass must re-earn it
 *   every round.
 * - When a hard rule forces OFF a capability that an ON capability declares
 *   as a dependency, the hard rule wins (the dependency stays OFF) and the
 *   dependent stays ON — v1 policy is warn-only. A
 *   {type: 'broken-dependency', id, dependency} object is appended to
 *   `warnings` (which otherwise holds plain strings) for the applier/gate to
 *   surface; the dependent is never auto-disabled here.
 *
 * @param {object} options
 * @param {object|Array} options.registry - registry object ({entries|capabilities}) or bare entry array
 * @param {Object<string, number>} [options.probabilities] - Jev noul answers by capability id
 * @param {object} [options.currentStates] - prior state file shape or bare id -> entry map
 * @param {object} [options.hardRules] - {locked, forcedOff, passThrough}
 * @returns {{states: object, changes: Array<{id, from, to}>, warnings: Array<(string|object)>}}
 */
function decide({ registry, probabilities, currentStates, hardRules } = {}) {
  const entries = toSortedEntries(registry);
  const sortedIds = entries.map(entry => entry.id);
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const currents = currentStateMap(currentStates);
  const seq = readSeq(currentStates) + 1;
  const probabilitiesObject = probabilities && typeof probabilities === 'object' ? probabilities : {};
  const warnings = [];

  // Step 1: kill switch pass-through — nothing is decided, nothing changes.
  if (hardRules && hardRules.passThrough === true) {
    const states = {};
    for (const id of sortedIds) {
      const current = currents.get(id);
      states[id] = {
        state: current && typeof current.state === 'string' ? current.state : STATE_OFF,
        reason: current && typeof current.reason === 'string' ? current.reason : 'pass-through',
        lastProbability: current && isFiniteNumber(current.lastProbability) ? current.lastProbability : null,
        changedAtSeq: current && isFiniteNumber(current.changedAtSeq) ? current.changedAtSeq : null
      };
    }
    return { states, changes: [], warnings };
  }

  const working = new Map();
  const warningSeen = new Set();
  applyThresholds(sortedIds, byId, probabilitiesObject, currents, working);
  applyDependencyClosure(sortedIds, byId, working, warnings, warningSeen);
  applyConflicts(sortedIds, byId, working, probabilitiesObject);
  applyHardRules(byId, working, hardRules);
  applyPostOverrideReconciliation(sortedIds, byId, working, warnings, warningSeen);

  const states = {};
  const changes = [];
  for (const id of sortedIds) {
    const current = currents.get(id);
    const from = current && typeof current.state === 'string' ? current.state : STATE_OFF;
    const entry = working.get(id);
    const to = entry.state;
    const changed = to !== from;
    states[id] = {
      state: to,
      reason: entry.reason,
      lastProbability: entry.lastProbability,
      changedAtSeq: changed ? seq : current && isFiniteNumber(current.changedAtSeq) ? current.changedAtSeq : null
    };
    if (changed) changes.push({ id, from, to });
  }
  return { states, changes, warnings };
}

module.exports = {
  DEFAULT_ACTIVATION_THRESHOLD,
  DEFAULT_DEACTIVATION_THRESHOLD,
  decide
};
