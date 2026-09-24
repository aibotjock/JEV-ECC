'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { decide, DEFAULT_ACTIVATION_THRESHOLD, DEFAULT_DEACTIVATION_THRESHOLD } = require('../../../scripts/lib/jev-switchboard/controller');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

function cap(overrides) {
  return Object.assign({ id: 'skill:test', type: 'skill', name: 'test', description: '', dependencies: [], conflicts: [], available: true }, overrides);
}

console.log('\nJEV switchboard controller (decide)');

if (test('activates exactly at the activation threshold (p === threshold => ON)', () => {
  const result = decide({
    registry: { entries: [cap({ id: 'skill:edge-on' })] },
    probabilities: { 'skill:edge-on': DEFAULT_ACTIVATION_THRESHOLD },
    currentStates: { meta: { seq: 10 }, states: {} },
    hardRules: { locked: [], forcedOff: [], passThrough: false }
  });
  assert.deepStrictEqual(result.states['skill:edge-on'], {
    state: 'ON',
    reason: 'threshold:on',
    lastProbability: DEFAULT_ACTIVATION_THRESHOLD,
    changedAtSeq: 11
  });
  assert.deepStrictEqual(result.changes, [{ id: 'skill:edge-on', from: 'OFF', to: 'ON' }]);
})) passed++;
else failed++;

if (test('deactivates exactly at the deactivation threshold (p === threshold => OFF)', () => {
  const result = decide({
    registry: { entries: [cap({ id: 'skill:edge-off' })] },
    probabilities: { 'skill:edge-off': DEFAULT_DEACTIVATION_THRESHOLD },
    currentStates: { meta: { seq: 10 }, states: {} },
    hardRules: { locked: [], forcedOff: [], passThrough: false }
  });
  assert.deepStrictEqual(result.states['skill:edge-off'], {
    state: 'OFF',
    reason: 'threshold:off',
    lastProbability: DEFAULT_DEACTIVATION_THRESHOLD,
    changedAtSeq: null
  });
  assert.deepStrictEqual(result.changes, []);
})) passed++;
else failed++;

if (test('keeps current state inside the hysteresis band (KEEP band)', () => {
  const result = decide({
    registry: { entries: [cap({ id: 'skill:hot' }), cap({ id: 'skill:cold' })] },
    probabilities: { 'skill:hot': 0.5, 'skill:cold': 0.5 },
    currentStates: {
      meta: { seq: 3 },
      states: {
        'skill:hot': { state: 'ON', reason: 'threshold:on', lastProbability: 0.9, changedAtSeq: 2 },
        'skill:cold': { state: 'OFF', reason: 'threshold:off', lastProbability: 0.2, changedAtSeq: 1 }
      }
    },
    hardRules: { locked: [], forcedOff: [], passThrough: false }
  });
  assert.deepStrictEqual(result.states['skill:hot'], {
    state: 'ON',
    reason: 'keep:hysteresis-band',
    lastProbability: 0.5,
    changedAtSeq: 2
  });
  assert.deepStrictEqual(result.states['skill:cold'], {
    state: 'OFF',
    reason: 'keep:hysteresis-band',
    lastProbability: 0.5,
    changedAtSeq: 1
  });
  assert.deepStrictEqual(result.changes, []);
})) passed++;
else failed++;

if (test('absent probability keeps current state (missing current defaults to OFF)', () => {
  const result = decide({
    registry: { entries: [cap({ id: 'skill:keep-on' }), cap({ id: 'skill:keep-missing' })] },
    probabilities: {},
    currentStates: {
      meta: { seq: 0 },
      states: { 'skill:keep-on': { state: 'ON', reason: 'threshold:on', lastProbability: 0.9, changedAtSeq: 0 } }
    },
    hardRules: { locked: [], forcedOff: [], passThrough: false }
  });
  assert.deepStrictEqual(result.states['skill:keep-on'], {
    state: 'ON',
    reason: 'keep:no-probability',
    lastProbability: 0.9,
    changedAtSeq: 0
  });
  assert.deepStrictEqual(result.states['skill:keep-missing'], {
    state: 'OFF',
    reason: 'keep:no-probability',
    lastProbability: null,
    changedAtSeq: null
  });
  assert.deepStrictEqual(result.changes, []);
})) passed++;
else failed++;

