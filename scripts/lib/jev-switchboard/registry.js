'use strict';

/**
 * JEV capability switchboard — capability registry (docs/JEV-SWITCHBOARD.md).
 *
 * One common registry for every regulated capability type (skills, MCPs,
 * overlay-opted-in tools); type-specific behavior happens at apply time, not
 * here. Derivation is read-only against the sources of truth:
 *
 *   - skills: each skills directory's SKILL.md YAML frontmatter (name + description only)
 *   - MCPs:   scripts/lib/mcp-inventory canonical ecc.mcp.v1 output
 *   - tools:  overlay-declared opt-ins ONLY (core host tools are never
 *             auto-added; regulation requires an explicit overlay entry)
 *
 * The routing overlay (config/jev-switchboard-routing.json) merges in
 * positiveTriggers / negativeTriggers / dependencies / conflicts /
 * per-capability thresholds / lockable, plus the registry-level alwaysLocked
 * set (security controls JEV cannot disable).
 *
 * Determinism: no clock, no randomness, all iterations in sorted order —
 * buildRegistry twice against the same inputs returns bit-identical output
 * (asserted by tests) so the controller and the doctor freshness check can
 * compare registries with plain deep equality.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const { collectMcpInventory } = require('../mcp-inventory/collect');
const { writeFileAtomic } = require('../atomic-write');

const REGISTRY_SCHEMA_VERSION = 'ecc.jev-registry.v1';
const CACHE_SCHEMA_VERSION = 'ecc.jev-registry-cache.v1';
const DEFAULT_ACTIVATION_THRESHOLD = 0.65;
const DEFAULT_DEACTIVATION_THRESHOLD = 0.35;
const CAPABILITY_ID_PREFIXES = ['skill', 'mcp', 'tool'];
const VALID_STATE_VALUES = ['ON', 'OFF', 'LOCKED'];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function firstLine(text) {
  return String(text || '').split(/\r?\n/)[0];
}

function displayPath(repoRoot, target) {
  const relative = path.relative(repoRoot, target);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : target;
}

// ---------------------------------------------------------------------------
// Path defaults (precedence mirrors the hook-flags.js pattern: explicit flag
// > env > built-in default; plugin root wins over agent data root for the
// cache because the cache is plugin-scoped, not user-scoped).
// ---------------------------------------------------------------------------

function defaultRepoRoot() {
  // scripts/lib/jev-switchboard/ -> repo root
  return path.resolve(__dirname, '..', '..', '..');
}

function defaultOverlayPath(repoRoot = defaultRepoRoot()) {
  return path.join(repoRoot, 'config', 'jev-switchboard-routing.json');
}

function expandTilde(value, env = process.env) {
  if (typeof value === 'string' && value.startsWith('~')) {
    const home = String(env.HOME || env.USERPROFILE || '').trim() || os.homedir();
    return path.join(home, value.slice(1).replace(/^[/\\]+/, ''));
  }
  return value;
}

function defaultDataRoot(env = process.env) {
  const explicit = String(env.ECC_AGENT_DATA_HOME || '').trim();
  if (explicit) return path.resolve(expandTilde(explicit, env));
  const home = String(env.HOME || env.USERPROFILE || '').trim() || os.homedir();
  return path.join(expandTilde(home, env), '.claude');
}

function defaultRegistryPath(env = process.env) {
  const pluginRoot = String(env.CLAUDE_PLUGIN_ROOT || env.ECC_PLUGIN_ROOT || '').trim();
  return path.join(path.resolve(expandTilde(pluginRoot || defaultDataRoot(env), env)), 'ecc', 'jev-registry.json');
}

// ---------------------------------------------------------------------------
// Overlay loading / normalization
// ---------------------------------------------------------------------------

function emptyOverlay() {
  return { version: 1, defaults: {}, capabilities: {}, alwaysLocked: [] };
}

function asThreshold(value, fallback, label, warnings) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    warnings.push(`${label} must be a number in [0,1] — using ${fallback}`);
    return fallback;
  }
  return value;
}

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(item => typeof item === 'string' && item.trim().length > 0);
}

function loadOverlay(overlayPath) {
  const resolved = path.resolve(String(overlayPath || defaultOverlayPath()));
  let raw;
  try {
    raw = fs.readFileSync(resolved, 'utf8');
  } catch (error) {
    // A missing overlay is a legitimate default-OFF situation (metadata is
    // optional); degrade to built-in defaults with a collected warning.
    return {
      overlay: emptyOverlay(),
      warnings: [`routing overlay not readable at ${resolved} (${error.code || firstLine(error.message)}) — using built-in defaults`]
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // A corrupt overlay would silently drop the alwaysLocked security set,
    // so this is the one derivation input we refuse to guess about.
    throw new Error(`routing overlay is not valid JSON at ${resolved}: ${firstLine(error.message)}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`routing overlay must be a JSON object at ${resolved}`);
  }
  return { overlay: parsed, warnings: [] };
}

function resolveDefaults(overlay, warnings) {
  const rawDefaults = isPlainObject(overlay.defaults) ? overlay.defaults : {};
  if (overlay.defaults !== undefined && !isPlainObject(overlay.defaults)) {
    warnings.push('overlay defaults must be an object — using built-in defaults');
  }
  const activationThreshold = asThreshold(rawDefaults.activationThreshold, DEFAULT_ACTIVATION_THRESHOLD, 'overlay defaults.activationThreshold', warnings);
  const deactivationThreshold = asThreshold(rawDefaults.deactivationThreshold, DEFAULT_DEACTIVATION_THRESHOLD, 'overlay defaults.deactivationThreshold', warnings);
  if (deactivationThreshold >= activationThreshold) {
    warnings.push(`overlay defaults thresholds inverted (deactivation ${deactivationThreshold} >= activation ${activationThreshold}) — hysteresis is disabled while inverted`);
  }
  return { activationThreshold, deactivationThreshold };
}

function normalizeAlwaysLocked(raw, warnings) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warnings.push('overlay alwaysLocked must be an array of capability ids — ignoring');
    return [];
  }
  const ids = [];
  for (const item of raw) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      warnings.push('overlay alwaysLocked contains a non-string (or empty) entry — ignored');
      continue;
    }
    ids.push(item.trim());
  }
  return Array.from(new Set(ids)).sort(compareStrings);
}

// ---------------------------------------------------------------------------
// Skill derivation
// ---------------------------------------------------------------------------

function parseSkillFrontmatter(content) {
  const clean = String(content).replace(/^\uFEFF/, '');
  const match = clean.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { ok: false, error: 'no YAML frontmatter block found' };
  let data;
  try {
    data = yaml.load(match[1]);
  } catch (error) {
    return { ok: false, error: `frontmatter is not valid YAML: ${firstLine(error.message)}` };
  }
  if (!isPlainObject(data)) return { ok: false, error: 'frontmatter did not parse to a mapping' };
  return { ok: true, data };
}

function deriveSkillCapabilities(repoRoot, defaults, warnings) {
  const skillsDir = path.join(repoRoot, 'skills');
  let dirents;
  try {
    dirents = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch (error) {
    warnings.push(`skills directory not readable at ${displayPath(repoRoot, skillsDir)} (${error.code || firstLine(error.message)}) — no skills derived`);
    return [];
  }

  const entries = [];
  for (const dirent of dirents.filter(item => item.isDirectory()).sort((a, b) => compareStrings(a.name, b.name))) {
    const skillMdPath = path.join(skillsDir, dirent.name, 'SKILL.md');

    let stat;
    try {
      stat = fs.statSync(skillMdPath);
    } catch (error) {
      if (error.code === 'ENOENT') continue; // dir without SKILL.md — expected, skip silently
      warnings.push(`skill ${dirent.name}: cannot stat SKILL.md (${error.code || firstLine(error.message)}) — skipped`);
      continue;
    }
    if (!stat.isFile()) continue;

    let content;
    try {
      content = fs.readFileSync(skillMdPath, 'utf8');
    } catch (error) {
      warnings.push(`skill ${dirent.name}: cannot read SKILL.md (${error.code || firstLine(error.message)}) — skipped`);
      continue;
    }

    // One malformed skill must never break the whole registry: collect a
    // warning and keep going.
    const parsed = parseSkillFrontmatter(content);
    if (!parsed.ok) {
      warnings.push(`skill ${dirent.name}: ${parsed.error} — skipped`);
      continue;
    }
    const name = typeof parsed.data.name === 'string' ? parsed.data.name.trim() : '';
    const description = typeof parsed.data.description === 'string' ? parsed.data.description.trim() : '';
    if (!name) {
      warnings.push(`skill ${dirent.name}: frontmatter missing required field: name — skipped`);
      continue;
    }
    if (!description) {
      warnings.push(`skill ${dirent.name}: frontmatter missing required field: description — skipped`);
      continue;
    }

    entries.push(
      baseEntry({
        id: `skill:${dirent.name}`,
        type: 'skill',
        name,
        description,
        available: true,
        source: `skills/${dirent.name}/SKILL.md`,
        defaults
      })
    );
  }
  return entries;
}

// ---------------------------------------------------------------------------
// MCP derivation (reuses mcp-inventory; never re-implemented here)
// ---------------------------------------------------------------------------

function deriveMcpCapabilities(mcpInventory, collectOptions, warnings, defaults) {
  let inventory = mcpInventory;
  if (inventory === undefined || inventory === null) {
    try {
      inventory = collectMcpInventory(collectOptions);
    } catch (error) {
      warnings.push(`MCP inventory collection failed (${firstLine(error.message)}) — no MCPs derived`);
      inventory = { servers: [] };
    }
  }

  const servers = isPlainObject(inventory) && Array.isArray(inventory.servers) ? inventory.servers : [];
  const entries = [];
  for (const server of servers) {
    if (!isPlainObject(server)) continue;
    const name = typeof server.name === 'string' && server.name.trim().length > 0 ? server.name.trim() : 'unknown';
    const sources = Array.isArray(server.sources) ? server.sources : [];
    const harnesses = Array.from(new Set(sources.map(source => (isPlainObject(source) && typeof source.harness === 'string' ? source.harness : 'unknown')))).sort(compareStrings);
    const transport = typeof server.transport === 'string' ? server.transport : 'stdio';
    const enabled = server.enabled !== false;
    entries.push(
      baseEntry({
        id: `mcp:${name}`,
        type: 'mcp',
        name,
        description: `MCP server (${transport}${enabled ? '' : ', disabled'}) configured in ${harnesses.length > 0 ? harnesses.join(', ') : 'unknown harness'}`,
        available: enabled,
        source: harnesses.length > 0 ? harnesses.join(',') : 'unknown',
        defaults
      })
    );
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Overlay merge
// ---------------------------------------------------------------------------

function baseEntry({ id, type, name, description, available, source, defaults }) {
  return {
    id,
    type,
    name,
    description: typeof description === 'string' ? description : '',
    positiveTriggers: [],
    negativeTriggers: [],
    dependencies: [],
    conflicts: [],
    activationThreshold: defaults.activationThreshold,
    deactivationThreshold: defaults.deactivationThreshold,
    lockable: true,
    available: Boolean(available),
    source: typeof source === 'string' ? source : ''
  };
}

function capabilityTypeFromId(id) {
  for (const prefix of CAPABILITY_ID_PREFIXES) {
    if (id.startsWith(`${prefix}:`)) return prefix;
  }
  return null;
}

function applyOverlayMetadata(entry, meta, defaults, warnings) {
  entry.positiveTriggers = asStringArray(meta.positiveTriggers);
  entry.negativeTriggers = asStringArray(meta.negativeTriggers);
  entry.dependencies = asStringArray(meta.dependencies);
  entry.conflicts = asStringArray(meta.conflicts);
  entry.activationThreshold = asThreshold(meta.activationThreshold, defaults.activationThreshold, `overlay entry ${entry.id} activationThreshold`, warnings);
  entry.deactivationThreshold = asThreshold(meta.deactivationThreshold, defaults.deactivationThreshold, `overlay entry ${entry.id} deactivationThreshold`, warnings);
  if (entry.deactivationThreshold >= entry.activationThreshold) {
    warnings.push(
      `overlay entry ${entry.id} has inverted thresholds (deactivation ${entry.deactivationThreshold} >= activation ${entry.activationThreshold}) — hysteresis is disabled for this capability`
    );
  }
  if (typeof meta.lockable === 'boolean') {
    entry.lockable = meta.lockable;
  } else if (meta.lockable !== undefined) {
    warnings.push(`overlay entry ${entry.id} lockable must be a boolean — ignoring`);
  }
}

// ---------------------------------------------------------------------------
// buildRegistry
// ---------------------------------------------------------------------------

function buildRegistry(options = {}) {
  const warnings = [];
  const repoRoot = path.resolve(options.repoRoot || defaultRepoRoot());

  let overlay = options.overlay;
  if (overlay === undefined || overlay === null) {
    const loaded = loadOverlay(options.overlayPath || defaultOverlayPath(repoRoot));
    overlay = loaded.overlay;
    warnings.push(...loaded.warnings);
  } else if (!isPlainObject(overlay)) {
    overlay = emptyOverlay();
    warnings.push('routing overlay argument is not an object — using built-in defaults');
  }

  const defaults = resolveDefaults(overlay, warnings);
  const alwaysLocked = normalizeAlwaysLocked(overlay.alwaysLocked, warnings);

  const entries = new Map();
  for (const entry of deriveSkillCapabilities(repoRoot, defaults, warnings)) entries.set(entry.id, entry);
  for (const entry of deriveMcpCapabilities(options.mcpInventory, options.collectMcpOptions, warnings, defaults)) entries.set(entry.id, entry);

  // Overlay-declared capabilities: tool opt-ins (created here — this is the
  // ONLY way a tool enters the registry) plus routing metadata and
  // unavailable placeholders for declared-but-missing skills/MCPs.
  const overlayCapabilities = isPlainObject(overlay.capabilities) ? overlay.capabilities : {};
  if (overlay.capabilities !== undefined && !isPlainObject(overlay.capabilities)) {
    warnings.push('overlay capabilities must be an object keyed by capability id — ignoring');
  }
  for (const id of Object.keys(overlayCapabilities).sort(compareStrings)) {
    const meta = overlayCapabilities[id];
    const type = capabilityTypeFromId(id);
    if (!type) {
      warnings.push(`overlay capability id has unknown type prefix (expected skill:|mcp:|tool:): ${id} — skipped`);
      continue;
    }

    let entry = entries.get(id);
    if (!entry) {
      // Tools exist by declaration (explicit opt-in); skills/MCPs must be
      // found in their source of truth or they are unavailable (hard rules
      // force unavailable capabilities OFF).
      const available = type === 'tool';
      const name = id.slice(type.length + 1);
      const description = isPlainObject(meta) && typeof meta.description === 'string' ? meta.description.trim() : '';
      entry = baseEntry({ id, type, name, description, available, source: 'overlay', defaults });
      if (!available) warnings.push(`overlay declares ${id} but no matching capability was found in its source — marked unavailable`);
      entries.set(id, entry);
    }

    if (!isPlainObject(meta)) {
      warnings.push(`overlay entry for ${id} is not an object — only the id is applied`);
      applyOverlayMetadata(entry, {}, defaults, warnings);
      continue;
    }
    applyOverlayMetadata(entry, meta, defaults, warnings);
  }

  // alwaysLocked wins over any per-entry lockable flag: the lock is permanent
  // and outside JEV's (and the overlay author's) reach.
  for (const id of alwaysLocked) {
    const entry = entries.get(id);
    if (!entry) {
      warnings.push(`alwaysLocked capability not present in registry: ${id}`);
      continue;
    }
    entry.lockable = false;
  }

  const capabilities = Array.from(entries.values()).sort((a, b) => compareStrings(a.id, b.id));

  // Referential integrity for routing edges (dependencies/conflicts must point
  // at registry ids or the controller could never apply them).
  for (const entry of capabilities) {
    for (const dependency of entry.dependencies) {
      if (!entries.has(dependency)) warnings.push(`dependency of ${entry.id} is not in the registry: ${dependency}`);
    }
    for (const conflict of entry.conflicts) {
      if (!entries.has(conflict)) warnings.push(`conflict of ${entry.id} is not in the registry: ${conflict}`);
    }
  }

  const counts = { skill: 0, mcp: 0, tool: 0, total: capabilities.length };
  for (const capability of capabilities) counts[capability.type] += 1;

  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    defaults,
    alwaysLocked,
    capabilities,
    buildSummary: { counts, warnings }
  };
}

// ---------------------------------------------------------------------------
// Registry cache
// ---------------------------------------------------------------------------
//
// The cache envelope is { schemaVersion, fingerprint, builtAt, inputs, registry }.
// Structural validity alone would let a stale cache be served indefinitely, so
// loadRegistry also checks freshness: the envelope records the derivation
// inputs it was built from (repoRoot + overlayPath) and a cheap fingerprint of
// them — count + sorted names of the skills/*/ dirs, the overlay file mtime,
// and the registry schema version (deliberately NOT a digest of every SKILL.md:
// too heavy to recompute on every load; content drift the fingerprint cannot
// see is the doctor's deep-compare job). On any mismatch the cache is
// re-derived and rewritten; a corrupt or unreadable cache still falls back to
// live derivation.

