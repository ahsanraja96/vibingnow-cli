import { spawn, execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { beforeAll, describe, expect, it } from 'vitest';

const CLI = resolve(__dirname, '..');
const HOOK = join(CLI, 'dist', 'hook.js');
const INDEX = join(CLI, 'dist', 'index.js');
const FIX = join(__dirname, 'fixtures');

beforeAll(() => {
  if (!existsSync(HOOK) || !existsSync(INDEX)) execSync('npm run build', { cwd: CLI, stdio: 'ignore' });
}, 60_000);

function runNode(args: string[], env: NodeJS.ProcessEnv, input = ''): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const p = spawn(process.execPath, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => res({ code, stdout, stderr }));
    p.stdin.end(input);
  });
}

// CODEX_HOME and CLAUDE_CONFIG_DIR point at folders that don't exist, so tests never read real sessions.
const withHome = (home: string) => ({ ...process.env, VIBEPULSE_HOME: home, CODEX_HOME: join(home, 'no-codex'), CLAUDE_CONFIG_DIR: join(home, 'no-claude'), VIBINGNOW_NO_SCHEDULE: '1' });

async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

describe('hook process', () => {
  it('is silent and exits 0 when the server is unreachable', async () => {
    const home = mkdtempSync(join(tmpdir(), 'vp-home-'));
    const port = await closedPort();
    writeFileSync(join(home, 'config.json'), JSON.stringify({ server: `http://127.0.0.1:${port}`, token: 't' }));
    const tr = join(home, 't.jsonl');
    copyFileSync(join(FIX, 'claude-transcript-1.jsonl'), tr);
    const r = await runNode([HOOK, 'claude'], withHome(home), JSON.stringify({ session_id: 's', transcript_path: tr }));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
    expect(state.lastSend.ok).toBe(false);
  }, 15_000);

  it('keeps what the server speed limit held back, and sends it next time', async () => {
    const home = mkdtempSync(join(tmpdir(), 'vp-home-'));
    const bodies: { tokensDelta: number; activeSeconds: number; tool?: string }[] = [];
    let take = 1000;
    const server: Server = createServer((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        bodies.push(JSON.parse(b));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, accepted: Math.min(take, bodies[bodies.length - 1].tokensDelta) }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as AddressInfo).port;
      writeFileSync(join(home, 'config.json'), JSON.stringify({ server: `http://127.0.0.1:${port}`, token: 't' }));
      const tr = join(home, 't.jsonl');
      copyFileSync(join(FIX, 'claude-transcript-1.jsonl'), tr);
      await runNode([HOOK, 'claude'], withHome(home), JSON.stringify({ session_id: 's', transcript_path: tr }));
      expect(bodies[0].tokensDelta).toBe(2450);
      const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
      expect(state.pending).toEqual([{ tokensDelta: 1450, model: 'claude-opus-4-1', activeSeconds: 0, signals: { errors: 0, retries: 0, testsFailed: 0, interrupts: 0 }, tool: 'claude-code' }]);
      take = Infinity;
      await runNode([HOOK, 'claude'], withHome(home), JSON.stringify({ session_id: 's', transcript_path: tr, hook_event_name: 'Stop' }));
      expect(bodies[1]).toMatchObject({ tokensDelta: 1450, activeSeconds: 0, tool: 'claude-code' });
      expect(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).pending).toBeUndefined();
    } finally {
      server.close();
    }
  }, 15_000);

  it('exits 0 silently on garbage input and when not connected', async () => {
    const home = mkdtempSync(join(tmpdir(), 'vp-home-'));
    for (const input of ['', 'not json', '{"transcript_path":"/nope"}']) {
      const r = await runNode([HOOK, 'claude'], withHome(home), input);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
    }
  }, 15_000);
});

describe('connect / status / disconnect end to end (fake server, temp dirs)', () => {
  it('pairs, installs, sends, and restores settings exactly', async () => {
    const seen: { method: string; url: string; auth?: string; body: string }[] = [];
    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
        res.setHeader('content-type', 'application/json');
        if (req.url === '/api/pair') res.end(JSON.stringify({ token: 'tok123', personId: 'p1', handle: 'ahsan' }));
        else res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const home = mkdtempSync(join(tmpdir(), 'vp-home-'));
      const env = withHome(home);
      const settings = join(home, 'claude-settings.json');
      const original = JSON.stringify({ env: { A: '1' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }] } }, null, 2) + '\n';
      writeFileSync(settings, original);

      for (let i = 0; i < 2; i++) {
        const r = await runNode([INDEX, 'connect', 'VP-7F3K-9Q', '--server', url, '--settings', settings], env);
        expect(r.code, r.stderr).toBe(0);
      }
      const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
      expect(cfg).toMatchObject({ server: url, token: 'tok123', personId: 'p1', handle: 'ahsan', settingsPath: settings });
      expect(existsSync(join(home, 'hook.mjs'))).toBe(true);
      expect(JSON.parse(readFileSync(settings, 'utf8')).hooks.Stop).toHaveLength(2);
      const pair = seen.find((s) => s.url === '/api/pair')!;
      expect(Object.keys(JSON.parse(pair.body)).sort()).toEqual(['code', 'device']);

      // The installed hook.mjs runs standalone and finds its home from its own location.
      const tr = join(home, 't.jsonl');
      // A session started after connecting: re-date the fixture to now, so none of it predates the connect.
      const nowIso = new Date(Date.now() + 1000).toISOString();
      writeFileSync(tr, readFileSync(join(FIX, 'claude-transcript-1.jsonl'), 'utf8').replace(/"timestamp":"[^"]*"/g, `"timestamp":"${nowIso}"`));
      const noHome = { ...process.env };
      delete noHome.VIBEPULSE_HOME;
      noHome.CLAUDE_CONFIG_DIR = join(home, 'no-claude');
      const h = await runNode([join(home, 'hook.mjs'), 'claude'], noHome, JSON.stringify({ session_id: 's', transcript_path: tr }));
      expect(h.code).toBe(0);
      expect(h.stdout).toBe('');
      // connect sends an all-zero test ping first; the hook's real send comes after it.
      const ingests = seen.filter((s) => s.url === '/api/ingest');
      expect(JSON.parse(ingests[0].body)).toEqual({ tokensDelta: 0, model: 'vibepulse-test', activeSeconds: 0, signals: { errors: 0, retries: 0, testsFailed: 0, interrupts: 0 } });
      const ingest = ingests[ingests.length - 1];
      expect(ingest.auth).toBe('Bearer tok123');
      expect(JSON.parse(ingest.body)).toEqual({ tokensDelta: 2450, reread: 102000, model: 'claude-opus-4-1', activeSeconds: 60, signals: { errors: 1, retries: 1, testsFailed: 3, interrupts: 1 }, tool: 'claude-code' });

      const st = await runNode([INDEX, 'status'], env);
      expect(st.stdout).toContain('ahsan');
      expect(st.stdout).toContain('installed');
      expect(st.stdout).toMatch(/Last send: .* ok/);

      const d = await runNode([INDEX, 'disconnect'], env);
      expect(d.code).toBe(0);
      expect(seen.some((s) => s.method === 'DELETE' && s.url === '/api/devices/current' && s.auth === 'Bearer tok123')).toBe(true);
      expect(readFileSync(settings, 'utf8')).toBe(original);
      expect(existsSync(join(home, 'config.json'))).toBe(false);
      expect(existsSync(join(home, 'hook.mjs'))).toBe(false);
    } finally {
      server.close();
    }
  }, 30_000);
});
