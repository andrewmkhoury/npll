#!/usr/bin/env node
/** node-link-local — sync a local package into current app via staged tarballs. */
import { add, remove } from '../lib/sync.js';

const [cmd, arg1] = process.argv.slice(2);
const usage = () => {
  console.error('Usage: node-link-local add <path-to-lib>');
  console.error('       node-link-local remove              # remove all linked packages');
  console.error('       node-link-local remove <name|path>  # remove one package');
};

if (!cmd || (cmd !== 'add' && cmd !== 'remove')) {
  console.error('❌ Command must be "add" or "remove".');
  usage();
  process.exit(1);
}

if (cmd === 'add') {
  if (!arg1) {
    console.error('❌ add requires <path-to-lib>.');
    usage();
    process.exit(1);
  }
}

try {
  if (cmd === 'add') {
    add({ libPath: arg1 });
  } else {
    remove({ packageNameOrPath: arg1 });
  }
} catch (err) {
  console.error('❌', err instanceof Error ? err.message : String(err));
  process.exit(1);
}