function normalizeConfigArg(config) {
  if (isPlainObject(config) && isPlainObject(config.config)) return config.config;
  return isPlainObject(config) ? config : {};
}

function resolveRegistryPathOption(options = {}) {
  if (options.registryPath) return options.registryPath;
  if (isPlainObject(options.config) && options.config.registryPath) return options.config.registryPath;
  return defaultRegistryPath(options.env || process.env);
}

// Deterministic, cheap digest of the live derivation inputs (never throws:
// an unreadable skills dir or a missing overlay is a legitimate input state).
function computeRegistryFingerprint(repoRoot, overlayPath) {
  const skillsDir = path.join(repoRoot, 'skills');
  let skillNames = [];
  try {
    skillNames = fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name)
      .sort(compareStrings);
  } catch {
    skillNames = [];
  }
  let overlayMtimeMs = 0;
  try {
    overlayMtimeMs = Math.round(fs.statSync(path.resolve(String(overlayPath || defaultOverlayPath(repoRoot)))).mtimeMs);
  } catch {
    overlayMtimeMs = 0;
  }
  return JSON.stringify({ schemaVersion: REGISTRY_SCHEMA_VERSION, skillCount: skillNames.length, skillNames, overlayMtimeMs });
}

function writeRegistryCache(registry, options = {}) {
  const target = path.resolve(resolveRegistryPathOption(options));
  const repoRoot = path.resolve(options.repoRoot || defaultRepoRoot());
  const overlayPath = options.overlayPath || defaultOverlayPath(repoRoot);
  const envelope = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    fingerprint: computeRegistryFingerprint(repoRoot, overlayPath),
    builtAt: new Date().toISOString(),
    inputs: { repoRoot, overlayPath },
    registry
  };
  writeFileAtomic(target, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
  return target;
}