if (test('is bit-for-bit deterministic on a fixed random-ish input (repeated runs deep-equal)', () => {
  const buildInput = () => ({
    registry: {
      entries: [
        cap({ id: 'skill:alpha' }),
        cap({ id: 'skill:bravo', dependencies: ['skill:delta'] }),
        cap({ id: 'skill:charlie', conflicts: ['skill:delta'], activationThreshold: 0.9 }),
        cap({ id: 'skill:delta', conflicts: ['skill:charlie'] }),
        cap({ id: 'skill:echo', dependencies: ['skill:bravo'] }),
        cap({ id: 'skill:foxtrot' })
      ]
    },
    probabilities: { 'skill:alpha': 0.73, 'skill:bravo': 0.42, 'skill:charlie': 0.95, 'skill:delta': 0.88, 'skill:echo': 0.77, 'skill:foxtrot': 0.03 },
    currentStates: {
      meta: { seq: 7 },
      states: {
        'skill:bravo': { state: 'ON', reason: 'threshold:on', lastProbability: 0.71, changedAtSeq: 4 },
        'skill:echo': { state: 'OFF', reason: 'threshold:off', lastProbability: 0.05, changedAtSeq: 3 },
        'skill:foxtrot': { state: 'LOCKED', reason: 'hard-rule:lock:security-policy', lastProbability: 0.66, changedAtSeq: 2 }
      }
    },
    hardRules: { locked: [], forcedOff: [], passThrough: false }
  });
  const first = decide(buildInput());
  const second = decide(buildInput());
  const third = decide(JSON.parse(JSON.stringify(buildInput())));
  assert.deepStrictEqual(first, second);
  assert.deepStrictEqual(first, third);
  // The conflict pair resolves and the LOCKED entry survives p=0.03.
  assert.strictEqual(first.states['skill:delta'].state, 'OFF');
  assert.strictEqual(first.states['skill:delta'].reason, 'conflict-with:skill:charlie');
  assert.strictEqual(first.states['skill:foxtrot'].state, 'LOCKED');
})) passed++;
else failed++;

if (test('closes a dependency chain A -> B -> C to ON', () => {
  const result = decide({
    registry: { entries: [cap({ id: 'skill:a', dependencies: ['skill:b'] }), cap({ id: 'skill:b', dependencies: ['skill:c'] }), cap({ id: 'skill:c' })] },
    probabilities: { 'skill:a': 0.9 },
    currentStates: { meta: { seq: 0 }, states: {} },
    hardRules: { locked: [], forcedOff: [], passThrough: false }
  });
  assert.deepStrictEqual(result.states['skill:a'], { state: 'ON', reason: 'threshold:on', lastProbability: 0.9, changedAtSeq: 1 });
  assert.deepStrictEqual(result.states['skill:b'], { state: 'ON', reason: 'dependency-of:skill:a', lastProbability: null, changedAtSeq: 1 });
  assert.deepStrictEqual(result.states['skill:c'], { state: 'ON', reason: 'dependency-of:skill:b', lastProbability: null, changedAtSeq: 1 });
  assert.deepStrictEqual(result.changes, [
    { id: 'skill:a', from: 'OFF', to: 'ON' },
    { id: 'skill:b', from: 'OFF', to: 'ON' },
    { id: 'skill:c', from: 'OFF', to: 'ON' }
  ]);
})) passed++;
else failed++;

