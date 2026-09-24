#!/usr/bin/env node
'use strict';

// Stop hook: JEV capability switchboard re-evaluation.
// Contract: docs/JEV-SWITCHBOARD.md ("Appliers (v1)").
//
// Same detached-evaluator spawn as jev-route.js (UserPromptSubmit), with
// event "stop" and no prompt text: the objective is carried from the prior
// state file when present so the end-of-turn evaluation keeps its bearings.
// Two small local reads (config + prior state), one payload write, one
// detached spawn - no network, no Jev calls, well under 200ms.

const { loadJevConfig } = require('../lib/jev-switchboard/config');
const { readState, resolveSessionKey } = require('../lib/jev-switchboard/state');
const { scheduleEvaluation, isTruncated, readRawStdin } = require('./jev-route');

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

function run(rawInput, context = {}) {
  if (isTruncated(context)) {
    // Fail-closed (gateguard convention) applied to the routing action: no
    // evaluator is spawned on truncated input. The stop event itself passes.
    return allow(
      typeof rawInput === 'string' ? rawInput : '',
      '[JevSwitchboard] Hook input exceeded the stdin budget; skipping stop re-evaluation'
    );
  }
  const data = parseInput(rawInput) || {};
  try {
    const env = context.env || process.env;
    const config = loadJevConfig(env);
    if (!config.enabled) {
      return allow(typeof rawInput === 'string' ? rawInput : '');
    }
    const sessionKey = resolveSessionKey(data, env);
    const priorState = readState({ config, sessionKey });
    const outcome = scheduleEvaluation(
      {
        event: 'stop',
        prompt: '',
        sessionKey,
        objective: priorState && typeof priorState.objective === 'string' ? priorState.objective : ''
      },
      { config, env, spawnImpl: context.spawnImpl, now: context.now }
    );
    if (outcome.error) {
      return allow(typeof rawInput === 'string' ? rawInput : '', `[JevSwitchboard] Stop re-evaluation skipped: ${outcome.error}`);
    }
  } catch (error) {
    return allow(typeof rawInput === 'string' ? rawInput : '', `[JevSwitchboard] Stop re-evaluation failed: ${error.message}`);
  }
  return allow(typeof rawInput === 'string' ? rawInput : '');
}

// Direct CLI execution: bounded stdin via jev-route.js's readRawStdin (1 MiB
// cap with truncation flag) so the hook can be exercised by spawning it with
// piped stdin without unbounded memory growth.
if (require.main === module) {
  readRawStdin().then(({ raw, truncated }) => {
    const result = run(raw, { truncated });
    if (result.stderr) process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
    process.stdout.write(result.stdout || '');
    process.exit(result.exitCode || 0);
  });
}

module.exports = { run };