// Returns the full cache envelope, or null when absent/corrupt (parse guarded).
// Never throws: callers fall back to live derivation.
function readRegistryCacheEnvelope(registryPath) {
  const target = path.resolve(String(registryPath || defaultRegistryPath()));
  let raw;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed) || parsed.schemaVersion !== CACHE_SCHEMA_VERSION) return null;
  if (!isPlainObject(parsed.registry)) return null;
  if (typeof parsed.registry.schemaVersion !== 'string' || !Array.isArray(parsed.registry.capabilities)) return null;
  return parsed;
}

// Returns the cached registry, or null when absent/corrupt (parse guarded).
// Never throws: callers fall back to live derivation.
function readRegistryCache(registryPath) {
  const envelope = readRegistryCacheEnvelope(registryPath);
  return envelope ? envelope.registry : null;
}

function loadRegistry(config = {}) {
  const cfg = normalizeConfigArg(config);
  const registryPath = resolveRegistryPathOption(cfg);

  // Freshness: the cache is served only when the derivation inputs it was
  // built from are unchanged (recorded in the envelope) and their live
  // fingerprint still matches. Explicit cfg inputs win over the recorded ones;
  // a bare load validates the cache against its own recorded inputs.
  const envelope = readRegistryCacheEnvelope(registryPath);
  if (envelope) {
    const stored = isPlainObject(envelope.inputs) ? envelope.inputs : {};
    const explicitRepoRoot = cfg.repoRoot ? path.resolve(cfg.repoRoot) : null;
    const explicitOverlayPath = cfg.overlayPath ? path.resolve(cfg.overlayPath) : null;
    const storedRepoRoot = stored.repoRoot ? path.resolve(stored.repoRoot) : null;
    const storedOverlayPath = stored.overlayPath ? path.resolve(stored.overlayPath) : null;
    const repoRoot = explicitRepoRoot || storedRepoRoot || path.resolve(defaultRepoRoot());
    const overlayPath = explicitOverlayPath || storedOverlayPath || defaultOverlayPath(repoRoot);
    const inputsUnchanged = (!storedRepoRoot || storedRepoRoot === repoRoot) && (!storedOverlayPath || storedOverlayPath === overlayPath);
    if (inputsUnchanged && envelope.fingerprint === computeRegistryFingerprint(repoRoot, overlayPath)) {
      return { registry: envelope.registry, source: 'cache' };
    }
  }

  const repoRoot = path.resolve(cfg.repoRoot || defaultRepoRoot());
  const registry = buildRegistry({
    repoRoot,
    overlay: cfg.overlay,
    overlayPath: cfg.overlayPath || defaultOverlayPath(repoRoot),
    // Injectable so callers (and tests) can pin the MCP inventory instead of
    // reading the live harness configs during a fallback derivation.
    mcpInventory: cfg.mcpInventory,
    collectMcpOptions: cfg.collectMcpOptions
  });
  try {
    writeRegistryCache(registry, { registryPath, repoRoot, overlayPath: cfg.overlayPath || defaultOverlayPath(repoRoot) });
  } catch {
    // A cache write failure must never break loading; the next load re-derives.
  }
  return { registry, source: 'derived' };
}

module.exports = {
  REGISTRY_SCHEMA_VERSION,
  CACHE_SCHEMA_VERSION,
  DEFAULT_ACTIVATION_THRESHOLD,
  DEFAULT_DEACTIVATION_THRESHOLD,
  VALID_STATE_VALUES,
  buildRegistry,
  loadRegistry,
  writeRegistryCache,
  readRegistryCache,
  readRegistryCacheEnvelope,
  computeRegistryFingerprint,
  parseSkillFrontmatter,
  loadOverlay,
  defaultRepoRoot,
  defaultOverlayPath,
  defaultDataRoot,
  defaultRegistryPath
};
