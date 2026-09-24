#!/usr/bin/env node
'use strict';

// Detached evaluator for the JEV capability switchboard.
// Contract: docs/JEV-SWITCHBOARD.md ("eval-runner.js").
//
// This is the ONLY component allowed to call Jev: hooks spawn it detached
// (`spawn(process.execPath, [evalRunnerPath, payloadPath], {detached:true,
// stdio:'ignore'}).unref()`) and exit immediately, so the network call never
// runs inside a <200ms hook process.
//
// Flow per invocation:
//   acquire <stateDir>/eval-<sessionKey>.lock via openSync(..., 'wx')
//     - EEXIST with mtime older than LOCK_STALE_MS -> steal (unlink + retry)
//     - EEXIST fresh -> exit quietly (an evaluation is already running)
//   loadJevConfig (disabled -> no-op) -> loadRegistry -> buildTaskState ->
//   evaluateCapabilities (network) -> collectHardRules -> decide ->
//   writeState -> telemetry.appendEvent -> release lock in finally.
//
// Failure policy: any error is caught, logged to telemetry as an
// {event:'eval-error', errorClass, message} row, and the process still exits
// 0 - nothing is ever thrown across the hook boundary, and current states are
// kept (the controller re-runs against the prior state file next event).

const fs = require('fs');
const path = require('path');
const { loadJevConfig } = require('./config');
const { loadRegistry } = require('./registry');
const { evaluateCapabilities } = require('./jev-client');
const { collectHardRules } = require('./hard-rules');
const { decide } = require('./controller');
const { buildTaskState } = require('./task-state');
const { readState, writeState, activeCapabilityIds } = require('./state');
const telemetry = require('./telemetry');

const LOCK_STALE_MS = 30 * 1000;

// Ownership tokens: each acquired lock records a per-process token written
// into the lock file. releaseLock only unlinks a lock whose content still
// matches OUR token, so an evaluator that overruns LOCK_STALE_MS and gets
// stolen from cannot release the successor's lock on its way out.
const lockOwnership = new Map();
let lockTokenCounter = 0;

function makeLockToken() {
  lockTokenCounter += 1;
  return `${process.pid}-${lockTokenCounter}-${Math.random().toString(36).slice(2, 10)}`;
}

function lockFilePath({ config, sessionKey }) {
  return path.join(config.stateDir, `eval-${sessionKey}.lock`);
}

// O_EXCL lockfile acquisition. Returns true when the lock was acquired (fresh
// or stolen from a stale holder), false when a live evaluation owns it.
function acquireLock(lockPath) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const token = makeLockToken();
      const descriptor = fs.openSync(lockPath, 'wx', 0o600);
      try {
        fs.writeSync(descriptor, token);
      } finally {
        fs.closeSync(descriptor);
      }
      lockOwnership.set(lockPath, token);
      return true;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    }
    try {
      const stat = fs.statSync(lockPath);
      if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        try {
          fs.unlinkSync(lockPath); // stale holder (crashed evaluator) - steal it
          continue;
        } catch (unlinkError) {
          if (unlinkError.code === 'ENOENT') continue;
          throw unlinkError;
        }
      }
    } catch (error) {
      if (error && error.code === 'ENOENT') continue; // released between open and stat
      throw error;
    }
    return false; // fresh lock held by another evaluation
  }
  return false; // lost the steal race on the second attempt
}

