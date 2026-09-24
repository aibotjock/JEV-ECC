'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runEvaluation, lockFilePath, acquireLock, releaseLock, LOCK_STALE_MS } = require('../../../scripts/lib/jev-switchboard/eval-runner');
const { writeState } = require('../../../scripts/lib/jev-switchboard/state');
const { REGISTRY_SCHEMA_VERSION, writeRegistryCache } = require('../../../scripts/lib/jev-switchboard/registry');

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

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

function makeFixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-jev-eval-'));
}

function makeConfig(dir) {
  return {
    enabled: true,
    apiKey: 'test-key',
    baseUrl: 'https://api.typesafe.ai',
    model: 'jev-1.13.0',
    activationThreshold: 0.65,
    deactivationThreshold: 0.35,
    timeoutMs: 2000,
    maxRetries: 0,
    stateDir: dir,
    telemetryPath: path.join(dir, 'telemetry.jsonl'),
    registryPath: path.join(dir, 'jev-registry.json')
  };
}

// Prime the registry cache through the module's own writer so loadRegistry()
// serves it (the cache freshness fingerprint covers the recorded inputs).
function primeRegistryCache(config, capabilities) {
  const fixtureRoot = path.join(config.stateDir, 'fixture-repo');
  fs.mkdirSync(path.join(fixtureRoot, 'skills'), { recursive: true });
  const overlayPath = path.join(fixtureRoot, 'routing.json');
  fs.writeFileSync(overlayPath, JSON.stringify({ version: 1, defaults: {}, capabilities: {}, alwaysLocked: [] }));
  const registry = {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    defaults: { activationThreshold: 0.65, deactivationThreshold: 0.35 },
    alwaysLocked: [],
    capabilities
  };
  writeRegistryCache(registry, { registryPath: config.registryPath, repoRoot: fixtureRoot, overlayPath });
  return registry;
}

function capability(id, type, name) {
  return {
    id,
    type,
    name,
    description: `${name} capability`,
    positiveTriggers: [],
    negativeTriggers: [],
    dependencies: [],
    conflicts: [],
    activationThreshold: 0.65,
    deactivationThreshold: 0.35,
    lockable: true,
    available: true,
    source: 'fixture'
  };
}

function writeRegistryFixture(config) {
  return primeRegistryCache(config, [capability('skill:alpha', 'skill', 'Alpha'), capability('skill:beta', 'skill', 'Beta'), capability('mcp:github', 'mcp', 'github')]);
}

function fakeFetch(answers) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      status: 200,
      text: async () => JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 11, output_tokens: 7 } })
    };
  };
  impl.calls = calls;
  return impl;
}

