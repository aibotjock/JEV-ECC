'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const stateStore = require('../../../scripts/lib/jev-switchboard/state');

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

function makeFixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-jev-state-'));
}

function makeConfig(dir) {
  return {
    enabled: true,
    apiKey: 'test-key',
    stateDir: dir,
    telemetryPath: path.join(dir, 'telemetry.jsonl'),
    registryPath: path.join(dir, 'jev-registry.json')
  };
}

function captureStderr(fn) {
  const original = process.stderr.write;
  const chunks = [];
  process.stderr.write = chunk => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    return { result: fn(), output: chunks.join('') };
  } finally {
    process.stderr.write = original;
  }
}

function controllerStates() {
  return {
    'skill:alpha': { state: 'ON', reason: 'threshold:on', lastProbability: 0.9, changedAtSeq: 1 },
    'skill:beta': { state: 'OFF', reason: 'threshold:off', lastProbability: 0.1, changedAtSeq: 1 },
    'mcp:github': { state: 'LOCKED', reason: 'hard-rule:lock:explicit-request', lastProbability: null, changedAtSeq: 1 }
  };
}

console.log('\nJEV switchboard state store');

if (
  test('writeState/readState roundtrip preserves the full document shape', () => {
    const dir = makeFixture();
    const config = makeConfig(dir);
    const written = stateStore.writeState({ config, sessionKey: 'sess1', states: controllerStates(), meta: { seq: 7, event: 'user-prompt', objective: 'review the code' } });
    assert.strictEqual(written.seq, 7);
    assert.strictEqual(written.event, 'user-prompt');
    assert.strictEqual(written.objective, 'review the code');
    const read = stateStore.readState({ config, sessionKey: 'sess1' });
    assert.deepStrictEqual(read, written);
    assert.strictEqual(read.states['skill:alpha'].state, 'ON');
    assert.strictEqual(read.states['skill:beta'].lastEvent, 'user-prompt');
    assert.strictEqual(read.states['mcp:github'].changedAtSeq, 1);
  })
) passed++;
else failed++;

if (
  test('state file lands at <stateDir>/state-<sessionKey>.json with 0600 perms', () => {
    const dir = makeFixture();
    const config = makeConfig(dir);
    stateStore.writeState({ config, sessionKey: 'abc', states: controllerStates(), meta: { seq: 1, event: 'stop' } });
    const filePath = path.join(dir, 'state-abc.json');
    assert.ok(fs.existsSync(filePath), 'state file should exist at the documented path');
    const mode = fs.statSync(filePath).mode & 0o777;
    assert.strictEqual(mode, 0o600, `expected 0600 perms, got ${mode.toString(8)}`);
    assert.strictEqual(stateStore.stateFilePath({ config, sessionKey: 'abc' }), filePath);
  })
) passed++;
else failed++;

if (
  test('missing state file reads as null (quiet)', () => {
    const dir = makeFixture();
    const config = makeConfig(dir);
    const { result, output } = captureStderr(() => stateStore.readState({ config, sessionKey: 'ghost' }));
    assert.strictEqual(result, null);
    assert.strictEqual(output, '', 'a missing file is normal operation, not a warning');
  })
) passed++;
else failed++;

if (
  test('corrupt state file reads as null with a collected warning', () => {
    const dir = makeFixture();
    const config = makeConfig(dir);
    fs.writeFileSync(path.join(dir, 'state-bad.json'), '{not json at all');
    const { result, output } = captureStderr(() => stateStore.readState({ config, sessionKey: 'bad' }));
    assert.strictEqual(result, null);
    assert.match(output, /not valid JSON/);
  })
) passed++;
else failed++;

if (
  test('wrong-shaped state file reads as null with a collected warning', () => {
    const dir = makeFixture();
    const config = makeConfig(dir);
    fs.writeFileSync(path.join(dir, 'state-shape.json'), JSON.stringify({ seq: 1, states: [1, 2, 3] }));
    const { result, output } = captureStderr(() => stateStore.readState({ config, sessionKey: 'shape' }));
    assert.strictEqual(result, null);
    assert.match(output, /unexpected shape/);
  })
) passed++;
else failed++;

