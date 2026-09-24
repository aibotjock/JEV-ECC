'use strict';

const assert = require('node:assert');
const { renderQuestion, renderState, MAX_QUESTION_WORDS } = require('../../../scripts/lib/jev-switchboard/question-render');

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

function wordCount(text) {
  const trimmed = String(text || '').trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

console.log('\nJEV switchboard question rendering');

if (
  test('renders a noul question referencing state fields with backticks', () => {
    const question = renderQuestion({
      id: 'skill:tdd',
      type: 'skill',
      name: 'TDD',
      description: 'Test-driven development workflow.',
      positiveTriggers: ['write tests first'],
      negativeTriggers: ['docs only'],
    });
    assert.strictEqual(question.type, 'noul');
    assert.strictEqual(typeof question.instructions, 'string');
    assert.ok(question.instructions.includes('`objective`'));
    assert.ok(question.instructions.includes('`phase`'));
    assert.ok(question.instructions.includes('`repoContext`'));
    assert.ok(question.instructions.includes('`activeCapabilities`'));
    assert.ok(question.instructions.includes('`explicitRequests`'));
    assert.ok(question.instructions.includes('`failureSignals`'));
    assert.ok(question.instructions.includes('"TDD"'));
  })
) passed++;
else failed++;

if (
  test('builds instructions from triggers and description', () => {
    const question = renderQuestion({
      id: 'skill:tdd',
      type: 'skill',
      name: 'TDD',
      description: 'Test-driven development workflow.',
      positiveTriggers: ['write tests first', 'red-green-refactor'],
      negativeTriggers: ['docs only'],
    });
    assert.ok(question.instructions.includes('Needed when: write tests first; red-green-refactor.'));
    assert.ok(question.instructions.includes('Not needed when: docs only.'));
    assert.ok(question.instructions.includes('Capability: Test-driven development workflow.'));
  })
) passed++;
else failed++;

if (
  test(`keeps questions within the ${MAX_QUESTION_WORDS}-word cap for oversized capabilities`, () => {
    const fat = renderQuestion({
      id: 'skill:fat',
      type: 'skill',
      name: 'Enormous Capability With A Very Long Name Indeed',
      description: `description word ${Array.from({ length: 120 }, (_v, i) => `d${i}`).join(' ')}`,
      positiveTriggers: Array.from({ length: 15 }, (_v, i) => `positive trigger phrase number ${i} goes here`),
      negativeTriggers: Array.from({ length: 15 }, (_v, i) => `negative trigger phrase number ${i} goes here`),
    });
    assert.strictEqual(wordCount(fat.instructions) <= MAX_QUESTION_WORDS, true);
    assert.ok(fat.instructions.includes('`objective`'));
    const longNameOnly = renderQuestion({
      id: 'skill:name',
      type: 'tool',
      name: Array.from({ length: 80 }, (_v, i) => `n${i}`).join(' '),
      description: '',
    });
    assert.strictEqual(wordCount(longNameOnly.instructions) <= MAX_QUESTION_WORDS, true);
  })
) passed++;
else failed++;

if (
  test('sanitizes backticks from capability-provided text so refs cannot be forged', () => {
    const question = renderQuestion({
      id: 'skill:evil',
      type: 'skill',
      name: 'evil `objective` fake',
      description: 'desc with `phase` inside',
      positiveTriggers: ['`repoContext` trick'],
      negativeTriggers: [],
    });
    const objectiveRefs = question.instructions.match(/`objective`/g) || [];
    assert.strictEqual(objectiveRefs.length, 1); // only the legitimate header ref
    assert.ok(!question.instructions.includes('`phase` inside'));
    assert.ok(!question.instructions.includes('`repoContext` trick'));
    assert.ok(!question.instructions.includes('`objective` fake'));
  })
) passed++;
else failed++;

if (
  test('falls back to id for a missing name and handles an empty capability', () => {
    const byId = renderQuestion({ id: 'skill:anon', type: 'skill' });
    assert.strictEqual(byId.type, 'noul');
    assert.ok(byId.instructions.includes('"skill:anon"'));
    assert.ok(wordCount(byId.instructions) <= MAX_QUESTION_WORDS);
    const empty = renderQuestion({});
    assert.strictEqual(empty.type, 'noul');
    assert.ok(empty.instructions.includes('"capability"'));
    assert.ok(empty.instructions.includes('`objective`'));
    assert.strictEqual(renderQuestion(null).type, 'noul');
  })
) passed++;
else failed++;

if (
  test('renders deterministically for the same input', () => {
    const cap = {
      id: 'skill:tdd',
      type: 'skill',
      name: 'TDD',
      description: 'Test-driven development workflow.',
      positiveTriggers: ['write tests first'],
      negativeTriggers: ['docs only'],
    };
    assert.deepStrictEqual(renderQuestion(cap), renderQuestion(cap));
  })
) passed++;
else failed++;

if (
  test('renderState drops empty fields but keeps meaningful falsy values', () => {
    const state = renderState({
      objective: 'ship it',
      missing: undefined,
      nulled: null,
      emptyString: '',
      emptyArray: [],
      emptyObject: {},
      zero: 0,
      flag: false,
    });
    assert.deepStrictEqual(state, { objective: 'ship it', zero: 0, flag: false });
  })
) passed++;
else failed++;

if (
  test('renderState caps arrays at five items', () => {
    const state = renderState({ explicitRequests: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] });
    assert.deepStrictEqual(state.explicitRequests, ['a', 'b', 'c', 'd', 'e']);
  })
) passed++;
else failed++;

if (
  test('renderState caps strings at 400 chars with a truncation marker', () => {
    const state = renderState({ objective: 'a'.repeat(500) });
    assert.strictEqual(state.objective.length, 400);
    assert.ok(state.objective.endsWith('...[truncated]'));
    const short = renderState({ objective: 'a'.repeat(400) });
    assert.strictEqual(short.objective.length, 400);
    assert.ok(!short.objective.includes('[truncated]'));
  })
) passed++;
else failed++;

if (
  test('renderState compacts nested objects with sorted keys for deterministic JSON', () => {
    const state = renderState({ z: { b: 1, a: '' }, a: 2, nested: { keep: 'x', drop: null } });
    assert.deepStrictEqual(state, { a: 2, nested: { keep: 'x' }, z: { b: 1 } });
    assert.strictEqual(JSON.stringify(state), '{"a":2,"nested":{"keep":"x"},"z":{"b":1}}');
    const withArrays = renderState({ failureSignals: [{ note: 'b'.repeat(600), ok: 1 }] });
    assert.strictEqual(withArrays.failureSignals[0].note.length, 400);
    assert.strictEqual(withArrays.failureSignals[0].ok, 1);
  })
) passed++;
else failed++;

if (
  test('renderState returns an empty object for null or undefined input', () => {
    assert.deepStrictEqual(renderState(null), {});
    assert.deepStrictEqual(renderState(undefined), {});
  })
) passed++;
else failed++;

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