function readTelemetryRows(telemetryPath) {
  if (!fs.existsSync(telemetryPath)) return [];
  return fs.readFileSync(telemetryPath, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
}

async function runTests() {
  console.log('\nJEV switchboard eval-runner');

  if (
    await asyncTest('happy path: evaluates, writes state, appends telemetry, releases the lock', async () => {
      const dir = makeFixture();
      const config = makeConfig(dir);
      writeRegistryFixture(config);
      const fetchImpl = fakeFetch({ 'skill:alpha': { type: 'noul', noul: 0.9 }, 'skill:beta': { type: 'noul', noul: 0.1 } });

      const result = await runEvaluation({ event: 'user-prompt', prompt: 'review everything carefully', sessionKey: 'sess-happy' }, { config, fetchImpl });

      assert.strictEqual(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
      assert.strictEqual(result.model, 'jev-1.13.0');
      assert.strictEqual(fetchImpl.calls.length, 1, 'exactly one batched Jev call');
      assert.strictEqual(fetchImpl.calls[0].url, 'https://api.typesafe.ai/v1/systemone');
      assert.strictEqual(fetchImpl.calls[0].body.model, 'jev-1.13.0');
      assert.ok(fetchImpl.calls[0].body.state.objective.length > 0);
      assert.ok(fetchImpl.calls[0].body.questions['skill:alpha'].type === 'noul');

      const state = JSON.parse(fs.readFileSync(path.join(dir, 'state-sess-happy.json'), 'utf8'));
      assert.strictEqual(state.seq, 1);
      assert.strictEqual(state.event, 'user-prompt');
      assert.strictEqual(state.states['skill:alpha'].state, 'ON');
      assert.strictEqual(state.states['skill:beta'].state, 'OFF');
      assert.strictEqual(state.states['mcp:github'].state, 'OFF', 'missing answer keeps current state (OFF default)');
      assert.strictEqual(state.states['skill:alpha'].lastEvent, 'user-prompt');

      const rows = readTelemetryRows(config.telemetryPath);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].event, 'user-prompt');
      assert.deepStrictEqual(rows[0].probabilities['skill:alpha'], 0.9);
      assert.strictEqual(rows[0].model, 'jev-1.13.0');
      assert.deepStrictEqual(rows[0].usage, { input_tokens: 11, output_tokens: 7 });
      assert.ok(Array.isArray(rows[0].decisions) && rows[0].decisions.length === 1);

      assert.strictEqual(fs.existsSync(lockFilePath({ config, sessionKey: 'sess-happy' })), false, 'lock released');
    })
  ) passed++;
  else failed++;

  if (
    await asyncTest('seq increments and OFF-to-ON changes are reported across runs', async () => {
      const dir = makeFixture();
      const config = makeConfig(dir);
      writeRegistryFixture(config);
      await runEvaluation({ event: 'user-prompt', prompt: 'p1', sessionKey: 's' }, { config, fetchImpl: fakeFetch({ 'skill:alpha': { type: 'noul', noul: 0.9 } }) });
      const second = await runEvaluation({ event: 'stop', prompt: '', sessionKey: 's' }, { config, fetchImpl: fakeFetch({ 'skill:alpha': { type: 'noul', noul: 0.05 } }) });
      const state = JSON.parse(fs.readFileSync(path.join(dir, 'state-s.json'), 'utf8'));
      assert.strictEqual(state.seq, 2);
      assert.strictEqual(state.event, 'stop');
      assert.strictEqual(state.states['skill:alpha'].state, 'OFF');
      assert.strictEqual(state.states['skill:alpha'].changedAtSeq, 2);
      assert.ok(second.decision.changes.some(change => change.id === 'skill:alpha' && change.from === 'ON' && change.to === 'OFF'));
    })
  ) passed++;
  else failed++;

  if (
    await asyncTest('tool-failure events record toolName/errorMessage in telemetry for readRecentFailures', async () => {
      const dir = makeFixture();
      const config = makeConfig(dir);
      writeRegistryFixture(config);
      await runEvaluation({ event: 'tool-failure', prompt: '', sessionKey: 'sf', toolName: 'mcp__github__search', errorMessage: '429 rate limited' }, { config, fetchImpl: fakeFetch({}) });
      const rows = readTelemetryRows(config.telemetryPath);
      assert.strictEqual(rows[0].event, 'tool-failure');
      assert.strictEqual(rows[0].toolName, 'mcp__github__search');
      assert.strictEqual(rows[0].errorMessage, '429 rate limited');
      const telemetry = require('../../../scripts/lib/jev-switchboard/telemetry');
      const failures = telemetry.readRecentFailures({ config });
      assert.strictEqual(failures.length, 1);
      assert.strictEqual(failures[0].toolName, 'mcp__github__search');
    })
  ) passed++;
  else failed++;

  if (
    await asyncTest('lock held by a live evaluation: exits silently with no fetch, no state, no telemetry', async () => {
      const dir = makeFixture();
      const config = makeConfig(dir);
      writeRegistryFixture(config);
      const lockPath = lockFilePath({ config, sessionKey: 'busy' });
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(lockPath, ''); // fresh lock, mtime = now
      const fetchImpl = fakeFetch({});

      const result = await runEvaluation({ event: 'user-prompt', prompt: 'p', sessionKey: 'busy' }, { config, fetchImpl });

      assert.deepStrictEqual(result, { ok: false, skipped: 'lock-held' });
      assert.strictEqual(fetchImpl.calls.length, 0);
      assert.strictEqual(fs.existsSync(path.join(dir, 'state-busy.json')), false);
      assert.strictEqual(readTelemetryRows(config.telemetryPath).length, 0);
      assert.strictEqual(fs.existsSync(lockPath), true, 'a held lock is never released by the loser');
    })
  ) passed++;
  else failed++;

  if (
    await asyncTest('stale lock is stolen and the evaluation proceeds', async () => {
      const dir = makeFixture();
      const config = makeConfig(dir);
      writeRegistryFixture(config);
      const lockPath = lockFilePath({ config, sessionKey: 'stale' });
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(lockPath, '');
      const old = new Date(Date.now() - (LOCK_STALE_MS + 30 * 1000));
      fs.utimesSync(lockPath, old, old);

      const result = await runEvaluation({ event: 'user-prompt', prompt: 'p', sessionKey: 'stale' }, { config, fetchImpl: fakeFetch({}) });

      assert.strictEqual(result.ok, true, `expected the stale lock to be stolen, got ${JSON.stringify(result)}`);
      assert.strictEqual(fs.existsSync(path.join(dir, 'state-stale.json')), true);
      assert.strictEqual(fs.existsSync(lockPath), false, 'stolen lock is released afterwards');
    })
  ) passed++;
  else failed++;

  if (
    test('acquireLock steal semantics: fresh locks lose, stale locks are unlinked', () => {
      const dir = makeFixture();
      const lockPath = path.join(dir, 'eval-x.lock');
      assert.strictEqual(acquireLock(lockPath), true);
      assert.strictEqual(acquireLock(lockPath), false, 'a fresh lock is respected');
      const old = new Date(Date.now() - (LOCK_STALE_MS + 1000));
      fs.utimesSync(lockPath, old, old);
      assert.strictEqual(acquireLock(lockPath), true, 'a stale lock is stolen');
      releaseLock(lockPath);
      assert.strictEqual(fs.existsSync(lockPath), false);
      assert.strictEqual(releaseLock(path.join(dir, 'never-existed.lock')), false, 'releasing a missing lock is a quiet no-op');
    })
  ) passed++;
  else failed++;

  if (
    await asyncTest('evaluation error: telemetry records eval-error and the boundary stays exit-0 shaped', async () => {
      const dir = makeFixture();
      const config = makeConfig(dir);
      writeRegistryFixture(config);
      const throwingFetch = async () => {
        throw new Error('ECONNREFUSED simulation');
      };

      const result = await runEvaluation({ event: 'user-prompt', prompt: 'p', sessionKey: 'err' }, { config, fetchImpl: throwingFetch });

      assert.strictEqual(result.ok, false);
      assert.match(result.error, /ECONNREFUSED|unavailable|failed/i);
      const rows = readTelemetryRows(config.telemetryPath);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].event, 'eval-error');
      assert.ok(rows[0].errorClass);
      assert.match(rows[0].message, /ECONNREFUSED|unavailable|failed/i);
      assert.strictEqual(fs.existsSync(path.join(dir, 'state-err.json')), false, 'fail-hold: no state file is written on error');
      assert.strictEqual(fs.existsSync(lockFilePath({ config, sessionKey: 'err' })), false, 'lock still released after the error');
    })
  ) passed++;
  else failed++;

  if (
    await asyncTest('disabled config: complete no-op (no fetch, no state, no telemetry), lock released', async () => {
      const dir = makeFixture();
      const config = makeConfig(dir);
      config.enabled = false;
      writeRegistryFixture(config);
      const fetchImpl = fakeFetch({});

      const result = await runEvaluation({ event: 'user-prompt', prompt: 'p', sessionKey: 'off' }, { config, fetchImpl });

      assert.deepStrictEqual(result, { ok: false, skipped: 'disabled' });
      assert.strictEqual(fetchImpl.calls.length, 0);
      assert.strictEqual(fs.existsSync(path.join(dir, 'state-off.json')), false);
      assert.strictEqual(readTelemetryRows(config.telemetryPath).length, 0);
      assert.strictEqual(fs.existsSync(lockFilePath({ config, sessionKey: 'off' })), false);
    })
  ) passed++;
  else failed++;

  if (
    await asyncTest('missing session key is a quiet skip', async () => {
      const dir = makeFixture();
      const config = makeConfig(dir);
      const result = await runEvaluation({ event: 'user-prompt', prompt: 'p', sessionKey: '' }, { config, fetchImpl: fakeFetch({}) });
      assert.deepStrictEqual(result, { ok: false, skipped: 'missing-session-key' });
    })
  ) passed++;
  else failed++;

  if (
    await asyncTest('hard rules participate: unavailable capabilities are forced OFF despite high probability', async () => {
      const dir = makeFixture();
      const config = makeConfig(dir);
      const capabilities = [capability('skill:gone', 'skill', 'Gone'), capability('skill:live', 'skill', 'Live')];
      capabilities[0].available = false;
      primeRegistryCache(config, capabilities);

      await runEvaluation({ event: 'user-prompt', prompt: 'p', sessionKey: 'hr' }, { config, fetchImpl: fakeFetch({ 'skill:gone': { type: 'noul', noul: 0.99 }, 'skill:live': { type: 'noul', noul: 0.8 } }) });

      const state = JSON.parse(fs.readFileSync(path.join(dir, 'state-hr.json'), 'utf8'));
      assert.strictEqual(state.states['skill:gone'].state, 'OFF');
      assert.match(state.states['skill:gone'].reason, /unavailable/);
      assert.strictEqual(state.states['skill:live'].state, 'ON');
    })
  ) passed++;
  else failed++;

  if (
    await asyncTest('absent answer KEEPs an existing ON capability (never punished to OFF)', async () => {
      const dir = makeFixture();
      const config = makeConfig(dir);
      writeRegistryFixture(config);
      writeState({
        config,
        sessionKey: 'sess-keep',
        states: {
          'skill:alpha': { state: 'ON', reason: 'threshold:on', lastProbability: 0.9 },
          'skill:beta': { state: 'OFF', reason: 'threshold:off', lastProbability: 0.1 }
        },
        meta: { seq: 1, event: 'user-prompt', objective: 'keep bearings' }
      });

      // Jev answers only for beta this round - alpha's answer is absent.
      // (Prompt deliberately names no capability id, or the explicit-request
      // hard rule would LOCK it before thresholds are ever consulted.)
      const result = await runEvaluation(
        { event: 'user-prompt', prompt: 'write release notes for the parser change', sessionKey: 'sess-keep' },
        { config, fetchImpl: fakeFetch({ 'skill:beta': { type: 'noul', noul: 0.1 } }) }
      );
      assert.strictEqual(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);

      const state = JSON.parse(fs.readFileSync(path.join(dir, 'state-sess-keep.json'), 'utf8'));
      assert.strictEqual(state.seq, 2, 'state advances a sequence number');
      assert.strictEqual(state.states['skill:alpha'].state, 'ON', 'absent answer keeps existing ON');
      assert.strictEqual(state.states['skill:alpha'].reason, 'keep:no-probability');
      assert.strictEqual(state.states['skill:beta'].state, 'OFF');
      const turnedOff = result.decision.changes.filter(change => change.id === 'skill:alpha' && change.to === 'OFF');
      assert.strictEqual(turnedOff.length, 0, 'no change row may turn a kept capability OFF');
    })
  ) passed++;
  else failed++;

  if (
    test('releaseLock never unlinks a lock stolen by a successor evaluator', () => {
      const dir = makeFixture();
      const lockPath = path.join(dir, 'eval-stolen.lock');
      try {
        assert.strictEqual(acquireLock(lockPath), true, 'fresh acquire succeeds');

        // Simulate a successor: this evaluator overran LOCK_STALE_MS, someone
        // else stole the lock and wrote their own ownership token.
        fs.writeFileSync(lockPath, 'successor-evaluator-token', { mode: 0o600 });

        assert.strictEqual(releaseLock(lockPath), false, 'release must refuse a foreign token');
        assert.strictEqual(fs.existsSync(lockPath), true, "successor's lock must survive");
        assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), 'successor-evaluator-token', 'content untouched');
      } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    })
  ) passed++;
  else failed++;

  if (
    test('CLI main() unlinks the pending payload file after consuming it', () => {
      const dir = makeFixture();
      const payloadPath = path.join(dir, `pending-sess-cli-${Date.now()}.json`);
      fs.writeFileSync(payloadPath, `${JSON.stringify({ event: 'user-prompt', prompt: 'secret-ish prompt text', sessionKey: 'sess-cli' })}\n`, { mode: 0o600 });
      try {
        const result = spawnSync(
          process.execPath,
          [path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'jev-switchboard', 'eval-runner.js'), payloadPath],
          {
            encoding: 'utf8',
            timeout: 20000,
            // ECC_JEV_STATE_DIR keeps the spawned evaluator (lock acquisition,
            // telemetry) inside the fixture - never the operator's real state dir.
            env: { PATH: process.env.PATH, HOME: process.env.HOME || os.tmpdir(), ECC_JEV_STATE_DIR: dir }
          }
        );
        assert.strictEqual(result.status, 0, `evaluator must always exit 0, got ${result.status}: ${result.stderr}`);
        assert.strictEqual(fs.existsSync(payloadPath), false, 'consumed payload must be unlinked, not accumulated');
      } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    })
  ) passed++;
  else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(error => {
  console.error(error);
  process.exit(1);
});
