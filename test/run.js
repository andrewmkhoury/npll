/**
 * Smoke test: run CLI with no args, add without path, and invalid command.
 */
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(__dirname, '..', 'bin', 'node-link-local.js');

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    cwd: path.join(__dirname, '..'),
  });
}

// No args -> usage, exit 1
const noArgs = run([]);
if (noArgs.status !== 1 || !noArgs.stderr.includes('add') || !noArgs.stderr.includes('remove')) {
  console.error('FAIL: expected usage and exit 1 when no args');
  process.exit(1);
}

// add without path -> exit 1
const addNoPath = run(['add']);
if (addNoPath.status !== 1 || !addNoPath.stderr.includes('path-to-lib')) {
  console.error('FAIL: expected error when add has no path');
  process.exit(1);
}

// Bad command -> exit 1
const badCmd = run(['bad']);
if (badCmd.status !== 1 || !badCmd.stderr.includes('add') || !badCmd.stderr.includes('remove')) {
  console.error('FAIL: expected error for bad command');
  process.exit(1);
}

console.log('OK: CLI usage and validation');
process.exit(0);
