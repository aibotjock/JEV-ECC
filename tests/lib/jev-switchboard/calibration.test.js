'use strict';

const assert = require('node:assert');
const {
  DEFAULT_ACTIVATION_THRESHOLD,
  DEFAULT_DEACTIVATION_THRESHOLD,
  SAMPLE_SIZE_WARNING_MIN_EVENTS,
  SAMPLE_SIZE_WARNING_TEXT,
  summarizeCalibration
} = require('../../../scripts/lib/jev-switchboard/calibration');

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

function eventRow(overrides = {}) {
  return {
    event: 'user-prompt',
    sessionKey: 's1',
    probabilities: {},
    decisions: [],
    latencyMs: 42,
    model: 'jev-1.13.0',
    ...overrides
  };
}

function capabilityById(summary, id) {
  const found = summary.capabilities.find(entry => entry.id === id);
  assert.ok(found, `expected a summary row for ${id}`);
  return found;
}

console.log('\nJEV switchboard calibration');

if (
  test('empty rows: zero counts, no capabilities, no recommendations, warning fires', () => {
    const summary = summarizeCalibration([]);
    assert.strictEqual(summary.events, 0);
    assert.strictEqual(summary.evalErrors, 0);
    assert.strictEqual(summary.rowsConsidered, 0);
    assert.deepStrictEqual(summary.capabilities, []);
    assert.deepStrictEqual(summary.recommendations, []);
    assert.strictEqual(summary.sampleSizeWarning, true);
    assert.strictEqual(summarizeCalibration().events, 0, 'missing rows argument tolerated');
  })
) passed++;
else failed++;

if (
  test('single event row: one capability with samples/meanP/minP/maxP', () => {
    const summary = summarizeCalibration([eventRow({ probabilities: { 'skill:alpha': 0.4, 'skill:beta': 0.9 } })]);
    assert.strictEqual(summary.events, 1);
    assert.strictEqual(summary.evalErrors, 0);
    assert.strictEqual(summary.rowsConsidered, 1);
    assert.strictEqual(summary.capabilities.length, 2);
    assert.strictEqual(summary.sampleSizeWarning, true, 'one event is far below the act-on floor');
    const alpha = capabilityById(summary, 'skill:alpha');
    assert.deepStrictEqual(
      { samples: alpha.samples, meanP: alpha.meanP, minP: alpha.minP, maxP: alpha.maxP, bandCount: alpha.bandCount },
      { samples: 1, meanP: 0.4, minP: 0.4, maxP: 0.4, bandCount: 1 }
    );
    const beta = capabilityById(summary, 'skill:beta');
    assert.strictEqual(beta.bandCount, 0, '0.9 is above the activation threshold, not in the band');
  })
) passed++;
else failed++;

if (
  test('band occupancy is strictly between the thresholds', () => {
    const rows = [
      eventRow({ probabilities: { a: 0.35, b: 0.36, c: 0.64, d: 0.65 } }), // a: at deactivation, d: at activation
      eventRow({ probabilities: { a: 0.35, b: 0.36, c: 0.64, d: 0.65 } })
    ];
    const summary = summarizeCalibration(rows);
    assert.strictEqual(capabilityById(summary, 'a').bandCount, 0, 'p === deactivationThreshold is not in the band');
    assert.strictEqual(capabilityById(summary, 'b').bandCount, 2);
    assert.strictEqual(capabilityById(summary, 'c').bandCount, 2);
    assert.strictEqual(capabilityById(summary, 'd').bandCount, 0, 'p === activationThreshold is not in the band');
  })
) passed++;
else failed++;

if (
  test('flips count ON<->OFF transitions; changes into LOCKED are terminal, not flips', () => {
    const rows = [
      eventRow({ decisions: [{ id: 'x', from: 'OFF', to: 'ON' }, { id: 'y', from: 'OFF', to: 'LOCKED' }] }),
      eventRow({ decisions: [{ id: 'x', from: 'ON', to: 'OFF' }] }),
      eventRow({ decisions: [{ id: 'x', from: 'OFF', to: 'ON' }] })
    ];
    const summary = summarizeCalibration(rows);
    const x = capabilityById(summary, 'x');
    const y = capabilityById(summary, 'y');
    assert.strictEqual(x.flips, 3, 'each ON/OFF change row counts exactly once');
    assert.strictEqual(x.onCount, 2);
    assert.strictEqual(x.offCount, 1);
    assert.strictEqual(y.flips, 0, 'OFF -> LOCKED is terminal, not a flip');
    assert.strictEqual(y.lockedCount, 1);
    assert.strictEqual(x.samples, 0, 'decisions without probabilities still produce a row');
    assert.strictEqual(x.meanP, null);
  })
) passed++;
else failed++;

