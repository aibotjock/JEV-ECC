/**
 * JEV capability switchboard configuration.
 *
 * Precedence chain (mirrors scripts/lib/hook-flags.js):
 *   1. ECC_JEV_* environment variables
 *   2. managed ecc/setup.json `.jevSwitchboard` object (path from ECC_HOOK_CONFIG,
 *      or CLAUDE_PLUGIN_ROOT/ECC_PLUGIN_ROOT + ecc/setup.json; missing file = no-op)
 *   3. built-in defaults
 *
 * The API key comes only from TYPESAFE_API_KEY (env only, never committed, never
 * managed). A missing/whitespace key forces enabled=false so the router stays
 * inert and the host agent is never broken.
 *
 * Model is pinned to 'jev-1.13.0' by default; never 'jev-latest' (aliases drift
 * silently). Thresholds must satisfy 0 <= deactivationThreshold < activationThreshold < 1;
 * invalid values are clamped or reverted to defaults with a stderr warning.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = Object.freeze({
  enabled: true,
  model: 'jev-1.13.0',
  baseUrl: 'https://api.typesafe.ai',
  activationThreshold: 0.65,
  deactivationThreshold: 0.35,
  timeoutMs: 8000,
  maxRetries: 2,
});

const ENV_NAMES = Object.freeze({
  enabled: 'ECC_JEV_ENABLED',
  model: 'ECC_JEV_MODEL',
  baseUrl: 'ECC_JEV_BASE_URL',
  activationThreshold: 'ECC_JEV_ACTIVATION_THRESHOLD',
  deactivationThreshold: 'ECC_JEV_DEACTIVATION_THRESHOLD',
  timeoutMs: 'ECC_JEV_TIMEOUT_MS',
  maxRetries: 'ECC_JEV_MAX_RETRIES',
  stateDir: 'ECC_JEV_STATE_DIR',
  registryPath: 'ECC_JEV_REGISTRY_PATH'
});

function warn(message) {
  process.stderr.write(`[jev-switchboard] Warning: ${sanitizeDiagnostic(message)}\n`);
}

function sanitizeDiagnostic(value) {
  return String(value || '').replace(/[^\x20-\x7E]/g, '?');
}

function parseBoolean(value, fallback = true) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function readManagedJevConfig(env) {
  const pluginRoot = String(env.CLAUDE_PLUGIN_ROOT || env.ECC_PLUGIN_ROOT || '').trim();
  const configPath =
    String(env.ECC_HOOK_CONFIG || '').trim() || (pluginRoot ? path.join(pluginRoot, 'ecc', 'setup.json') : '');
  if (!configPath || !fs.existsSync(configPath)) return {};

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const jev = config && typeof config === 'object' && !Array.isArray(config) ? config.jevSwitchboard : null;
    return jev && typeof jev === 'object' && !Array.isArray(jev) ? jev : {};
  } catch (error) {
    warn(`unable to read managed ECC jev config at ${configPath}: ${sanitizeDiagnostic(error.message)}`);
    return {};
  }
}

function resolveString(envValue, managedValue, fallback) {
  if (!isBlank(envValue)) return String(envValue).trim();
  if (!isBlank(managedValue)) return String(managedValue).trim();
  return fallback;
}

function resolveNumber(envValue, managedValue, fallback, label) {
  const candidates = [envValue, managedValue];
  for (const candidate of candidates) {
    if (isBlank(candidate)) continue;
    const parsed = Number(candidate);
    if (Number.isFinite(parsed)) return parsed;
    warn(`ignoring non-numeric ${label} value`);
  }
  return fallback;
}

function resolveThresholds(env, managed) {
  const activation = resolveNumber(
    env[ENV_NAMES.activationThreshold],
    managed.activationThreshold,
    DEFAULTS.activationThreshold,
    'activationThreshold'
  );
  const deactivation = resolveNumber(
    env[ENV_NAMES.deactivationThreshold],
    managed.deactivationThreshold,
    DEFAULTS.deactivationThreshold,
    'deactivationThreshold'
  );
  const clamp01 = value => Math.min(1, Math.max(0, value));
  const act = clamp01(activation);
  const deact = clamp01(deactivation);
  if (act !== activation) warn(`clamped activationThreshold into [0,1] (was ${activation})`);
  if (deact !== deactivation) warn(`clamped deactivationThreshold into [0,1] (was ${deactivation})`);
  if (!(deact < act && act < 1)) {
    warn(
      `invalid thresholds (need 0 <= deactivationThreshold < activationThreshold < 1, got ${deact}/${act});` +
        ` reverting to defaults ${DEFAULTS.deactivationThreshold}/${DEFAULTS.activationThreshold}`
    );
    return { activationThreshold: DEFAULTS.activationThreshold, deactivationThreshold: DEFAULTS.deactivationThreshold };
  }
  return { activationThreshold: act, deactivationThreshold: deact };
}

function getHomeDir(env) {
  const explicit = env.HOME || env.USERPROFILE;
  if (explicit && String(explicit).trim()) return path.resolve(String(explicit));
  return os.homedir();
}

function expandHome(value, homeDir) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('~')) {
    const remainder = trimmed.slice(1).replace(/^[/\\]+/, '');
    return remainder ? path.join(homeDir, remainder) : homeDir;
  }
  return path.resolve(trimmed);
}

function resolveAgentDataRoot(env) {
  const homeDir = getHomeDir(env);
  return expandHome(env.ECC_AGENT_DATA_HOME, homeDir) || path.join(homeDir, '.claude');
}

function loadJevConfig(env = process.env) {
  const managed = readManagedJevConfig(env);
  const apiKey = String(env.TYPESAFE_API_KEY || '').trim();

  const enabledRaw = env[ENV_NAMES.enabled] !== undefined ? env[ENV_NAMES.enabled] : managed.enabled;
  let enabled = parseBoolean(enabledRaw, DEFAULTS.enabled);

  const model = resolveString(env[ENV_NAMES.model], managed.model, DEFAULTS.model);
  const baseUrl = resolveString(env[ENV_NAMES.baseUrl], managed.baseUrl, DEFAULTS.baseUrl).replace(/\/+$/, '') || DEFAULTS.baseUrl;
  const thresholds = resolveThresholds(env, managed);
  const timeoutMs = Math.max(
    1,
    Math.round(resolveNumber(env[ENV_NAMES.timeoutMs], managed.timeoutMs, DEFAULTS.timeoutMs, 'timeoutMs'))
  );
  const maxRetries = Math.max(
    0,
    Math.round(resolveNumber(env[ENV_NAMES.maxRetries], managed.maxRetries, DEFAULTS.maxRetries, 'maxRetries'))
  );

  const agentDataRoot = resolveAgentDataRoot(env);
  // ECC_JEV_STATE_DIR / ECC_JEV_REGISTRY_PATH override the default layout so
  // hooks, the CLI, and the evaluator all land in the same place when an
  // operator (or a test) redirects them. The CLI's --state-dir/--registry-path
  // flags remain the strongest override for CLI-owned operations.
  const stateDir = path.resolve(expandHome(env[ENV_NAMES.stateDir], getHomeDir(env)) || path.join(agentDataRoot, 'ecc', 'jev-switchboard'));
  const registryPath = path.resolve(
    expandHome(env[ENV_NAMES.registryPath], getHomeDir(env)) || path.join(stateDir, 'jev-registry.json')
  );

  if (enabled && !apiKey) {
    // No key means the router must be inert; gates pass through and the agent
    // is never broken. Silent on purpose: absent keys are normal operation.
    enabled = false;
  }

  return {
    enabled,
    apiKey,
    baseUrl,
    model,
    activationThreshold: thresholds.activationThreshold,
    deactivationThreshold: thresholds.deactivationThreshold,
    timeoutMs,
    maxRetries,
    stateDir,
    telemetryPath: path.join(stateDir, 'telemetry.jsonl'),
    registryPath,
  };
}

module.exports = {
  DEFAULTS,
  ENV_NAMES,
  loadJevConfig,
};
