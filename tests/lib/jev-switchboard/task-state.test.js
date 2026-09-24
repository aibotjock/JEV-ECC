'use strict';

const assert = require('node:assert');
const { buildTaskState, deriveObjective, extractExplicitRequests, normalizeFailureSignals, MAX_OBJECTIVE_CHARS } = require('../../../scripts/lib/jev-switchboard/task-state');
const { MAX_STATE_ARRAY_ITEMS, MAX_STATE_STRING_CHARS } = require('../../../scripts/lib/jev-switchboard/question-render');

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

console.log('\nJEV switchboard task-state builder');

if (
  test('builds the documented shape for a user-prompt event', () => {
    const state = buildTaskState({
      event: 'user-prompt',
      prompt: 'Review the auth module. Also add tests for it.',
      sessionKey: 'sess-1',
      repoContext: { cwd: '/repo' },
      recentFailures: [{ toolName: 'Bash', errorMessage: 'exit 1' }]
    });
    assert.deepStrictEqual(Object.keys(state), ['failureSignals', 'objective', 'phase', 'repoContext', 'sessionKey']);
    assert.strictEqual(state.objective, 'Review the auth module.');
    assert.strictEqual(state.phase, 'planning');
    assert.strictEqual(state.sessionKey, 'sess-1');
    assert.deepStrictEqual(state.repoContext, { cwd: '/repo' });
    assert.deepStrictEqual(state.failureSignals, ['Bash: exit 1']);
  })
) passed++;
else failed++;

if (
  test('phase follows the routing event', () => {
    assert.strictEqual(buildTaskState({ event: 'stop', sessionKey: 's' }).phase, 'closing');
    assert.strictEqual(buildTaskState({ event: 'tool-failure', sessionKey: 's' }).phase, 'recovering');
    assert.strictEqual(buildTaskState({ event: 'user-prompt', sessionKey: 's' }).phase, 'planning');
    assert.strictEqual(buildTaskState({ event: 'nonsense', sessionKey: 's' }).phase, 'planning', 'unknown events fall back to user-prompt semantics');
  })
) passed++;
else failed++;

if (
  test('stop events carry the prior objective; prompts override it', () => {
    const carried = buildTaskState({ event: 'stop', prompt: '', priorObjective: 'ship the release', sessionKey: 's' });
    assert.strictEqual(carried.objective, 'ship the release');
    const overridden = buildTaskState({ event: 'stop', prompt: 'new goal now', priorObjective: 'ship the release', sessionKey: 's' });
    assert.strictEqual(overridden.objective, 'new goal now');
    const bare = buildTaskState({ event: 'stop', prompt: '', sessionKey: 's' });
    assert.ok(!('objective' in bare), 'empty objective fields are dropped entirely');
  })
) passed++;
else failed++;

if (
  test('objective collapses whitespace and caps at the question-render string budget', () => {
    const messy = deriveObjective('user-prompt', '  fix   the\n\nlogin   bug  ');
    assert.strictEqual(messy, 'fix the login bug');
    const long = 'y'.repeat(MAX_STATE_STRING_CHARS + 500);
    const objective = deriveObjective('user-prompt', long);
    assert.strictEqual(objective.length, MAX_STATE_STRING_CHARS);
    assert.match(objective, /\.\.\.\[truncated\]$/);
    assert.ok(MAX_OBJECTIVE_CHARS <= MAX_STATE_STRING_CHARS);
  })
) passed++;
else failed++;

if (
  test('explicitRequests pulls slash commands and backtick spans, capped at 5', () => {
    const found = extractExplicitRequests('run /code-review then `/tdd` and /e2e plus `react-patterns` maybe /plan');
    assert.deepStrictEqual(found, ['/code-review', '/tdd', '/e2e', 'react-patterns', '/plan']);
    assert.deepStrictEqual(extractExplicitRequests('no requests here'), undefined);
    assert.deepStrictEqual(extractExplicitRequests(''), undefined);
  })
) passed++;
else failed++;

if (
  test('failureSignals accept objects and raw strings, capped at the array budget', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ toolName: `tool${i}`, errorMessage: `boom ${i}` }));
    const signals = normalizeFailureSignals(many);
    assert.strictEqual(signals.length, MAX_STATE_ARRAY_ITEMS);
    assert.strictEqual(signals[0], 'tool0: boom 0');
    assert.strictEqual(signals[4], 'tool4: boom 4');
    assert.deepStrictEqual(normalizeFailureSignals(['plain signal']), ['plain signal']);
    assert.deepStrictEqual(normalizeFailureSignals([]), undefined);
    assert.deepStrictEqual(normalizeFailureSignals(null), undefined);
    assert.deepStrictEqual(normalizeFailureSignals([{ toolName: '', errorMessage: '' }]), undefined);
  })
) passed++;
else failed++;

if (
  test('activeCapabilities are deduped, sorted, and capped', () => {
    const state = buildTaskState({
      event: 'user-prompt',
      prompt: 'x',
      sessionKey: 's',
      activeCapabilities: ['skill:z', 'mcp:a', 'skill:z', 'skill:b', 'tool:c', 'skill:d', 'skill:e', 'skill:f']
    });
    assert.strictEqual(state.activeCapabilities.length, MAX_STATE_ARRAY_ITEMS);
    assert.deepStrictEqual(state.activeCapabilities, ['mcp:a', 'skill:b', 'skill:d', 'skill:e', 'skill:f']);
  })
) passed++;
else failed++;

if (
  test('repoContext keeps only usable fields', () => {
    assert.deepStrictEqual(buildTaskState({ event: 'user-prompt', sessionKey: 's', repoContext: { cwd: '  ', projectRoot: '/p', languages: ['js', '', 'py', 'go', 'rs', 'extra'] } }).repoContext, {
      projectRoot: '/p',
      languages: ['js', 'py', 'go', 'rs', 'extra']
    });
    assert.ok(!('repoContext' in buildTaskState({ event: 'user-prompt', sessionKey: 's' })));
  })
) passed++;
else failed++;

if (
  test('empty inputs still produce a compact, JSON-serializable state', () => {
    const state = buildTaskState({});
    const roundtripped = JSON.parse(JSON.stringify(state));
    assert.deepStrictEqual(roundtripped, state);
    assert.ok(typeof state.phase === 'string');
    assert.ok(!('objective' in state));
    assert.ok(!('failureSignals' in state));
  })
) passed++;
else failed++;

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
