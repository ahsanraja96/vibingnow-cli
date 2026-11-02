import { execSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { beforeAll, describe, expect, it } from 'vitest';
import { addCodexHook, codexHookState, removeCodexHook, MARK } from '../src/codex-config.js';

const CLI = resolve(__dirname, '..');
const INDEX = join(CLI, 'dist', 'index.js');
const FIX = join(__dirname, 'fixtures');

beforeAll(() => {
  execSync('npm run build', { cwd: CLI, stdio: 'ignore' });
}, 60_000);

function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const p = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => res({ code, stdout, stderr }));
  });
}

describe('codex config.toml edits', () => {
  const hook = 'C:\Users\me\.vibepulse\hook.mjs';
  it('adds one marked notify line at the top level and removes it exactly', () => {
    for (const before of ['', 'model = "o3"\n', 'model = "o3"', 'model = "o3"\r\n\r\n[profiles.fast]\nmodel = "o4-mini"\n', '[tui]\nx = 1\n']) {
      const after = addCodexHook(before, hook);
      expect(codexHookState(after)).toBe('installed');
      const line = after.split(/\r?\n/).find((l) => l.includes(MARK))!;
      expect(line).toContain(`'${hook}'`);
      // the notify line sits before any [table]
      const lines = after.split(/\r?\n/);
      const firstTable = lines.findIndex((l) => l.startsWith('['));
      if (firstTable >= 0) expect(lines.indexOf(line)).toBeLessThan(firstTable);
      if (before) expect(removeCodexHook(after)).toBe(before);
      // installing twice keeps one line
      expect(addCodexHook(after, hook).split(MARK).length - 1).toBe(1);
    }
  });
  it("leaves someone else's notify program alone", () => {
    expect(codexHookState('notify = ["say", "done"]\n')).toBe('other-notify');
    expect(() => addCodexHook('notify = ["say", "done"]\n', hook)).toThrow(/left your Codex config alone/);
    // a notify inside a [table] isn't the top-level setting
    expect(codexHookState('[other]\nnotify = 1\n')).toBe('missing');
  });
});

describe('codex end to end (fake server, temp dirs)', () => {
  it('connect adds the hook, counts only new Codex work, never sends turn text, disconnect restores', async () => {
    const seen: { url: string; body: string }[] = [];
    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        seen.push({ url: req.url!, body });
        res.setHeader('content-type', 'application/json');
        res.end(req.url === '/api/pair' ? JSON.stringify({ token: 'tok', personId: 'p1', handle: 'ahsan' }) : JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const home = mkdtempSync(join(tmpdir(), 'vp-codex-'));
      const codexHome = join(home, 'codex');
      const sessions = join(codexHome, 'sessions', '2026', '10', '15');
      mkdirSync(sessions, { recursive: true });
      const rollout = join(sessions, 'rollout-2026-10-15-abc.jsonl');
      const lines = readFileSync(join(FIX, 'codex-rollout.jsonl'), 'utf8').trimEnd().split('\n');
      writeFileSync(rollout, lines.slice(0, 5).join('\n') + '\n'); // work done before connecting
      const cfg = join(codexHome, 'config.toml');
      const original = 'model = "gpt-5-codex"\n\n[tui]\nnotifications = true\n';
      writeFileSync(cfg, original);
      const env = { ...process.env, VIBEPULSE_HOME: join(home, 'vp'), CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: join(home, 'no-claude'), VIBINGNOW_NO_SCHEDULE: '1' };
      const settings = join(home, 'claude.json');

      const c = await run([INDEX, 'connect', 'VP-AAAA-BB', '--server', url, '--settings', settings], env);
      expect(c.code, c.stderr).toBe(0);
      expect(c.stdout).toContain('notify hook');
      expect(codexHookState(readFileSync(cfg, 'utf8'))).toBe('installed');

      // Codex finishes a turn: the rest of the rollout appears, then notify runs the hook with turn JSON.
      appendFileSync(rollout, lines.slice(5).join('\n') + '\n');
      const turn = JSON.stringify({ type: 'agent-turn-complete', 'input-messages': ['secret prompt'], 'last-assistant-message': 'secret answer' });
      const h = await run([join(home, 'vp', 'hook.mjs'), 'codex', turn], env);
      expect(h.code).toBe(0);
      expect(h.stdout).toBe('');
      const ingests = seen.filter((s) => s.url === '/api/ingest');
      const last = ingests[ingests.length - 1];
      expect(last.body).not.toContain('secret');
      const p = JSON.parse(last.body);
      expect(Object.keys(p).filter((k) => k !== 'reread').sort()).toEqual(['activeSeconds', 'model', 'signals', 'tokensDelta', 'tool']);
      expect(p.reread ?? 0).toBeGreaterThanOrEqual(0);
      expect(p.model).toBe('gpt-5-codex');
      expect(p.tokensDelta).toBeGreaterThan(0);

      // Running again with nothing new sends nothing.
      const before = seen.length;
      await run([join(home, 'vp', 'hook.mjs'), 'codex', turn], env);
      expect(seen.length).toBe(before);

      const st = await run([INDEX, 'status'], env);
      expect(st.stdout).toMatch(/Codex:\s+installed/);

      const d = await run([INDEX, 'disconnect'], env);
      expect(d.code).toBe(0);
      expect(readFileSync(cfg, 'utf8')).toBe(original);
      expect(existsSync(join(home, 'vp', 'hook.mjs'))).toBe(false);
    } finally {
      server.close();
    }
  }, 40_000);
});
