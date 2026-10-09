/** Regressions for GHSA-qhr7-859c-m2p7 and GHSA-6j4f-fj2g-mc7p. */
'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const { braceExpand } = require('minimatch');
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`  ✗ ${name}\n    Error: ${error.message}`);
    failed += 1;
  }
}

function assertExpansionCompletes(pattern) {
  // Isolate malicious-input cases so prior expansions and JIT warming cannot
  // hide stack exhaustion or terminate the rest of the test suite.
  const result = spawnSync(process.execPath, [
    '-e',
    'require(process.argv[1]).braceExpand(process.argv[2]);',
    require.resolve('minimatch'),
    pattern
  ], { encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  assert.strictEqual(result.status, 0, result.stderr || result.signal);
}

test('deep nested brace groups do not exhaust the stack', () => {
  const pattern = '{'.repeat(4000) + 'a,b' + '}'.repeat(4000);
  assertExpansionCompletes(pattern);
});

test('long comma-part chains do not exhaust the stack', () => {
  const pattern = '{' + '{a},'.repeat(8000) + 'b}';
  assertExpansionCompletes(pattern);
});

test('ordinary glob brace alternatives preserve their expansion', () => {
  assert.deepStrictEqual(braceExpand('src/{a,b}.{js,ts}'), [
    'src/a.js', 'src/a.ts', 'src/b.js', 'src/b.ts'
  ]);
});

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
