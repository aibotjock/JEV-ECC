#!/usr/bin/env node
'use strict';

/**
 * JEV capability switchboard CLI (docs/JEV-SWITCHBOARD.md).
 *
 *   build-registry   derive the capability registry and write the cache
 *   status           print the ON/OFF/LOCKED table for one session
 *   doctor           health checks: api key, registry cache freshness, state writability
 *   eval             run one routing evaluation in-process (may block on Jev)
 *   calibrate        summarize telemetry.jsonl and suggest threshold tuning
 *
 * Pure node, zero dependencies beyond the repo's existing libs. The only
 * network call is `eval`, which runs runEvaluation() in-process on purpose:
 * the CLI may wait. Hooks stay detached from the Jev HTTP call (eval-runner).
 */

const fs = require('fs');
const path = require('path');
const {
  REGISTRY_SCHEMA_VERSION,
  buildRegistry,
  loadRegistry,
  writeRegistryCache,
  readRegistryCache,
  defaultRepoRoot,
  defaultOverlayPath,
  defaultDataRoot,
  defaultRegistryPath
} = require('./lib/jev-switchboard/registry');
const { writeFileAtomic } = require('./lib/atomic-write');
const { loadJevConfig } = require('./lib/jev-switchboard/config');
const { runEvaluation } = require('./lib/jev-switchboard/eval-runner');
const { summarizeCalibration, SAMPLE_SIZE_WARNING_TEXT } = require('./lib/jev-switchboard/calibration');

const COMMANDS = ['build-registry', 'status', 'doctor', 'eval', 'calibrate'];
const EVAL_EVENTS = ['user-prompt', 'stop', 'tool-failure'];

function usage() {
  return [
    'Usage: jev-switchboard <command> [options]',
    '',
    'Commands:',
    '  build-registry   Derive the capability registry (skills + MCPs + overlay',
    '                   tool opt-ins), merge routing metadata, write the cache.',
    '  status           Print the ON/OFF/LOCKED capability table for a session.',
    '  doctor           Check api key, registry cache freshness, state writability.',
    '  eval             Run one routing evaluation now (calls Jev; may block).',
    '  calibrate        Summarize telemetry.jsonl, suggest threshold tuning.',
    '',
    'Options:',
    '  --repo-root <path>     Repository root to derive from (default: this repo)',
    '  --overlay <path>       Routing overlay JSON (default: <repoRoot>/config/jev-switchboard-routing.json)',
    '  --registry-path <path> Registry cache path (env ECC_JEV_REGISTRY_PATH)',
    '  --state-dir <dir>      Session state directory (env ECC_JEV_STATE_DIR)',
    '  --session <key>        Session key for status/eval (default: default)',
    '  --prompt <text>        Prompt text for eval (required unless --event stop)',
    '  --event <name>         Routing event for eval: user-prompt | stop | tool-failure',
    '  --tool-name <name>     Failed tool name for eval --event tool-failure',
    '  --error-message <msg>  Failure detail for eval --event tool-failure',
    '  --json                 Print machine-readable JSON (build-registry, eval, calibrate)',
    '  -h, --help             Show this help',
    '',
    'Exit codes: 0 success or skip, 1 usage or operational error.'
  ].join('\n');
}

function parseArgs(argv = process.argv) {
  const args = argv.slice(2);
  const valueFlags = {
    '--repo-root': 'repoRoot',
    '--overlay': 'overlay',
    '--registry-path': 'registryPath',
    '--state-dir': 'stateDir',
    '--session': 'session',
    '--prompt': 'prompt',
    '--event': 'event',
    '--tool-name': 'toolName',
    '--error-message': 'errorMessage'
  };
  const options = {
    repoRoot: null,
    overlay: null,
    registryPath: null,
    stateDir: null,
    session: null,
    prompt: null,
    event: null,
    toolName: null,
    errorMessage: null,
    json: false,
    help: false
  };
  let command = null;
  let error = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(valueFlags, arg)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        error = `missing value for ${arg}`;
        break;
      }
      options[valueFlags[arg]] = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      error = `unknown option: ${arg}`;
      break;
    }
    if (command === null) {
      command = arg;
      continue;
    }
    error = `unexpected argument: ${arg}`;
    break;
  }

  if (!error && command !== null && !COMMANDS.includes(command)) {
    error = `unknown command: ${command}`;
  }
  return { command, options, error };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function firstLine(text) {
  return String(text || '').split(/\r?\n/)[0];
}

