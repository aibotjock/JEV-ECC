'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const telemetry = require('../../../scripts/lib/jev-switchboard/telemetry');

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-jev-telemetry-'));
}

function makeConfig(dir) {
  return { enabled: true, apiKey: 'k', stateDir: dir, telemetryPath: path.join(dir, 'telemetry.jsonl'), registryPath: path.join(dir, 'jev-registry.json') };
}

function readLines(filePath) {
  return fs.readFileSync(filePath, 'utf8').split('\n').filter(line => line.trim());
}

console.log('\nJEV switchboard telemetry');

if (
  test('appendEvent appends one JSON object per line and creates the directory', () => {
    const dir = makeFixture();
    const config = makeConfig(path.join(dir, 'nested', 'deep'));
    assert.strictEqual(telemetry.appendEvent({ config, event: { event: 'user-prompt', probabilities: { 'skill:a': 0.9 }, decisions: [{ id: 'skill:a', from: 'OFF', to: 'ON' }], latencyMs: 42, model: 'jev-1.13.0', usage: { input_tokens: 1, output_tokens: 2 } } }), true);
    assert.strictEqual(telemetry.appendEvent({ config, event: { event: 'stop', latencyMs: 7, model: 'jev-1.13.0' } }), true);
    const lines = readLines(config.telemetryPath);
    assert.strictEqual(lines.length, 2);
    const first = JSON.parse(lines[0]);
    assert.strictEqual(first.event, 'user-prompt');
    assert.strictEqual(first.latencyMs, 42);
    assert.strictEqual(first.model, 'jev-1.13.0');
    assert.deepStrictEqual(first.probabilities, { 'skill:a': 0.9 });
    assert.strictEqual(first.decisions[0].to, 'ON');
    assert.match(first.ts, /^\d{4}-\d{2}-\d{2}T/);
    assert.strictEqual(JSON.parse(lines[1]).event, 'stop');
  })
) passed++;
else failed++;

if (
  test('appendEvent long strings are capped and never throw on odd values', () => {
    const dir = makeFixture();
    const config = makeConfig(dir);
    const long = 'x'.repeat(2000);
    assert.strictEqual(telemetry.appendEvent({ config, event: { event: 'tool-failure', errorMessage: long, weird: () => {}, nested: { deep: NaN } } }), true);
    const row = JSON.parse(readLines(config.telemetryPath)[0]);
    assert.strictEqual(row.errorMessage.length, 500, 'capped string lands exactly at the 500-char budget including the marker');
    assert.match(row.errorMessage, /\.\.\.\[truncated\]$/);
    assert.ok(!('weird' in row), 'functions are dropped, not serialized');
    assert.ok(!('deep' in row.nested), 'NaN values are dropped');
  })
) passed++;
else failed++;

if (
  test('readRecentFailures scans backwards for failure-signal events only', () => {
    const dir = makeFixture();
    const config = makeConfig(dir);
    telemetry.appendEvent({ config, event: { event: 'user-prompt', latencyMs: 10, model: 'm' } });
    telemetry.appendEvent({ config, event: { event: 'tool-failure', toolName: 'Bash', errorMessage: 'exit 1', ts: '2026-01-01T00:00:00Z' } });
    telemetry.appendEvent({ config, event: { event: 'stop', latencyMs: 5, model: 'm' } });
    telemetry.appendEvent({ config, event: { event: 'eval-error', errorClass: 'JevUnavailableError', message: 'gave up', ts: '2026-01-02T00:00:00Z' } });
    telemetry.appendEvent({ config, event: { event: 'tool-failure', toolName: 'mcp__github__search', errorMessage: '429 rate limited', ts: '2026-01-03T00:00:00Z' } });

    const failures = telemetry.readRecentFailures({ config });
    assert.strictEqual(failures.length, 3);
    assert.strictEqual(failures[0].toolName, 'mcp__github__search', 'most recent failure first');
    assert.strictEqual(failures[1].event, 'eval-error');
    assert.strictEqual(failures[1].message, 'gave up');
    assert.strictEqual(failures[2].toolName, 'Bash');

    const limited = telemetry.readRecentFailures({ config, limit: 1 });
    assert.strictEqual(limited.length, 1);
    assert.strictEqual(limited[0].toolName, 'mcp__github__search');
  })
) passed++;
else failed++;

if (
  test('readRecentFailures returns [] for a missing file and skips corrupt lines', () => {
    const dir = makeFixture();
    const config = makeConfig(dir);
    assert.deepStrictEqual(telemetry.readRecentFailures({ config }), []);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(config.telemetryPath, ['{"event":"tool-failure","toolName":"a"}', 'torn tail without newline {"event"', '', '{"event":"tool-failure","toolName":"b"}'].join('\n') + '\n');
    const failures = telemetry.readRecentFailures({ config });
    assert.deepStrictEqual(failures.map(row => row.toolName), ['b', 'a']);
  })
) passed++;
else failed++;

if (
  test('appendEvent never throws on an unwritable telemetry path', () => {
    const dir = makeFixture();
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    const config = makeConfig(dir);
    config.telemetryPath = path.join(blocker, 'telemetry.jsonl'); // mkdir fails: parent is a file
    let threw = null;
    let result = null;
    try {
      result = telemetry.appendEvent({ config, event: { event: 'user-prompt' } });
    } catch (error) {
      threw = error;
    }
    assert.strictEqual(threw, null, 'appendEvent must never throw');
    assert.strictEqual(result, false);
  })
) passed++;
else failed++;

if (
  test('appendEvent with a missing config or path is a quiet no-op', () => {
    assert.strictEqual(telemetry.appendEvent({ config: null, event: { event: 'x' } }), false);
    assert.strictEqual(telemetry.appendEvent({ config: { telemetryPath: '' }, event: { event: 'x' } }), false);
  })
) passed++;
else failed++;

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
