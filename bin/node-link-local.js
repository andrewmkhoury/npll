#!/usr/bin/env node
/** node-link-local — sync a local package into an app via staged tarballs. Usage: add|remove <lib-path> <app-path> */
import { add, remove } from '../lib/sync.js';

const [cmd, libPath, appPath] = process.argv.slice(2);
const usage = () => {
  console.error('Usage: node-link-local add <path-to-lib> <path-to-app>');
  console.error('       node-link-local remove <path-to-lib> <path-to-app>');
};

if (!cmd || !libPath || !appPath) {
  console.error('❌ Missing arguments.');
  usage();
  process.exit(1);
}
if (cmd !== 'add' && cmd !== 'remove') {
  console.error('❌ Command must be "add" or "remove".');
  usage();
  process.exit(1);
}

try {
  cmd === 'add' ? add({ libPath, appPath }) : remove({ libPath, appPath });
} catch (err) {
  console.error('❌', err instanceof Error ? err.message : String(err));
  process.exit(1);
}