function fromEnvOrFlag(flagValue, envName) {
  if (flagValue) return String(flagValue);
  const fromEnv = String(process.env[envName] || '').trim();
  return fromEnv || null;
}

// Expand a leading '~' exactly like config.js's expandHome so CLI-resolved
// paths and loadJevConfig paths agree; otherwise a tilde-form
// ECC_JEV_STATE_DIR silently splits the data plane (eval writes <cwd>/~/x
// while hooks/calibrate read $HOME/x).
function expandLeadingTilde(value) {
  const text = String(value || '');
  if (text === '~') return defaultDataRoot();
  if (text.startsWith('~/') || text.startsWith('~\\')) {
    return path.join(defaultDataRoot(), text.slice(2));
  }
  return text;
}

function resolveRegistryPath(options) {
  const explicit = fromEnvOrFlag(options.registryPath, 'ECC_JEV_REGISTRY_PATH');
  return path.resolve(expandLeadingTilde(explicit) || defaultRegistryPath());
}

function resolveStateDir(options) {
  const explicit = fromEnvOrFlag(options.stateDir, 'ECC_JEV_STATE_DIR');
  return path.resolve(expandLeadingTilde(explicit) || path.join(defaultDataRoot(), 'ecc', 'jev-switchboard'));
}

// Session keys are embedded in file names; keep the character set closed so a
// hostile session id cannot traverse out of the state directory.
function sanitizeSessionKey(session) {
  const cleaned = String(session || 'default').replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned || 'default';
}

function stateFilePath(stateDir, session) {
  return path.join(stateDir, `state-${sanitizeSessionKey(session)}.json`);
}

function readStateFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) && isPlainObject(parsed.states) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeStateValue(value) {
  return value === 'ON' || value === 'OFF' || value === 'LOCKED' ? value : 'OFF';
}

function formatProbability(recorded) {
  if (recorded && typeof recorded.lastProbability === 'number' && Number.isFinite(recorded.lastProbability)) {
    return recorded.lastProbability.toFixed(2);
  }
  return '-';
}

function cmdBuildRegistry(options) {
  const repoRoot = path.resolve(options.repoRoot || defaultRepoRoot());
  const overlayPath = options.overlay ? path.resolve(options.overlay) : defaultOverlayPath(repoRoot);
  const registry = buildRegistry({ repoRoot, overlayPath });
  const registryPath = writeRegistryCache(registry, { registryPath: resolveRegistryPath(options) });

  if (options.json) {
    console.log(JSON.stringify(registry, null, 2));
    return 0;
  }

  const { counts, warnings } = registry.buildSummary;
  const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
  console.log(`JEV switchboard registry (${REGISTRY_SCHEMA_VERSION})`);
  console.log(`  ${plural(counts.skill, 'skill')}, ${plural(counts.mcp, 'mcp')}, ${plural(counts.tool, 'tool')} — ${counts.total} capabilities`);
  console.log(`  alwaysLocked: ${registry.alwaysLocked.length > 0 ? registry.alwaysLocked.join(', ') : '(none)'}`);
  console.log(`  cache: ${registryPath}`);
  if (warnings.length === 0) {
    console.log('  warnings: none');
  } else {
    console.log(`  warnings (${warnings.length}):`);
    for (const warning of warnings) console.log(`    - ${warning}`);
  }
  return 0;
}