if (test('survives a dependency cycle, collecting a warning instead of looping', () => {
  const result = decide({
    registry: { entries: [cap({ id: 'skill:cyc-a', dependencies: ['skill:cyc-b'] }), cap({ id: 'skill:cyc-b', dependencies: ['skill:cyc-a'] }), cap({ id: 'skill:solo' })] },
    probabilities: { 'skill:cyc-a': 0.9 },
    currentStates: { meta: { seq: 5 }, states: {} },
    hardRules: { locked: [], forcedOff: [], passThrough: false }
  });
  assert.strictEqual(result.states['skill:cyc-a'].state, 'ON');
  assert.strictEqual(result.states['skill:cyc-b'].state, 'ON');
  assert.strictEqual(result.states['skill:cyc-b'].reason, 'dependency-of:skill:cyc-a');
  assert.strictEqual(result.states['skill:solo'].state, 'OFF');
  assert.ok(result.warnings.includes('dependency-cycle:skill:cyc-a->skill:cyc-b->skill:cyc-a'), `expected cycle warning, got: ${JSON.stringify(result.warnings)}`);
  assert.deepStrictEqual(result.changes, [
    { id: 'skill:cyc-a', from: 'OFF', to: 'ON' },
    { id: 'skill:cyc-b', from: 'OFF', to: 'ON' }
  ]);
})) passed++;
else failed++;

if (test('resolves a mutual conflict by keeping the higher probability', () => {
  const result = decide({
    registry: { entries: [cap({ id: 'skill:heavy', conflicts: ['skill:light'] }), cap({ id: 'skill:light', conflicts: ['skill:heavy'] })] },
    probabilities: { 'skill:heavy': 0.9, 'skill:light': 0.8 },
    currentStates: { meta: { seq: 0 }, states: {} },
    hardRules: { locked: [], forcedOff: [], passThrough: false }
  });
  assert.strictEqual(result.states['skill:heavy'].state, 'ON');
  assert.deepStrictEqual(result.states['skill:light'], { state: 'OFF', reason: 'conflict-with:skill:heavy', lastProbability: 0.8, changedAtSeq: null });
  // light's OFF is net OFF->OFF: no spurious change entry.
  assert.deepStrictEqual(result.changes, [{ id: 'skill:heavy', from: 'OFF', to: 'ON' }]);
})) passed++;
else failed++;

if (test('breaks a conflict tie with the lexicographically smaller id', () => {
  const result = decide({
    registry: { entries: [cap({ id: 'skill:bbb', conflicts: ['skill:aaa'] }), cap({ id: 'skill:aaa', conflicts: ['skill:bbb'] })] },
    probabilities: { 'skill:aaa': 0.9, 'skill:bbb': 0.9 },
    currentStates: { meta: { seq: 0 }, states: {} },
    hardRules: { locked: [], forcedOff: [], passThrough: false }
  });
  assert.strictEqual(result.states['skill:aaa'].state, 'ON');
  assert.strictEqual(result.states['skill:bbb'].state, 'OFF');
  assert.strictEqual(result.states['skill:bbb'].reason, 'conflict-with:skill:aaa');
})) passed++;
else failed++;

if (test('does not fire on a one-directional conflict listing', () => {
  const result = decide({
    registry: { entries: [cap({ id: 'skill:aggro', conflicts: ['skill:passive'] }), cap({ id: 'skill:passive' })] },
    probabilities: { 'skill:aggro': 0.9, 'skill:passive': 0.9 },
    currentStates: { meta: { seq: 0 }, states: {} },
    hardRules: { locked: [], forcedOff: [], passThrough: false }
  });
  assert.strictEqual(result.states['skill:aggro'].state, 'ON');
  assert.strictEqual(result.states['skill:passive'].state, 'ON');
})) passed++;
else failed++;

if (test('keeps a LOCKED capability locked even with p = 0', () => {
  const result = decide({
    registry: { entries: [cap({ id: 'skill:guarded' })] },
    probabilities: { 'skill:guarded': 0 },
    currentStates: {
      meta: { seq: 9 },
      states: { 'skill:guarded': { state: 'LOCKED', reason: 'hard-rule:lock:explicit-request', lastProbability: 0.8, changedAtSeq: 4 } }
    },
    hardRules: { locked: [], forcedOff: [], passThrough: false }
  });
  assert.deepStrictEqual(result.states['skill:guarded'], {
    state: 'LOCKED',
    reason: 'hard-rule:lock:explicit-request',
    lastProbability: 0,
    changedAtSeq: 4
  });
  assert.deepStrictEqual(result.changes, []);
})) passed++;
else failed++;

