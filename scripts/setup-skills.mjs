import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const agentsSkills = resolve(rootDir, '.agents', 'skills');
const claudeDir = resolve(rootDir, '.claude');
const claudeSkills = resolve(claudeDir, 'skills');

if (!existsSync(agentsSkills)) {
  console.error(`[setup:skills] Canonical skills directory not found: ${agentsSkills}`);
  process.exit(1);
}

mkdirSync(claudeDir, { recursive: true });

let existingStat = null;
try {
  existingStat = lstatSync(claudeSkills);
} catch {
  existingStat = null;
}

if (existingStat) {
  if (existingStat.isSymbolicLink() && existsSync(claudeSkills)) {
    try {
      if (realpathSync(claudeSkills) === realpathSync(agentsSkills)) {
        console.log('[setup:skills] .claude/skills already links to .agents/skills');
        process.exit(0);
      }
    } catch {
      // fall through to recreate broken/mismatched link
    }
  }

  if (existingStat.isSymbolicLink()) {
    if (process.platform === 'win32') {
      rmdirSync(claudeSkills);
    } else {
      unlinkSync(claudeSkills);
    }
  } else {
    rmSync(claudeSkills, { recursive: true, force: true });
  }
}

if (process.platform === 'win32') {
  execFileSync('cmd.exe', ['/c', 'mklink', '/J', claudeSkills, agentsSkills], {
    stdio: 'pipe',
  });
} else {
  symlinkSync('../.agents/skills', claudeSkills, 'dir');
}

if (realpathSync(claudeSkills) !== realpathSync(agentsSkills)) {
  console.error('[setup:skills] Created link does not resolve to .agents/skills');
  process.exit(1);
}

console.log('[setup:skills] Linked .claude/skills -> .agents/skills');