function cmdStatus(options) {
  const session = sanitizeSessionKey(options.session);
  const stateDir = resolveStateDir(options);
  const stateFile = stateFilePath(stateDir, session);

  let registry;
  try {
    registry = loadRegistry({
      registryPath: resolveRegistryPath(options),
      repoRoot: options.repoRoot ? path.resolve(options.repoRoot) : undefined,
      overlayPath: options.overlay ? path.resolve(options.overlay) : undefined
    }).registry;
  } catch (error) {
    process.stderr.write(`Error: cannot load registry: ${firstLine(error.message)}\n`);
    return 1;
  }

  const state = readStateFile(stateFile);
  const fileStates = state ? state.states : {};
  const alwaysLocked = new Set(registry.alwaysLocked);
  const capabilityIds = new Set(registry.capabilities.map(capability => capability.id));
  const ids = Array.from(new Set([...capabilityIds, ...Object.keys(fileStates)])).sort(compareStrings);

  console.log(`JEV switchboard status (session: ${session})`);
  console.log(`  registry: ${registry.buildSummary.counts.total} capabilities (${registry.capabilities.filter(c => !c.available).length} unavailable)`);
  if (state) {
    console.log(`  state file: ${stateFile} — seq ${typeof state.seq === 'number' ? state.seq : '?'}, event ${typeof state.event === 'string' ? state.event : '?'}`);
  } else {
    console.log(`  state file: ${stateFile} — not found (never evaluated; gates pass-through, capabilities default OFF)`);
  }

  const rows = ids.map(id => {
    const locked = alwaysLocked.has(id);
    const recorded = isPlainObject(fileStates[id]) ? fileStates[id] : null;
    return {
      stateValue: locked ? 'LOCKED' : normalizeStateValue(recorded && recorded.state),
      label: capabilityIds.has(id) ? id : `${id} (unregistered)`,
      probability: formatProbability(recorded)
    };
  });
  const labelWidth = Math.min(Math.max(...rows.map(row => row.label.length), 12), 64);
  console.log(`  ${'STATE'.padEnd(8)}${'CAPABILITY'.padEnd(labelWidth + 2)}P`);
  for (const row of rows) console.log(`  ${row.stateValue.padEnd(8)}${row.label.padEnd(labelWidth + 2)}${row.probability}`);
  return 0;
}

function cmdDoctor(options) {
  const lines = [];
  const ok = message => lines.push(`  [ok]    ${message}`);
  const warn = message => lines.push(`  [warn]  ${message}`);

  // 1. API key presence (value is never printed).
  const apiKey = String(process.env.TYPESAFE_API_KEY || '').trim();
  if (apiKey.length > 0) {
    ok('api key present (TYPESAFE_API_KEY)');
  } else {
    warn('api key missing (TYPESAFE_API_KEY) — Jev evaluation disabled; gates pass-through');
  }

  const killSwitch = String(process.env.ECC_JEV_ENABLED === undefined ? '' : process.env.ECC_JEV_ENABLED)
    .trim()
    .toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(killSwitch)) {
    warn('kill switch active (ECC_JEV_ENABLED=false) — switchboard disabled');
  } else {
    ok('kill switch inactive');
  }

  // 2. Registry cache freshness: cache must exist, parse, and deep-match a live
  //    derivation (buildRegistry is deterministic, so equality is exact).
  const repoRoot = path.resolve(options.repoRoot || defaultRepoRoot());
  const overlayPath = options.overlay ? path.resolve(options.overlay) : defaultOverlayPath(repoRoot);
  const registryPath = resolveRegistryPath(options);
  let derived = null;
  try {
    derived = buildRegistry({ repoRoot, overlayPath });
  } catch (error) {
    warn(`cannot derive live registry: ${firstLine(error.message)}`);
  }
  if (derived) {
    const cached = readRegistryCache(registryPath);
    if (cached) {
      if (JSON.stringify(cached) === JSON.stringify(derived)) {
        ok(`registry cache fresh (${derived.buildSummary.counts.total} capabilities)`);
      } else {
        warn(`registry cache stale at ${registryPath} — run: node scripts/jev-switchboard.js build-registry`);
      }
    } else if (fs.existsSync(registryPath)) {
      warn(`registry cache corrupt at ${registryPath} — run: node scripts/jev-switchboard.js build-registry`);
    } else {
      warn(`registry cache missing at ${registryPath} — run: node scripts/jev-switchboard.js build-registry`);
    }
  }

  // 3. State file writability (probe write + remove; same atomic path the
  //    eval-runner uses).
  const stateDir = resolveStateDir(options);
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const probe = path.join(stateDir, `.doctor-probe-${process.pid}`);
    writeFileAtomic(probe, '', { mode: 0o600 });
    fs.rmSync(probe, { force: true });
    ok(`state dir writable (${stateDir})`);
  } catch (error) {
    warn(`state dir not writable (${stateDir}: ${firstLine(error.message)})`);
  }

  console.log('JEV switchboard doctor');
  for (const line of lines) console.log(line);
  return 0;
}