if (
  test('explicitLocks counts decision reasons matching explicit-request / hard-rule:lock only', () => {
    const rows = [
      eventRow({
        decisions: [
          { id: 'x', from: 'OFF', to: 'LOCKED', reason: 'hard-rule:lock:explicit-request' },
          { id: 'y', from: 'OFF', to: 'LOCKED', reason: 'hard-rule:lock:security-policy' },
          { id: 'z', from: 'OFF', to: 'ON', reason: 'threshold:on' },
          { id: 'w', from: 'OFF', to: 'ON' }
        ]
      })
    ];
    const summary = summarizeCalibration(rows);
    assert.strictEqual(capabilityById(summary, 'x').explicitLocks, 1);
    assert.strictEqual(capabilityById(summary, 'y').explicitLocks, 1, 'any hard-rule:lock source counts');
    assert.strictEqual(capabilityById(summary, 'z').explicitLocks, 0);
    assert.strictEqual(capabilityById(summary, 'w').explicitLocks, 0, 'missing reason is not an explicit lock');
  })
) passed++;
else failed++;

if (
  test('flip recommendation fires at >= 3 flips and stays quiet below', () => {
    const twoFlips = summarizeCalibration([
      eventRow({ decisions: [{ id: 'x', from: 'OFF', to: 'ON' }] }),
      eventRow({ decisions: [{ id: 'x', from: 'ON', to: 'OFF' }] })
    ]);
    assert.deepStrictEqual(twoFlips.recommendations, []);

    const threeFlips = summarizeCalibration([
      eventRow({ decisions: [{ id: 'x', from: 'OFF', to: 'ON' }] }),
      eventRow({ decisions: [{ id: 'x', from: 'ON', to: 'OFF' }] }),
      eventRow({ decisions: [{ id: 'x', from: 'OFF', to: 'ON' }] })
    ]);
    assert.deepStrictEqual(threeFlips.recommendations, ['widen hysteresis band for x (3 flips)']);
  })
) passed++;
else failed++;

if (
  test('threshold recommendation requires mean inside the band AND >= 5 samples', () => {
    const row = p => eventRow({ probabilities: { x: p } });
    const few = summarizeCalibration([row(0.4), row(0.4), row(0.4), row(0.4)]);
    assert.deepStrictEqual(few.recommendations, [], '4 samples is below the advice floor');

    const enough = summarizeCalibration([row(0.4), row(0.4), row(0.4), row(0.4), row(0.4)]);
    assert.deepStrictEqual(enough.recommendations, ['review activation threshold for x (mean P=0.40 sits in the hysteresis band)']);

    const hot = summarizeCalibration([row(0.9), row(0.9), row(0.9), row(0.9), row(0.9)]);
    assert.deepStrictEqual(hot.recommendations, [], 'mean above the activation threshold does not fire');
  })
) passed++;
else failed++;

if (
  test('weak-trigger recommendation fires at >= 2 explicit locks with >= 5 samples', () => {
    const lock = (row, id) => eventRow({ probabilities: { [id]: 0.9 }, decisions: [{ id, from: 'OFF', to: 'LOCKED', reason: 'hard-rule:lock:explicit-request' }], ...row });
    const oneLock = summarizeCalibration([
      lock({}, 'x'),
      eventRow({ probabilities: { x: 0.9 } }),
      eventRow({ probabilities: { x: 0.9 } }),
      eventRow({ probabilities: { x: 0.9 } }),
      eventRow({ probabilities: { x: 0.9 } })
    ]);
    assert.deepStrictEqual(oneLock.recommendations, [], 'a single explicit lock is not a trigger problem');

    const twoLocks = summarizeCalibration([lock({}, 'x'), lock({}, 'x'), eventRow({ probabilities: { x: 0.9 } }), eventRow({ probabilities: { x: 0.9 } }), eventRow({ probabilities: { x: 0.9 } })]);
    assert.deepStrictEqual(twoLocks.recommendations, ['triggers for x may be too weak (locked on by explicit request 2 times)']);

    const fewSamples = summarizeCalibration([lock({}, 'x'), lock({}, 'x'), eventRow({ probabilities: { x: 0.9 } })]);
    assert.deepStrictEqual(fewSamples.recommendations, [], '2 explicit locks with only 3 samples stay quiet');
  })
) passed++;
else failed++;

