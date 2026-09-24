/**
 * Tests for scripts/hooks/jev-route.js (plus its Stop / PostToolUseFailure
 * siblings that share the detached-eval spawn helper).
 *
 * Run with: node tests/hooks/jev-route.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const routeScript = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'jev-route.js');
const route = require('../../scripts/hooks/jev-route');
const reeval = require('../../scripts/hooks/jev-reeval');
const failureReeval = require('../../scripts/hooks/jev-failure-reeval');
const { EVAL_RUNNER_PATH } = route;
const { REGISTRY_SCHEMA_VERSION, writeRegistryCache } = require('../../scripts/lib/jev-switchboard/registry');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    return false;
  }
}

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-jev-route-'));
}

function recordingSpawn() {
  const calls = [];
  const impl = (command, args, options) => {
    calls.push({ command, args, options, unrefed: false });
    return { unref: () => { calls[calls.length - 1].unrefed = true; } };
  };
  impl.calls = calls;
  return impl;
}

function makeEnv(home, extra = {}) {
  return {
    HOME: home,
    ECC_AGENT_DATA_HOME: home,
    TYPESAFE_API_KEY: 'test-key',
    ...extra
  };
}

function stateDirOf(home) {
  return path.join(home, 'ecc', 'jev-switchboard');
}

function primeRegistryCache(home) {
  const fixtureRoot = path.join(home, 'fixture-repo');
  fs.mkdirSync(path.join(fixtureRoot, 'skills'), { recursive: true });
  const overlayPath = path.join(fixtureRoot, 'routing.json');
  fs.writeFileSync(overlayPath, JSON.stringify({ version: 1, defaults: {}, capabilities: {}, alwaysLocked: [] }));
  writeRegistryCache(
    { schemaVersion: REGISTRY_SCHEMA_VERSION, defaults: {}, alwaysLocked: [], capabilities: [{ id: 'skill:alpha', type: 'skill', name: 'Alpha', available: true }] },
    { registryPath: path.join(stateDirOf(home), 'jev-registry.json'), repoRoot: fixtureRoot, overlayPath }
  );
}

function waitForFile(filePath, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      if (content.trim()) return content;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function runTests() {
  console.log('\n=== Testing jev-route.js (detached evaluator spawn) ===\n');
  let passed = 0;
  let failed = 0;

  if (
    test('spawns the detached evaluator with the correct argv and options', () => {
      const home = createTempDir();
      try {
        const spawnImpl = recordingSpawn();
        const fixedNow = 1730000000000;
        const raw = JSON.stringify({ session_id: 'sess-route', prompt: 'review the auth module' });
        const result = route.run(raw, { env: makeEnv(home), spawnImpl, now: () => fixedNow });

        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(spawnImpl.calls.length, 1, 'exactly one detached spawn');
        const call = spawnImpl.calls[0];
        assert.strictEqual(call.command, process.execPath, 'spawns process.execPath (node)');
        assert.strictEqual(call.args[0], EVAL_RUNNER_PATH, 'argv[0] is the eval-runner script');
        assert.strictEqual(path.dirname(call.args[1]), stateDirOf(home), 'payload file lives in stateDir');
        assert.match(path.basename(call.args[1]), /^pending-sess-route-\d+\.json$/);
        assert.strictEqual(call.options.detached, true, 'spawn must be detached');
        assert.strictEqual(call.options.stdio, 'ignore', 'stdio must be ignored');
        assert.strictEqual(call.unrefed, true, 'child must be unref()d so the hook can exit');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    })
  ) passed++;
  else failed++;

  if (
    test('writes the evaluation payload file before spawning', () => {
      const home = createTempDir();
      try {
        const spawnImpl = recordingSpawn();
        const fixedNow = 1730000001234;
        route.run(JSON.stringify({ session_id: 'sess-pay', prompt: 'do the thing' }), { env: makeEnv(home), spawnImpl, now: () => fixedNow });

        const payloadPath = path.join(stateDirOf(home), 'pending-sess-pay-1730000001234.json');
        assert.ok(fs.existsSync(payloadPath), 'payload file written via atomic write');
        const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
        assert.strictEqual(payload.event, 'user-prompt');
        assert.strictEqual(payload.prompt, 'do the thing');
        assert.strictEqual(payload.sessionKey, 'sess-pay');
        const mode = fs.statSync(payloadPath).mode & 0o777;
        assert.strictEqual(mode, 0o600, 'payload file is 0600');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    })
  ) passed++;
  else failed++;

  if (
    test('disabled config (no TYPESAFE_API_KEY): no spawn, no payload, exit 0', () => {
      const home = createTempDir();
      try {
        const spawnImpl = recordingSpawn();
        const env = makeEnv(home);
        delete env.TYPESAFE_API_KEY;
        const result = route.run(JSON.stringify({ session_id: 's', prompt: 'p' }), { env, spawnImpl });
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(spawnImpl.calls.length, 0);
        assert.strictEqual(fs.existsSync(stateDirOf(home)), false, 'disabled means zero filesystem writes');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    })
  ) passed++;
  else failed++;

  if (
    test('kill switch ECC_JEV_ENABLED=false: no spawn, exit 0', () => {
      const home = createTempDir();
      try {
        const spawnImpl = recordingSpawn();
        const result = route.run(JSON.stringify({ session_id: 's', prompt: 'p' }), { env: makeEnv(home, { ECC_JEV_ENABLED: 'false' }), spawnImpl });
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(spawnImpl.calls.length, 0);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    })
  ) passed++;
  else failed++;

  if (
    test('truncated stdin fails closed: no evaluator spawned on partial input', () => {
      const home = createTempDir();
      try {
        const spawnImpl = recordingSpawn();
        const result = route.run(JSON.stringify({ session_id: 's', prompt: 'partial...' }), { env: makeEnv(home), spawnImpl, truncated: true });
        assert.strictEqual(result.exitCode, 0, 'the prompt itself is never blocked');
        assert.ok(/skipping evaluation/i.test(result.stderr), 'a skip note lands on stderr');
        assert.strictEqual(spawnImpl.calls.length, 0);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    })
  ) passed++;
  else failed++;

  if (
    test('unparseable stdin: no spawn, exit 0', () => {
      const home = createTempDir();
      try {
        const spawnImpl = recordingSpawn();
        const result = route.run('not json at all', { env: makeEnv(home), spawnImpl });
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(spawnImpl.calls.length, 0);
        assert.ok(/Unparseable/i.test(result.stderr));
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    })
  ) passed++;
  else failed++;

  if (
    test('a throwing spawn never breaks the hook (exit 0 with a stderr note)', () => {
      const home = createTempDir();
      try {
        const boom = () => {
          throw new Error('spawn ENOENT simulation');
        };
        const result = route.run(JSON.stringify({ session_id: 's', prompt: 'p' }), { env: makeEnv(home), spawnImpl: boom });
        assert.strictEqual(result.exitCode, 0);
        assert.match(result.stderr, /Routing failed/);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    })
  ) passed++;
  else failed++;

  if (
    test('prompts are capped in the payload', () => {
      const home = createTempDir();
      try {
        const spawnImpl = recordingSpawn();
        route.run(JSON.stringify({ session_id: 's', prompt: 'z'.repeat(20000) }), { env: makeEnv(home), spawnImpl });
        const payloadPath = spawnImpl.calls[0].args[1];
        const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
        assert.ok(payload.prompt.length <= route.MAX_PROMPT_CHARS + 20);
        assert.match(payload.prompt, /\.\.\.\[truncated\]$/);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    })
  ) passed++;
  else failed++;

  if (
    test('Stop re-evaluation carries the objective from the prior state file', () => {
      const home = createTempDir();
      try {
        fs.mkdirSync(stateDirOf(home), { recursive: true });
        fs.writeFileSync(
          path.join(stateDirOf(home), 'state-sess-stop.json'),
          JSON.stringify({ seq: 2, event: 'user-prompt', objective: 'ship the release', states: {} })
        );
        const spawnImpl = recordingSpawn();
        const fixedNow = 1730000009999;
        const result = reeval.run(JSON.stringify({ session_id: 'sess-stop' }), { env: makeEnv(home), spawnImpl, now: () => fixedNow });
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(spawnImpl.calls.length, 1);
        const payload = JSON.parse(fs.readFileSync(spawnImpl.calls[0].args[1], 'utf8'));
        assert.strictEqual(payload.event, 'stop');
        assert.strictEqual(payload.prompt, '');
        assert.strictEqual(payload.objective, 'ship the release');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    })
  ) passed++;
  else failed++;

  if (
    test('PostToolUseFailure re-evaluation carries toolName and a capped error excerpt', () => {
      const home = createTempDir();
      try {
        const spawnImpl = recordingSpawn();
        const fixedNow = 1730000011111;
        const result = failureReeval.run(
          JSON.stringify({ session_id: 'sess-fail', tool_name: 'mcp__github__search', error: 'x'.repeat(3000) }),
          { env: makeEnv(home), spawnImpl, now: () => fixedNow }
        );
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(spawnImpl.calls.length, 1);
        const payload = JSON.parse(fs.readFileSync(spawnImpl.calls[0].args[1], 'utf8'));
        assert.strictEqual(payload.event, 'tool-failure');
        assert.strictEqual(payload.toolName, 'mcp__github__search');
        assert.ok(payload.errorMessage.length <= route.MAX_ERROR_CHARS + 20);
        assert.match(payload.errorMessage, /\.\.\.\[truncated\]$/);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    })
  ) passed++;
  else failed++;

  if (
    test('capText applies the question-render truncation convention', () => {
      assert.strictEqual(route.capText('short', 100), 'short');
      const capped = route.capText('y'.repeat(600), 500);
      assert.strictEqual(capped.length, 500);
      assert.match(capped, /\.\.\.\[truncated\]$/);
    })
  ) passed++;
  else failed++;

  if (
    test('end-to-end: piped stdin spawns the evaluator which fails safe offline and logs eval-error', () => {
      const home = createTempDir();
      try {
        // Localhost refused port: the evaluator's only network attempt fails
        // instantly with no external traffic; retries are disabled.
        const env = {
          ...process.env,
          HOME: home,
          ECC_AGENT_DATA_HOME: home,
          TYPESAFE_API_KEY: 'test-key',
          ECC_JEV_BASE_URL: 'http://127.0.0.1:1',
          ECC_JEV_MAX_RETRIES: '0',
          ECC_JEV_TIMEOUT_MS: '2000'
        };
        primeRegistryCache(home);
        const input = JSON.stringify({ session_id: 'sess-e2e', prompt: 'review everything' });
        const result = spawnSync('node', [routeScript], { input, encoding: 'utf8', env, timeout: 15000 });
        assert.strictEqual(result.status, 0, `hook must exit 0, stderr: ${result.stderr}`);

        const stateDir = stateDirOf(home);
        const pending = fs.readdirSync(stateDir).filter(name => name.startsWith('pending-sess-e2e-'));
        assert.strictEqual(pending.length, 1, 'payload file written before spawn');

        const telemetryPath = path.join(stateDir, 'telemetry.jsonl');
        const telemetry = waitForFile(telemetryPath);
        const rows = telemetry.trim().split('\n').map(line => JSON.parse(line));
        assert.ok(rows.some(row => row.event === 'eval-error'), 'offline failure lands as eval-error telemetry, exit stays clean');
        assert.strictEqual(fs.existsSync(path.join(stateDir, 'state-sess-e2e.json')), false, 'fail-hold: no state file on evaluation error');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    })
  ) passed++;
  else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
