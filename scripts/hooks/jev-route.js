#!/usr/bin/env node
'use strict';

// UserPromptSubmit hook: JEV capability switchboard router.
// Contract: docs/JEV-SWITCHBOARD.md ("Appliers (v1)").
//
// Stays inside the <200ms no-network hook budget: two small local writes
// (payload file via atomic-write) plus one detached spawn of the evaluator.
// The Jev HTTP call happens ONLY in the detached evaluator process
// (scripts/lib/jev-switchboard/eval-runner.js), never here. Kill-switched via
// the loadJevConfig precedence chain (ECC_JEV_ENABLED / managed setup.json /
// missing TYPESAFE_API_KEY => disabled => immediate exit 0).
//
// Fail-closed on stdin truncation (gateguard convention): a prompt cut
// mid-stream is not routed - no evaluator is spawned on partial input - but
// the hook never blocks the prompt itself (exit 0).

const path = require('path');
const { spawn } = require('child_process');
const { loadJevConfig } = require('../lib/jev-switchboard/config');
const { resolveSessionKey } = require('../lib/jev-switchboard/state');
const { writeFileAtomic } = require('../lib/atomic-write');

const MAX_STDIN = 1024 * 1024;
const MAX_PROMPT_CHARS = 8000;
const MAX_ERROR_CHARS = 500;
const EVAL_RUNNER_PATH = path.join(__dirname, '..', 'lib', 'jev-switchboard', 'eval-runner.js');

function isTruncated(context) {
  if (context && context.truncated === true) return true;
  return /^(1|true|yes)$/i.test(String(process.env.ECC_HOOK_INPUT_TRUNCATED || ''));
}

function parseInput(rawInput) {
  try {
    const data = typeof rawInput === 'string' ? (rawInput.trim() ? JSON.parse(rawInput) : {}) : rawInput;
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return null;
  }
}

function allow(stdout, stderr) {
  return typeof stderr === 'string' && stderr ? { stdout, stderr, exitCode: 0 } : { stdout, exitCode: 0 };
}

/**
 * Write the evaluation payload and spawn the detached evaluator.
 * Shared by jev-reeval.js (Stop) and jev-failure-reeval.js
 * (PostToolUseFailure); spawnImpl/env/now are injectable for tests.
 *
 * @param {object} payload - {event, prompt, sessionKey, toolName, errorMessage}
 * @param {object} [options] - {config, env, spawnImpl, now}
 * @returns {{spawned: boolean, payloadPath: string|null, error: string|null}}
 */
function scheduleEvaluation(payload, options = {}) {
  const env = options.env || process.env;
  const config = options.config || loadJevConfig(env);
  if (!config.enabled) {
    return { spawned: false, payloadPath: null, error: null };
  }
  const sessionKey = String(payload.sessionKey || '').trim();
  if (!sessionKey) {
    return { spawned: false, payloadPath: null, error: 'missing session key' };
  }
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  const payloadPath = path.join(config.stateDir, `pending-${sessionKey}-${now}.json`);
  writeFileAtomic(payloadPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });

  const spawnImpl = options.spawnImpl || spawn;
  const child = spawnImpl(process.execPath, [EVAL_RUNNER_PATH, payloadPath], {
    detached: true,
    stdio: 'ignore',
    env: { ...env }
  });
  if (child && typeof child.unref === 'function') {
    child.unref();
  }
  return { spawned: true, payloadPath, error: null };
}

// question-render truncation convention: the marker fits inside the cap.
function capText(value, maxChars) {
  const text = String(value === undefined || value === null ? '' : value);
  if (text.length <= maxChars) return text;
  const marker = '...[truncated]';
  return text.slice(0, maxChars - marker.length) + marker;
}

function run(rawInput, context = {}) {
  const data = parseInput(rawInput);
  if (!data) {
    // Unparseable input: nothing to route, never break the prompt.
    return allow(typeof rawInput === 'string' ? rawInput : '', '[JevSwitchboard] Unparseable UserPromptSubmit input; skipping routing');
  }
  if (isTruncated(context)) {
    // Fail-closed (gateguard convention) applied to the routing action: no
    // evaluator is spawned on a truncated prompt. The prompt itself passes.
    return allow(
      typeof rawInput === 'string' ? rawInput : '',
      `[JevSwitchboard] Hook input exceeded the stdin budget while routing; skipping evaluation for this prompt`
    );
  }
  try {
    const env = context.env || process.env;
    const outcome = scheduleEvaluation(
      {
        event: 'user-prompt',
        prompt: capText(data.prompt, MAX_PROMPT_CHARS),
        sessionKey: resolveSessionKey(data, env)
      },
      { env, spawnImpl: context.spawnImpl, now: context.now }
    );
    if (outcome.error) {
      return allow(typeof rawInput === 'string' ? rawInput : '', `[JevSwitchboard] Routing skipped: ${outcome.error}`);
    }
  } catch (error) {
    return allow(typeof rawInput === 'string' ? rawInput : '', `[JevSwitchboard] Routing failed: ${error.message}`);
  }
  return allow(typeof rawInput === 'string' ? rawInput : '');
}

// Direct CLI execution (spawned by tests / manual runs): read bounded stdin
// with the mcp-health-check truncation conventions, then run.
function readRawStdin() {
  return new Promise(resolve => {
    let raw = '';
    let truncated = /^(1|true|yes)$/i.test(String(process.env.ECC_HOOK_INPUT_TRUNCATED || ''));
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      if (raw.length < MAX_STDIN) {
        const remaining = MAX_STDIN - raw.length;
        raw += chunk.substring(0, remaining);
        if (chunk.length > remaining) truncated = true;
      } else {
        truncated = true;
      }
    });
    process.stdin.on('end', () => resolve({ raw, truncated }));
    process.stdin.on('error', () => resolve({ raw, truncated }));
  });
}

async function main() {
  const { raw, truncated } = await readRawStdin();
  const result = run(raw, { truncated });
  if (result.stderr) process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
  process.stdout.write(result.stdout || '');
  process.exit(result.exitCode || 0);
}

if (require.main === module) {
  main();
}

module.exports = {
  EVAL_RUNNER_PATH,
  MAX_STDIN,
  MAX_PROMPT_CHARS,
  MAX_ERROR_CHARS,
  capText,
  isTruncated,
  readRawStdin,
  scheduleEvaluation,
  run
};
