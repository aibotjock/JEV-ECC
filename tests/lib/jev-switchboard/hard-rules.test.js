'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { collectHardRules } = require('../../../scripts/lib/jev-switchboard/hard-rules');

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

function makeRegistry() {
  return {
    entries: [
      { id: 'mcp:github', type: 'mcp', name: 'GitHub Server', available: true },
      { id: 'skill:git', type: 'skill', name: 'git', available: true },
      { id: 'skill:git-workflow', type: 'skill', name: 'Git Workflow', available: true },
      { id: 'skill:legacy-thing', type: 'skill', name: 'Legacy Thing', available: false },
      { id: 'skill:plain', type: 'skill', name: 'plain', available: true },
      { id: 'skill:secure-guard', type: 'skill', name: 'secure guard', available: true }
    ]
  };
}

const NO_ENV = {};

console.log('\nJEV switchboard hard rules (collectHardRules)');

if (test('kill switch dominates every other rule (config.enabled false)', () => {
  const result = collectHardRules({
    registry: makeRegistry(),
    promptText: 'run git and Git Workflow and mcp:github now',
    config: { enabled: false, alwaysLocked: ['skill:secure-guard'] },
    env: NO_ENV
  });
  assert.deepStrictEqual(result, { locked: [], forcedOff: [], passThrough: true });
})) passed++;
else failed++;

if (test('kill switch also fires from the ECC_JEV_ENABLED env var', () => {
  const viaEnv = collectHardRules({ registry: makeRegistry(), promptText: 'use git', config: { enabled: true }, env: { ECC_JEV_ENABLED: 'false' } });
  assert.deepStrictEqual(viaEnv, { locked: [], forcedOff: [], passThrough: true });
  const viaZero = collectHardRules({ registry: makeRegistry(), promptText: 'use git', config: {}, env: { ECC_JEV_ENABLED: '0' } });
  assert.deepStrictEqual(viaZero, { locked: [], forcedOff: [], passThrough: true });
  const enabled = collectHardRules({ registry: makeRegistry(), promptText: 'use git', config: { enabled: true }, env: { ECC_JEV_ENABLED: 'true' } });
  assert.strictEqual(enabled.passThrough, false);
})) passed++;
else failed++;

if (test('locks capabilities explicitly requested by name (word boundary, case-insensitive)', () => {
  const result = collectHardRules({ registry: makeRegistry(), promptText: 'run git status', config: {}, env: NO_ENV });
  assert.deepStrictEqual(result.locked, [{ id: 'skill:git', source: 'explicit-request' }]);
  const upper = collectHardRules({ registry: makeRegistry(), promptText: 'GIT PLEASE', config: {}, env: NO_ENV });
  assert.deepStrictEqual(upper.locked, [{ id: 'skill:git', source: 'explicit-request' }]);
  assert.strictEqual(result.passThrough, false);
})) passed++;
else failed++;

if (test('"git" must not match inside "digit" (word-boundary matching)', () => {
  const result = collectHardRules({ registry: makeRegistry(), promptText: 'check the digits in column two', config: {}, env: NO_ENV });
  assert.deepStrictEqual(result.locked, []);
  const sneaky = collectHardRules({ registry: makeRegistry(), promptText: 'digit gitting committed', config: {}, env: NO_ENV });
  assert.deepStrictEqual(sneaky.locked, []);
})) passed++;
else failed++;

if (test('matches multi-word names and ids as whole units only', () => {
  const byName = collectHardRules({ registry: makeRegistry(), promptText: 'follow the Git Workflow exactly', config: {}, env: NO_ENV });
  assert.deepStrictEqual(byName.locked, [
    { id: 'skill:git', source: 'explicit-request' },
    { id: 'skill:git-workflow', source: 'explicit-request' }
  ]);
  const byId = collectHardRules({ registry: makeRegistry(), promptText: 'use mcp:github for the issues', config: {}, env: NO_ENV });
  assert.deepStrictEqual(byId.locked, [{ id: 'mcp:github', source: 'explicit-request' }]);
  // 'git' inside 'github' is not a word-boundary match either.
  const glued = collectHardRules({ registry: makeRegistry(), promptText: 'checkout via github actions', config: {}, env: NO_ENV });
  assert.deepStrictEqual(glued.locked, []);
})) passed++;
else failed++;

