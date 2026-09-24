/**
 * Tests for scripts/hooks/jev-gate.js
 *
 * Run with: node tests/hooks/jev-gate.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const script = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'jev-gate.js');
const gate = require('../../scripts/hooks/jev-gate');

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-jev-gate-'));
}

function buildHookEnv(env = {}) {
  const merged = { ...process.env, ECC_HOOK_PROFILE: 'standard' };
  for (const [key, value] of Object.entries(env)) {
    if (value === null || value === undefined) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function runHook(input, env = {}) {
  const result = spawnSync('node', [script], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: buildHookEnv(env),
    timeout: 15000,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  return {
    code: result.status === null || result.status === undefined ? 0 : result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
}

// A temp "agent data home": <home>/ecc/jev-switchboard/{state,registry cache}
function makeAgentHome() {
  const home = createTempDir();
  const stateDir = path.join(home, 'ecc', 'jev-switchboard');
  fs.mkdirSync(stateDir, { recursive: true });
  return { home, stateDir };
}

function baseEnv(home, extra = {}) {
  return {
    HOME: home,
    ECC_AGENT_DATA_HOME: home,
    TYPESAFE_API_KEY: 'test-key',
    CLAUDE_HOOK_EVENT_NAME: 'PreToolUse',
    ...extra
  };
}

function writeStateFile(stateDir, sessionKey, states) {
  fs.writeFileSync(
    path.join(stateDir, `state-${sessionKey}.json`),
    JSON.stringify({ schemaVersion: 'ecc.jev-state.v1', seq: 1, event: 'user-prompt', updatedAt: new Date().toISOString(), states })
  );
}

function writeRegistryCache(stateDir, capabilities) {
  fs.writeFileSync(
    path.join(stateDir, 'jev-registry.json'),
    JSON.stringify({ schemaVersion: 'ecc.jev-registry-cache.v1', registry: { schemaVersion: 'ecc.jev-registry.v1', capabilities } })
  );
}

function registryCaps() {
  return [
    { id: 'skill:code-review', type: 'skill', name: 'Code Review', available: true },
    { id: 'skill:tdd-workflow', type: 'skill', name: 'TDD Workflow', available: true },
    { id: 'tool:Bash', type: 'tool', name: 'Bash', available: true },
    { id: 'mcp:github', type: 'mcp', name: 'github', available: true }
  ];
}

const OFF_REVIEW = { state: 'OFF', reason: 'threshold:off', lastProbability: 0.18, lastEvent: 'user-prompt', changedAtSeq: 1 };
const ON_TDD = { state: 'ON', reason: 'threshold:on', lastProbability: 0.9, lastEvent: 'user-prompt', changedAtSeq: 1 };
const LOCKED_TOOL = { state: 'LOCKED', reason: 'hard-rule:lock:security-policy', lastProbability: null, lastEvent: 'user-prompt', changedAtSeq: 1 };

function runTests() {
  console.log('\n=== Testing jev-gate.js ===\n');
  let passed = 0;
  let failed = 0;

  if (
    test('OFF skill is denied with the mcp-health-check deny shape (exit 2, stderr log, raw stdout passthrough)', () => {
      const { home, stateDir } = makeAgentHome();
      try {
        writeRegistryCache(stateDir, registryCaps());
        writeStateFile(stateDir, 'sess1', { 'skill:code-review': OFF_REVIEW });
        const input = { session_id: 'sess1', tool_name: 'Skill', tool_input: { skill: 'code-review' } };
        const result = runHook(input, baseEnv(home));

        assert.strictEqual(result.code, 2, `expected exit 2, got ${result.code} (${result.stderr})`);
        assert.strictEqual(result.stdout, JSON.stringify(input), 'raw input must be echoed back like mcp-health-check');
        assert.ok(result.stderr.includes('[JevSwitchboard]'), `expected [JevSwitchboard] prefix, got: ${result.stderr}`);
        assert.ok(result.stderr.includes('skill:code-review'), 'deny reason must name the capability id');
        assert.ok(result.stderr.includes('relevance 0.18 below activation 0.65'), 'deny reason must include the routing probability vs threshold');
        assert.ok(/name the capability|explicitly/i.test(result.stderr), 'deny reason must explain how to override explicitly');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    })
  ) passed++;
  else failed++;

  if (
    test('ON and LOCKED capabilities pass silently (exit 0)', () => {
      const { home, stateDir } = makeAgentHome();
      try {
        writeRegistryCache(stateDir, registryCaps());
        writeStateFile(stateDir, 'sess2', { 'skill:tdd-workflow': ON_TDD, 'tool:Bash': LOCKED_TOOL });
        const on = runHook({ session_id: 'sess2', tool_name: 'Skill', tool_input: { skill: 'tdd-workflow' } }, baseEnv(home));
        assert.strictEqual(on.code, 0);
        assert.strictEqual(on.stderr, '', 'ON capabilities pass without noise');
        const locked = runHook({ session_id: 'sess2', tool_name: 'Bash', tool_input: { command: 'ls' } }, baseEnv(home));
        assert.strictEqual(locked.code, 0);
        assert.strictEqual(locked.stderr, '');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    })
  ) passed++;
  else failed++;

  if (
    test('unknown capability state passes (exit 0)', () => {
      const { home, stateDir } = makeAgentHome();
      try {
        writeRegistryCache(stateDir, registryCaps());
        writeStateFile(stateDir, 'sess3', { 'skill:tdd-workflow': ON_TDD });
        const result = runHook({ session_id: 'sess3', tool_name: 'Skill', tool_input: { skill: 'code-review' } }, baseEnv(home));
        assert.strictEqual(result.code, 0, 'a capability with no state entry must pass');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    })
  ) passed++;
  else failed++;

  if (
    test('no state file => fail-open pass-through (exit 0)', () => {
      const { home } = makeAgentHome();
      try {
        const result = runHook({ session_id: 'never-evaluated', tool_name: 'Skill', tool_input: { skill: 'code-review' } }, baseEnv(home));
        assert.strictEqual(result.code, 0, 'never-evaluated sessions must pass through');
        assert.strictEqual(result.stderr, '');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    })
  ) passed++;
  else failed++;

  if (
    test('mcp__server__tool maps to the mcp:<server> capability', () => {
      const { home, stateDir } = makeAgentHome();
      try {
        writeRegistryCache(stateDir, registryCaps());
        writeStateFile(stateDir, 'sess4', { 'mcp:github': { state: 'OFF', reason: 'threshold:off', lastProbability: 0.2, lastEvent: 'user-prompt', changedAtSeq: 1 } });
        const denied = runHook({ session_id: 'sess4', tool_name: 'mcp__github__search_repos', tool_input: {} }, baseEnv(home));
        assert.strictEqual(denied.code, 2, 'mcp:github OFF must deny mcp__github__* calls');
        assert.ok(denied.stderr.includes('mcp:github'));
        const unlisted = runHook({ session_id: 'sess4', tool_name: 'mcp__unlisted__tool', tool_input: {} }, baseEnv(home));
        assert.strictEqual(unlisted.code, 0, 'servers with no state entry pass');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    })
  ) passed++;
  else failed++;

  if (
    test('core tools without overlay entries are untouched', () => {
      const { home, stateDir } = makeAgentHome();
      try {
        writeRegistryCache(stateDir, registryCaps().filter(entry => entry.id !== 'tool:Bash'));
        writeStateFile(stateDir, 'sess5', { 'skill:code-review': OFF_REVIEW });
        const result = runHook({ session_id: 'sess5', tool_name: 'Bash', tool_input: { command: 'echo hi' } }, baseEnv(home));
        assert.strictEqual(result.code, 0, 'Bash is not overlay-declared => unregulated');
        assert.strictEqual(result.stderr, '');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    })
  ) passed++;
  else failed++;

  if (
    test('overlay-declared regulated tools are denied when OFF', () => {
      const { home, stateDir } = makeAgentHome();
      try {
        writeRegistryCache(stateDir, registryCaps());
        writeStateFile(stateDir, 'sess6', { 'tool:Bash': { state: 'OFF', reason: 'threshold:off', lastProbability: 0.05, lastEvent: 'user-prompt', changedAtSeq: 1 } });
        const result = runHook({ session_id: 'sess6', tool_name: 'Bash', tool_input: { command: 'ls' } }, baseEnv(home));
        assert.strictEqual(result.code, 2, 'an overlay-declared tool:Bash entry must be gated');
        assert.ok(result.stderr.includes('tool:Bash'));
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    })
  ) passed++;
  else failed++;

  if (
    test('kill switch (ECC_JEV_ENABLED=false) exits 0 immediately', () => {
      const { home, stateDir } = makeAgentHome();
      try {
        writeRegistryCache(stateDir, registryCaps());
        writeStateFile(stateDir, 'sess7', { 'skill:code-review': OFF_REVIEW });
        const result = runHook({ session_id: 'sess7', tool_name: 'Skill', tool_input: { skill: 'code-review' } }, baseEnv(home, { ECC_JEV_ENABLED: 'false' }));
        assert.strictEqual(result.code, 0);
        assert.strictEqual(result.stderr, '');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    })
  ) passed++;
  else failed++;

  if (
    test('missing TYPESAFE_API_KEY disables the switchboard (exit 0)', () => {
      const { home, stateDir } = makeAgentHome();
      try {
        writeRegistryCache(stateDir, registryCaps());
        writeStateFile(stateDir, 'sess8', { 'skill:code-review': OFF_REVIEW });
        const result = runHook({ session_id: 'sess8', tool_name: 'Skill', tool_input: { skill: 'code-review' } }, baseEnv(home, { TYPESAFE_API_KEY: null }));
        assert.strictEqual(result.code, 0);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    })
  ) passed++;
  else failed++;

  if (
    test('truncated stdin fails closed like gateguard (exit 2 + BLOCKED stderr)', () => {
      const { home } = makeAgentHome();
      try {
        const input = JSON.stringify({ session_id: 'sess9', tool_name: 'Skill', tool_input: { skill: 'code-review' } });
        const result = runHook(input, baseEnv(home, { ECC_HOOK_INPUT_TRUNCATED: '1', ECC_HOOK_INPUT_MAX_BYTES: '512' }));
        assert.strictEqual(result.code, 2, 'truncated input must block by default (fail-closed)');
        assert.ok(result.stderr.includes('512'), `expected the limit in the message, got: ${result.stderr}`);
        assert.ok(/could not safely inspect/i.test(result.stderr));
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    })
  ) passed++;
  else failed++;

  if (
    test('ECC_JEV_GATE_FAIL_OPEN reverses the truncation block', () => {
      const { home } = makeAgentHome();
      try {
        const input = JSON.stringify({ session_id: 'sessA', tool_name: 'Skill', tool_input: { skill: 'code-review' } });
        const result = runHook(input, baseEnv(home, { ECC_HOOK_INPUT_TRUNCATED: '1', ECC_JEV_GATE_FAIL_OPEN: '1' }));
        assert.strictEqual(result.code, 0);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    })
  ) passed++;
  else failed++;

  if (
    test('unparseable stdin passes through (exit 0)', () => {
      const { home } = makeAgentHome();
      try {
        const result = runHook('this is not json', baseEnv(home));
        assert.strictEqual(result.code, 0, 'parse errors never block tool execution');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    })
  ) passed++;
  else failed++;

  if (
    test('missing registry cache keeps the gate open for Skill calls', () => {
      const { home, stateDir } = makeAgentHome();
      try {
        writeStateFile(stateDir, 'sessB', { 'skill:code-review': OFF_REVIEW });
        const result = runHook({ session_id: 'sessB', tool_name: 'Skill', tool_input: { skill: 'code-review' } }, baseEnv(home));
        assert.strictEqual(result.code, 0, 'without the registry cache the id cannot be mapped => pass');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    })
  ) passed++;
  else failed++;

  if (
    test('unit: skill matching covers ids, nested dirs, and display names', () => {
      const registry = {
        capabilities: [
          { id: 'skill:code-review', type: 'skill', name: 'Code Review' },
          { id: 'skill:tools/deep-skill', type: 'skill', name: 'Deep' }
        ]
      };
      assert.strictEqual(gate.matchSkillCapability(registry, { skill: 'code-review' }).id, 'skill:code-review');
      assert.strictEqual(gate.matchSkillCapability(registry, { skill: 'deep-skill' }).id, 'skill:tools/deep-skill', 'id suffix matches nested skill dirs');
      assert.strictEqual(gate.matchSkillCapability(registry, { skill: 'Deep' }).id, 'skill:tools/deep-skill', 'single-word display names match by name');
      assert.strictEqual(gate.matchSkillCapability(registry, { skill: 'Code Review' }), null, 'identifier extraction rejects spaced names; nothing to map');
      assert.strictEqual(gate.matchSkillCapability(registry, { skill: 'unknown-skill' }), null);
      assert.strictEqual(gate.matchSkillCapability(registry, {}), null);
      assert.strictEqual(gate.mcpServerFromToolName('mcp__github__search__repos'), 'github');
      assert.strictEqual(gate.mcpServerFromToolName('mcp__onlyonesegment'), null);
      assert.strictEqual(gate.mcpServerFromToolName('Bash'), null);
    })
  ) passed++;
  else failed++;

  if (
    test('run() via require(): deny result mirrors the spawned deny shape', () => {
      const raw = JSON.stringify({ session_id: 'sessC', tool_name: 'Skill', tool_input: { skill: 'code-review' } });
      const result = gate.run(raw, { env: { ECC_JEV_ENABLED: 'false', TYPESAFE_API_KEY: '' } });
      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.stdout, raw);
    })
  ) passed++;
  else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