// The eval command builds the real runtime config (loadJevConfig precedence:
// ECC_JEV_* env > managed setup.json > defaults) and then lets the CLI's
// --state-dir/--registry-path flags override, matching the config.js note that
// CLI flags are the strongest override for CLI-owned operations.
function buildEvalConfig(options) {
  const config = loadJevConfig(process.env);
  const stateDir = resolveStateDir(options);
  if (path.resolve(config.stateDir) !== stateDir) {
    config.stateDir = stateDir;
    config.telemetryPath = path.join(stateDir, 'telemetry.jsonl');
  }
  const registryPath = resolveRegistryPath(options);
  if (path.resolve(config.registryPath) !== registryPath) {
    config.registryPath = registryPath;
  }
  return config;
}

// Validate eval flags and shape the runEvaluation payload. Returns
// {payload} or {error} (usage error).
function buildEvalPayload(options) {
  const event = options.event === null || options.event === undefined ? 'user-prompt' : options.event;
  if (!EVAL_EVENTS.includes(event)) {
    return { error: `invalid --event value: ${event} (expected ${EVAL_EVENTS.join(' | ')})` };
  }
  const prompt = typeof options.prompt === 'string' ? options.prompt : '';
  if (prompt.trim() === '' && event !== 'stop') {
    return { error: `--prompt is required for --event ${event} (only --event stop may omit it)` };
  }
  return {
    payload: {
      event,
      prompt,
      sessionKey: sanitizeSessionKey(options.session || 'default'),
      ...(typeof options.toolName === 'string' && options.toolName ? { toolName: options.toolName } : {}),
      ...(typeof options.errorMessage === 'string' && options.errorMessage ? { errorMessage: options.errorMessage } : {})
    }
  };
}

const EVAL_SKIP_REASONS = {
  disabled: 'switchboard disabled (missing TYPESAFE_API_KEY or ECC_JEV_ENABLED=false); gates pass-through',
  'lock-held': 'another evaluation already holds this session lock; try again shortly',
  'missing-session-key': 'no session key resolved'
};

// Runs runEvaluation() in-process: the CLI may wait on the Jev call, unlike
// hooks, which stay detached. `injected.fetchImpl` keeps tests off the network.
async function cmdEval(options, injected = {}) {
  const built = buildEvalPayload(options);
  if (built.error) {
    process.stderr.write(`Error: ${built.error}\n\n${usage()}\n`);
    return 1;
  }
  const config = buildEvalConfig(options);
  // Hooks get the state dir created implicitly by the payload's atomic write;
  // the CLI path has no payload, so create it up front instead of dying on a
  // raw ENOENT from the lock file.
  try {
    fs.mkdirSync(config.stateDir, { recursive: true });
  } catch {
    // runEvaluation will surface a readable error if the dir stays missing
  }
  const result = await runEvaluation(built.payload, { config, fetchImpl: injected.fetchImpl });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return result && result.ok === false && result.error ? 1 : 0;
  }

  if (result && result.ok === false && result.error) {
    process.stderr.write(`Error: evaluation failed: ${firstLine(result.error)}\n`);
    return 1;
  }
  if (result && result.ok === false && result.skipped) {
    const detail = EVAL_SKIP_REASONS[result.skipped] || 'no evaluation ran';
    console.log(`JEV switchboard eval skipped (${result.skipped}) — ${detail}`);
    return 0;
  }

  const decision = (result && result.decision) || { states: {}, changes: [] };
  const states = decision.states || {};
  const changes = Array.isArray(decision.changes) ? decision.changes : [];
  const activeIds = Object.keys(states)
    .filter(id => states[id] && (states[id].state === 'ON' || states[id].state === 'LOCKED'))
    .sort(compareStrings);
  const offCount = Object.keys(states).filter(id => states[id] && states[id].state === 'OFF').length;

  console.log(
    `JEV switchboard eval ok — session=${built.payload.sessionKey} event=${built.payload.event}` +
      ` model=${result ? result.model : '?'} latency_ms=${result && Number.isFinite(result.latencyMs) ? result.latencyMs : '?'} state_changes=${changes.length}`
  );
  if (activeIds.length === 0) {
    console.log('  no capabilities ON or LOCKED');
  } else {
    const idWidth = Math.min(Math.max(...activeIds.map(id => id.length), 12), 48);
    for (const id of activeIds) {
      const entry = states[id];
      console.log(`  ${entry.state.padEnd(8)}${id.padEnd(idWidth + 2)}p=${formatProbability(entry)}  ${entry.reason || ''}`.trimEnd());
    }
  }
  console.log(`  OFF: ${offCount} capabilities`);
  return 0;
}

