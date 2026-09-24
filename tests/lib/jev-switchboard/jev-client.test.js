'use strict';

const assert = require('node:assert');
const {
  evaluateCapabilities,
  JevError,
  JevAuthError,
  JevRateLimitError,
  JevUnprocessableError,
  JevUnavailableError,
} = require('../../../scripts/lib/jev-switchboard/jev-client');

let passed = 0;
let failed = 0;

function test(name, fn) {
  return { name, fn };
}

function jsonResponse(status, payload, headers) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: headers || {},
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  };
}

function capability(id, overrides) {
  return Object.assign(
    {
      id,
      type: 'skill',
      name: `Cap ${id}`,
      description: 'Does work for the task.',
      positiveTriggers: ['tests mentioned'],
      negativeTriggers: ['docs only'],
    },
    overrides
  );
}

function makeHarness(responses, configOverrides) {
  const calls = [];
  const delays = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(calls.length);
    return next;
  };
  const sleepImpl = async ms => {
    delays.push(ms);
  };
  const config = Object.assign({ apiKey: 'sk-test-secret-123' }, configOverrides);
  return { calls, delays, fetchImpl, sleepImpl, config };
}

// Every message/stack/name reachable through the cause chain, so leak
// assertions cover the whole chain and not just the top-level message.
function causeChainText(error) {
  const surfaces = [];
  let cause = error && error.cause;
  while (cause) {
    surfaces.push(String(cause.message || ''), String(cause.stack || ''), String(cause.name || ''));
    cause = cause.cause;
  }
  return surfaces.join('\n');
}

function brokenBodyResponse(status, payload) {
  const response = jsonResponse(status, payload);
  const rejectBody = async () => {
    throw new Error(`body stream aborted mid-read while sending Authorization: Bearer sk-test-secret-123 (${status})`);
  };
  response.text = rejectBody;
  response.json = rejectBody;
  return response;
}

