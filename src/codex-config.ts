// Codex hook: one `notify = [...]` line in Codex's config.toml (default ~/.codex/config.toml) runs
// `node hook.mjs codex` after each agent turn. Edited as plain text so the rest of the file is untouched:
// the line goes in the top-level section (before the first [table]) and is marked so disconnect can
// remove exactly it. If Codex already has a notify program of its own, we leave it alone and say so.
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { backupPath } from './settings.js';

export const MARK = '# added by vibingnow';
const NOTIFY = /^\s*notify\s*=/;
const TABLE = /^\s*\[/;

export class CodexConfigError extends Error {}

export const codexHome = () => process.env.CODEX_HOME || join(homedir(), '.codex');
export const defaultCodexConfig = () => join(codexHome(), 'config.toml');

/** A TOML string for a path: a literal string (no escaping) unless it contains a single quote. */
function tomlString(s: string): string {
  if (!s.includes("'") && !/[\n\r]/.test(s)) return `'${s}'`;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function notifyLine(hookPath: string): string {
  return `notify = [${tomlString(process.execPath)}, ${tomlString(hookPath)}, "codex"] ${MARK}`;
}

/** Line index range of the top-level section (before the first [table] header). */
function topLevelEnd(lines: string[]): number {
  const i = lines.findIndex((l) => TABLE.test(l));
  return i < 0 ? lines.length : i;
}

export type CodexState = 'installed' | 'missing' | 'other-notify';

export function codexHookState(text: string): CodexState {
  const lines = text.split(/\r?\n/);
  const top = lines.slice(0, topLevelEnd(lines));
  if (top.some((l) => l.includes(MARK) && NOTIFY.test(l))) return 'installed';
  if (top.some((l) => NOTIFY.test(l))) return 'other-notify';
  return 'missing';
}

// Our line, with the line break before it (group 1) and after it (group 2). Works on the raw text so the
// rest of the file, including mixed line endings, is never touched.
const OURS = /(\r?\n)?^[ \t]*notify[ \t]*=[^\r\n]*# added by (?:vibingnow|vibepulse)[^\r\n]*$(\r?\n)?/m;

export function addCodexHook(text: string, hookPath: string): string {
  const state = codexHookState(text);
  if (state === 'other-notify') throw new CodexConfigError('Codex already runs its own notify program, so VibingNow left your Codex config alone. Claude Code is still connected.');
  if (state === 'installed') text = removeCodexHook(text);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const line = notifyLine(hookPath);
  // Top-level keys must come before the first [table]: insert there, or at the end if there is none.
  const table = /^[ \t]*\[/m.exec(text);
  if (table) return text.slice(0, table.index) + line + eol + text.slice(table.index);
  if (!text.length) return line + eol;
  return /\r?\n$/.test(text) ? text + line + eol : text + eol + line;
}

export function removeCodexHook(text: string): string {
  // Remove the line with the break after it; if it was the last line with no break after it, remove the
  // break before it instead. Either way the file comes back exactly as it was.
  return text.replace(OURS, (_m, before?: string, after?: string) => (after ? (before ?? '') : ''));
}

function writeAtomic(file: string, text: string) {
  const tmp = `${file}.vibingnow.tmp`;
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
  writeFileSync(tmp, text, { encoding: 'utf8', mode });
  chmodSync(tmp, mode);
  renameSync(tmp, file);
}

export function installCodexHook(file: string, hookPath: string, now = new Date()): { backup: string | null; created: boolean } {
  const exists = existsSync(file);
  const before = exists ? readFileSync(file, 'utf8') : '';
  const after = addCodexHook(before, hookPath);
  let backup: string | null = null;
  if (exists) {
    backup = backupPath(file, now);
    copyFileSync(file, backup);
  }
  writeAtomic(file, after);
  return { backup, created: !exists };
}

export function uninstallCodexHook(file: string, createdByUs: boolean): { removed: boolean; deletedFile: boolean } {
  if (!existsSync(file)) return { removed: false, deletedFile: false };
  const before = readFileSync(file, 'utf8');
  if (codexHookState(before) !== 'installed') return { removed: false, deletedFile: false };
  const after = removeCodexHook(before);
  if (createdByUs && !after.trim()) {
    rmSync(file, { force: true });
    return { removed: true, deletedFile: true };
  }
  writeAtomic(file, after);
  return { removed: true, deletedFile: false };
}
