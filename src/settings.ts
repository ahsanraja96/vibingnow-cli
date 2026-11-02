// Merge and unmerge the VibingNow hooks in Claude Code's settings.json. Never touches anything else.
// Stop sends when a reply finishes; PostToolUse sends during long replies (the hook throttles it).
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';

type Json = Record<string, unknown>;

export const HOOK_EVENT = 'Stop';
export const HOOK_EVENTS = [HOOK_EVENT, 'PostToolUse'] as const;

// The full path to node, not bare `node`: Claude Code runs hooks without the shell setup that puts
// nvm, volta or fnm's node on PATH, so a bare `node` can fail silently there (the Codex hook does the same).
export function hookCommand(hookPath: string, nodePath = process.execPath): string {
  const q = (p: string) => `"${p.replace(/\\/g, '/')}"`;
  return `${q(nodePath)} ${q(hookPath)} claude`;
}

/** The node our installed hook runs with, or null when it uses bare `node` (an install from 0.1.2 or earlier). */
export function hookNode(settings: Json): string | null | undefined {
  for (const gs of Object.values((settings.hooks as Json | undefined) ?? {})) {
    if (!Array.isArray(gs)) continue;
    for (const g of gs) {
      const list = g && typeof g === 'object' && Array.isArray((g as Json).hooks) ? ((g as Json).hooks as Json[]) : [];
      for (const h of list) {
        if (!isVibePulseHandler(h)) continue;
        const m = /^"([^"]+)"/.exec(String(h.command));
        return m ? m[1] : null;
      }
    }
  }
  return undefined;
}

/** True for a hook handler VibingNow (or VibePulse, its old name) added (matches our default path, or the exact command we wrote). */
export function isVibePulseHandler(h: unknown, command?: string): boolean {
  if (!h || typeof h !== 'object') return false;
  const c = (h as Json).command;
  if (typeof c !== 'string') return false;
  if (command && c === command) return true;
  return /vibingnow|vibepulse/i.test(c) && c.includes('hook.mjs');
}

export type ParseResult = { ok: true; value: Json } | { ok: false; error: string };

export function parseSettings(text: string): ParseResult {
  if (!text.trim()) return { ok: true, value: {} };
  try {
    const v = JSON.parse(text.replace(/^﻿/, '')) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'the file is valid JSON but not an object' };
    return { ok: true, value: v as Json };
  } catch (e) {
    return { ok: false, error: `the file is not valid JSON (${e instanceof Error ? e.message : String(e)})` };
  }
}

export function formatSettings(v: Json): string {
  return JSON.stringify(v, null, 2) + '\n';
}

/** Removes our handlers. Only drops groups/events/hooks that our removal emptied, so originals round-trip. */
export function removeVibePulseHook(settings: Json, command?: string): Json {
  const out = structuredClone(settings);
  const hooks = out.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return out;
  const h = hooks as Json;
  let anyChanged = false;
  for (const [event, groups] of Object.entries(h)) {
    if (!Array.isArray(groups)) continue;
    let changed = false;
    const kept: unknown[] = [];
    for (const g of groups) {
      if (g && typeof g === 'object' && Array.isArray((g as Json).hooks)) {
        const list = (g as Json).hooks as unknown[];
        const left = list.filter((x) => !isVibePulseHandler(x, command));
        if (left.length !== list.length) {
          changed = true;
          if (left.length) kept.push({ ...(g as Json), hooks: left });
          continue;
        }
      }
      kept.push(g);
    }
    if (!changed) continue;
    anyChanged = true;
    if (kept.length) h[event] = kept;
    else delete h[event];
  }
  if (anyChanged && Object.keys(h).length === 0) delete out.hooks;
  return out;
}

function hasRemoved(settings: Json, command?: string): boolean {
  const hooks = settings.hooks as Json | undefined;
  if (!hooks || typeof hooks !== 'object') return false;
  return Object.values(hooks).some(
    (gs) => Array.isArray(gs) && gs.some((g) => g && typeof g === 'object' && Array.isArray((g as Json).hooks) && ((g as Json).hooks as unknown[]).some((x) => isVibePulseHandler(x, command))),
  );
}

/** Adds exactly one VibingNow handler per event in HOOK_EVENTS (removing any earlier ones first). */
export function addVibePulseHook(settings: Json, command: string): Json {
  const out = removeVibePulseHook(settings, command);
  const hooks = out.hooks && typeof out.hooks === 'object' && !Array.isArray(out.hooks) ? (out.hooks as Json) : {};
  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    groups.push({ hooks: [{ type: 'command', command, async: true, timeout: 10 }] });
    hooks[event] = groups;
  }
  out.hooks = hooks;
  return out;
}

export function hasVibePulseHook(settings: Json, command?: string): boolean {
  return hasRemoved(settings, command);
}

export function backupPath(file: string, now = new Date()): string {
  return `${file}.vibingnow-backup-${now.toISOString().replace(/:/g, '-')}`;
}

export class SettingsError extends Error {}

function readSettings(file: string): Json | null {
  if (!existsSync(file)) return null;
  const parsed = parseSettings(readFileSync(file, 'utf8'));
  if (!parsed.ok) throw new SettingsError(`Not changing ${file}: ${parsed.error}. Fix or move it, then run this again.`);
  return parsed.value;
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.vibepulse-tmp`;
  // Keep the file's permissions (settings can hold API keys in env; a private file must stay private).
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
  writeFileSync(tmp, text, { encoding: 'utf8', mode });
  chmodSync(tmp, mode);
  renameSync(tmp, file);
}

/** Throws SettingsError if the file exists but can't be parsed. */
export function checkSettings(file: string): void {
  readSettings(file);
}

export interface InstallResult {
  backup: string | null;
  created: boolean;
}

export function installHook(file: string, command: string, now = new Date()): InstallResult {
  const current = readSettings(file);
  let backup: string | null = null;
  if (current) {
    backup = backupPath(file, now);
    copyFileSync(file, backup);
  }
  writeAtomic(file, formatSettings(addVibePulseHook(current ?? {}, command)));
  return { backup, created: current === null };
}

export interface UninstallResult {
  removed: boolean;
  backup: string | null;
  deletedFile: boolean;
}

/** `createdByUs`: connect created the file, so an otherwise empty result removes it again. */
export function uninstallHook(file: string, command: string | undefined, createdByUs: boolean, now = new Date()): UninstallResult {
  const current = readSettings(file);
  if (!current || !hasVibePulseHook(current, command)) return { removed: false, backup: null, deletedFile: false };
  const next = removeVibePulseHook(current, command);
  if (createdByUs && Object.keys(next).length === 0) {
    unlinkSync(file);
    return { removed: true, backup: null, deletedFile: true };
  }
  const backup = backupPath(file, now);
  copyFileSync(file, backup);
  writeAtomic(file, formatSettings(next));
  return { removed: true, backup, deletedFile: false };
}
