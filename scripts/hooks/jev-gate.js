#!/usr/bin/env node
'use strict';

// PreToolUse hook: JEV capability switchboard gate.
// Contract: docs/JEV-SWITCHBOARD.md ("Appliers (v1)").
//
// Registered under matcher "Skill" and matcher ".*". Reads ONLY the cached
// per-session state file (plus the registry cache file for id mapping) - no
// network, no jev-client.js, everything local and fast. Capability mapping:
//   tool_name "Skill"                -> skill capability whose id/name matches
//                                        the tool_input skill id (registry
//                                        CACHE only, never live derivation)
//   tool_name "mcp__<server>__<tool>" -> mcp:<server> capability
//   anything else                     -> overlay-declared tool:<name> entries
//                                        only; unregulated tools exit 0
//
// Deny mechanism mirrors mcp-health-check.js exactly: a stderr log line, the
// raw input echoed on stdout, and exit code 2 (blocked). ON / LOCKED /
// unknown states and never-evaluated sessions (no state file) pass through
// silently (exit 0) - gates deny only what a successful evaluation or a hard
// rule has turned OFF. Fail-closed on truncated stdin like gateguard unless
// ECC_JEV_GATE_FAIL_OPEN is set.

const { loadJevConfig } = require('../lib/jev-switchboard/config');
const { readRegistryCache } = require('../lib/jev-switchboard/registry');
const { readStatesForGate, resolveSessionKey } = require('../lib/jev-switchboard/state');
const { extractSkillId } = require('./skill-run-tracker');

const MAX_STDIN = 1024 * 1024;
const MCPPREFIX = 'mcp__';

function isFailOpen(env) {
  return /^(1|true|yes)$/i.test(String((env && env.ECC_JEV_GATE_FAIL_OPEN) || ''));
}

function isTruncated(context, env) {
  if (context && context.truncated === true) return true;
  return /^(1|true|yes)$/i.test(String((env && env.ECC_HOOK_INPUT_TRUNCATED) || ''));
}

function parseInput(rawInput) {
  try {
    const data = typeof rawInput === 'string' ? (rawInput.trim() ? JSON.parse(rawInput) : {}) : rawInput;
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return null;
  }
}

function allow(stdout) {
  return { stdout, exitCode: 0 };
}

// mcp-health-check.js deny shape: stderr log + raw passthrough + exit 2.
function deny(rawInput, stderr, env) {
  return { stdout: rawInput, stderr, exitCode: isFailOpen(env) ? 0 : 2 };
}

// The mcp-health-check server-target convention: mcp__<server>__<tool> with
// at least two segments after the prefix.
function mcpServerFromToolName(toolName) {
  if (!toolName.startsWith(MCPPREFIX)) return null;
  const segments = toolName.slice(MCPPREFIX.length).split('__');
  if (segments.length < 2 || !segments[0]) return null;
  return segments[0];
}

// Resolve a Skill tool_input to a registry skill capability using the cached
// registry only. Match order: exact id (skill:<dir>), id suffix (nested skill
// dirs), then display name (case-insensitive).
function matchSkillCapability(registry, toolInput) {
  const skillId = extractSkillId(toolInput);
  if (!skillId) return null;
  const bare = skillId.replace(/^\/+/, '');
  const lower = bare.toLowerCase();
  const capabilities = Array.isArray(registry.capabilities) ? registry.capabilities : [];
  const skills = capabilities.filter(entry => entry && entry.id && entry.id.startsWith('skill:'));
  const byId = skills.find(entry => entry.id === `skill:${bare}` || entry.id.endsWith(`/${bare}`));
  if (byId) return byId;
  return skills.find(entry => typeof entry.name === 'string' && entry.name.trim().toLowerCase() === lower) || null;
}

function matchToolCapability(registry, toolName) {
  const capabilities = Array.isArray(registry.capabilities) ? registry.capabilities : [];
  return capabilities.find(entry => entry && entry.id === `tool:${toolName}`) || null;
}

function relevanceClause(entry, config) {
  const probability = entry && typeof entry.lastProbability === 'number' && Number.isFinite(entry.lastProbability) ? entry.lastProbability : null;
  if (probability === null) return '';
  return ` (relevance ${probability} below activation ${config.activationThreshold})`;
}

function denyMessage({ capabilityId, capabilityName, entry, config, toolName }) {
  const reason = entry && typeof entry.reason === 'string' && entry.reason ? entry.reason : 'turned off by routing';
  const displayName = capabilityName || capabilityId;
  return (
    `[JevSwitchboard] ${capabilityId} is OFF for this session; blocking ${toolName} so the router's capability budget is honored. ` +
    `Routing reason: ${reason}${relevanceClause(entry, config)}. ` +
    `To override, explicitly name the capability in your reply (say "${displayName}" or ${capabilityId}) and the next routing evaluation locks it on.`
  );
}

function run(rawInput, context = {}) {
  const stdout = typeof rawInput === 'string' ? rawInput : '';
  const data = parseInput(rawInput);
  if (!data) {
    return allow(stdout); // parse errors never block tool execution
  }
  const env = context.env || process.env;
  const config = loadJevConfig(env);
  if (!config.enabled) {
    return allow(stdout); // kill switch / missing key => pass-through
  }
  if (isTruncated(context, env)) {
    // Fail-closed like gateguard: an input we could not read completely must
    // not be routed around. ECC_JEV_GATE_FAIL_OPEN reverses this.
    const limit = Number(env.ECC_HOOK_INPUT_MAX_BYTES) || MAX_STDIN;
    return deny(
      stdout,
      `[JevSwitchboard] Hook input exceeded ${limit} bytes, so the JEV gate could not safely inspect the complete request. Retry with a smaller tool input or explicitly disable this hook.`,
      env
    );
  }

  const states = readStatesForGate({ config, sessionKey: resolveSessionKey(data, env) });
  if (!states) {
    return allow(stdout); // never-evaluated session => fail-open pass-through
  }

  const toolName = String(data.tool_name || data.name || '');
  let capability = null;
  if (toolName === 'Skill' || toolName === 'skill') {
    const registry = readRegistryCache(config.registryPath); // cache ONLY - never derive live in a hook
    if (!registry) return allow(stdout);
    capability = matchSkillCapability(registry, data.tool_input);
    if (!capability) return allow(stdout); // unknown skill => not regulated here
  } else if (toolName.startsWith(MCPPREFIX)) {
    const server = mcpServerFromToolName(toolName);
    if (!server) return allow(stdout);
    capability = { id: `mcp:${server}`, name: server };
  } else {
    const registry = readRegistryCache(config.registryPath);
    if (!registry) return allow(stdout);
    capability = matchToolCapability(registry, toolName);
    if (!capability) return allow(stdout); // core host tools are never regulated in v1
  }

  const entry = states[capability.id];
  if (!entry || entry.state !== 'OFF') {
    return allow(stdout); // ON / LOCKED / unknown => pass silently
  }

  return deny(stdout, denyMessage({ capabilityId: capability.id, capabilityName: capability.name, entry, config, toolName }), env);
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
  mcpServerFromToolName,
  matchSkillCapability,
  matchToolCapability,
  denyMessage,
  run
};