if (test('locks alwaysLocked overlay ids as security policy', () => {
  const result = collectHardRules({ registry: makeRegistry(), promptText: '', config: { alwaysLocked: ['skill:secure-guard'] }, env: NO_ENV });
  assert.deepStrictEqual(result.locked, [{ id: 'skill:secure-guard', source: 'security-policy' }]);
  // The overlay may also ride on the registry build.
  const viaRegistry = collectHardRules({
    registry: { entries: makeRegistry().entries, alwaysLocked: ['skill:secure-guard'] },
    promptText: '',
    config: {},
    env: NO_ENV
  });
  assert.deepStrictEqual(viaRegistry.locked, [{ id: 'skill:secure-guard', source: 'security-policy' }]);
})) passed++;
else failed++;

if (test('forces unavailable capabilities off', () => {
  const result = collectHardRules({ registry: makeRegistry(), promptText: '', config: {}, env: NO_ENV });
  assert.deepStrictEqual(result.forcedOff, [{ id: 'skill:legacy-thing', reason: 'unavailable' }]);
})) passed++;
else failed++;

if (test('explicit request outranks the security-policy source on the same id', () => {
  const result = collectHardRules({ registry: makeRegistry(), promptText: 'use git now', config: { alwaysLocked: ['skill:git'] }, env: NO_ENV });
  assert.deepStrictEqual(result.locked, [{ id: 'skill:git', source: 'explicit-request' }]);
})) passed++;
else failed++;

if (test('empty and missing prompts produce no explicit locks while other rules still apply', () => {
  const empty = collectHardRules({ registry: makeRegistry(), promptText: '', config: { alwaysLocked: ['skill:secure-guard'] }, env: NO_ENV });
  assert.deepStrictEqual(empty.locked, [{ id: 'skill:secure-guard', source: 'security-policy' }]);
  assert.deepStrictEqual(empty.forcedOff, [{ id: 'skill:legacy-thing', reason: 'unavailable' }]);
  const missing = collectHardRules({ registry: makeRegistry(), promptText: undefined, config: {}, env: NO_ENV });
  assert.deepStrictEqual(missing.locked, []);
  assert.deepStrictEqual(missing.forcedOff, [{ id: 'skill:legacy-thing', reason: 'unavailable' }]);
})) passed++;
else failed++;

if (test('returns buckets sorted by id regardless of registry order', () => {
  const result = collectHardRules({ registry: makeRegistry(), promptText: 'git plus mcp:github plus Git Workflow', config: { alwaysLocked: ['skill:secure-guard'] }, env: NO_ENV });
  assert.deepStrictEqual(result.locked, [
    { id: 'mcp:github', source: 'explicit-request' },
    { id: 'skill:git', source: 'explicit-request' },
    { id: 'skill:git-workflow', source: 'explicit-request' },
    { id: 'skill:secure-guard', source: 'security-policy' }
  ]);
  const ids = result.forcedOff.map(item => item.id);
  assert.deepStrictEqual(ids, [...ids].sort());
})) passed++;
else failed++;

if (test('handles missing registry and config without throwing', () => {
  const result = collectHardRules({ promptText: 'anything at all', env: NO_ENV });
  assert.deepStrictEqual(result, { locked: [], forcedOff: [], passThrough: false });
  const noArgs = collectHardRules();
  assert.deepStrictEqual(noArgs, { locked: [], forcedOff: [], passThrough: false });
})) passed++;
else failed++;

if (test('reads the prompt from a fixture file on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-jev-hard-rules-'));
  try {
    const promptPath = path.join(dir, 'prompt.txt');
    fs.writeFileSync(promptPath, 'please use git for this change', 'utf8');
    const promptText = fs.readFileSync(promptPath, 'utf8');
    const result = collectHardRules({ registry: makeRegistry(), promptText, config: {}, env: NO_ENV });
    assert.deepStrictEqual(result.locked, [{ id: 'skill:git', source: 'explicit-request' }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})) passed++;
else failed++;

console.log(`Results: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
