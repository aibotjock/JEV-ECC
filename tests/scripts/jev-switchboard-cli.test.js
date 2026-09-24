'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sanitizeSessionKey, cmdEval } = require('../../scripts/jev-switchboard');

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

// Temporarily override process.env for in-process cmdEval calls (the CLI builds
// its config from process.env); returns a restore function.
function setEnv(values) {
  const saved = {};
  for (const key of Object.keys(values)) {
    saved[key] = process.env[key];
    if (values[key] === undefined || values[key] === '') delete process.env[key];
    else process.env[key] = values[key];
  }
  return () => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined || saved[key] === '') delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
}

// In-process eval with an injected fetch (never the network), capturing the
// console output the CLI would print.
async function runCmdEvalCaptured(options, injected) {
  const out = [];
  const err = [];
  const originalLog = console.log;
  const originalStderrWrite = process.stderr.write;
  console.log = (...args) => {
    out.push(args.join(' '));
  };
  process.stderr.write = chunk => {
    err.push(String(chunk));
    return true;
  };
  let code = null;
  try {
    code = await cmdEval(options, injected);
  } finally {
    console.log = originalLog;
    process.stderr.write = originalStderrWrite;
  }
  return { code, out: out.join('\n'), err: err.join('') };
}

function fakeFetch(answers) {
  return async () => ({
    status: 200,
    text: async () => JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 11, output_tokens: 7 } })
  });
}

