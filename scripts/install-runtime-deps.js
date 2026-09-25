#!/usr/bin/env node
'use strict';

/**
 * Install the production Node dependencies required by copied ECC hook runtime
 * files into Claude install roots. The selective installer copies scripts/lib
 * into ~/.claude or ./.claude, so Node must be able to resolve the production
 * dependencies from that copied location without relying on NODE_PATH or the
 * original source checkout.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RUNTIME_DEPENDENCIES = Object.freeze(['@iarna/toml', 'ajv', 'js-yaml', 'sql.js']);

function parseInstallIntent(args) {
  let target = 'claude';
  let dryRun = false;
  let noHooks = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--dry-run') dryRun = true;
    if (arg === '--no-hooks') noHooks = true;
    if (arg === '--target' && args[i + 1]) {
      target = args[i + 1];
      i += 1;
    }
  }

  return { target, dryRun, noHooks };
}

function resolveTargetRoot(intent, options = {}) {
  const cwd = options.cwd || process.cwd();
  const homeDir = options.homeDir || process.env.HOME || os.homedir();
  if (intent.target === 'claude-project') return path.join(cwd, '.claude');
  if (intent.target === 'claude') return path.join(homeDir, '.claude');
  return null;
}

function loadRuntimeDependencySpecs(repoRoot) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const dependencies = packageJson.dependencies || {};
  return RUNTIME_DEPENDENCIES.map(name => {
    const version = dependencies[name];
    if (!version) throw new Error(`Missing production dependency declaration for ${name}`);
    return `${name}@${version}`;
  });
}

function hookRuntimePresent(targetRoot) {
  return Boolean(
    targetRoot &&
      fs.existsSync(path.join(targetRoot, 'scripts', 'lib', 'jev-switchboard', 'registry.js'))
  );
}

function runtimeDependenciesSatisfied(targetRoot, repoRoot) {
  const expected = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).dependencies || {};
  for (const name of RUNTIME_DEPENDENCIES) {
    const packagePath = path.join(targetRoot, 'node_modules', ...name.split('/'), 'package.json');
    if (!fs.existsSync(packagePath)) return false;
    try {
      const installed = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
      if (String(installed.version) !== String(expected[name])) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function installRuntimeDependencies(targetRoot, repoRoot, options = {}) {
  if (runtimeDependenciesSatisfied(targetRoot, repoRoot)) return { installed: false, reason: 'already-satisfied' };

  const npm = options.npmCommand || (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const specs = loadRuntimeDependencySpecs(repoRoot);
  const args = [
    'install',
    '--prefix', targetRoot,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    '--no-save',
    ...specs,
  ];

  const result = spawnSync(npm, args, {
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm install for hook runtime dependencies failed with status ${result.status}`);

  return { installed: true, reason: 'installed' };
}

function main(args = process.argv.slice(2), options = {}) {
  const intent = parseInstallIntent(args);
  if (intent.dryRun || intent.noHooks) return { skipped: true, reason: intent.dryRun ? 'dry-run' : 'hooks-disabled' };
  if (!['claude', 'claude-project'].includes(intent.target)) return { skipped: true, reason: 'unsupported-target' };

  const repoRoot = options.repoRoot || path.resolve(__dirname, '..');
  const targetRoot = resolveTargetRoot(intent, options);
  if (!hookRuntimePresent(targetRoot)) return { skipped: true, reason: 'hook-runtime-not-installed' };

  const result = installRuntimeDependencies(targetRoot, repoRoot, options);
  if (result.installed) {
    process.stdout.write(`[ECC] Installed hook runtime dependencies into ${targetRoot}\n`);
  }
  return { skipped: false, targetRoot, ...result };
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[ECC] Hook runtime dependency install failed: ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  RUNTIME_DEPENDENCIES,
  parseInstallIntent,
  resolveTargetRoot,
  loadRuntimeDependencySpecs,
  hookRuntimePresent,
  runtimeDependenciesSatisfied,
  installRuntimeDependencies,
  main,
};
