'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sanitizeSessionKey } = require('../../scripts/jev-switchboard');

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

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'jev-switchboard.js');
const REPO_ROOT = path.join(__dirname, '..', '..');

// Fixture repo root + isolated HOME so MCP collection reads only the fixture
// (no real ~/.claude.json, ~/.codex, or OpenCode config leaks into counts).
const fixtureRoot = fs.mkdtempSync(`${os.tmpdir()}/ecc-cli-registry-`);
const fixtureHome = fs.mkdtempSync(`${os.tmpdir()}/ecc-cli-home-`);

fs.mkdirSync(path.join(fixtureRoot, 'skills', 'gateguard'), { recursive: true });
fs.writeFileSync(
  path.join(fixtureRoot, 'skills', 'gateguard', 'SKILL.md'),
  '---\nname: gateguard\ndescription: Fact-forcing gate that blocks edits until concrete facts are gathered.\n---\n\n# GateGuard\n'
);
fs.mkdirSync(path.join(fixtureRoot, 'skills', 'alpha'), { recursive: true });
fs.writeFileSync(path.join(fixtureRoot, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha-skill\ndescription: Does alpha things routing needs to know about.\n---\n\n# Alpha\n');
fs.mkdirSync(path.join(fixtureRoot, 'config'), { recursive: true });
fs.writeFileSync(
  path.join(fixtureRoot, 'config', 'jev-switchboard-routing.json'),
  JSON.stringify(
    {
      version: 1,
      defaults: { activationThreshold: 0.65, deactivationThreshold: 0.35 },
      capabilities: {
        'tool:WebSearch': { description: 'Search the web.', positiveTriggers: ['search the web'] }
      },
      alwaysLocked: ['skill:gateguard']
    },
    null,
    2
  )
);

const registryPath = path.join(fixtureRoot, 'registry', 'jev-registry.json');
const stateDir = path.join(fixtureRoot, 'state');

function run(args, envOverrides = {}) {
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: fixtureHome,
    ECC_AGENT_DATA_HOME: fixtureHome,
    XDG_CONFIG_HOME: path.join(fixtureHome, '.xdg', 'config'),
    XDG_DATA_HOME: path.join(fixtureHome, '.xdg', 'data'),
    XDG_CACHE_HOME: path.join(fixtureHome, '.xdg', 'cache'),
    XDG_STATE_HOME: path.join(fixtureHome, '.xdg', 'state'),
    CLAUDE_PLUGIN_ROOT: '',
    ECC_PLUGIN_ROOT: '',
    ECC_JEV_REGISTRY_PATH: '',
    ECC_JEV_STATE_DIR: '',
    ECC_JEV_ENABLED: '',
    TYPESAFE_API_KEY: '',
    ...envOverrides
  };
  return spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env, cwd: REPO_ROOT, timeout: 30000 });
}

function runOk(args, envOverrides = {}) {
  const outcome = run(args, envOverrides);
  assert.strictEqual(outcome.status, 0, `exit 0 for: ${args.join(' ')}\nstdout: ${outcome.stdout}\nstderr: ${outcome.stderr}`);
  return outcome.stdout;
}

function writeStateFile(session, state) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, `state-${session}.json`), JSON.stringify(state, null, 2));
}

console.log('\njev-switchboard CLI');

if (
  test('build-registry derives the fixture repo, writes the cache, prints a summary', () => {
    const stdout = runOk(['build-registry', '--repo-root', fixtureRoot, '--overlay', path.join(fixtureRoot, 'config', 'jev-switchboard-routing.json'), '--registry-path', registryPath]);
    assert.ok(stdout.includes('JEV switchboard registry'), 'summary header printed');
    assert.ok(stdout.includes('2 skills, 0 mcps, 1 tool — 3 capabilities'), `counts line: ${stdout}`);
    assert.ok(stdout.includes('alwaysLocked: skill:gateguard'));
    assert.ok(stdout.includes(registryPath), 'cache path printed');

    assert.ok(fs.statSync(registryPath).isFile(), 'cache file written');
    assert.strictEqual(fs.statSync(registryPath).mode & 0o777, 0o600, 'cache file is 0600');
    const envelope = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    assert.strictEqual(envelope.schemaVersion, 'ecc.jev-registry-cache.v1');
    assert.deepStrictEqual(
      envelope.registry.capabilities.map(capability => capability.id),
      ['skill:alpha', 'skill:gateguard', 'tool:WebSearch'],
      'sorted capability ids in the cache'
    );
    const gateguard = envelope.registry.capabilities.find(capability => capability.id === 'skill:gateguard');
    assert.strictEqual(gateguard.lockable, false, 'alwaysLocked capability is not lockable');
  })
)
  passed++;
