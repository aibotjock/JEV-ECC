#!/usr/bin/env node
'use strict';

// PostToolUseFailure hook: JEV capability switchboard failure re-evaluation.
// Contract: docs/JEV-SWITCHBOARD.md ("Appliers (v1)").
//
// Same detached-evaluator spawn as jev-route.js (UserPromptSubmit), with
// event "tool-failure" and a bounded error excerpt from the stdin payload so
// the next evaluation carries a failure signal (readRecentFailures feeds it
// back through telemetry). One payload write + one detached spawn; no
// network, no Jev calls.

const { loadJevConfig } = require('../lib/jev-switchboard/config');
const { resolveSessionKey } = require('../lib/jev-switchboard/state');
const { scheduleEvaluation, capText, MAX_ERROR_CHARS, isTruncated, readRawStdin } = require('./jev-route');

function parseInput(rawInput) {
  try {
    const data = typeof rawInput === 'string' ? (rawInput.trim() ? JSON.parse(rawInput) : {}) : rawInput;
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return null;
  }
}

// mcp-health-check.js failureSummary convention: probe the field names the
// harnesses actually send, first match wins.
function errorExcerpt(data) {
  const toolInput = data.tool_input && typeof data.tool_input === 'object' ? data.tool_input : {};
  const pieces = [
    typeof data.error === 'string' ? data.error : '',
    typeof data.message === 'string' ? data.message : '',
    typeof data.tool_response === 'string' ? data.tool_response : '',
    typeof data.tool_output === 'string' ? data.tool_output : '',
    typeof toolInput.error === 'string' ? toolInput.error : ''
  ].filter(Boolean);
  return capText(pieces.join('\n'), MAX_ERROR_CHARS);
}

function allow(stdout, stderr) {
  return typeof stderr === 'string' && stderr ? { stdout, stderr, exitCode: 0 } : { stdout, exitCode: 0 };
}

function run(rawInput, context = {}) {
  if (isTruncated(context)) {
    // Fail-closed (gateguard convention) applied to the routing action: no
    // evaluator is spawned on truncated input. The failure event itself passes.
    return allow(
      typeof rawInput === 'string' ? rawInput : '',
      '[JevSwitchboard] Hook input exceeded the stdin budget; skipping failure re-evaluation'
    );
  }
  const data = parseInput(rawInput);
  if (!data) {
    return allow(typeof rawInput === 'string' ? rawInput : '', '[JevSwitchboard] Unparseable PostToolUseFailure input; skipping re-evaluation');
  }
  try {
    const env = context.env || process.env;
    const config = loadJevConfig(env);
    if (!config.enabled) {
      return allow(typeof rawInput === 'string' ? rawInput : '');
    }
    const outcome = scheduleEvaluation(
      {
        event: 'tool-failure',
        prompt: '',
        sessionKey: resolveSessionKey(data, env),
        toolName: capText(data.tool_name || data.name || '', 128),
        errorMessage: errorExcerpt(data)
      },
      { config, env, spawnImpl: context.spawnImpl, now: context.now }
    );
    if (outcome.error) {
      return allow(typeof rawInput === 'string' ? rawInput : '', `[JevSwitchboard] Failure re-evaluation skipped: ${outcome.error}`);
    }
  } catch (error) {
    return allow(typeof rawInput === 'string' ? rawInput : '', `[JevSwitchboard] Failure re-evaluation failed: ${error.message}`);
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

module.exports = { errorExcerpt, run };
