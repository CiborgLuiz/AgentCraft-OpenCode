// Find OpenCode CLI/binary. Uses --opencode-path / AGENTCRAFT_OPENCODE_PATH or `opencode` on PATH.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

function onPath(name: string): string | undefined {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 5000 });
    const hits = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (hits.length === 0) return undefined;
    return process.platform === 'win32' ? (hits.find((h) => /\.(exe|cmd|bat)$/i.test(h)) ?? hits[0]) : hits[0];
  } catch {
    return undefined;
  }
}

let cached: { key: string; bin: string | undefined } | undefined;

export function findOpenCode(explicit?: string): string | undefined {
  const key = explicit ?? '';
  if (cached?.key === key) return cached.bin;
  const bin = explicit ? (fs.existsSync(explicit) ? explicit : onPath(explicit)) : onPath('opencode');
  cached = { key, bin };
  return bin;
}

export const OPENCODE_NOT_FOUND = 'OpenCode not found. Install opencode or pass --opencode-path.';