else failed++;

if (
  test('build-registry --json prints the full registry as JSON', () => {
    const stdout = runOk(['build-registry', '--repo-root', fixtureRoot, '--overlay', path.join(fixtureRoot, 'config', 'jev-switchboard-routing.json'), '--registry-path', registryPath, '--json']);
    const registry = JSON.parse(stdout);
    assert.strictEqual(registry.schemaVersion, 'ecc.jev-registry.v1');
    assert.deepStrictEqual(registry.buildSummary.counts, { skill: 2, mcp: 0, tool: 1, total: 3 });
  })
)
  passed++;
else failed++;

if (
  test('status prints ON/OFF/LOCKED from the registry and the state file', () => {
    writeStateFile('default', {
      seq: 3,
      event: 'Stop',
      states: {
        'skill:alpha': { state: 'ON', lastProbability: 0.91 },
        'skill:gateguard': { state: 'OFF', lastProbability: 0.1 },
        'tool:gone': { state: 'ON', lastProbability: 0.5 }
      }
    });
    const stdout = runOk(['status', '--registry-path', registryPath, '--state-dir', stateDir]);
    const lines = stdout.split(/\r?\n/);
    assert.ok(stdout.includes('seq 3, event Stop'), 'state file metadata shown');
    assert.ok(
      lines.some(line => /^ {2}LOCKED\s+skill:gateguard/.test(line)),
      'alwaysLocked renders LOCKED even when the state file says OFF'
    );
    assert.ok(
      lines.some(line => /^ {2}ON\s+skill:alpha\s+0\.91$/.test(line)),
      `ON row with probability: ${stdout}`
    );
    assert.ok(
      lines.some(line => /^ {2}OFF\s+tool:WebSearch\s+-$/.test(line)),
      'never-evaluated registry capability defaults to OFF'
    );
    assert.ok(
      lines.some(line => /^ {2}ON\s+tool:gone \(unregistered\)\s+0\.50$/.test(line)),
      'state-only id is marked unregistered'
    );
  })
)
  passed++;
else failed++;

if (
  test('status with no state file reports pass-through and defaults everything to OFF', () => {
    const stdout = runOk(['status', '--registry-path', registryPath, '--state-dir', stateDir, '--session', 'custom']);
    assert.ok(stdout.includes('session: custom'));
    assert.ok(stdout.includes(path.join(stateDir, 'state-custom.json')));
    assert.ok(stdout.includes('not found (never evaluated; gates pass-through'));
    assert.ok(!/^ {2}ON\b/m.test(stdout), 'nothing is ON without an evaluation');
    assert.ok(/^ {2}LOCKED\s+skill:gateguard/m.test(stdout), 'alwaysLocked stays LOCKED regardless');
  })
)
  passed++;
else failed++;

if (
  test('session keys are sanitized into the state file name', () => {
    assert.strictEqual(sanitizeSessionKey('../evil'), '.._evil');
    assert.strictEqual(sanitizeSessionKey('plain-session.1'), 'plain-session.1');
    assert.strictEqual(sanitizeSessionKey(''), 'default');
    const stdout = runOk(['status', '--registry-path', registryPath, '--state-dir', stateDir, '--session', '../evil']);
    assert.ok(stdout.includes(path.join(stateDir, 'state-.._evil.json')), 'path stays inside the state dir');
  })
)
  passed++;
else failed++;

