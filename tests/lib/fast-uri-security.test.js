/** Regression for GHSA-hrr3-gc8f-f4qj through Ajv's default URI resolver. */
'use strict';

const assert = require('assert');
const Ajv = require('ajv');
const resolver = new Ajv().opts.uriResolver;
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

test('percent-encoded uppercase host octets normalize after decoding', () => {
  for (const url of ['//%41.com', '//%41.%43OM', '//A.%43om']) {
    assert.strictEqual(resolver.parse(url).host, 'a.com', url);
  }
});

test('scheme-relative percent-encoded and literal hosts normalize equally', () => {
  assert.strictEqual(resolver.normalize('//%41.com'), resolver.normalize('//a.com'));
});

test('equivalent encoded hosts compare equally', () => {
  assert.strictEqual(resolver.equal('//%41.com', '//a.com'), true);
  assert.strictEqual(resolver.equal('//%41.com', '//b.com'), false);
});

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