if (
  test('atomic overwrite: a second write replaces the first completely', () => {
    const dir = makeFixture();
    const config = makeConfig(dir);
    stateStore.writeState({ config, sessionKey: 's', states: controllerStates(), meta: { seq: 1, event: 'user-prompt' } });
    stateStore.writeState({
      config,
      sessionKey: 's',
      states: { 'skill:only': { state: 'OFF', reason: 'threshold:off', lastProbability: 0.2, changedAtSeq: 2 } },
      meta: { seq: 2, event: 'stop' }
    });
    const read = stateStore.readState({ config, sessionKey: 's' });
    assert.deepStrictEqual(Object.keys(read.states), ['skill:only']);
    assert.strictEqual(read.seq, 2);
    assert.strictEqual(read.event, 'stop');
    assert.strictEqual(read.states['skill:only'].changedAtSeq, 2);
    // No temp files left behind by the atomic write.
    const leftovers = fs.readdirSync(dir).filter(name => name.includes('.tmp'));
    assert.deepStrictEqual(leftovers, []);
  })
) passed++;
else failed++;

if (
  test('writeState normalizes invalid entries instead of throwing', () => {
    const dir = makeFixture();
    const config = makeConfig(dir);
    const written = stateStore.writeState({
      config,
      sessionKey: 'norm',
      states: { 'skill:x': { state: 'MAYBE', reason: 42, lastProbability: 'high', changedAtSeq: 'one' } },
      meta: { seq: 'NaN', event: 9 }
    });
    assert.strictEqual(written.states['skill:x'].state, 'OFF');
    assert.strictEqual(written.states['skill:x'].reason, '');
    assert.strictEqual(written.states['skill:x'].lastProbability, null);
    assert.strictEqual(written.states['skill:x'].changedAtSeq, null);
    assert.strictEqual(written.seq, 0);
    assert.strictEqual(written.event, '');
  })
) passed++;
else failed++;

if (
  test('readStatesForGate returns a fast {id -> entry} map or null when absent', () => {
    const dir = makeFixture();
    const config = makeConfig(dir);
    assert.strictEqual(stateStore.readStatesForGate({ config, sessionKey: 'none' }), null);
    stateStore.writeState({ config, sessionKey: 'g', states: controllerStates(), meta: { seq: 3, event: 'user-prompt' } });
    const map = stateStore.readStatesForGate({ config, sessionKey: 'g' });
    assert.deepStrictEqual(Object.keys(map).sort(), ['mcp:github', 'skill:alpha', 'skill:beta']);
    assert.strictEqual(map['skill:beta'].state, 'OFF');
  })
) passed++;
else failed++;

if (
  test('activeCapabilityIds lists ON and LOCKED ids only', () => {
    const dir = makeFixture();
    const config = makeConfig(dir);
    const written = stateStore.writeState({ config, sessionKey: 'a', states: controllerStates(), meta: { seq: 1, event: 'user-prompt' } });
    assert.deepStrictEqual(stateStore.activeCapabilityIds(written).sort(), ['mcp:github', 'skill:alpha']);
    assert.deepStrictEqual(stateStore.activeCapabilityIds(null), []);
  })
) passed++;
else failed++;

if (
  test('resolveSessionKey sanitizes direct ids and hashes the fallbacks', () => {
    const env = {};
    assert.strictEqual(stateStore.resolveSessionKey({ session_id: 'abc-123' }, env), 'abc-123');
    assert.strictEqual(stateStore.resolveSessionKey({ session_id: 'bad/key with spaces' }, env), 'bad_key_with_spaces');
    const hashed = stateStore.resolveSessionKey({ transcript_path: '/tmp/t/xyz.jsonl' }, env);
    assert.match(hashed, /^tx-[0-9a-f]{24}$/);
    const projected = stateStore.resolveSessionKey({}, { CLAUDE_PROJECT_DIR: '/repo' });
    assert.match(projected, /^proj-[0-9a-f]{24}$/);
    assert.strictEqual(stateStore.resolveSessionKey({}, { CLAUDE_SESSION_ID: 'env-sess' }), 'env-sess');
  })
) passed++;
else failed++;

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