if (
  test('usage errors exit 1 with a message; --help exits 0', () => {
    const bogus = run(['bogus']);
    assert.strictEqual(bogus.status, 1);
    assert.ok(bogus.stderr.includes('unknown command: bogus'));

    const noArgs = run([]);
    assert.strictEqual(noArgs.status, 1);

    const unknownFlag = run(['status', '--nope']);
    assert.strictEqual(unknownFlag.status, 1);
    assert.ok(unknownFlag.stderr.includes('unknown option: --nope'));

    const missingValue = run(['build-registry', '--repo-root']);
    assert.strictEqual(missingValue.status, 1);
    assert.ok(missingValue.stderr.includes('missing value for --repo-root'));

    const help = run(['--help']);
    assert.strictEqual(help.status, 0);
    assert.ok(help.stdout.includes('Usage: jev-switchboard'));

    const pending = run(['eval']);
    assert.strictEqual(pending.status, 1);
    assert.ok(pending.stderr.includes('not implemented yet'));
  })
)
  passed++;
else failed++;

if (
  test('doctor reports key presence without ever printing the key value', () => {
    const missing = runOk([
      'doctor',
      '--repo-root',
      fixtureRoot,
      '--overlay',
      path.join(fixtureRoot, 'config', 'jev-switchboard-routing.json'),
      '--registry-path',
      registryPath,
      '--state-dir',
      stateDir
    ]);
    assert.ok(missing.includes('[warn]  api key missing (TYPESAFE_API_KEY)'));
    assert.ok(missing.includes('[ok]    registry cache fresh (3 capabilities)'));
    assert.ok(missing.includes(`[ok]    state dir writable (${stateDir})`));

    const fakeKey = 'sk-test-key-DO-NOT-PRINT-0123456789';
    const present = runOk(
      ['doctor', '--repo-root', fixtureRoot, '--overlay', path.join(fixtureRoot, 'config', 'jev-switchboard-routing.json'), '--registry-path', registryPath, '--state-dir', stateDir],
      { TYPESAFE_API_KEY: fakeKey }
    );
    assert.ok(present.includes('[ok]    api key present (TYPESAFE_API_KEY)'));
    assert.ok(!present.includes(fakeKey), 'the key value is never echoed');
    assert.ok(!present.includes('[warn]  api key'), 'no key warning when present');

    const killed = runOk(
      ['doctor', '--repo-root', fixtureRoot, '--overlay', path.join(fixtureRoot, 'config', 'jev-switchboard-routing.json'), '--registry-path', registryPath, '--state-dir', stateDir],
      { ECC_JEV_ENABLED: 'false' }
    );
    assert.ok(killed.includes('[warn]  kill switch active'));
  })
)
  passed++;
else failed++;

if (
  test('doctor flags a stale or missing registry cache', () => {
    const staleDir = fs.mkdtempSync(`${os.tmpdir()}/ecc-cli-stale-`);
    const stalePath = path.join(staleDir, 'jev-registry.json');
    const base = ['doctor', '--repo-root', fixtureRoot, '--overlay', path.join(fixtureRoot, 'config', 'jev-switchboard-routing.json'), '--state-dir', stateDir];

    const missingCache = runOk([...base, '--registry-path', stalePath]);
    assert.ok(missingCache.includes('[warn]  registry cache missing'));

    fs.writeFileSync(stalePath, JSON.stringify({ schemaVersion: 'ecc.jev-registry-cache.v1', registry: { schemaVersion: 'x', capabilities: [] } }));
    const staleCache = runOk([...base, '--registry-path', stalePath]);
    assert.ok(staleCache.includes('[warn]  registry cache stale'));

    fs.writeFileSync(stalePath, '{ corrupt');
    const corruptCache = runOk([...base, '--registry-path', stalePath]);
    assert.ok(corruptCache.includes('[warn]  registry cache corrupt'));
    fs.rmSync(staleDir, { recursive: true, force: true });
  })
)
  passed++;
else failed++;

fs.rmSync(fixtureRoot, { recursive: true, force: true });
fs.rmSync(fixtureHome, { recursive: true, force: true });

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
