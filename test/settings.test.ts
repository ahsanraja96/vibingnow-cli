import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addVibePulseHook, hookCommand, hookNode, installHook, removeBackups, removeVibePulseHook, uninstallHook, SettingsError, hasVibePulseHook } from '../src/settings.js';

const hooks: Record<string, unknown[]> = Object.fromEntries(
  ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 'SessionEnd'].map((ev) => [
    ev,
    [{ hooks: [{ type: 'command', command: 'node "C:/Users/me/.sessionlens/hook.mjs" claude', async: true, timeout: 5 }] }],
  ]),
);
hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] });
const REAL: Record<string, unknown> = {
  env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_METRICS_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318/otlp' },
  permissions: { allow: ['Bash(npm test:*)'], deny: [] },
  model: 'opus',
  hooks,
  statusLine: { type: 'command', command: 'node "C:/Users/me/.sessionlens/statusline.mjs"' },
};

const tmp = () => mkdtempSync(join(tmpdir(), 'vp-settings-'));
const CMD = hookCommand('C:\\Users\\me\\.vibepulse\\hook.mjs', 'C:\\Program Files\\nodejs\\node.exe');

describe('settings merge', () => {
  it('builds the command with the full node path and forward slashes', () => {
    expect(CMD).toBe('"C:/Program Files/nodejs/node.exe" "C:/Users/me/.vibepulse/hook.mjs" claude');
    expect(hookCommand('/home/me/.vibingnow/hook.mjs')).toBe(`"${process.execPath.replace(/\\/g, '/')}" "/home/me/.vibingnow/hook.mjs" claude`);
  });

  it('replaces an older bare-node hook on reconnect and reports which node it runs', () => {
    const old = addVibePulseHook(REAL, 'node "C:/Users/me/.vibingnow/hook.mjs" claude');
    expect(hookNode(old)).toBeNull();
    const next = addVibePulseHook(old, CMD);
    expect((next.hooks as Record<string, unknown[]>).Stop).toHaveLength(2);
    expect(hookNode(next)).toBe('C:/Program Files/nodejs/node.exe');
    expect(hookNode(REAL)).toBeUndefined();
  });

  it('adds one Stop and one PostToolUse entry, keeps everything else, and is idempotent', () => {
    const once = addVibePulseHook(REAL, CMD);
    const twice = addVibePulseHook(once, CMD);
    expect(twice).toEqual(once);
    const h = twice.hooks as Record<string, unknown[]>;
    expect(h.Stop).toHaveLength(2);
    expect(h.Stop[1]).toEqual({ hooks: [{ type: 'command', command: CMD, async: true, timeout: 10 }] });
    expect(h.PostToolUse).toEqual([...(hooks.PostToolUse as unknown[]), { hooks: [{ type: 'command', command: CMD, async: true, timeout: 10 }] }]);
    for (const ev of Object.keys(hooks)) if (ev !== 'Stop' && ev !== 'PostToolUse') expect(h[ev]).toEqual(hooks[ev]);
    for (const k of ['env', 'permissions', 'model', 'statusLine']) expect(twice[k]).toEqual(REAL[k]);
    expect(removeVibePulseHook(twice, CMD)).toEqual(REAL);
  });

  it('removes keys it emptied, but not pre-existing empty ones', () => {
    expect(removeVibePulseHook(addVibePulseHook({ a: 1 }, CMD), CMD)).toEqual({ a: 1 });
    expect(removeVibePulseHook(addVibePulseHook({ hooks: { PreToolUse: [] } }, CMD), CMD)).toEqual({ hooks: { PreToolUse: [] } });
    expect(removeVibePulseHook({ hooks: { Stop: [] } }, CMD)).toEqual({ hooks: { Stop: [] } });
  });

  // Unix file modes don't exist on Windows.
  it.skipIf(process.platform === 'win32')('keeps a private settings file private', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-mode-'));
    const file = join(dir, 'settings.json');
    writeFileSync(file, '{"env":{"KEY":"secret"}}\n', { mode: 0o600 });
    chmodSync(file, 0o600);
    installHook(file, CMD);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('install backs up, round-trips, and preserves formatting', () => {
    const dir = tmp();
    const file = join(dir, 'settings.json');
    const original = JSON.stringify(REAL, null, 2) + '\n';
    writeFileSync(file, original);
    const r1 = installHook(file, CMD, new Date('2026-10-15T10:11:12.000Z'));
    expect(r1.backup).toBe(`${file}.vibingnow-backup-2026-10-15T10-11-12.000Z`);
    expect(readFileSync(r1.backup!, 'utf8')).toBe(original);
    installHook(file, CMD, new Date('2026-10-15T10:11:13.000Z'));
    const text = readFileSync(file, 'utf8');
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "hooks": {');
    expect(text.split(JSON.stringify(CMD)).length - 1).toBe(2); // Stop and PostToolUse
    const u = uninstallHook(file, CMD, false);
    expect(u.removed).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(REAL);
    expect(readFileSync(file, 'utf8')).toBe(original);
    // One backup at a time, and none left once disconnect clears them (they can hold API keys).
    expect(readdirSync(dir).filter((f) => f.includes('vibingnow-backup')).length).toBe(1);
    writeFileSync(join(dir, 'other.json.vibingnow-backup-x'), '{}');
    expect(removeBackups(file)).toBe(1);
    expect(readdirSync(dir).filter((f) => f.includes('vibingnow-backup'))).toEqual(['other.json.vibingnow-backup-x']);
  });

  it.skipIf(process.platform === 'win32')('keeps the backup private', () => {
    const dir = tmp();
    const file = join(dir, 'settings.json');
    writeFileSync(file, '{"env":{"KEY":"secret"}}\n', { mode: 0o644 });
    const r = installHook(file, CMD);
    expect(statSync(r.backup!).mode & 0o777).toBe(0o600);
  });

  it('creates the file when missing and removes it again on disconnect', () => {
    const file = join(tmp(), 'settings.json');
    expect(installHook(file, CMD)).toEqual({ backup: null, created: true });
    expect(hasVibePulseHook(JSON.parse(readFileSync(file, 'utf8')), CMD)).toBe(true);
    expect(uninstallHook(file, CMD, true).deletedFile).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it('refuses invalid JSON without touching it', () => {
    const dir = tmp();
    const file = join(dir, 'settings.json');
    writeFileSync(file, '{ "hooks": { ,,, }');
    expect(() => installHook(file, CMD)).toThrow(SettingsError);
    expect(readFileSync(file, 'utf8')).toBe('{ "hooks": { ,,, }');
    expect(readdirSync(dir)).toEqual(['settings.json']);
  });

  it('does not treat the SessionLens hook as ours', () => {
    expect(hasVibePulseHook(REAL)).toBe(false);
  });
});