if (test('applies hard rules last, overriding thresholds and dependency closure', () => {
  const result = decide({
    registry: { entries: [cap({ id: 'skill:req' }), cap({ id: 'skill:broken' }), cap({ id: 'skill:dep-winner', dependencies: ['skill:dep-loser'] }), cap({ id: 'skill:dep-loser' })] },
    probabilities: { 'skill:req': 0.01, 'skill:broken': 0.99, 'skill:dep-winner': 0.99, 'skill:dep-loser': 0.01 },
    currentStates: { meta: { seq: 20 }, states: { 'skill:broken': { state: 'ON', reason: 'threshold:on', lastProbability: 0.95, changedAtSeq: 18 } } },
    hardRules: {
      locked: [{ id: 'skill:req', source: 'explicit-request' }],
      forcedOff: [{ id: 'skill:broken', reason: 'unavailable' }, { id: 'skill:dep-loser', reason: 'unavailable' }],
      passThrough: false
    }
  });
  // Lock beats a threshold-OFF decision.
  assert.deepStrictEqual(result.states['skill:req'], { state: 'LOCKED', reason: 'hard-rule:lock:explicit-request', lastProbability: 0.01, changedAtSeq: 21 });
  // forcedOff beats a threshold-ON decision.
  assert.deepStrictEqual(result.states['skill:broken'], { state: 'OFF', reason: 'hard-rule:unavailable', lastProbability: 0.99, changedAtSeq: 21 });
  // forcedOff beats a dependency closure that turned the entry ON mid-pipeline (net OFF->OFF).
  assert.deepStrictEqual(result.states['skill:dep-loser'], { state: 'OFF', reason: 'hard-rule:unavailable', lastProbability: 0.01, changedAtSeq: null });
  assert.strictEqual(result.states['skill:dep-winner'].state, 'ON');
  assert.deepStrictEqual(result.changes, [
    { id: 'skill:broken', from: 'ON', to: 'OFF' },
    { id: 'skill:dep-winner', from: 'OFF', to: 'ON' },
    { id: 'skill:req', from: 'OFF', to: 'LOCKED' }
  ]);
})) passed++;
else failed++;

if (test('hard-rule forcedOff overrides even a current LOCKED state', () => {
  const result = decide({
    registry: { entries: [cap({ id: 'skill:was-locked' })] },
    probabilities: { 'skill:was-locked': 0.99 },
    currentStates: {
      meta: { seq: 2 },
      states: { 'skill:was-locked': { state: 'LOCKED', reason: 'hard-rule:lock:explicit-request', lastProbability: 0.9, changedAtSeq: 1 } }
    },
    hardRules: { locked: [], forcedOff: [{ id: 'skill:was-locked', reason: 'unavailable' }], passThrough: false }
  });
  assert.deepStrictEqual(result.states['skill:was-locked'], { state: 'OFF', reason: 'hard-rule:unavailable', lastProbability: 0.99, changedAtSeq: 3 });
  assert.deepStrictEqual(result.changes, [{ id: 'skill:was-locked', from: 'LOCKED', to: 'OFF' }]);
})) passed++;
else failed++;

if (test('reports changes only for capabilities that actually moved', () => {
  const result = decide({
    registry: { entries: [cap({ id: 'skill:dropper' }), cap({ id: 'skill:keeper' }), cap({ id: 'skill:locked-one' }), cap({ id: 'skill:mover' }), cap({ id: 'skill:stayer' })] },
    probabilities: { 'skill:dropper': 0.1, 'skill:keeper': 0.5, 'skill:locked-one': 0.9, 'skill:mover': 0.9, 'skill:stayer': 0.1 },
    currentStates: {
      meta: { seq: 8 },
      states: {
        'skill:dropper': { state: 'ON', reason: 'threshold:on', lastProbability: 0.9, changedAtSeq: 6 },
        'skill:keeper': { state: 'ON', reason: 'threshold:on', lastProbability: 0.9, changedAtSeq: 5 },
        'skill:locked-one': { state: 'LOCKED', reason: 'hard-rule:lock:security-policy', lastProbability: 0.9, changedAtSeq: 4 }
      }
    },
    hardRules: { locked: [], forcedOff: [], passThrough: false }
  });
  assert.deepStrictEqual(result.changes, [
    { id: 'skill:dropper', from: 'ON', to: 'OFF' },
    { id: 'skill:mover', from: 'OFF', to: 'ON' }
  ]);
  assert.strictEqual(result.states['skill:keeper'].state, 'ON');
  assert.strictEqual(result.states['skill:locked-one'].state, 'LOCKED');
  assert.strictEqual(result.states['skill:stayer'].state, 'OFF');
})) passed++;
else failed++;

