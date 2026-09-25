'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadJevConfig, DEFAULTS } = require('../../../scripts/lib/jev-switchboard/config');

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-'));
}

function writeManagedSetup(dir, payload) {
  const eccDir = path.join(dir, 'ecc');
  fs.mkdirSync(eccDir, { recursive: true });
  const setupPath = path.join(eccDir, 'setup.json');
  fs.writeFileSync(setupPath, JSON.stringify(payload));
  return setupPath;
}

function baseEnv(home) {
  return { HOME: home, TYPESAFE_API_KEY: 'test-key' };
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

function expectedDefaultShape(home) {
  const stateDir = path.join(home, '.claude', 'ecc', 'jev-switchboard');
  return {
    enabled: true,
    apiKey: 'test-key',
    baseUrl: 'https://api.typesafe.ai',
    model: 'jev-1.13.0',
    activationThreshold: 0.85,
    deactivationThreshold: 0.49,
    timeoutMs: 8000,
    maxRetries: 2,
    stateDir,
    telemetryPath: path.join(stateDir, 'telemetry.jsonl'),
    registryPath: path.join(stateDir, 'jev-registry.json'),
  };
}

console.log('\nJEV switchboard config');

if (
  test('applies defaults when no env vars or managed config exist', () => {
    const home = makeFixture();
    assert.deepStrictEqual(loadJevConfig(baseEnv(home)), expectedDefaultShape(home));
  })
) passed++;
else failed++;

if (
  test('prefers ECC_JEV_* env over managed setup.json over defaults', () => {
    const home = makeFixture();
    const setupPath = writeManagedSetup(home, {
      jevSwitchboard: {
        model: 'jev-managed',
        baseUrl: 'https://managed.example/',
        activationThreshold: 0.7,
        deactivationThreshold: 0.2,
        timeoutMs: 5000,
        maxRetries: 1,
      },
    });
    const config = loadJevConfig({
      ...baseEnv(home),
      ECC_HOOK_CONFIG: setupPath,
      ECC_JEV_MODEL: 'jev-1.13.0',
      ECC_JEV_ACTIVATION_THRESHOLD: '0.8',
    });
    assert.strictEqual(config.model, 'jev-1.13.0'); // env wins
    assert.strictEqual(config.activationThreshold, 0.8); // env wins
    assert.strictEqual(config.baseUrl, 'https://managed.example'); // managed wins, trailing slash trimmed
    assert.strictEqual(config.deactivationThreshold, 0.2); // managed wins
    assert.strictEqual(config.timeoutMs, 5000); // managed wins
    assert.strictEqual(config.maxRetries, 1); // managed wins
    assert.strictEqual(config.enabled, true); // default
  })
) passed++;
else failed++;

if (
  test('uses managed setup.json when env vars are absent', () => {
    const home = makeFixture();
    const setupPath = writeManagedSetup(home, { jevSwitchboard: { model: 'jev-managed', timeoutMs: 3000 } });
    const config = loadJevConfig({ ...baseEnv(home), ECC_HOOK_CONFIG: setupPath });
    assert.strictEqual(config.model, 'jev-managed');
    assert.strictEqual(config.timeoutMs, 3000);
    assert.strictEqual(config.activationThreshold, DEFAULTS.activationThreshold);
  })
) passed++;
else failed++;

if (
  test('reads managed config from CLAUDE_PLUGIN_ROOT/ecc/setup.json', () => {
    const home = makeFixture();
    writeManagedSetup(home, { jevSwitchboard: { model: 'jev-pluginroot' } });
    const config = loadJevConfig({ ...baseEnv(home), CLAUDE_PLUGIN_ROOT: home });
    assert.strictEqual(config.model, 'jev-pluginroot');
  })
) passed++;
else failed++;

if (
  test('treats a missing managed file as a no-op', () => {
    const home = makeFixture();
    assert.deepStrictEqual(
      loadJevConfig({ ...baseEnv(home), ECC_HOOK_CONFIG: path.join(home, 'absent.json') }),
      expectedDefaultShape(home)
    );
    const emptyRoot = makeFixture();
    assert.deepStrictEqual(loadJevConfig({ ...baseEnv(emptyRoot), CLAUDE_PLUGIN_ROOT: emptyRoot }), expectedDefaultShape(emptyRoot));
  })
) passed++;
else failed++;

if (
  test('ignores malformed managed JSON and warns', () => {
    const home = makeFixture();
    const eccDir = path.join(home, 'ecc');
    fs.mkdirSync(eccDir, { recursive: true });
    const badPath = path.join(eccDir, 'setup.json');
    fs.writeFileSync(badPath, '{not json');
    const { result, output } = captureStderr(() => loadJevConfig({ ...baseEnv(home), ECC_HOOK_CONFIG: badPath }));
    assert.deepStrictEqual(result, expectedDefaultShape(home));
    assert.match(output, /Warning/);
  })
) passed++;
else failed++;

if (
  test('forces enabled=false when TYPESAFE_API_KEY is missing or blank', () => {
    const home = makeFixture();
    const setupPath = writeManagedSetup(home, { jevSwitchboard: { enabled: true } });
    const missing = loadJevConfig({ ...baseEnv(home), ECC_HOOK_CONFIG: setupPath, TYPESAFE_API_KEY: undefined });
    assert.strictEqual(missing.enabled, false);
    assert.strictEqual(missing.apiKey, '');
    const blank = loadJevConfig({ ...baseEnv(home), ECC_HOOK_CONFIG: setupPath, TYPESAFE_API_KEY: '   ' });
    assert.strictEqual(blank.enabled, false);
    assert.strictEqual(blank.apiKey, '');
  })
) passed++;
else failed++;

if (
  test('honors the ECC_JEV_ENABLED=false kill switch', () => {
    const home = makeFixture();
    const off = loadJevConfig({ ...baseEnv(home), ECC_JEV_ENABLED: 'false' });
    assert.strictEqual(off.enabled, false);
    const zero = loadJevConfig({ ...baseEnv(home), ECC_JEV_ENABLED: '0' });
    assert.strictEqual(zero.enabled, false);
    const on = loadJevConfig({ ...baseEnv(home), ECC_JEV_ENABLED: 'true' });
    assert.strictEqual(on.enabled, true);
  })
) passed++;
else failed++;

if (
  test('honors managed enabled=false when env is unset', () => {
    const home = makeFixture();
    const setupPath = writeManagedSetup(home, { jevSwitchboard: { enabled: false } });
    const config = loadJevConfig({ ...baseEnv(home), ECC_HOOK_CONFIG: setupPath });
    assert.strictEqual(config.enabled, false);
  })
) passed++;
else failed++;

if (
  test('preserves a valid threshold pair', () => {
    const home = makeFixture();
    const config = loadJevConfig({
      ...baseEnv(home),
      ECC_JEV_ACTIVATION_THRESHOLD: '0.75',
      ECC_JEV_DEACTIVATION_THRESHOLD: '0.25',
    });
    assert.strictEqual(config.activationThreshold, 0.75);
    assert.strictEqual(config.deactivationThreshold, 0.25);
  })
) passed++;
else failed++;

if (
  test('reverts inverted threshold pairs to defaults with a warning', () => {
    const home = makeFixture();
    const { result, output } = captureStderr(() =>
      loadJevConfig({ ...baseEnv(home), ECC_JEV_ACTIVATION_THRESHOLD: '0.3', ECC_JEV_DEACTIVATION_THRESHOLD: '0.7' })
    );
    assert.strictEqual(result.activationThreshold, DEFAULTS.activationThreshold);
    assert.strictEqual(result.deactivationThreshold, DEFAULTS.deactivationThreshold);
    assert.match(output, /threshold/i);
  })
) passed++;
else failed++;

if (
  test('rejects activationThreshold >= 1 by reverting to defaults', () => {
    const home = makeFixture();
    const tooHigh = loadJevConfig({ ...baseEnv(home), ECC_JEV_ACTIVATION_THRESHOLD: '1.5', ECC_JEV_DEACTIVATION_THRESHOLD: '0.2' });
    assert.strictEqual(tooHigh.activationThreshold, DEFAULTS.activationThreshold);
    assert.strictEqual(tooHigh.deactivationThreshold, DEFAULTS.deactivationThreshold);
    const exactlyOne = loadJevConfig({ ...baseEnv(home), ECC_JEV_ACTIVATION_THRESHOLD: '1', ECC_JEV_DEACTIVATION_THRESHOLD: '0.2' });
    assert.strictEqual(exactlyOne.activationThreshold, DEFAULTS.activationThreshold);
  })
) passed++;
else failed++;

if (
  test('clamps out-of-range thresholds into [0,1] when the pair stays valid', () => {
    const home = makeFixture();
    const { result, output } = captureStderr(() =>
      loadJevConfig({ ...baseEnv(home), ECC_JEV_DEACTIVATION_THRESHOLD: '-0.5', ECC_JEV_ACTIVATION_THRESHOLD: '0.5' })
    );
    assert.strictEqual(result.deactivationThreshold, 0);
    assert.strictEqual(result.activationThreshold, 0.5);
    assert.match(output, /clamp/i);
  })
) passed++;
else failed++;

if (
  test('falls back to defaults for non-numeric values', () => {
    const home = makeFixture();
    const config = loadJevConfig({
      ...baseEnv(home),
      ECC_JEV_ACTIVATION_THRESHOLD: 'abc',
      ECC_JEV_DEACTIVATION_THRESHOLD: 'not-a-number',
      ECC_JEV_TIMEOUT_MS: 'soon',
      ECC_JEV_MAX_RETRIES: 'lots',
    });
    assert.strictEqual(config.activationThreshold, DEFAULTS.activationThreshold);
    assert.strictEqual(config.deactivationThreshold, DEFAULTS.deactivationThreshold);
    assert.strictEqual(config.timeoutMs, DEFAULTS.timeoutMs);
    assert.strictEqual(config.maxRetries, DEFAULTS.maxRetries);
  })
) passed++;
else failed++;

if (
  test('resolves paths under ECC_AGENT_DATA_HOME (including tilde form)', () => {
    const home = makeFixture();
    const explicit = loadJevConfig({ ...baseEnv(home), ECC_AGENT_DATA_HOME: path.join(home, 'agent-data') });
    assert.strictEqual(explicit.stateDir, path.join(home, 'agent-data', 'ecc', 'jev-switchboard'));
    assert.strictEqual(explicit.telemetryPath, path.join(home, 'agent-data', 'ecc', 'jev-switchboard', 'telemetry.jsonl'));
    assert.strictEqual(explicit.registryPath, path.join(home, 'agent-data', 'ecc', 'jev-switchboard', 'jev-registry.json'));
    const tilde = loadJevConfig({ ...baseEnv(home), ECC_AGENT_DATA_HOME: '~/ad' });
    assert.strictEqual(tilde.stateDir, path.join(home, 'ad', 'ecc', 'jev-switchboard'));
  })
) passed++;
else failed++;

if (
  test('rounds timeoutMs and maxRetries and floors maxRetries at 0', () => {
    const home = makeFixture();
    const config = loadJevConfig({ ...baseEnv(home), ECC_JEV_TIMEOUT_MS: '2500.4', ECC_JEV_MAX_RETRIES: '2.7' });
    assert.strictEqual(config.timeoutMs, 2500);
    assert.strictEqual(config.maxRetries, 3);
    const negative = loadJevConfig({ ...baseEnv(home), ECC_JEV_MAX_RETRIES: '-3' });
    assert.strictEqual(negative.maxRetries, 0);
  })
) passed++;
else failed++;

if (
  test('trims the API key and baseUrl', () => {
    const home = makeFixture();
    const config = loadJevConfig({ ...baseEnv(home), TYPESAFE_API_KEY: '  sk-test  ', ECC_JEV_BASE_URL: 'https://x.example//' });
    assert.strictEqual(config.apiKey, 'sk-test');
    assert.strictEqual(config.baseUrl, 'https://x.example');
  })
) passed++;
else failed++;

if (
  test('ECC_JEV_STATE_DIR overrides the default state layout (tilde form too)', () => {
    const home = makeFixture();
    const explicit = loadJevConfig({ ...baseEnv(home), ECC_JEV_STATE_DIR: path.join(home, 'elsewhere') });
    assert.strictEqual(explicit.stateDir, path.join(home, 'elsewhere'));
    assert.strictEqual(explicit.telemetryPath, path.join(home, 'elsewhere', 'telemetry.jsonl'));
    const tilde = loadJevConfig({ ...baseEnv(home), ECC_JEV_STATE_DIR: '~/.jev-live' });
    assert.strictEqual(tilde.stateDir, path.join(home, '.jev-live'), 'tilde must expand against HOME');
  })
) passed++;
else failed++;

if (
  test('ECC_JEV_REGISTRY_PATH overrides the registry cache path (defaults into the state dir)', () => {
    const home = makeFixture();
    const overridden = loadJevConfig({ ...baseEnv(home), ECC_JEV_REGISTRY_PATH: path.join(home, 'reg.json') });
    assert.strictEqual(overridden.registryPath, path.join(home, 'reg.json'));
    const redirected = loadJevConfig({ ...baseEnv(home), ECC_JEV_STATE_DIR: path.join(home, 'sd') });
    assert.strictEqual(redirected.registryPath, path.join(home, 'sd', 'jev-registry.json'), 'registry follows a redirected state dir');
  })
) passed++;
else failed++;

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
