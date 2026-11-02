import { mkdirSync, mkdtempSync, utimesSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectGemini, collectOpenCode, isValidPayload, queue, type HookState } from '../src/hook.js';

const connected = Date.parse('2026-10-16T00:00:00Z');
const now = Date.now();

describe('Gemini CLI', () => {
  // Shapes as written by Gemini CLI's chatRecordingService: a metadata line, then messages (a reply is written
  // again once its token counts arrive), and $set lines.
  const meta = '{"sessionId":"s1","projectHash":"h","startTime":"2026-10-16T09:00:00Z"}\n';
  const user = (id: string, at: string) => `{"id":"${id}","timestamp":"${at}","type":"user","content":"secret prompt"}\n`;
  const reply = (id: string, at: string, tokens?: object) =>
    `{"id":"${id}","timestamp":"${at}","type":"gemini","content":"secret code","model":"gemini-2.5-pro"${tokens ? `,"tokens":${JSON.stringify(tokens)}` : ''}}\n`;

  it('counts each reply once, when its tokens are known, and only after connect', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-gem-'));
    const chats = join(dir, 'abc123', 'chats');
    mkdirSync(chats, { recursive: true });
    const f = join(chats, 'session-2026-10-16T09-00-x1.jsonl');
    writeFileSync(
      f,
      meta +
        reply('old', '2026-10-15T09:00:00Z', { input: 900, output: 900, cached: 0, thoughts: 0, tool: 0, total: 1800 }) +
        user('u1', '2026-10-16T09:00:01Z') +
        reply('g1', '2026-10-16T09:00:02Z') +
        reply('g1', '2026-10-16T09:00:02Z', { input: 1000, output: 50, cached: 800, thoughts: 30, tool: 5, total: 1085 }) +
        '{"$set":{"lastUpdated":"2026-10-16T09:00:03Z"}}\n',
    );
    const state: HookState = { transcripts: {} };
    const p = collectGemini(state, now, connected, dir);
    expect(p).toMatchObject({ tokensDelta: 200 + 50 + 30, model: 'gemini-2.5-pro', tool: 'gemini-cli' });
    expect(isValidPayload(p)).toBe(true);
    expect(JSON.stringify(p)).not.toContain('secret');
    expect(collectGemini(state, now + 1000, connected, dir)).toBeNull();
    appendFileSync(f, reply('g1', '2026-10-16T09:00:02Z', { input: 1000, output: 50, cached: 800 }) + reply('g2', '2026-10-16T09:01:00Z', { input: 10, output: 5 }));
    expect(collectGemini(state, now + 2000, connected, dir)?.tokensDelta).toBe(15);
  });

  it('reads the older single-JSON session files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-gem-'));
    mkdirSync(join(dir, 'h', 'chats'), { recursive: true });
    writeFileSync(join(dir, 'h', 'chats', 'session-old.json'), JSON.stringify({ sessionId: 's', messages: [{ id: 'a', timestamp: '2026-10-16T10:00:00Z', type: 'gemini', model: 'gemini-2.5-flash', tokens: { input: 40, output: 2, cached: 0 } }] }));
    expect(collectGemini({ transcripts: {} }, now, connected, dir)?.tokensDelta).toBe(42);
  });
});

describe('OpenCode', () => {
  const msg = (id: string, created: number, done: boolean, tokens: object) =>
    JSON.stringify({ id, sessionID: 'ses_1', role: 'assistant', providerID: 'moonshot', modelID: 'kimi-k2', time: done ? { created, completed: created + 5000 } : { created }, tokens });

  it('counts finished replies once, with cache writes but not cache reads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-oc-'));
    const ses = join(dir, 'storage', 'message', 'ses_1');
    mkdirSync(ses, { recursive: true });
    const t0 = Date.parse('2026-10-16T09:00:00Z');
    writeFileSync(join(ses, 'msg_old.json'), msg('msg_old', t0 - 86_400_000, true, { input: 999, output: 999 }));
    writeFileSync(join(ses, 'msg_a.json'), msg('msg_a', t0, true, { input: 100, output: 20, reasoning: 5, cache: { read: 5000, write: 30 } }));
    writeFileSync(join(ses, 'msg_b.json'), msg('msg_b', t0 + 1000, false, { input: 0, output: 0 })); // still streaming
    const state: HookState = { transcripts: {} };
    expect(collectOpenCode(state, now, connected, dir)).toMatchObject({ tokensDelta: 155, model: 'kimi-k2', tool: 'opencode' });
    writeFileSync(join(ses, 'msg_b.json'), msg('msg_b', t0 + 1000, true, { input: 7, output: 3 }));
    const later = now + 120_000;
    utimesSync(join(ses, 'msg_b.json'), later / 1000, later / 1000);
    expect(collectOpenCode(state, later + 1000, connected, dir)?.tokensDelta).toBe(10);
    expect(collectOpenCode(state, later + 2000, connected, dir)).toBeNull();
  });
});

describe('pending', () => {
  it('keeps one pending payload per tool', () => {
    const z = { errors: 0, retries: 0, testsFailed: 0, interrupts: 0 };
    const q = queue([{ tokensDelta: 5, model: 'x', activeSeconds: 1, signals: z, tool: 'codex' }], [
      { tokensDelta: 7, model: 'y', activeSeconds: 1, signals: z, tool: 'codex' },
      { tokensDelta: 3, model: 'gemini-2.5-pro', activeSeconds: 1, signals: z, tool: 'gemini-cli' },
      null,
    ]);
    expect(q.map((p) => [p.tool, p.tokensDelta])).toEqual([['codex', 12], ['gemini-cli', 3]]);
  });
});
