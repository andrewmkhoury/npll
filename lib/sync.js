/**
 * Local package sync via staged tarballs. Cross-platform: uses only Node path/fs/os
 * and spawns package-manager binaries (pnpm/yarn/npm) via PATH.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { detectPackageManager, findWorkspaceRoot } from './detect-pm.js';

const CACHE_DIR = '.local-packages';
const RESTORE_FILE = 'node-link-local-restore.json';
const GITIGNORE_ENTRY = '.local-packages/';

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function resolvePath(p) {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function readPackageInfo(dir) {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) throw new Error(`No package.json in: ${dir}`);
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  return { name: pkg.name, version: pkg.version || '0.0.0' };
}

/** Run cmd with args in cwd. Uses shell so Windows finds pnpm.cmd / yarn.cmd / npm.cmd. */
function run(cwd, cmd, args, opts = {}) {
  const env = { ...process.env, COREPACK_ENABLE_STRICT: '0', ...opts.env };
  const result = spawnSync(cmd, args, {
    cwd,
    env,
    stdio: opts.quiet ? 'pipe' : 'inherit',
    shell: true,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(' ')} (exit ${result.status})`);
  }
}

/** Tarball basename for scoped packages: @scope/pkg -> scope-pkg-1.0.0.tgz */
function tarballBasename(pkgName) {
  return pkgName.startsWith('@') ? pkgName.slice(1).replace('/', '-') : pkgName;
}

function findLatestTarball(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.tgz'));
  if (files.length === 0) return null;
  const withTime = files.map((f) => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }));
  withTime.sort((a, b) => b.mtime - a.mtime);
  return withTime[0].name;
}

function deleteStagedTarballs(cacheDir, pkgName) {
  if (!fs.existsSync(cacheDir)) return;
  const prefix = tarballBasename(pkgName) + '-';
  for (const f of fs.readdirSync(cacheDir)) {
    if (f.startsWith(prefix) && f.endsWith('.tgz')) {
      fs.unlinkSync(path.join(cacheDir, f));
    }
  }
}

/** Remove .local-packages dir if it's empty. */
function cleanCacheDir(appDir) {
  const cacheDir = path.join(appDir, CACHE_DIR);
  if (!fs.existsSync(cacheDir)) return;
  const files = fs.readdirSync(cacheDir).filter((f) => f !== RESTORE_FILE);
  if (files.length === 0) fs.rmSync(cacheDir, { recursive: true });
}

/** True if arg looks like a path (not a bare package name). */
function isPathArg(arg) {
  // Scoped package names (@scope/name) contain / but are not filesystem paths.
  if (/^@[^/]+\/[^/]+$/.test(arg)) return false;
  return arg.includes(path.sep) || arg.startsWith('.') || /^[A-Za-z]:/.test(arg);
}

/** Resolve package name: if path arg, read from lib package.json; else return as name. */
function resolvePackageName(appDir, nameOrPath) {
  if (!isPathArg(nameOrPath)) return nameOrPath;
  const libDir = resolvePath(path.resolve(appDir, nameOrPath));
  return readPackageInfo(libDir).name;
}

// ---------------------------------------------------------------------------
// Restore manifest — records each package's original version spec so remove
// can put it back exactly as it was (or delete it if it wasn't there before).
// ---------------------------------------------------------------------------

function getRestorePath(appDir) {
  return path.join(appDir, CACHE_DIR, RESTORE_FILE);
}

function readRestore(appDir) {
  const fp = getRestorePath(appDir);
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function writeRestore(appDir, data) {
  const cacheDir = path.join(appDir, CACHE_DIR);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(getRestorePath(appDir), JSON.stringify(data, null, 2));
}

/** Snapshot pkgName's current version spec in the restore manifest (called before add). */
function saveRestoreEntry(appDir, pkgName) {
  const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
  const restore = readRestore(appDir) || { dependencies: {}, devDependencies: {} };
  const dep = pkg.dependencies?.[pkgName];
  const dev = pkg.devDependencies?.[pkgName];
  // Store the original spec, or delete the key if the package wasn't there.
  if (typeof dep === 'string') {
    restore.dependencies[pkgName] = dep;
  } else {
    delete restore.dependencies[pkgName];
  }
  if (typeof dev === 'string') {
    restore.devDependencies[pkgName] = dev;
  } else {
    delete restore.devDependencies[pkgName];
  }
  writeRestore(appDir, restore);
}

/** Pop pkgName from restore manifest. Returns { dependency, devDependency } (undefined = wasn't there). */
function popRestoreEntry(appDir, pkgName) {
  const restore = readRestore(appDir);
  if (!restore) return { dependency: undefined, devDependency: undefined };
  const dependency = restore.dependencies?.[pkgName];
  const devDependency = restore.devDependencies?.[pkgName];
  delete restore.dependencies[pkgName];
  delete restore.devDependencies[pkgName];
  const hasEntries =
    Object.keys(restore.dependencies).length > 0 ||
    Object.keys(restore.devDependencies).length > 0;
  if (hasEntries) {
    writeRestore(appDir, restore);
  } else {
    const fp = getRestorePath(appDir);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  return { dependency, devDependency };
}

// ---------------------------------------------------------------------------
// Gitignore helper
// ---------------------------------------------------------------------------

function hasGitDir(dir) {
  return fs.existsSync(path.join(dir, '.git'));
}

function gitignoreHasLocalPackages(dir) {
  const gitignorePath = path.join(dir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) return false;
  return fs
    .readFileSync(gitignorePath, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean)
    .some((l) => l === '.local-packages' || l === '.local-packages/' || l.startsWith('.local-packages'));
}

function promptGitignoreIfNeeded(appDir, log) {
  if (!hasGitDir(appDir) || gitignoreHasLocalPackages(appDir)) return;
  log('');
  log('💡 Consider adding the following to your .gitignore so staged tarballs are not committed:');
  log(`   ${GITIGNORE_ENTRY}`);
  log('');
}

// ---------------------------------------------------------------------------
// Pack helpers
// ---------------------------------------------------------------------------

/**
 * Normalize package.json in a temp copy before packing (yarn/npm sources only).
 * Replaces workspace: specifiers with * and strips lifecycle scripts.
 * pnpm sources skip this — pnpm pack resolves all protocols natively.
 */
function normalizePackageJson(dir) {
  const pkgPath = path.join(dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

  const fixDeps = (deps) => {
    if (!deps) return;
    for (const k of Object.keys(deps)) {
      if (typeof deps[k] === 'string' && deps[k].startsWith('workspace:')) deps[k] = '*';
    }
  };
  fixDeps(pkg.dependencies);
  fixDeps(pkg.devDependencies);
  fixDeps(pkg.peerDependencies);

  pkg.scripts = pkg.scripts || {};
  delete pkg.scripts.prepare;
  delete pkg.scripts.prepack;
  delete pkg.scripts.postpack;

  if (Array.isArray(pkg.files) && !pkg.files.includes('dist')) pkg.files.push('dist');
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
}

/** Package names in app currently linked via file:.local-packages/ */
function getLocalPackageNames(appDir) {
  const pkgPath = path.join(appDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return [];
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const ref = 'file:.local-packages/';
  const names = [];
  for (const deps of [pkg.dependencies, pkg.devDependencies]) {
    if (!deps) continue;
    for (const [name, value] of Object.entries(deps)) {
      if (typeof value === 'string' && value.startsWith(ref)) names.push(name);
    }
  }
  return [...new Set(names)];
}

// ---------------------------------------------------------------------------
// Workspace-aware build
// ---------------------------------------------------------------------------

/**
 * Build the package at sourceDir.
 *
 * When the package lives inside a workspace, runs the build via the workspace
 * root using a pm-scoped filter command so the package manager provides the
 * correct PATH, resolved protocols, and hoisted binaries:
 *
 *   yarn  → yarn workspace <name> run build          (from root)
 *   pnpm  → pnpm --filter <name> run build           (from root)
 *   npm   → npm run build --workspace=<name>         (from root)
 *   bun   → bun run --filter <name> build            (from root)
 *
 * Falls back to a plain `<pm> run build` in sourceDir for standalone packages.
 */
function buildPackage(sourceDir, pkgName, log) {
  const workspace = findWorkspaceRoot(sourceDir);
  if (workspace) {
    const { rootDir, pm } = workspace;
    log(`🏗️  Building via workspace root (${pm} workspace filter)...`);
    switch (pm) {
      case 'yarn':
        run(rootDir, 'yarn', ['workspace', pkgName, 'run', 'build']);
        break;
      case 'pnpm':
        run(rootDir, 'pnpm', ['--filter', pkgName, 'run', 'build']);
        break;
      case 'bun':
        run(rootDir, 'bun', ['run', '--filter', pkgName, 'build']);
        break;
      default: // npm and anything unrecognised
        run(rootDir, 'npm', ['run', 'build', `--workspace=${pkgName}`]);
        break;
    }
  } else {
    const pm = detectPackageManager(sourceDir);
    run(sourceDir, pm, ['run', 'build']);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function remove(opts, log = console.log) {
  const appDir = resolvePath(opts.appPath || process.cwd());
  const pkgPath = path.join(appDir, 'package.json');
  if (!fs.existsSync(pkgPath)) throw new Error(`No package.json in destination: ${appDir}`);

  const nameOrPath = opts.packageNameOrPath;
  let names;
  if (nameOrPath === undefined || nameOrPath === '') {
    names = getLocalPackageNames(appDir);
    if (names.length === 0) {
      log('No node-link-local packages in this app.');
      cleanCacheDir(appDir);
      return;
    }
  } else {
    names = [resolvePackageName(appDir, nameOrPath)];
  }

  // Restore package.json entries for all packages before running install.
  // Tarballs are kept alive until AFTER install succeeds — removing them first
  // causes yarn to fail because yarn.lock may still reference the file path.
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const toClean = [];
  for (const pkgName of names) {
    const ref = 'file:.local-packages/';
    const inDep = typeof pkg.dependencies?.[pkgName] === 'string' && pkg.dependencies[pkgName].startsWith(ref);
    const inDev = typeof pkg.devDependencies?.[pkgName] === 'string' && pkg.devDependencies[pkgName].startsWith(ref);
    if (!inDep && !inDev) {
      log(`⚠️  ${pkgName} is not linked via node-link-local; skipping.`);
      continue;
    }
    log(`🧹 Restoring ${pkgName}...`);
    const { dependency, devDependency } = popRestoreEntry(appDir, pkgName);
    pkg.dependencies = pkg.dependencies || {};
    pkg.devDependencies = pkg.devDependencies || {};
    if (dependency !== undefined) {
      pkg.dependencies[pkgName] = dependency;
    } else {
      delete pkg.dependencies[pkgName];
    }
    if (devDependency !== undefined) {
      pkg.devDependencies[pkgName] = devDependency;
    } else {
      delete pkg.devDependencies[pkgName];
    }
    log(`✅ Restored ${pkgName}`);
    toClean.push(pkgName);
  }

  if (toClean.length === 0) return;

  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

  const pm = detectPackageManager(appDir);
  log('📦 Running install to sync node_modules...');
  run(appDir, pm, pm === 'yarn' ? ['install', '--mode=skip-build'] : ['install']);

  // Safe to delete tarballs now that install succeeded and yarn.lock is updated.
  const cacheDir = path.join(appDir, CACHE_DIR);
  for (const pkgName of toClean) {
    deleteStagedTarballs(cacheDir, pkgName);
  }
  cleanCacheDir(appDir);
}

export function add(opts, log = console.log) {
  const sourceDir = resolvePath(opts.libPath);
  const destDir = resolvePath(opts.appPath || process.cwd());
  if (!fs.existsSync(path.join(sourceDir, 'package.json'))) {
    throw new Error(`No package.json in source: ${sourceDir}`);
  }
  if (!fs.existsSync(path.join(destDir, 'package.json'))) {
    throw new Error(`No package.json in destination: ${destDir}`);
  }

  const { name: pkgName, version } = readPackageInfo(sourceDir);
  const srcPm = detectPackageManager(sourceDir);
  const destPm = detectPackageManager(destDir);
  log(`📦 ${pkgName}@${version}  (source: ${srcPm}, app: ${destPm})`);

  // Snapshot the current version spec before we overwrite it.
  saveRestoreEntry(destDir, pkgName);

  if (fs.existsSync(path.join(sourceDir, 'dist'))) {
    log('✨ dist/ present');
  } else {
    log('🛠️  Building (no dist/)...');
    buildPackage(sourceDir, pkgName, log);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-link-local-'));
  try {
    log('📂 Snapshot + pack...');
    if (srcPm === 'pnpm') {
      // pnpm pack natively resolves catalog:, workspace:, and all pnpm-specific
      // version protocols. Pack directly from the source so pnpm has full workspace
      // context. npm_config_ignore_scripts suppresses prepack/postpack since we
      // already ensured dist/ is present above.
      run(sourceDir, 'pnpm', ['pack', '--pack-destination', tempDir], {
        quiet: true,
        env: { npm_config_ignore_scripts: 'true' },
      });
    } else {
      // yarn/npm: copy to temp, replace workspace: refs with *, then pack.
      fs.cpSync(sourceDir, tempDir, { recursive: true });
      normalizePackageJson(tempDir);
      // Yarn v1 fails if .npmrc references ${NPM_AUTH_TOKEN} and the var is unset.
      // Packing doesn't need auth, so a placeholder is safe here.
      const packEnv = process.env.NPM_AUTH_TOKEN ? {} : { NPM_AUTH_TOKEN: 'placeholder' };
      run(tempDir, srcPm, ['pack'], { quiet: true, env: packEnv });
    }

    const tarball = findLatestTarball(tempDir);
    if (!tarball) throw new Error('Pack produced no tarball');

    const cacheDir = path.join(destDir, CACHE_DIR);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.copyFileSync(path.join(tempDir, tarball), path.join(cacheDir, tarball));

    const fileRef = `file:.local-packages/${tarball}`;
    log('🚀 Installing from staged tarball...');

    if (destPm === 'yarn') {
      const pkgJsonPath = path.join(destDir, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      pkg.dependencies = pkg.dependencies || {};
      pkg.dependencies[pkgName] = fileRef;
      fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2));
      run(destDir, 'yarn', ['install', '--mode=skip-build']);
    } else if (destPm === 'pnpm') {
      run(destDir, 'pnpm', [
        'add',
        `${pkgName}@${fileRef}`,
        '--workspace=false',
        '--no-link-workspace-packages',
        '--save-workspace-protocol=false',
        '--no-lockfile',
      ]);
    } else {
      run(destDir, 'npm', ['install', fileRef]);
    }
    log(`✅ Installed ${pkgName}`);
    promptGitignoreIfNeeded(destDir, log);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