function readTelemetryRows(telemetryPath) {
  if (!fs.existsSync(telemetryPath)) return [];
  return fs.readFileSync(telemetryPath, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
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

    const evalNoPrompt = run(['eval']);
    assert.strictEqual(evalNoPrompt.status, 1);
    assert.ok(evalNoPrompt.stderr.includes('--prompt is required for --event user-prompt'));
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

// ---------------------------------------------------------------------------
// eval + calibrate
// ---------------------------------------------------------------------------

(async () => {
  const evalStateDir = path.join(fixtureRoot, 'eval-state');
  fs.mkdirSync(evalStateDir, { recursive: true }); // the evaluator's lock acquisition needs the dir to exist
  const fakeKey = 'sk-cli-eval-DO-NOT-PRINT-9876543210';

  if (
    test('eval usage errors: invalid --event and missing prompt for tool-failure exit 1', () => {
      const badEvent = run(['eval', '--event', 'bogus', '--prompt', 'x']);
      assert.strictEqual(badEvent.status, 1);
      assert.ok(badEvent.stderr.includes('invalid --event value: bogus'));

      const noPromptToolFailure = run(['eval', '--event', 'tool-failure']);
      assert.strictEqual(noPromptToolFailure.status, 1);
      assert.ok(noPromptToolFailure.stderr.includes('--prompt is required for --event tool-failure'));

      const unknownFlag = run(['eval', '--prompt']);
      assert.strictEqual(unknownFlag.status, 1);
      assert.ok(unknownFlag.stderr.includes('missing value for --prompt'));
    })
  ) passed++;
  else failed++;

  if (
    test('eval without an api key skips (disabled) and exits 0', () => {
      const stdout = runOk(['eval', '--event', 'stop', '--state-dir', stateDir, '--registry-path', registryPath]);
      assert.ok(stdout.includes('JEV switchboard eval skipped (disabled)'), `skip line printed: ${stdout}`);
      assert.ok(stdout.includes('TYPESAFE_API_KEY'), 'the skip line names the missing knob');
      assert.ok(!stdout.includes('Error'), 'a skip is not an error');
    })
  ) passed++;
  else failed++;

  if (
    await asyncTest('eval happy path: runs in-process with an injected fetch, prints the decision summary', async () => {
      const restoreEnv = setEnv({
        TYPESAFE_API_KEY: fakeKey,
        ECC_JEV_ENABLED: '',
        ECC_JEV_STATE_DIR: '',
        ECC_JEV_REGISTRY_PATH: '',
        ECC_HOOK_CONFIG: '',
        CLAUDE_PLUGIN_ROOT: '',
        ECC_PLUGIN_ROOT: ''
      });
      try {
        const { code, out } = await runCmdEvalCaptured(
          {
            repoRoot: null,
            overlay: null,
            registryPath,
            stateDir: evalStateDir,
            session: 'evaltest',
            prompt: 'ship the release notes for the parser change',
            event: null,
            toolName: null,
            errorMessage: null,
            json: false,
            help: false
          },
          {
            fetchImpl: fakeFetch({ 'skill:alpha': { type: 'noul', noul: 0.9 }, 'skill:gateguard': { type: 'noul', noul: 0.05 }, 'tool:WebSearch': { type: 'noul', noul: 0.1 } })
          }
        );

        assert.strictEqual(code, 0, `exit 0, got ${code}\nstdout: ${out}`);
        assert.ok(out.includes('JEV switchboard eval ok — session=evaltest event=user-prompt'), `ok line: ${out}`);
        assert.ok(/model=jev-1\.13\.0 latency_ms=\d+/.test(out), 'model and latency in the ok line');
        assert.ok(out.includes('state_changes=2'), `alpha OFF->ON plus gateguard OFF->LOCKED: ${out}`);
        const lines = out.split(/\r?\n/);
        assert.ok(lines.some(line => /^ {2}ON\s+skill:alpha\s+p=0\.90\s+threshold:on$/.test(line)), `ON row with probability: ${out}`);
        assert.ok(lines.some(line => /^ {2}LOCKED\s+skill:gateguard\s+p=0\.05\s+hard-rule:lock:security-policy$/.test(line)), `LOCKED row with reason: ${out}`);
        assert.ok(out.includes('OFF: 1 capabilities'), `OFF count: ${out}`);
        assert.ok(!out.includes(fakeKey), 'the api key is never echoed');

        const stateFile = JSON.parse(fs.readFileSync(path.join(evalStateDir, 'state-evaltest.json'), 'utf8'));
        assert.strictEqual(stateFile.seq, 1);
        assert.strictEqual(stateFile.states['skill:alpha'].state, 'ON');
        assert.strictEqual(stateFile.states['skill:gateguard'].state, 'LOCKED');
        assert.strictEqual(stateFile.states['tool:WebSearch'].state, 'OFF');
        const rows = readTelemetryRows(path.join(evalStateDir, 'telemetry.jsonl'));
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].event, 'user-prompt');
        assert.strictEqual(rows[0].probabilities['skill:alpha'], 0.9);
        assert.strictEqual(fs.existsSync(path.join(evalStateDir, 'eval-evaltest.lock')), false, 'lock released');
      } finally {
        restoreEnv();
      }
    })
  ) passed++;
  else failed++;

  if (
    await asyncTest('eval --json prints the full result object without secrets', async () => {
      const restoreEnv = setEnv({ TYPESAFE_API_KEY: fakeKey, ECC_JEV_ENABLED: '', ECC_JEV_STATE_DIR: '', ECC_JEV_REGISTRY_PATH: '' });
      try {
        const { code, out } = await runCmdEvalCaptured(
          {
            repoRoot: null,
            overlay: null,
            registryPath,
            stateDir: evalStateDir,
            session: 'evaljson',
            prompt: 'check the alpha coverage',
            event: null,
            toolName: null,
            errorMessage: null,
            json: true,
            help: false
          },
          { fetchImpl: fakeFetch({ 'skill:alpha': { type: 'noul', noul: 0.7 } }) }
        );
        assert.strictEqual(code, 0);
        const result = JSON.parse(out);
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.model, 'jev-1.13.0');
        assert.strictEqual(result.decision.states['skill:alpha'].state, 'ON');
        assert.ok(!out.includes(fakeKey), 'the api key never appears in the JSON result');
        assert.ok(!out.includes('Bearer'), 'no Authorization material in the JSON result');
      } finally {
        restoreEnv();
      }
    })
  ) passed++;
  else failed++;

  if (
    await asyncTest('eval error after retries exits 1 and records an eval-error telemetry row', async () => {
      const restoreEnv = setEnv({
        TYPESAFE_API_KEY: fakeKey,
        ECC_JEV_ENABLED: '',
        ECC_JEV_STATE_DIR: '',
        ECC_JEV_REGISTRY_PATH: '',
        ECC_JEV_MAX_RETRIES: '0' // no backoff sleeps in tests
      });
      const throwingFetch = async () => {
        throw new Error('connection refused (injected)');
      };
      try {
        const { code, out, err } = await runCmdEvalCaptured(
          {
            repoRoot: null,
            overlay: null,
            registryPath,
            stateDir: evalStateDir,
            session: 'evalerr',
            prompt: 'route me',
            event: null,
            toolName: null,
            errorMessage: null,
            json: false,
            help: false
          },
          { fetchImpl: throwingFetch }
        );
        assert.strictEqual(code, 1, `{ok:false,error} exits 1, got ${code}\nstdout: ${out}\nstderr: ${err}`);
        assert.ok(err.includes('Error: evaluation failed:'), `error line on stderr: ${err}`);
        assert.ok(err.includes('connection refused'), 'the (redacted) failure reason surfaces');
        assert.ok(!err.includes(fakeKey) && !out.includes(fakeKey), 'the api key never appears');
        assert.strictEqual(fs.existsSync(path.join(evalStateDir, 'state-evalerr.json')), false, 'fail-hold: no state file on error');
        const rows = readTelemetryRows(path.join(evalStateDir, 'telemetry.jsonl'));
        assert.strictEqual(rows[rows.length - 1].event, 'eval-error');
      } finally {
        restoreEnv();
      }
    })
  ) passed++;
  else failed++;

  if (
    test('calibrate with no telemetry file prints a friendly note and exits 0', () => {
      const emptyDir = fs.mkdtempSync(`${os.tmpdir()}/ecc-cli-cal-empty-`);
      try {
        const stdout = runOk(['calibrate', '--state-dir', emptyDir]);
        assert.ok(stdout.includes('JEV switchboard calibrate'));
        assert.ok(stdout.includes(`no telemetry yet at ${path.join(emptyDir, 'telemetry.jsonl')}`));
        assert.ok(stdout.includes('nothing to calibrate'));
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    })
  ) passed++;
  else failed++;

  const calStateDir = path.join(fixtureRoot, 'cal-state');
  {
    // 12 routing-event rows: alpha flips 6x and sits mid-band on average, mid
    // never leaves the band, weak is locked on by explicit request twice, calm
    // is a single quiet sample.
    const alpha = [0.8, 0.1, 0.7, 0.2, 0.75, 0.15];
    const mid = [0.5, 0.45, 0.55, 0.48, 0.52, 0.47, 0.5, 0.49, 0.51, 0.53, 0.5];
    const weak = [0.9, 0.85, 0.88, 0.91, 0.87, 0.9, 0.86, 0.84, 0.83, 0.89, 0.92];
    const rows = [];
    alpha.forEach((p, index) => {
      const decisions = [{ id: 'skill:alpha', from: index % 2 === 0 ? 'OFF' : 'ON', to: index % 2 === 0 ? 'ON' : 'OFF' }];
      if (index === 0) decisions.push({ id: 'skill:weak', from: 'OFF', to: 'LOCKED', reason: 'hard-rule:lock:explicit-request' });
      rows.push({ event: 'user-prompt', sessionKey: 'cal', probabilities: { 'skill:alpha': p, 'skill:mid': mid[index], 'skill:weak': weak[index] }, decisions, latencyMs: 40, model: 'jev-1.13.0' });
    });
    for (let index = 6; index < 11; index++) {
      const decisions = index === 6 ? [{ id: 'skill:weak', from: 'OFF', to: 'LOCKED', reason: 'hard-rule:lock:explicit-request' }] : [];
      rows.push({ event: 'stop', sessionKey: 'cal2', probabilities: { 'skill:mid': mid[index], 'skill:weak': weak[index] }, decisions, latencyMs: 35, model: 'jev-1.13.0' });
    }
    rows.push({ event: 'user-prompt', sessionKey: 'cal2', probabilities: { 'skill:calm': 0.05 }, decisions: [], latencyMs: 28, model: 'jev-1.13.0' });
    fs.mkdirSync(calStateDir, { recursive: true });
    fs.writeFileSync(path.join(calStateDir, 'telemetry.jsonl'), `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
  }

  if (
    test('calibrate prints the table sorted by samples and the matching recommendations', () => {
      const stdout = runOk(['calibrate', '--state-dir', calStateDir]);
      assert.ok(stdout.includes('JEV switchboard calibrate — 12 routing events, 0 eval errors'), `summary line: ${stdout}`);
      const lines = stdout.split(/\r?\n/);
      const dataRows = lines.filter(line => /^ {2}skill:/.test(line));
      assert.strictEqual(dataRows.length, 4, 'one row per sampled capability');
      assert.ok(dataRows[0].includes('skill:mid'), 'most-sampled capability leads the table');
      assert.ok(dataRows[0].includes('11'), 'mid has 11 samples');
      assert.ok(
        lines.some(line => /skill:alpha\s+6\s+0\.45\s+3\/3\/0\s+0\s+6\s+0/.test(line)),
        `alpha row with samples/mean/on-off-locked/band/flips/explicitLocks: ${stdout}`
      );
      assert.ok(stdout.includes('- widen hysteresis band for skill:alpha (6 flips)'));
      assert.ok(stdout.includes('- review activation threshold for skill:alpha (mean P=0.45 sits in the hysteresis band)'));
      assert.ok(stdout.includes('- review activation threshold for skill:mid (mean P=0.50 sits in the hysteresis band)'));
      assert.ok(stdout.includes('- triggers for skill:weak may be too weak (locked on by explicit request 2 times)'));
      assert.ok(!stdout.includes('sample size too small'), '12 events clear the act-on floor');
    })
  ) passed++;
  else failed++;

  if (
    test('calibrate --json prints the summarizeCalibration output', () => {
      const stdout = runOk(['calibrate', '--state-dir', calStateDir, '--json']);
      const summary = JSON.parse(stdout);
      assert.strictEqual(summary.events, 12);
      assert.strictEqual(summary.evalErrors, 0);
      assert.strictEqual(summary.rowsConsidered, 12);
      assert.strictEqual(summary.capabilities.length, 4);
      assert.strictEqual(summary.sampleSizeWarning, false);
      assert.strictEqual(summary.recommendations.length, 4);
      assert.ok(summary.recommendations.some(item => item.startsWith('widen hysteresis band for skill:alpha')));
      const weak = summary.capabilities.find(entry => entry.id === 'skill:weak');
      assert.strictEqual(weak.explicitLocks, 2);
      assert.strictEqual(weak.lockedCount, 2);
    })
  ) passed++;
  else failed++;

  if (
    test('calibrate warns when the sample size is too small to act on', () => {
      const smallDir = fs.mkdtempSync(`${os.tmpdir()}/ecc-cli-cal-small-`);
      try {
        fs.writeFileSync(
          path.join(smallDir, 'telemetry.jsonl'),
          `${JSON.stringify({ event: 'user-prompt', sessionKey: 's', probabilities: { 'skill:x': 0.5 }, decisions: [], latencyMs: 10, model: 'jev-1.13.0' })}\n`
        );
        const stdout = runOk(['calibrate', '--state-dir', smallDir]);
        assert.ok(stdout.includes('sample size too small to act on — collect more routing events'), `warning printed: ${stdout}`);
      } finally {
        fs.rmSync(smallDir, { recursive: true, force: true });
      }
    })
  ) passed++;
  else failed++;

  if (
    test('eval expands tilde --state-dir / ECC_JEV_STATE_DIR against HOME (no <cwd>/~ data split)', () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-cli-tilde-home-'));
      try {
        // Flag form: disabled skip still mkdirs the resolved state dir first.
        const byFlag = run(['eval', '--event', 'stop', '--state-dir', '~/tstate'], { HOME: home, ECC_AGENT_DATA_HOME: home });
        assert.strictEqual(byFlag.status, 0, `skip exits 0: ${byFlag.stdout}${byFlag.stderr}`);
        assert.ok(fs.existsSync(path.join(home, 'tstate')), 'tilde flag resolves under HOME');

        // Env form: config.js and the CLI must land in the SAME directory.
        const byEnv = run(['eval', '--event', 'stop'], { HOME: home, ECC_AGENT_DATA_HOME: home, ECC_JEV_STATE_DIR: '~/tenv' });
        assert.strictEqual(byEnv.status, 0, `skip exits 0: ${byEnv.stdout}${byEnv.stderr}`);
        assert.ok(fs.existsSync(path.join(home, 'tenv')), 'tilde env resolves under HOME');

        assert.ok(!fs.existsSync(path.join(REPO_ROOT, '~')), 'no literal ~/ directory is created under the cwd');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    })
  ) passed++;
  else failed++;

  if (
    await asyncTest('eval --event tool-failure enriches the payload and telemetry row', async () => {
      const restoreEnv = setEnv({ TYPESAFE_API_KEY: fakeKey, ECC_JEV_ENABLED: '', ECC_JEV_STATE_DIR: '', ECC_JEV_REGISTRY_PATH: '' });
      try {
        const { code, out } = await runCmdEvalCaptured(
          {
            repoRoot: null,
            overlay: null,
            registryPath,
            stateDir: evalStateDir,
            session: 'evalfail',
            prompt: 'the deploy hook exploded again',
            event: 'tool-failure',
            toolName: 'Bash',
            errorMessage: 'deploy.sh: line 12: command not found',
            json: false,
            help: false
          },
          { fetchImpl: fakeFetch({ 'skill:alpha': { type: 'noul', noul: 0.8 } }) }
        );
        assert.strictEqual(code, 0, `exit 0, got ${code}\nstdout: ${out}`);
        assert.ok(out.includes('event=tool-failure'), `event surfaced: ${out}`);
        const rows = fs.readFileSync(path.join(evalStateDir, 'telemetry.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
        const row = rows.find(r => r.event === 'tool-failure');
        assert.ok(row, 'a tool-failure telemetry row exists');
        assert.strictEqual(row.toolName, 'Bash');
        assert.strictEqual(row.errorMessage, 'deploy.sh: line 12: command not found');
      } finally {
        restoreEnv();
      }
    })
  ) passed++;
  else failed++;

  if (
    await asyncTest('telemetry decision rows carry the destination reason (calibrate depends on it)', async () => {
      const restoreEnv = setEnv({ TYPESAFE_API_KEY: fakeKey, ECC_JEV_ENABLED: '', ECC_JEV_STATE_DIR: '', ECC_JEV_REGISTRY_PATH: '' });
      try {
        const { code } = await runCmdEvalCaptured(
          {
            repoRoot: null,
            overlay: null,
            registryPath,
            stateDir: evalStateDir,
            session: 'evalreason',
            prompt: 'wire the beta pipeline',
            event: null,
            toolName: null,
            errorMessage: null,
            json: false,
            help: false
          },
          { fetchImpl: fakeFetch({ 'skill:alpha': { type: 'noul', noul: 0.9 }, 'skill:gateguard': { type: 'noul', noul: 0.05 } }) }
        );
        assert.strictEqual(code, 0);
        const rows = fs.readFileSync(path.join(evalStateDir, 'telemetry.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
        const row = rows.find(r => r.sessionKey === 'evalreason');
        assert.ok(row, 'row for the session exists');
        const alpha = row.decisions.find(change => change.id === 'skill:alpha');
        const gate = row.decisions.find(change => change.id === 'skill:gateguard');
        assert.ok(alpha && alpha.reason === 'threshold:on', `threshold change carries its reason: ${JSON.stringify(row.decisions)}`);
        assert.ok(gate && gate.reason === 'hard-rule:lock:security-policy', `hard-rule lock carries its reason: ${JSON.stringify(row.decisions)}`);
      } finally {
        restoreEnv();
      }
    })
  ) passed++;
  else failed++;

  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fs.rmSync(fixtureHome, { recursive: true, force: true });

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
