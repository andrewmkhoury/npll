/**
 * Local package sync via staged tarballs. Cross-platform: uses only Node path/fs/os
 * and spawns package-manager binaries (pnpm/yarn/npm) via PATH.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { detectPackageManager } from './detect-pm.js';

const CACHE_DIR = '.local-packages';

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
  const env = { ...process.env, COREPACK_ENABLE_STRICT: '0' };
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

function normalizePackageJson(dir) {
  const pkgPath = path.join(dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

  const fixWorkspace = (deps) => {
    if (!deps) return;
    for (const k of Object.keys(deps)) {
      if (deps[k] === 'workspace:*') deps[k] = '*';
    }
  };
  fixWorkspace(pkg.dependencies);
  fixWorkspace(pkg.devDependencies);
  fixWorkspace(pkg.peerDependencies);

  pkg.scripts = pkg.scripts || {};
  delete pkg.scripts.prepare;
  delete pkg.scripts.prepack;
  delete pkg.scripts.postpack;

  if (Array.isArray(pkg.files) && !pkg.files.includes('dist')) pkg.files.push('dist');
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
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

export function remove(opts, log = console.log) {
  const sourceDir = resolvePath(opts.libPath);
  const destDir = resolvePath(opts.appPath);
  if (!fs.existsSync(path.join(destDir, 'package.json'))) {
    throw new Error(`No package.json in destination: ${destDir}`);
  }

  const { name: pkgName } = readPackageInfo(sourceDir);
  const pm = detectPackageManager(destDir);
  log(`🧹 Removing ${pkgName}...`);
  run(destDir, pm, pm === 'npm' ? ['uninstall', pkgName] : ['remove', pkgName]);
  deleteStagedTarballs(path.join(destDir, CACHE_DIR), pkgName);
  log(`✅ Removed ${pkgName}`);
}

export function add(opts, log = console.log) {
  const sourceDir = resolvePath(opts.libPath);
  const destDir = resolvePath(opts.appPath);
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

  const distPath = path.join(sourceDir, 'dist');
  if (!fs.existsSync(distPath)) {
    log('🛠️  Building (no dist/)...');
    run(sourceDir, srcPm, ['run', 'build']);
  } else {
    log('✨ dist/ present');
  }

  // mkdtempSync: use path.join so prefix is correct on Windows (path separators)
  const tempPrefix = path.join(os.tmpdir(), 'node-link-local-');
  const tempDir = fs.mkdtempSync(tempPrefix);
  try {
    log('📂 Snapshot + pack...');
    fs.cpSync(sourceDir, tempDir, { recursive: true });
    normalizePackageJson(tempDir);
    run(tempDir, srcPm, ['pack'], { quiet: true });

    const tarball = findLatestTarball(tempDir);
    if (!tarball) throw new Error('Pack produced no tarball');

    const cacheDir = path.join(destDir, CACHE_DIR);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.copyFileSync(path.join(tempDir, tarball), path.join(cacheDir, tarball));

    const fileRef = `file:.local-packages/${tarball}`;
    log(`🚀 Installing from staged tarball...`);

    if (destPm === 'yarn') {
      const pkgPath = path.join(destDir, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      pkg.dependencies = pkg.dependencies || {};
      pkg.dependencies[pkgName] = fileRef;
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
      run(destDir, 'yarn', ['install', '--mode=skip-build']);
    } else if (destPm === 'pnpm') {
      run(destDir, 'pnpm', [
        'add',
        `${pkgName}@${fileRef}`,
        '--workspace=false',
        '--no-link-workspace-packages',
        '--resolve-workspace-protocol=false',
      ]);
    } else {
      run(destDir, 'npm', ['install', fileRef]);
    }
    log(`✅ Installed ${pkgName}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
