'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  RUNTIME_DEPENDENCIES,
  parseInstallIntent,
  resolveTargetRoot,
  loadRuntimeDependencySpecs,
  hookRuntimePresent,
  runtimeDependenciesSatisfied,
} = require('../../scripts/install-runtime-deps');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${error.stack || error.message}`);
    failed += 1;
  }
}

console.log('\nHook runtime dependency installer');

test('parses Claude project install intent', () => {
  assert.deepStrictEqual(
    parseInstallIntent(['--target', 'claude-project', '--profile', 'core', '--enable-hooks']),
    { target: 'claude-project', dryRun: false, noHooks: false }
  );
});

test('honors dry-run and no-hooks flags', () => {
  assert.strictEqual(parseInstallIntent(['--dry-run']).dryRun, true);
  assert.strictEqual(parseInstallIntent(['--no-hooks']).noHooks, true);
});

test('resolves project-local and home Claude roots', () => {
  assert.strictEqual(
    resolveTargetRoot({ target: 'claude-project' }, { cwd: '/tmp/project', homeDir: '/tmp/home' }),
    path.join('/tmp/project', '.claude')
  );
  assert.strictEqual(
    resolveTargetRoot({ target: 'claude' }, { cwd: '/tmp/project', homeDir: '/tmp/home' }),
    path.join('/tmp/home', '.claude')
  );
  assert.strictEqual(resolveTargetRoot({ target: 'cursor' }, { cwd: '/tmp/project', homeDir: '/tmp/home' }), null);
});

test('derives pinned runtime dependency specs from package.json', () => {
  const repoRoot = path.join(__dirname, '..', '..');
  const specs = loadRuntimeDependencySpecs(repoRoot);
  for (const name of RUNTIME_DEPENDENCIES) {
    assert.ok(specs.some(spec => spec.startsWith(`${name}@`)), `missing ${name}`);
  }
  assert.ok(specs.includes('js-yaml@4.3.2'));
});

test('detects installed hook runtime and exact dependency versions', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-runtime-deps-'));
  const targetRoot = path.join(temp, '.claude');
  const repoRoot = path.join(temp, 'repo');
  fs.mkdirSync(path.join(targetRoot, 'scripts', 'lib', 'jev-switchboard'), { recursive: true });
  fs.writeFileSync(path.join(targetRoot, 'scripts', 'lib', 'jev-switchboard', 'registry.js'), '// test');
  fs.mkdirSync(repoRoot, { recursive: true });

  const dependencies = {
    '@iarna/toml': '2.2.5',
    ajv: '8.20.0',
    'js-yaml': '4.3.2',
    'sql.js': '1.14.2',
  };
  fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ dependencies }));

  assert.strictEqual(hookRuntimePresent(targetRoot), true);
  assert.strictEqual(runtimeDependenciesSatisfied(targetRoot, repoRoot), false);

  for (const [name, version] of Object.entries(dependencies)) {
    const packageDir = path.join(targetRoot, 'node_modules', ...name.split('/'));
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name, version }));
  }

  assert.strictEqual(runtimeDependenciesSatisfied(targetRoot, repoRoot), true);
});

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