async function run() {
  console.log('\nJEV switchboard client');

  const cases = [];

  cases.push(
    test('returns the success shape with model, probabilities, usage, and latency', async () => {
      const h = makeHarness([
        jsonResponse(200, {
          model: 'jev-1.13.0',
          answers: { 'skill:tdd': { type: 'noul', noul: 0.42 }, 'skill:docs': { type: 'noul', noul: 0.9 } },
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
      ]);
      const result = await evaluateCapabilities({
        state: { objective: 'ship the feature' },
        capabilities: [capability('skill:tdd'), capability('skill:docs')],
        config: h.config,
        fetchImpl: h.fetchImpl,
        sleepImpl: h.sleepImpl,
      });
      assert.strictEqual(result.model, 'jev-1.13.0');
      assert.deepStrictEqual(result.probabilities, { 'skill:tdd': 0.42, 'skill:docs': 0.9 });
      assert.deepStrictEqual(result.usage, { input_tokens: 10, output_tokens: 2 });
      assert.ok(Number.isInteger(result.latencyMs) && result.latencyMs >= 0);
    })
  );

  cases.push(
    test('batches N capabilities into exactly one fetch call with sorted noul questions', async () => {
      const h = makeHarness([jsonResponse(200, { model: 'jev-1.13.0', answers: {}, usage: {} })]);
      await evaluateCapabilities({
        state: 'objective text',
        capabilities: ['skill:zeta', 'skill:alpha', 'skill:mid'].map(id => capability(id)),
        config: h.config,
        fetchImpl: h.fetchImpl,
        sleepImpl: h.sleepImpl,
      });
      assert.strictEqual(h.calls.length, 1);
      const body = JSON.parse(h.calls[0].options.body);
      assert.deepStrictEqual(Object.keys(body.questions), ['skill:alpha', 'skill:mid', 'skill:zeta']);
      for (const id of Object.keys(body.questions)) {
        assert.strictEqual(body.questions[id].type, 'noul');
        assert.strictEqual(typeof body.questions[id].instructions, 'string');
        assert.ok(body.questions[id].instructions.length > 0);
      }
    })
  );

  cases.push(
    test('sends the pinned request shape with bearer auth to /v1/systemone', async () => {
      const h = makeHarness([jsonResponse(200, { model: 'jev-1.13.0', answers: {}, usage: {} })]);
      await evaluateCapabilities({
        state: { objective: 'x' },
        capabilities: [capability('skill:alpha'), capability('skill:beta')],
        config: h.config,
        fetchImpl: h.fetchImpl,
        sleepImpl: h.sleepImpl,
      });
      const call = h.calls[0];
      assert.strictEqual(call.url, 'https://api.typesafe.ai/v1/systemone');
      assert.strictEqual(call.options.method, 'POST');
      assert.strictEqual(call.options.headers.Authorization, 'Bearer sk-test-secret-123');
      assert.strictEqual(call.options.headers['Content-Type'], 'application/json');
      const body = JSON.parse(call.options.body);
      assert.strictEqual(body.model, 'jev-1.13.0');
      assert.deepStrictEqual(body.state, { objective: 'x' });
      assert.deepStrictEqual(Object.keys(body.questions), ['skill:alpha', 'skill:beta']);
    })
  );

  cases.push(
    test('retries a 429 honoring retry-after-ms then succeeds', async () => {
      const h = makeHarness([
        jsonResponse(429, { error: 'slow down' }, { 'retry-after-ms': '25' }),
        jsonResponse(200, { model: 'jev-1.13.0', answers: { 'skill:tdd': { type: 'noul', noul: 0.7 } }, usage: {} }),
      ]);
      const result = await evaluateCapabilities({
        state: {},
        capabilities: [capability('skill:tdd')],
        config: h.config,
        fetchImpl: h.fetchImpl,
        sleepImpl: h.sleepImpl,
      });
      assert.strictEqual(h.calls.length, 2);
      assert.deepStrictEqual(h.delays, [25]);
      assert.deepStrictEqual(result.probabilities, { 'skill:tdd': 0.7 });
    })
  );

  cases.push(
    test('uses exponential backoff (500ms doubling, max 5s) when no Retry-After is present', async () => {
      const h = makeHarness([jsonResponse(500, { error: 'boom' })]);
      await assert.rejects(
        () =>
          evaluateCapabilities({
            state: {},
            capabilities: [capability('skill:tdd')],
            config: { ...h.config, maxRetries: 2 },
            fetchImpl: h.fetchImpl,
            sleepImpl: h.sleepImpl,
          }),
        JevUnavailableError
      );
      assert.strictEqual(h.calls.length, 3); // initial + 2 retries
      assert.deepStrictEqual(h.delays, [500, 1000]);
    })
  );

  cases.push(
    test('gives up after maxRetries on 5xx with JevUnavailableError', async () => {
      const h = makeHarness([jsonResponse(503, { error: 'unavailable' })]);
      await assert.rejects(
        () =>
          evaluateCapabilities({
            state: {},
            capabilities: [capability('skill:tdd')],
            config: { ...h.config, maxRetries: 2 },
            fetchImpl: h.fetchImpl,
            sleepImpl: h.sleepImpl,
          }),
        JevUnavailableError
      );
      assert.strictEqual(h.calls.length, 3);
    })
  );

  cases.push(
    test('throws JevRateLimitError when 429 persists past maxRetries', async () => {
      const h = makeHarness([jsonResponse(429, { error: 'slow down' })]);
      await assert.rejects(
        () =>
          evaluateCapabilities({
            state: {},
            capabilities: [capability('skill:tdd')],
            config: { ...h.config, maxRetries: 1 },
            fetchImpl: h.fetchImpl,
            sleepImpl: h.sleepImpl,
          }),
        JevRateLimitError
      );
      assert.strictEqual(h.calls.length, 2);
    })
  );

  cases.push(
    test('does not retry a 401 and throws JevAuthError', async () => {
      const h = makeHarness([jsonResponse(401, { error: 'bad key' })]);
      await assert.rejects(
        () =>
          evaluateCapabilities({
            state: {},
            capabilities: [capability('skill:tdd')],
            config: h.config,
            fetchImpl: h.fetchImpl,
            sleepImpl: h.sleepImpl,
          }),
        JevAuthError
      );
      assert.strictEqual(h.calls.length, 1);
      assert.strictEqual(h.delays.length, 0);
    })
  );

  cases.push(
    test('maps 422 to JevUnprocessableError carrying the field the body names, without retry', async () => {
      const h = makeHarness([jsonResponse(422, { error: { message: 'Invalid request', param: 'state' } })]);
      let caught = null;
      try {
        await evaluateCapabilities({
          state: {},
          capabilities: [capability('skill:tdd')],
          config: h.config,
          fetchImpl: h.fetchImpl,
          sleepImpl: h.sleepImpl,
        });
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof JevUnprocessableError);
      assert.ok(caught instanceof JevError);
      assert.strictEqual(caught.field, 'state');
      assert.match(caught.message, /state/);
      assert.strictEqual(h.calls.length, 1);
    })
  );

  cases.push(
    test('leaves missing answer ids absent from probabilities (never 0)', async () => {
      const h = makeHarness([
        jsonResponse(200, {
          model: 'jev-1.13.0',
          answers: { 'skill:answered': { type: 'noul', noul: 0.42 } },
          usage: {},
        }),
      ]);
      const result = await evaluateCapabilities({
        state: {},
        capabilities: [capability('skill:answered'), capability('skill:skipped')],
        config: h.config,
        fetchImpl: h.fetchImpl,
        sleepImpl: h.sleepImpl,
      });
      assert.deepStrictEqual(result.probabilities, { 'skill:answered': 0.42 });
      assert.ok(!('skill:skipped' in result.probabilities));
    })
  );

  cases.push(
    test('echoes the response model and falls back to the requested model', async () => {
      const echoed = makeHarness([jsonResponse(200, { model: 'jev-echoed-model', answers: {}, usage: {} })]);
      const withModel = await evaluateCapabilities({
        state: {},
        capabilities: [capability('skill:tdd')],
        config: echoed.config,
        fetchImpl: echoed.fetchImpl,
        sleepImpl: echoed.sleepImpl,
      });
      assert.strictEqual(withModel.model, 'jev-echoed-model');
      const silent = makeHarness([jsonResponse(200, { answers: {}, usage: {} })]);
      const withoutModel = await evaluateCapabilities({
        state: {},
        capabilities: [capability('skill:tdd')],
        config: { ...silent.config, model: 'jev-1.13.0' },
        fetchImpl: silent.fetchImpl,
        sleepImpl: silent.sleepImpl,
      });
      assert.strictEqual(withoutModel.model, 'jev-1.13.0');
    })
  );

  cases.push(
    test('never leaks the API key or Authorization header in error output', async () => {
      const network = makeHarness([new Error('fetch failed while sending Authorization: Bearer sk-test-secret-123')]);
      await assert.rejects(
        () =>
          evaluateCapabilities({
            state: {},
            capabilities: [capability('skill:tdd')],
            config: { ...network.config, maxRetries: 0 },
            fetchImpl: network.fetchImpl,
            sleepImpl: network.sleepImpl,
          }),
        error => {
          assert.ok(!error.message.includes('sk-test-secret-123'), `key leaked: ${error.message}`);
          assert.ok(!String(error.stack || '').includes('sk-test-secret-123'));
          return error instanceof JevUnavailableError;
        }
      );
      const server = makeHarness([jsonResponse(500, { error: 'boom sk-test-secret-123' })]);
      await assert.rejects(
        () =>
          evaluateCapabilities({
            state: {},
            capabilities: [capability('skill:tdd')],
            config: { ...server.config, maxRetries: 0 },
            fetchImpl: server.fetchImpl,
            sleepImpl: server.sleepImpl,
          }),
        error => {
          assert.ok(!error.message.includes('sk-test-secret-123'), `key leaked: ${error.message}`);
          return error instanceof JevUnavailableError;
        }
      );
    })
  );

  cases.push(
    test('times out per attempt and classifies as unavailable', async () => {
      const calls = [];
      const fetchImpl = () => {
        calls.push(1);
        return new Promise(() => {});
      };
      await assert.rejects(
        () =>
          evaluateCapabilities({
            state: {},
            capabilities: [capability('skill:tdd')],
            config: { apiKey: 'sk-test-secret-123', timeoutMs: 25, maxRetries: 0 },
            fetchImpl,
            sleepImpl: async () => {},
          }),
        error => {
          assert.ok(error instanceof JevUnavailableError);
          assert.match(error.message, /timed out/);
          return true;
        }
      );
      assert.strictEqual(calls.length, 1);
    })
  );

  cases.push(
    test('retries connection errors then succeeds', async () => {
      const h = makeHarness([
        new TypeError('fetch failed'),
        jsonResponse(200, { model: 'jev-1.13.0', answers: { 'skill:tdd': { type: 'noul', noul: 0.55 } }, usage: {} }),
      ]);
      const result = await evaluateCapabilities({
        state: {},
        capabilities: [capability('skill:tdd')],
        config: h.config,
        fetchImpl: h.fetchImpl,
        sleepImpl: h.sleepImpl,
      });
      assert.strictEqual(h.calls.length, 2);
      assert.deepStrictEqual(result.probabilities, { 'skill:tdd': 0.55 });
    })
  );

  cases.push(
    test('a body read that rejects on a 2xx throws the typed connection-classified unavailable error with a redacted cause', async () => {
      const h = makeHarness([brokenBodyResponse(200, { model: 'jev-1.13.0', answers: {}, usage: {} })]);
      let caught = null;
      try {
        await evaluateCapabilities({
          state: {},
          capabilities: [capability('skill:tdd')],
          config: h.config,
          fetchImpl: h.fetchImpl,
          sleepImpl: h.sleepImpl,
        });
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof JevUnavailableError, `expected JevUnavailableError, got: ${caught && caught.constructor.name}`);
      assert.strictEqual(caught.code, 'connection', 'classified like a connection failure');
      assert.ok(!caught.message.includes('sk-test-secret-123'), `key leaked: ${caught.message}`);
      assert.ok(!caught.message.includes('Bearer'), `Authorization leaked: ${caught.message}`);
      const chain = causeChainText(caught);
      assert.ok(caught.cause, 'the connection-classified cause is attached');
      assert.ok(!chain.includes('sk-test-secret-123'), `key leaked via cause chain: ${chain}`);
      assert.ok(!chain.includes('Bearer'), `Authorization leaked via cause chain: ${chain}`);
      assert.ok(chain.includes('[REDACTED]'), `cause is scrubbed, not raw: ${chain}`);
    })
  );

  cases.push(
    test('a body read that rejects on a 500 is classified as retryable and retried per policy', async () => {
      const h = makeHarness([brokenBodyResponse(500, { error: 'boom' })]);
      let caught = null;
      try {
        await evaluateCapabilities({
          state: {},
          capabilities: [capability('skill:tdd')],
          config: { ...h.config, maxRetries: 2 },
          fetchImpl: h.fetchImpl,
          sleepImpl: h.sleepImpl,
        });
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof JevUnavailableError, `expected JevUnavailableError, got: ${caught && caught.constructor.name}`);
      assert.strictEqual(h.calls.length, 3, 'initial attempt + 2 retries (body-read failure is retryable)');
      assert.deepStrictEqual(h.delays, [500, 1000], 'exponential backoff applies');
      const chain = causeChainText(caught);
      assert.ok(!caught.message.includes('sk-test-secret-123'), `key leaked: ${caught.message}`);
      assert.ok(!chain.includes('sk-test-secret-123'), `key leaked via cause chain: ${chain}`);
      assert.ok(!chain.includes('Bearer'), `Authorization leaked via cause chain: ${chain}`);
      assert.ok(chain.includes('[REDACTED]'), `cause is scrubbed, not raw: ${chain}`);
    })
  );

  cases.push(
    test('requires an API key before doing any work', async () => {
      await assert.rejects(
        () =>
          evaluateCapabilities({
            state: {},
            capabilities: [capability('skill:tdd')],
            config: { apiKey: '' },
            fetchImpl: async () => {
              throw new Error('must not be called');
            },
            sleepImpl: async () => {},
          }),
        JevAuthError
      );
    })
  );

  for (const testCase of cases) {
    try {
      await testCase.fn();
      passed++;
      console.log(`  ✓ ${testCase.name}`);
    } catch (error) {
      failed++;
      console.log(`  ✗ ${testCase.name}`);
      console.log(`    Error: ${error.message}`);
    }
  }

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