if (
  test('sampleSizeWarning flips at the 10-event boundary', () => {
    const nine = summarizeCalibration(Array.from({ length: SAMPLE_SIZE_WARNING_MIN_EVENTS - 1 }, () => eventRow()));
    assert.strictEqual(nine.sampleSizeWarning, true);
    const ten = summarizeCalibration(Array.from({ length: SAMPLE_SIZE_WARNING_MIN_EVENTS }, () => eventRow()));
    assert.strictEqual(ten.sampleSizeWarning, false);
    assert.match(SAMPLE_SIZE_WARNING_TEXT, /sample size too small to act on/);
  })
) passed++;
else failed++;

if (
  test('eval-error rows count as errors, not events; foreign rows are ignored', () => {
    const summary = summarizeCalibration([
      eventRow(),
      { event: 'eval-error', sessionKey: 's1', errorClass: 'JevUnavailableError', message: 'gave up' },
      { event: 'eval-error', sessionKey: 's1', errorClass: 'JevUnavailableError', message: 'gave up again' },
      { event: 'something-else', probabilities: { x: 0.9 } },
      'not even a row',
      null
    ]);
    assert.strictEqual(summary.events, 1);
    assert.strictEqual(summary.evalErrors, 2);
    assert.strictEqual(summary.rowsConsidered, 3, 'foreign rows never skew the considered count');
    assert.strictEqual(summary.capabilities.length, 0, 'the foreign row probabilities are ignored');
  })
) passed++;
else failed++;

if (
  test('non-finite probabilities are skipped; malformed decisions are ignored', () => {
    const summary = summarizeCalibration([
      eventRow({ probabilities: { x: 0.5, y: 'high', z: Number.NaN } }),
      eventRow({ decisions: [{ from: 'OFF', to: 'ON' }, 'garbage', { id: 'ok', from: 'OFF', to: 'ON' }] })
    ]);
    const x = capabilityById(summary, 'x');
    assert.strictEqual(x.samples, 1);
    assert.ok(!summary.capabilities.some(entry => entry.id === 'y'), 'string probability creates no row');
    assert.ok(!summary.capabilities.some(entry => entry.id === 'z'), 'NaN probability creates no row');
    assert.strictEqual(capabilityById(summary, 'ok').onCount, 1);
  })
) passed++;
else failed++;

if (
  test('custom thresholds reshape the band and the advice', () => {
    const rows = Array.from({ length: 5 }, () => eventRow({ probabilities: { x: 0.3 } }));
    const defaults = summarizeCalibration(rows);
    assert.strictEqual(capabilityById(defaults, 'x').bandCount, 0, '0.3 is at/below the default deactivation threshold');
    const lowered = summarizeCalibration(rows, { activationThreshold: 0.65, deactivationThreshold: 0.2 });
    assert.strictEqual(capabilityById(lowered, 'x').bandCount, 5);
    assert.deepStrictEqual(lowered.recommendations, ['review activation threshold for x (mean P=0.30 sits in the hysteresis band)']);
    assert.strictEqual(DEFAULT_ACTIVATION_THRESHOLD, 0.65);
    assert.strictEqual(DEFAULT_DEACTIVATION_THRESHOLD, 0.35);
  })
) passed++;
else failed++;

if (
  test('output is deterministic and capabilities are sorted by id', () => {
    const rows = [
      eventRow({ probabilities: { c: 0.5, a: 1.0, b: 0.1 } }),
      eventRow({ probabilities: { a: 0.5, b: 0.2 } })
    ];
    const first = summarizeCalibration(rows);
    const second = summarizeCalibration([...rows]);
    assert.deepStrictEqual(first, second);
    assert.deepStrictEqual(
      first.capabilities.map(entry => entry.id),
      ['a', 'b', 'c']
    );
    const a = capabilityById(first, 'a');
    assert.strictEqual(a.meanP, 0.75);
    assert.strictEqual(a.minP, 0.5);
    assert.strictEqual(a.maxP, 1);
  })
) passed++;
else failed++;

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
