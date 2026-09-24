'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildRegistry,
  loadRegistry,
  writeRegistryCache,
  readRegistryCache,
  parseSkillFrontmatter,
  loadOverlay,
  defaultRegistryPath,
  defaultOverlayPath,
  DEFAULT_ACTIVATION_THRESHOLD,
  DEFAULT_DEACTIVATION_THRESHOLD,
  CACHE_SCHEMA_VERSION,
  REGISTRY_SCHEMA_VERSION
} = require('../../../scripts/lib/jev-switchboard/registry');

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

// ---------------------------------------------------------------------------
// Fixture tree: repoRoot with 3 skill dirs — one good, one malformed
// frontmatter, one without SKILL.md — plus a second repoRoot whose only skill
// lacks a name. All under /tmp/ecc-* so nothing touches the real repo.
// ---------------------------------------------------------------------------

const fixtureRoot = fs.mkdtempSync(`${os.tmpdir()}/ecc-registry-test-`);
const fixtureNoName = fs.mkdtempSync(`${os.tmpdir()}/ecc-registry-noname-`);

fs.mkdirSync(path.join(fixtureRoot, 'skills', 'alpha'), { recursive: true });
fs.writeFileSync(path.join(fixtureRoot, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha-skill\ndescription: Does alpha things routing needs to know about.\n---\n\n# Alpha\n');
fs.mkdirSync(path.join(fixtureRoot, 'skills', 'bad-yaml'), { recursive: true });
fs.writeFileSync(path.join(fixtureRoot, 'skills', 'bad-yaml', 'SKILL.md'), '---\nname: [unclosed\ndescription: broken on purpose\n---\n');
fs.mkdirSync(path.join(fixtureRoot, 'skills', 'no-skill-md'), { recursive: true });

fs.mkdirSync(path.join(fixtureNoName, 'skills', 'only'), { recursive: true });
fs.writeFileSync(path.join(fixtureNoName, 'skills', 'only', 'SKILL.md'), '---\ndescription: has a description but no name\n---\n');

const overlay = {
  version: 1,
  defaults: { activationThreshold: 0.7, deactivationThreshold: 0.3 },
  capabilities: {
    'skill:alpha': { positiveTriggers: ['alpha work'], activationThreshold: 0.8, lockable: true, dependencies: ['skill:ghost'] },
    'skill:ghost': { positiveTriggers: ['ghost protocol'], description: 'Declared but missing from the skills dir.', dependencies: ['skill:nobody'] },
    'tool:WebSearch': { description: 'Search the web.', positiveTriggers: ['search'], deactivationThreshold: 0.2, conflicts: ['tool:Nobody'] },
    'tool:BadThresholds': { description: 'Inverted on purpose.', activationThreshold: 0.1, deactivationThreshold: 0.9 },
    'bogus:x': { positiveTriggers: ['nope'] }
  },
  alwaysLocked: ['skill:alpha', 'skill:never-exists']
};

const mcpInventory = {
  schemaVersion: 'ecc.mcp.v1',
  servers: [
    { name: 'zeta-server', transport: 'stdio', enabled: true, sources: [{ harness: 'codex' }, { harness: 'claude-code' }] },
    { name: 'alpha-server', transport: 'http', enabled: false, sources: [{ harness: 'opencode' }] }
  ],
  fragmentation: [],
  aggregates: {}
};

const result = buildRegistry({ repoRoot: fixtureRoot, overlay, mcpInventory });
const byId = new Map(result.capabilities.map(capability => [capability.id, capability]));
const warnings = result.buildSummary.warnings;
const warningText = warnings.join('\n');

console.log('\njev-switchboard registry');

if (
  test('derives skill entries from SKILL.md frontmatter (name + description)', () => {
    const alpha = byId.get('skill:alpha');
    assert.ok(alpha, 'skill:alpha entry exists');
    assert.strictEqual(alpha.type, 'skill');
    assert.strictEqual(alpha.name, 'alpha-skill');
    assert.strictEqual(alpha.description, 'Does alpha things routing needs to know about.');
    assert.strictEqual(alpha.source, 'skills/alpha/SKILL.md');
    assert.strictEqual(alpha.available, true);
  })
)
  passed++;
else failed++;

if (
  test('skips a malformed-frontmatter skill with a collected warning, never throws', () => {
    assert.ok(!byId.has('skill:bad-yaml'), 'malformed skill is not in the registry');
    assert.ok(
      warnings.some(w => w.includes('skill bad-yaml') && w.includes('skipped')),
      `warning collected: ${warningText}`
    );
  })
)
  passed++;
else failed++;

if (
  test('skips a skill dir without SKILL.md silently', () => {
    assert.ok(!byId.has('skill:no-skill-md'));
    assert.ok(!warnings.some(w => w.includes('no-skill-md')), 'no warning for a dir without SKILL.md');
  })
)
  passed++;
else failed++;

if (
  test('warns when frontmatter is missing the name field', () => {
    const noName = buildRegistry({ repoRoot: fixtureNoName, overlay: { capabilities: {} } });
    assert.strictEqual(noName.buildSummary.counts.skill, 0);
    assert.ok(noName.buildSummary.warnings.some(w => w.includes('skill only') && w.includes('required field: name')));
  })
)
  passed++;
else failed++;

if (
  test('derives MCP capabilities from the canonical ecc.mcp.v1 inventory', () => {
    const zeta = byId.get('mcp:zeta-server');
    assert.ok(zeta, 'mcp:zeta-server exists');
    assert.strictEqual(zeta.type, 'mcp');
    assert.strictEqual(zeta.available, true);
    assert.ok(zeta.description.includes('stdio'), `description mentions transport: ${zeta.description}`);
    assert.ok(zeta.description.includes('claude-code, codex'), 'harnesses listed in sorted order');

    const disabled = byId.get('mcp:alpha-server');
    assert.ok(disabled, 'mcp:alpha-server exists');
    assert.strictEqual(disabled.available, false, 'disabled server is unavailable');
    assert.ok(disabled.description.includes('disabled'));
  })
)
  passed++;
else failed++;

if (
  test('adds overlay-declared tools only — core host tools are never auto-added', () => {
    const toolIds = result.capabilities
      .filter(capability => capability.type === 'tool')
      .map(capability => capability.id)
      .sort();
    assert.deepStrictEqual(toolIds, ['tool:BadThresholds', 'tool:WebSearch']);
    assert.ok(!byId.has('tool:Bash'), 'core host tools absent without an overlay opt-in');
    const webSearch = byId.get('tool:WebSearch');
    assert.strictEqual(webSearch.available, true, 'declared tool exists by declaration');
    assert.strictEqual(webSearch.description, 'Search the web.');
    assert.strictEqual(webSearch.source, 'overlay');
  })
)
  passed++;
else failed++;

if (
  test('marks overlay-declared but missing skills unavailable with a warning', () => {
    const ghost = byId.get('skill:ghost');
    assert.ok(ghost, 'placeholder entry exists');
    assert.strictEqual(ghost.available, false);
    assert.strictEqual(ghost.source, 'overlay');
    assert.ok(warnings.some(w => w.includes('skill:ghost') && w.includes('unavailable')));
  })
)
  passed++;
else failed++;

if (
  test('merges overlay triggers, dependencies, conflicts and per-capability thresholds', () => {
    const alpha = byId.get('skill:alpha');
    assert.deepStrictEqual(alpha.positiveTriggers, ['alpha work']);
    assert.deepStrictEqual(alpha.negativeTriggers, []);
    assert.deepStrictEqual(alpha.dependencies, ['skill:ghost']);
    assert.strictEqual(alpha.activationThreshold, 0.8);
    assert.strictEqual(alpha.deactivationThreshold, 0.3, 'overlay default fills unspecified threshold');

    const webSearch = byId.get('tool:WebSearch');
    assert.strictEqual(webSearch.activationThreshold, 0.7, 'overlay defaults.activationThreshold');
    assert.strictEqual(webSearch.deactivationThreshold, 0.2);
    assert.deepStrictEqual(webSearch.conflicts, ['tool:Nobody']);
  })
)
  passed++;
else failed++;

if (
  test('alwaysLocked forces lockable false, overriding an overlay lockable true', () => {
    assert.strictEqual(byId.get('skill:alpha').lockable, false, 'alwaysLocked wins over overlay lockable:true');
    assert.strictEqual(byId.get('skill:ghost').lockable, true, 'unlocked entries stay lockable');
    assert.deepStrictEqual(result.alwaysLocked, ['skill:alpha', 'skill:never-exists'], 'sorted and retained');
    assert.ok(warnings.some(w => w.includes('alwaysLocked capability not present in registry: skill:never-exists')));
  })
)
  passed++;
else failed++;

if (
  test('warns on unknown capability id prefixes and inverted thresholds', () => {
    assert.ok(warnings.some(w => w.includes('bogus:x') && w.includes('unknown type prefix')));
    assert.ok(!byId.has('bogus:x'));
    assert.ok(warnings.some(w => w.includes('tool:BadThresholds') && w.includes('inverted thresholds')));
    const bad = byId.get('tool:BadThresholds');
    assert.strictEqual(bad.activationThreshold, 0.1, 'inverted values are kept, only warned about');
    assert.strictEqual(bad.deactivationThreshold, 0.9);
  })
)
  passed++;
else failed++;

if (
  test('warns on dependencies and conflicts that reference unknown ids', () => {
    assert.ok(warnings.some(w => w.includes('dependency of skill:ghost is not in the registry: skill:nobody')));
    assert.ok(warnings.some(w => w.includes('conflict of tool:WebSearch is not in the registry: tool:Nobody')));
    assert.ok(!warnings.some(w => w.includes('dependency of skill:alpha')), 'valid dependency produces no warning');
  })
)
  passed++;
else failed++;

if (
  test('output is sorted by id and deterministic across builds', () => {
    const ids = result.capabilities.map(capability => capability.id);
    assert.deepStrictEqual(ids, [...ids].sort(), 'capabilities sorted by id');
    const second = buildRegistry({ repoRoot: fixtureRoot, overlay, mcpInventory });
    assert.deepStrictEqual(second, result, 'bit-for-bit identical rebuild');
  })
)
  passed++;
else failed++;

if (
  test('buildSummary counts capabilities by type', () => {
    assert.deepStrictEqual(result.buildSummary.counts, { skill: 2, mcp: 2, tool: 2, total: 6 });
  })
)
  passed++;
else failed++;

if (
  test('resolves registry defaults from the overlay with validation', () => {
    assert.deepStrictEqual(result.defaults, { activationThreshold: 0.7, deactivationThreshold: 0.3 });
    const invalid = buildRegistry({
      repoRoot: fixtureRoot,
      overlay: { defaults: { activationThreshold: 'high', deactivationThreshold: 0.35 }, capabilities: {} }
    });
    assert.strictEqual(invalid.defaults.activationThreshold, DEFAULT_ACTIVATION_THRESHOLD, 'invalid default falls back');
    assert.strictEqual(invalid.defaults.deactivationThreshold, DEFAULT_DEACTIVATION_THRESHOLD);
    assert.ok(invalid.buildSummary.warnings.some(w => w.includes('overlay defaults.activationThreshold')));
  })
)
  passed++;
else failed++;

if (
  test('missing overlay file degrades to built-in defaults with a warning; corrupt overlay throws', () => {
    const missing = buildRegistry({ repoRoot: fixtureRoot, overlayPath: path.join(fixtureRoot, 'no-such-overlay.json'), mcpInventory });
    assert.deepStrictEqual(missing.defaults, { activationThreshold: DEFAULT_ACTIVATION_THRESHOLD, deactivationThreshold: DEFAULT_DEACTIVATION_THRESHOLD });
    assert.ok(missing.buildSummary.warnings.some(w => w.includes('routing overlay not readable')));

    const corruptPath = path.join(fixtureRoot, 'corrupt-overlay.json');
    fs.writeFileSync(corruptPath, '{ not json');
    assert.throws(() => loadOverlay(corruptPath), /not valid JSON/);
  })
)
  passed++;
else failed++;

if (
  test('parseSkillFrontmatter flags a missing frontmatter block', () => {
    const parsed = parseSkillFrontmatter('# Just markdown, no frontmatter\n');
    assert.strictEqual(parsed.ok, false);
    assert.ok(parsed.error.includes('no YAML frontmatter block'));
  })
)
  passed++;
else failed++;

if (
  test('writeRegistryCache + loadRegistry roundtrip through the cache', () => {
    const cachePath = path.join(fixtureRoot, 'cache', 'jev-registry.json');
    const written = writeRegistryCache(result, { registryPath: cachePath, repoRoot: fixtureRoot });
    assert.strictEqual(written, cachePath);
    assert.ok(fs.statSync(cachePath).isFile());

    const envelope = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    assert.strictEqual(envelope.schemaVersion, CACHE_SCHEMA_VERSION);
    assert.deepStrictEqual(envelope.registry, result);
    assert.ok(typeof envelope.fingerprint === 'string' && envelope.fingerprint.length > 0, 'cache envelope carries a fingerprint');
    assert.ok(typeof envelope.builtAt === 'string' && !Number.isNaN(Date.parse(envelope.builtAt)), 'cache envelope carries builtAt');
    assert.deepStrictEqual(envelope.inputs, { repoRoot: fixtureRoot, overlayPath: defaultOverlayPath(fixtureRoot) }, 'cache envelope records its derivation inputs');

    const loaded = loadRegistry({ registryPath: cachePath, repoRoot: fixtureRoot, overlay });
    assert.strictEqual(loaded.source, 'cache');
    assert.deepStrictEqual(loaded.registry, result);

    const wrapped = loadRegistry({ config: { registryPath: cachePath } });
    assert.strictEqual(wrapped.source, 'cache', 'loadRegistry({config}) unwrap form works');
  })
)
  passed++;
else failed++;

if (
  test('loadRegistry falls back to live derivation on absent or corrupt cache', () => {
    const absent = loadRegistry({ registryPath: path.join(fixtureRoot, 'cache', 'never-written.json'), repoRoot: fixtureRoot, overlay, mcpInventory });
    assert.strictEqual(absent.source, 'derived');
    assert.deepStrictEqual(absent.registry, result);

    const corruptPath = path.join(fixtureRoot, 'cache', 'corrupt.json');
    fs.mkdirSync(path.dirname(corruptPath), { recursive: true });
    fs.writeFileSync(corruptPath, '{ this is not json');
    assert.strictEqual(readRegistryCache(corruptPath), null, 'parse is guarded, never throws');
    const corrupt = loadRegistry({ registryPath: corruptPath, repoRoot: fixtureRoot, overlay, mcpInventory });
    assert.strictEqual(corrupt.source, 'derived');
    assert.deepStrictEqual(corrupt.registry, result);
    const repaired = JSON.parse(fs.readFileSync(corruptPath, 'utf8'));
    assert.strictEqual(repaired.schemaVersion, CACHE_SCHEMA_VERSION, 'fallback derivation rewrites the corrupt cache');
  })
)
  passed++;
else failed++;

if (
  test('serves the cache without rewriting it when the live fingerprint matches', () => {
    const cachePath = path.join(fixtureRoot, 'cache', 'fresh.json');
    writeRegistryCache(result, { registryPath: cachePath, repoRoot: fixtureRoot });
    const before = fs.readFileSync(cachePath, 'utf8');
    const loaded = loadRegistry({ registryPath: cachePath, repoRoot: fixtureRoot, overlay, mcpInventory });
    assert.strictEqual(loaded.source, 'cache');
    assert.deepStrictEqual(loaded.registry, result);
    assert.strictEqual(fs.readFileSync(cachePath, 'utf8'), before, 'a matching fingerprint does not rewrite the cache');
  })
)
  passed++;
else failed++;

if (
  test('regenerates the cache when a skill dir is added or removed from the fixture tree', () => {
    const cachePath = path.join(fixtureRoot, 'cache', 'drift.json');
    writeRegistryCache(result, { registryPath: cachePath, repoRoot: fixtureRoot });

    fs.mkdirSync(path.join(fixtureRoot, 'skills', 'late-skill'), { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, 'skills', 'late-skill', 'SKILL.md'), '---\nname: late-skill\ndescription: Arrived after the cache was built.\n---\n');
    const added = loadRegistry({ registryPath: cachePath, repoRoot: fixtureRoot, overlay, mcpInventory });
    assert.strictEqual(added.source, 'derived', 'an added skill dir invalidates the cache');
    assert.ok(added.registry.capabilities.some(capability => capability.id === 'skill:late-skill'), 're-derived registry includes the new skill');
    const rewritten = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    assert.ok(rewritten.registry.capabilities.some(capability => capability.id === 'skill:late-skill'), 'cache is rewritten with the fresh derivation');

    fs.rmSync(path.join(fixtureRoot, 'skills', 'late-skill'), { recursive: true, force: true });
    const removed = loadRegistry({ registryPath: cachePath, repoRoot: fixtureRoot, overlay, mcpInventory });
    assert.strictEqual(removed.source, 'derived', 'a removed skill dir invalidates the cache');
    assert.ok(!removed.registry.capabilities.some(capability => capability.id === 'skill:late-skill'), 're-derived registry drops the removed skill');
  })
)
  passed++;
else failed++;

if (
  test('regenerates the cache when the overlay file mtime changes (touch)', () => {
    const overlayRoot = fs.mkdtempSync(`${os.tmpdir()}/ecc-registry-overlay-`);
    try {
      fs.mkdirSync(path.join(overlayRoot, 'skills', 'solo'), { recursive: true });
      fs.writeFileSync(path.join(overlayRoot, 'skills', 'solo', 'SKILL.md'), '---\nname: solo\ndescription: One skill.\n---\n');
      const overlayFile = path.join(overlayRoot, 'config', 'jev-switchboard-routing.json');
      fs.mkdirSync(path.dirname(overlayFile), { recursive: true });
      fs.writeFileSync(overlayFile, JSON.stringify({ version: 1, capabilities: {} }, null, 2));

      const cachePath = path.join(overlayRoot, 'cache.json');
      const built = buildRegistry({ repoRoot: overlayRoot, overlayPath: overlayFile, mcpInventory });
      writeRegistryCache(built, { registryPath: cachePath, repoRoot: overlayRoot, overlayPath: overlayFile });

      const fresh = loadRegistry({ registryPath: cachePath, repoRoot: overlayRoot, overlayPath: overlayFile, mcpInventory });
      assert.strictEqual(fresh.source, 'cache', 'unchanged overlay mtime serves the cache');

      const later = new Date(Date.now() + 5000);
      fs.utimesSync(overlayFile, later, later);
      const stale = loadRegistry({ registryPath: cachePath, repoRoot: overlayRoot, overlayPath: overlayFile, mcpInventory });
      assert.strictEqual(stale.source, 'derived', 'a touched overlay mtime invalidates the cache');
      assert.deepStrictEqual(stale.registry, built, 're-derivation is deterministic and matches the original build');
    } finally {
      fs.rmSync(overlayRoot, { recursive: true, force: true });
    }
  })
)
  passed++;
else failed++;

if (
  test('defaultRegistryPath prefers plugin root, then agent data home, then ~/.claude', () => {
    assert.strictEqual(defaultRegistryPath({ CLAUDE_PLUGIN_ROOT: '/plugins/ecc', HOME: '/home/tester' }), path.join('/plugins/ecc', 'ecc', 'jev-registry.json'));
    assert.strictEqual(defaultRegistryPath({ ECC_AGENT_DATA_HOME: '/data/root', HOME: '/home/tester' }), path.join('/data/root', 'ecc', 'jev-registry.json'));
    assert.strictEqual(defaultRegistryPath({ HOME: '/home/tester' }), path.join('/home/tester', '.claude', 'ecc', 'jev-registry.json'));
  })
)
  passed++;
else failed++;

if (
  test('registry carries the documented schema version', () => {
    assert.strictEqual(result.schemaVersion, REGISTRY_SCHEMA_VERSION);
  })
)
  passed++;
else failed++;

fs.rmSync(fixtureRoot, { recursive: true, force: true });
fs.rmSync(fixtureNoName, { recursive: true, force: true });

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