if (test('increments seq for moved states and preserves changedAtSeq for kept ones', () => {
  const result = decide({
    registry: { entries: [cap({ id: 'skill:flip' }), cap({ id: 'skill:hold' })] },
    probabilities: { 'skill:flip': 0.9, 'skill:hold': 0.2 },
    currentStates: {
      meta: { seq: 41 },
      states: {
        'skill:flip': { state: 'OFF', reason: 'threshold:off', lastProbability: 0.1, changedAtSeq: 5 },
        'skill:hold': { state: 'OFF', reason: 'threshold:off', lastProbability: 0.1, changedAtSeq: 9 }
      }
    },
    hardRules: { locked: [], forcedOff: [], passThrough: false }
  });
  assert.strictEqual(result.states['skill:flip'].changedAtSeq, 42);
  assert.strictEqual(result.states['skill:hold'].changedAtSeq, 9);
  // Missing meta.seq starts from 0, so the first change lands on seq 1.
  const fresh = decide({
    registry: { entries: [cap({ id: 'skill:first' })] },
    probabilities: { 'skill:first': 0.9 },
    currentStates: { states: {} },
    hardRules: { locked: [], forcedOff: [], passThrough: false }
  });
  assert.strictEqual(fresh.states['skill:first'].changedAtSeq, 1);
})) passed++;
else failed++;

if (test('pass-through leaves every state unchanged', () => {
  const result = decide({
    registry: { entries: [cap({ id: 'skill:a' }), cap({ id: 'skill:b' })] },
    probabilities: { 'skill:a': 0.01 },
    currentStates: {
      meta: { seq: 12 },
      states: { 'skill:a': { state: 'ON', reason: 'threshold:on', lastProbability: 0.9, changedAtSeq: 2 } }
    },
    hardRules: { locked: [], forcedOff: [], passThrough: true }
  });
  assert.deepStrictEqual(result.states['skill:a'], { state: 'ON', reason: 'threshold:on', lastProbability: 0.9, changedAtSeq: 2 });
  assert.deepStrictEqual(result.states['skill:b'], { state: 'OFF', reason: 'pass-through', lastProbability: null, changedAtSeq: null });
  assert.deepStrictEqual(result.changes, []);
})) passed++;
else failed++;

if (test('ignores probability ids that are not in the registry', () => {
  const result = decide({
    registry: { entries: [cap({ id: 'skill:known' })] },
    probabilities: { 'skill:ghost': 0.99, 'skill:known': 0.5 },
    currentStates: { meta: { seq: 0 }, states: {} },
    hardRules: { locked: [], forcedOff: [], passThrough: false }
  });
  assert.deepStrictEqual(Object.keys(result.states), ['skill:known']);
  assert.strictEqual(result.states['skill:known'].state, 'OFF');
  assert.strictEqual(result.states['skill:known'].reason, 'keep:hysteresis-band');
})) passed++;
else failed++;

if (test('reads currentStates from a state-file fixture on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-jev-controller-'));
  try {
    const fixturePath = path.join(dir, 'state-session.json');
    fs.writeFileSync(
      fixturePath,
      JSON.stringify({
        meta: { seq: 99 },
        states: { 'skill:disk': { state: 'OFF', reason: 'threshold:off', lastProbability: 0.1, changedAtSeq: 90 } }
      }),
      'utf8'
    );
    const currentStates = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const result = decide({
      registry: { entries: [cap({ id: 'skill:disk' })] },
      probabilities: { 'skill:disk': 0.99 },
      currentStates,
      hardRules: { locked: [], forcedOff: [], passThrough: false }
    });
    assert.deepStrictEqual(result.states['skill:disk'], { state: 'ON', reason: 'threshold:on', lastProbability: 0.99, changedAtSeq: 100 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})) passed++;