function releaseLock(lockPath) {
  const token = lockOwnership.get(lockPath);
  if (!token) return false; // this process never acquired it - not ours to release
  lockOwnership.delete(lockPath);
  let held;
  try {
    held = fs.readFileSync(lockPath, 'utf8');
  } catch {
    return false; // already gone
  }
  if (held !== token) return false; // stolen by a successor evaluator - leave its lock alone
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function readSeq(state) {
  if (!state || typeof state !== 'object') return 0;
  if (Number.isFinite(state.seq)) return state.seq;
  if (state.meta && Number.isFinite(state.meta.seq)) return state.meta.seq;
  return 0;
}

function activeIdsFromState(state) {
  try {
    return activeCapabilityIds(state);
  } catch {
    return [];
  }
}

function repoContextFromEnv(env) {
  const context = {};
  const cwd = env.CLAUDE_PROJECT_DIR || process.cwd();
  if (typeof cwd === 'string' && cwd.trim()) context.cwd = cwd;
  return context;
}

function evalErrorEvent(sessionKey, error) {
  return {
    event: 'eval-error',
    sessionKey,
    errorClass: (error && error.name) || 'Error',
    message: String((error && error.message) || error)
  };
}

/**
 * Run one full routing evaluation for a session.
 *
 * @param {object} payload - {event: 'user-prompt'|'stop'|'tool-failure', prompt, sessionKey, toolName, errorMessage}
 * @param {object} [options] - {config, fetchImpl, env}
 * @returns {Promise<object>} {ok:true, decision, model, latencyMs} or {ok:false, skipped|error}
 */
async function runEvaluation(payload, options = {}) {
  const env = options.env || process.env;
  const config = options.config || loadJevConfig(env);
  const source = payload && typeof payload === 'object' ? payload : {};
  const sessionKey = String(source.sessionKey || '').trim();
  if (!sessionKey) return { ok: false, skipped: 'missing-session-key' };

  const lockPath = lockFilePath({ config, sessionKey });
  if (!acquireLock(lockPath)) {
    return { ok: false, skipped: 'lock-held' };
  }

  try {
    if (!config.enabled) {
      return { ok: false, skipped: 'disabled' };
    }

    const { registry } = loadRegistry(config);
    const priorState = readState({ config, sessionKey });
    const recentFailures = telemetry.readRecentFailures({ config });
    const promptText = typeof source.prompt === 'string' ? source.prompt : '';

    const taskState = buildTaskState({
      event: source.event,
      prompt: promptText,
      sessionKey,
      recentFailures,
      repoContext: repoContextFromEnv(env),
      activeCapabilities: activeIdsFromState(priorState),
      priorObjective: priorState && typeof priorState.objective === 'string' ? priorState.objective : undefined
    });

    const evaluated = await evaluateCapabilities({
      state: taskState,
      capabilities: registry.capabilities,
      config,
      fetchImpl: options.fetchImpl
    });

    const hardRules = collectHardRules({ registry, promptText, config, env });
    const decision = decide({ registry, probabilities: evaluated.probabilities, currentStates: priorState, hardRules });
    const seq = readSeq(priorState) + 1;

    writeState({
      config,
      sessionKey,
      states: decision.states,
      meta: { seq, event: source.event, objective: taskState.objective }
    });

    telemetry.appendEvent({
      config,
      event: {
        event: source.event,
        sessionKey,
        probabilities: evaluated.probabilities,
        // Change rows carry the destination state's reason so downstream
        // consumers (calibrate's explicitLocks) can classify hard-rule locks;
        // the controller's bare {id, from, to} shape stays forward-compatible.
        decisions: decision.changes.map(change => {
          const state = decision.states && decision.states[change.id];
          return state && typeof state.reason === 'string' && state.reason
            ? { ...change, reason: state.reason }
            : { ...change };
        }),
        latencyMs: evaluated.latencyMs,
        model: evaluated.model,
        usage: evaluated.usage,
        ...(typeof source.toolName === 'string' && source.toolName ? { toolName: source.toolName } : {}),
        ...(typeof source.errorMessage === 'string' && source.errorMessage ? { errorMessage: source.errorMessage } : {})
      }
    });

    return { ok: true, decision, model: evaluated.model, latencyMs: evaluated.latencyMs };
  } catch (error) {
    telemetry.appendEvent({ config, event: evalErrorEvent(sessionKey, error) });
    return { ok: false, error: String((error && error.message) || error) };
  } finally {
    releaseLock(lockPath);
  }
}

// Direct CLI execution: node eval-runner.js <payload.json>
// Always exits 0 - the evaluator is spawned detached from hooks and must
// never surface as a failure to the host agent.
async function main() {
  const payloadPath = process.argv[2];
  if (!payloadPath) {
    process.exit(0);
    return;
  }
  let payload = {};
  const resolvedPayloadPath = path.resolve(payloadPath);
  try {
    payload = JSON.parse(fs.readFileSync(resolvedPayloadPath, 'utf8'));
  } catch (error) {
    process.stderr.write(`[jev-switchboard] eval-runner could not read payload at ${payloadPath}: ${error.message}\n`);
    payload = null;
  } finally {
    // The payload has been consumed either way - remove it so prompt-bearing
    // pending-*.json files never accumulate in stateDir (one per routing event).
    try {
      fs.unlinkSync(resolvedPayloadPath);
    } catch {
      // already gone or unreadable - nothing to clean up
    }
  }
  if (!payload) {
    process.exit(0);
    return;
  }
  let config;
  try {
    config = loadJevConfig(process.env);
  } catch (error) {
    process.stderr.write(`[jev-switchboard] eval-runner config load failed: ${error.message}\n`);
    process.exit(0);
    return;
  }
  try {
    const result = await runEvaluation(payload, { config });
    if (result && result.ok) {
      process.stderr.write(`[jev-switchboard] eval ok session=${payload.sessionKey || '?'} changes=${result.decision ? result.decision.changes.length : 0}\n`);
    } else if (result && result.skipped) {
      process.stderr.write(`[jev-switchboard] eval skipped (${result.skipped})\n`);
    }
  } catch (error) {
    // runEvaluation never throws, but the boundary stays guarded regardless.
    telemetry.appendEvent({ config, event: evalErrorEvent(payload.sessionKey, error) });
  }
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  LOCK_STALE_MS,
  lockFilePath,
  acquireLock,
  releaseLock,
  runEvaluation,
  main
};