// Parse telemetry.jsonl rows; unreadable/blank/torn lines are skipped, never
// fatal (telemetry is strictly separate from policy).
function readTelemetryRows(telemetryPath) {
  let raw;
  try {
    raw = fs.readFileSync(telemetryPath, 'utf8');
  } catch {
    return null;
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) rows.push(parsed);
    } catch {
      // torn tail line from a concurrent append - skip
    }
  }
  return rows;
}

function cmdCalibrate(options) {
  const config = loadJevConfig(process.env);
  if (options.stateDir) {
    config.stateDir = resolveStateDir(options);
    config.telemetryPath = path.join(config.stateDir, 'telemetry.jsonl');
  }
  const telemetryPath = config.telemetryPath;
  const rows = readTelemetryRows(telemetryPath);
  if (rows === null) {
    console.log('JEV switchboard calibrate');
    console.log(`  no telemetry yet at ${telemetryPath} — evaluations append routing events there`);
    console.log('nothing to calibrate');
    return 0;
  }

  const summary = summarizeCalibration(rows, {
    activationThreshold: config.activationThreshold,
    deactivationThreshold: config.deactivationThreshold
  });

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  }

  console.log(`JEV switchboard calibrate — ${summary.events} routing event${summary.events === 1 ? '' : 's'}, ${summary.evalErrors} eval error${summary.evalErrors === 1 ? '' : 's'} (${telemetryPath})`);
  if (summary.capabilities.length === 0) {
    console.log('  no capability samples recorded');
  } else {
    // Most-sampled capabilities first; ties fall back to sorted ids.
    const ordered = [...summary.capabilities].sort((a, b) => b.samples - a.samples || compareStrings(a.id, b.id));
    const idWidth = Math.min(Math.max(...ordered.map(row => row.id.length), 2), 48);
    console.log(
      `  ${'ID'.padEnd(idWidth)}  ${'SAMPLES'.padStart(7)}  ${'MEAN P'.padStart(6)}  ${'ON/OFF/LOCKED'.padStart(13)}  ${'BAND'.padStart(4)}  ${'FLIPS'.padStart(5)}  ${'EXPLICIT LOCKS'.padStart(14)}`
    );
    for (const row of ordered) {
      const meanP = row.meanP === null ? '-' : row.meanP.toFixed(2);
      const counts = `${row.onCount}/${row.offCount}/${row.lockedCount}`;
      console.log(
        `  ${row.id.padEnd(idWidth)}  ${String(row.samples).padStart(7)}  ${meanP.padStart(6)}  ${counts.padStart(13)}  ${String(row.bandCount).padStart(4)}  ${String(row.flips).padStart(5)}  ${String(row.explicitLocks).padStart(14)}`
      );
    }
  }

  if (summary.recommendations.length === 0) {
    console.log('recommendations: none');
  } else {
    console.log('recommendations:');
    for (const recommendation of summary.recommendations) console.log(`  - ${recommendation}`);
  }
  if (summary.sampleSizeWarning) {
    console.log(`warning: ${SAMPLE_SIZE_WARNING_TEXT}`);
  }
  return 0;
}

async function main(argv = process.argv) {
  const { command, options, error } = parseArgs(argv);
  if (error) {
    process.stderr.write(`Error: ${error}\n\n${usage()}\n`);
    return 1;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (!command) {
    process.stderr.write(`${usage()}\n`);
    return 1;
  }

  try {
    if (command === 'build-registry') return cmdBuildRegistry(options);
    if (command === 'status') return cmdStatus(options);
    if (command === 'doctor') return cmdDoctor(options);
    if (command === 'eval') return await cmdEval(options);
    if (command === 'calibrate') return cmdCalibrate(options);
  } catch (error) {
    process.stderr.write(`Error: ${firstLine(error && error.message ? error.message : String(error))}\n`);
    return 1;
  }

  process.stderr.write(`Error: unknown command: ${command}\n\n${usage()}\n`);
  return 1;
}

if (require.main === module) {
  main().then(
    code => process.exit(code),
    error => {
      process.stderr.write(`Error: ${firstLine(error && error.message ? error.message : String(error))}\n`);
      process.exit(1);
    }
  );
}

module.exports = {
  main,
  parseArgs,
  usage,
  cmdBuildRegistry,
  cmdStatus,
  cmdDoctor,
  cmdEval,
  cmdCalibrate,
  buildEvalConfig,
  buildEvalPayload,
  resolveStateDir,
  stateFilePath,
  sanitizeSessionKey
};