else failed++;

if (test('demotes a dependency-activated capability when its activator is forced OFF in a later decide() call', () => {
  const registry = { entries: [cap({ id: 'skill:a', dependencies: ['skill:b'] }), cap({ id: 'skill:b' })] };
  const first = decide({
    registry,
    probabilities: { 'skill:a': 0.9 },
    currentStates: { meta: { seq: 0 }, states: {} },
    hardRules: { locked: [], forcedOff: [], passThrough: false }
  });
  assert.strictEqual(first.states['skill:a'].state, 'ON');
  assert.strictEqual(first.states['skill:b'].state, 'ON');
  assert.strictEqual(first.states['skill:b'].reason, 'dependency-of:skill:a');

  const second = decide({
    registry,
    probabilities: {},
    currentStates: { meta: { seq: 1 }, states: first.states },
    hardRules: { locked: [], forcedOff: [{ id: 'skill:a', reason: 'unavailable' }], passThrough: false }
  });
  assert.deepStrictEqual(second.states['skill:a'], { state: 'OFF', reason: 'hard-rule:unavailable', lastProbability: 0.9, changedAtSeq: 2 });
  assert.deepStrictEqual(second.states['skill:b'], { state: 'OFF', reason: 'dependency-demoted', lastProbability: null, changedAtSeq: 2 });
  assert.deepStrictEqual(second.changes, [
    { id: 'skill:a', from: 'ON', to: 'OFF' },
    { id: 'skill:b', from: 'ON', to: 'OFF' }
  ]);
  assert.deepStrictEqual(second.warnings, [], 'a demoted dependency is not also a broken-dependency warning');
})) passed++;
else failed++;

if (test('demotes the whole chain A -> B -> C when A is forced OFF by a hard rule', () => {
  const result = decide({
    registry: { entries: [cap({ id: 'skill:a', dependencies: ['skill:b'] }), cap({ id: 'skill:b', dependencies: ['skill:c'] }), cap({ id: 'skill:c' })] },
    probabilities: { 'skill:a': 0.9 },
    currentStates: { meta: { seq: 0 }, states: {} },
    hardRules: { locked: [], forcedOff: [{ id: 'skill:a', reason: 'unavailable' }], passThrough: false }
  });
  assert.strictEqual(result.states['skill:a'].state, 'OFF');
  assert.strictEqual(result.states['skill:a'].reason, 'hard-rule:unavailable');
  assert.deepStrictEqual(result.states['skill:b'], { state: 'OFF', reason: 'dependency-demoted', lastProbability: null, changedAtSeq: null });
  assert.deepStrictEqual(result.states['skill:c'], { state: 'OFF', reason: 'dependency-demoted', lastProbability: null, changedAtSeq: null });
  assert.deepStrictEqual(result.changes, [], 'everything nets out OFF -> OFF: no spurious change entries');
})) passed++;
else failed++;

if (test('keeps an ON dependent running but warns when a hard rule forces its dependency OFF', () => {
  const result = decide({
    registry: { entries: [cap({ id: 'skill:dependent', dependencies: ['skill:library'] }), cap({ id: 'skill:library' })] },
    probabilities: { 'skill:dependent': 0.9 },
    currentStates: { meta: { seq: 0 }, states: {} },
    hardRules: { locked: [], forcedOff: [{ id: 'skill:library', reason: 'unavailable' }], passThrough: false }
  });
  assert.strictEqual(result.states['skill:dependent'].state, 'ON', 'v1 policy: warn only, the dependent stays ON');
  assert.strictEqual(result.states['skill:dependent'].reason, 'threshold:on');
  assert.strictEqual(result.states['skill:library'].state, 'OFF', 'hard rules win: the dependency stays forced off');
  assert.strictEqual(result.states['skill:library'].reason, 'hard-rule:unavailable');
  assert.deepStrictEqual(result.warnings, [{ type: 'broken-dependency', id: 'skill:dependent', dependency: 'skill:library' }]);
})) passed++;
else failed++;

console.log(`Results: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
