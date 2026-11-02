// VibingNow hook and sync. Three ways in:
//   `node hook.mjs claude`  Claude Code hook (Stop/PostToolUse): the transcript that fired it plus any other
//                           Claude Code session on this computer that changed since the last run.
//   `node hook.mjs codex`   Codex notify program: token totals from the newest rollout files.
//   `node hook.mjs sync`    the once-a-minute background sync: Claude Code, Codex, Gemini CLI and OpenCode.
// Every reply is counted once (by message id, or Codex's running totals), whichever way it is found first.
// Copied to <VIBEPULSE_HOME>/hook.mjs.
// It must stay self-contained: only node: built-ins, no package imports, so it runs with plain `node`.
// It sends numbers only (tokens, model name, active seconds, four signal counts). Never text, paths or code.
// It never prints to stdout, never throws and always exits 0.
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type Json = Record<string, unknown>;

export interface Signals {
  errors: number;
  retries: number;
  testsFailed: number;
  interrupts: number;
}

export type Tool = 'claude-code' | 'codex' | 'gemini-cli' | 'opencode';
export const TOOLS: Tool[] = ['claude-code', 'codex', 'gemini-cli', 'opencode'];

export interface Payload {
  tokensDelta: number;
  model: string;
  activeSeconds: number;
  signals: Signals;
  tool?: Tool;
  /** Cached tokens re-read (shown as the "total incl. re-reads" figure, never in the fair count). */
  reread?: number;
}

export interface Cursor {
  offset: number;
  seen: string[];
  model?: string;
  touchedAt?: number;
}

export interface HookState {
  lastActivityAt?: number;
  /** Last mid-reply (PostToolUse) run, for the throttle. */
  lastToolRunAt?: number;
  lastSend?: { at: number; ok: boolean; status?: number; error?: string; tokensDelta?: number };
  transcripts: Record<string, Cursor>;
  codex?: Record<string, CodexCursor>;
  /** Numbers a failed send couldn't deliver, one per tool; added to the next send, so nothing is lost. */
  pending?: Payload[];
  /** Last sweep of all Claude Code transcripts on this computer. */
  lastSweepAt?: number;
  /** Gemini CLI and OpenCode: cursors, replies already counted, and the last sweep. */
  gemini?: { files: Record<string, Cursor>; sweptAt?: number };
  opencode?: { seen: string[]; sweptAt?: number };
}

export interface CodexCursor {
  offset: number;
  total: CodexTotal | null;
  model?: string;
  touchedAt?: number;
}

// ---------- Codex: rollout-*.jsonl files under ~/.codex/sessions; token_count events carry cumulative totals ----------

export interface CodexTotal {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

const cn = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/** New (non-cached) tokens represented by a cumulative total: (input - cached) + output. */
export function newTokensOf(t: CodexTotal | null): number {
  if (!t) return 0;
  return Math.max(0, t.input_tokens - t.cached_input_tokens) + t.output_tokens;
}

/**
 * Delta since `prevTotal` (the last total seen on the previous read). Returns the latest total to keep for
 * next time. If the totals went backwards (new session file / reset) the latest total counts in full.
 */
export function codexDelta(text: string, prevTotal: CodexTotal | null): { tokensDelta: number; model: string | null; total: CodexTotal | null; reread?: number } {
  let model: string | null = null;
  let total: CodexTotal | null = null;
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    let l: Record<string, unknown>;
    try {
      l = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    const p = l?.payload as Record<string, unknown> | undefined;
    if (!p || typeof p !== 'object') continue;
    if (l.type === 'turn_context' && typeof p.model === 'string') model = p.model;
    if (p.type === 'token_count') {
      const t = (p.info as Record<string, unknown> | null | undefined)?.total_token_usage as Record<string, unknown> | undefined;
      if (t && typeof t === 'object') {
        total = {
          input_tokens: cn(t.input_tokens),
          cached_input_tokens: cn(t.cached_input_tokens),
          output_tokens: cn(t.output_tokens),
          reasoning_output_tokens: cn(t.reasoning_output_tokens),
        };
      }
    }
  }
  if (!total) return { tokensDelta: 0, model, total: prevTotal };
  const now = newTokensOf(total);
  const before = newTokensOf(prevTotal);
  const cached = total.cached_input_tokens;
  const cachedBefore = prevTotal?.cached_input_tokens ?? 0;
  return { tokensDelta: now >= before ? now - before : now, model, total, reread: cached >= cachedBefore ? cached - cachedBefore : cached };
}

export const codexSessionsDir = () => join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');

/** Lists rollout files, newest first. */
export function findRollouts(dir = codexSessionsDir()): string[] {
  const out: { path: string; mtime: number }[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/^rollout-.*\.jsonl$/.test(e.name)) {
        try {
          out.push({ path: p, mtime: statSync(p).mtimeMs });
        } catch {
          /* gone */
        }
      }
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => b.mtime - a.mtime).map((x) => x.path);
}

export interface ChunkResult {
  tokensDelta: number;
  /** Cache reads (re-read context), counted apart from tokensDelta. */
  reread?: number;
  model: string | null;
  signals: Signals;
  activity: boolean;
}

const MAX_SEEN = 5000;
const MAX_TRANSCRIPTS = 50;
/** Codex sessions read each run (newest first). */
const MAX_CODEX_FILES = 25;
const MAX_CHUNK = 64 * 1024 * 1024;
const MODEL_RE = /^[\w.:/@-]+$/;
const INTERRUPT = '[Request interrupted by user';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b && typeof b === 'object' && typeof (b as Json).text === 'string' ? ((b as Json).text as string) : ''))
    .join('\n');
}

function failedTests(text: string): number {
  let n = 0;
  for (const m of text.matchAll(/(\d+) (failed|failing)/g)) n = Math.max(n, Number(m[1]));
  if (n === 0 && text.includes('FAIL ')) n = 1;
  return n;
}

/**
 * Totals for the new transcript lines. `seen` (assistant message ids already counted) is updated in place.
 *
 * tokensDelta = input + output + cache_creation. cache_read is deliberately left out: Claude Code re-reads
 * the whole cached conversation on every turn, so cache reads are often 10-100x the real work and grow with
 * session length, not effort. Counting them would make everyone with a long session look volcanic.
 */
export function processChunk(text: string, seen: Set<string>, since?: number): ChunkResult {
  const signals: Signals = { errors: 0, retries: 0, testsFailed: 0, interrupts: 0 };
  let tokensDelta = 0;
  let reread = 0;
  let model: string | null = null;
  let activity = false;
  let lastToolKey: string | null = null;
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    let line: Json;
    try {
      line = JSON.parse(raw) as Json;
    } catch {
      continue;
    }
    if (!line || typeof line !== 'object') continue;
    if (since !== undefined) {
      const at = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : NaN;
      if (!(at >= since)) continue; // from before this computer was connected (or undated)
    }
    const msg = line.message as Json | undefined;
    if (line.type === 'assistant' && msg && typeof msg === 'object') {
      activity = true;
      const usage = msg.usage as Json | undefined;
      const id = typeof msg.id === 'string' ? msg.id : typeof line.uuid === 'string' ? line.uuid : '';
      if (usage && typeof usage === 'object' && !(id && seen.has(id))) {
        if (id) seen.add(id);
        tokensDelta += num(usage.input_tokens) + num(usage.output_tokens) + num(usage.cache_creation_input_tokens);
        reread += num(usage.cache_read_input_tokens);
      }
      if (typeof msg.model === 'string' && MODEL_RE.test(msg.model) && msg.model.length <= 80) model = msg.model;
      if (Array.isArray(msg.content)) {
        for (const b of msg.content as Json[]) {
          if (!b || b.type !== 'tool_use') continue;
          const key = `${String(b.name)}\u0000${JSON.stringify(b.input ?? null)}`;
          if (key === lastToolKey) signals.retries++;
          lastToolKey = key;
        }
      }
    } else if (line.type === 'user' && msg && typeof msg === 'object') {
      activity = true;
      const content = msg.content;
      if (typeof content === 'string') {
        if (content.includes(INTERRUPT)) signals.interrupts++;
      } else if (Array.isArray(content)) {
        let interrupted = false;
        for (const b of content as Json[]) {
          if (!b || typeof b !== 'object') continue;
          if (b.type === 'tool_result') {
            if (b.is_error === true) signals.errors++;
            signals.testsFailed += failedTests(textOf(b.content));
          } else if (b.type === 'text' && typeof b.text === 'string' && b.text.includes(INTERRUPT)) interrupted = true;
        }
        if (interrupted) signals.interrupts++;
      }
    }
  }
  return { tokensDelta, reread, model, signals, activity };
}

/** Reads complete lines added since the cursor. Partial last lines are left for next time. */
export function readNewChunk(path: string, offset: number): { text: string; offset: number } {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    let start = offset > size ? 0 : offset; // file was rewritten: start over
    if (size - start > MAX_CHUNK) start = size - MAX_CHUNK;
    const len = size - start;
    if (len <= 0) return { text: '', offset: start };
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    const lastNl = buf.lastIndexOf(0x0a, got - 1);
    if (lastNl < 0) return { text: '', offset: start };
    return { text: buf.subarray(0, lastNl + 1).toString('utf8'), offset: start + lastNl + 1 };
  } finally {
    closeSync(fd);
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function activeSecondsFor(now: number, lastActivityAt: number | undefined): number {
  if (!lastActivityAt) return 60;
  return clamp(Math.round((now - lastActivityAt) / 1000), 0, 300);
}

/** Builds exactly the IngestPayload shape, or null when there is nothing worth sending. */
export function buildPayload(r: ChunkResult, model: string, activeSeconds: number): Payload | null {
  const s = r.signals;
  if (r.tokensDelta === 0 && s.errors + s.retries + s.testsFailed + s.interrupts === 0) return null;
  return {
    tokensDelta: clamp(r.tokensDelta, 0, 50_000_000),
    ...(r.reread ? { reread: clamp(r.reread, 0, 1_000_000_000) } : {}),
    model,
    activeSeconds: clamp(activeSeconds, 0, 3600),
    signals: {
      errors: clamp(s.errors, 0, 1000),
      retries: clamp(s.retries, 0, 1000),
      testsFailed: clamp(s.testsFailed, 0, 1000),
      interrupts: clamp(s.interrupts, 0, 1000),
    },
  };
}

/** Mirror of validateIngest in @vibepulse/shared (copied because this file may not import packages). */
export function isValidPayload(p: unknown): p is Payload {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  const b = p as Json;
  const keys = Object.keys(b).filter((k) => k !== 'tool' && k !== 'reread');
  if (b.reread !== undefined && !(typeof b.reread === 'number' && Number.isInteger(b.reread) && b.reread >= 0 && b.reread <= 1_000_000_000)) return false;
  if (keys.length !== 4 || !['tokensDelta', 'model', 'activeSeconds', 'signals'].every((k) => keys.includes(k))) return false;
  if (b.tool !== undefined && !TOOLS.includes(b.tool as Tool)) return false;
  const int = (v: unknown, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
  if (!int(b.tokensDelta, 50_000_000) || !int(b.activeSeconds, 3600)) return false;
  if (typeof b.model !== 'string' || !b.model.trim() || b.model.length > 80 || !MODEL_RE.test(b.model)) return false;
  const s = b.signals as Json;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return false;
  const sk = Object.keys(s);
  const want = ['errors', 'retries', 'testsFailed', 'interrupts'];
  if (sk.length !== 4 || !want.every((k) => sk.includes(k))) return false;
  return want.every((k) => int(s[k], 1000));
}

export function vibepulseHome(selfPath?: string): string {
  const env = process.env.VIBINGNOW_HOME || process.env.VIBEPULSE_HOME;
  if (env) return env;
  if (selfPath && basename(selfPath) === 'hook.mjs') return dirname(selfPath);
  return join(homedir(), '.vibingnow');
}

export function loadState(home: string): HookState {
  try {
    const s = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')) as HookState;
    if (s && typeof s === 'object' && s.transcripts && typeof s.transcripts === 'object') return s;
  } catch {
    /* fresh state */
  }
  return { transcripts: {} };
}

export function saveState(home: string, state: HookState): void {
  const entries = Object.entries(state.transcripts).sort((a, b) => (b[1].touchedAt ?? 0) - (a[1].touchedAt ?? 0));
  state.transcripts = Object.fromEntries(entries.slice(0, MAX_TRANSCRIPTS));
  mkdirSync(home, { recursive: true });
  const file = join(home, 'state.json');
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * One hook run: advance the cursor, and return the payload to send (or null). Updates state in place.
 * `connectedAt`: for a transcript seen for the first time, lines logged before this are skipped, so a long
 * session that was already open at connect doesn't count its whole history on the first send.
 */
export function collect(state: HookState, transcriptPath: string, now: number, connectedAt?: number): Payload | null {
  const r = collectFile(state, transcriptPath, now, connectedAt);
  const model = r.model ?? state.transcripts[transcriptPath]?.model ?? 'unknown';
  const payload = r.activity ? buildPayload(r, model, activeSecondsFor(now, state.lastActivityAt)) : null;
  if (r.activity) state.lastActivityAt = now;
  return payload;
}

/** Reads one transcript's new lines and advances its cursor. Each reply is counted once, by message id. */
function collectFile(state: HookState, path: string, now: number, connectedAt?: number): ChunkResult {
  const known = state.transcripts[path];
  const cur: Cursor = known ?? { offset: 0, seen: [] };
  const { text, offset } = readNewChunk(path, cur.offset);
  const seen = new Set(cur.seen);
  const r = processChunk(text, seen, known || !connectedAt ? undefined : connectedAt);
  state.transcripts[path] = { offset, seen: [...seen].slice(-MAX_SEEN), model: r.model ?? cur.model, touchedAt: now };
  return r;
}

export const claudeProjectsDir = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');

/** Claude Code transcripts changed after `since`, newest first (subagent transcripts included). */
export function findTranscripts(since: number, dir = claudeProjectsDir()): string[] {
  const out: { path: string; mtime: number }[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith('.jsonl')) {
        try {
          const mtime = statSync(p).mtimeMs;
          if (mtime > since) out.push({ path: p, mtime });
        } catch {
          /* gone */
        }
      }
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => b.mtime - a.mtime).map((x) => x.path);
}

/**
 * The Claude Code side of a run: the transcript that fired the hook, plus every other transcript on this
 * computer that changed since the last sweep. So a session whose own hook never runs (opened before connect,
 * an app that skips hooks) is still counted the next time any session's hook runs. Lines from before connect
 * are skipped, and replies are counted once by message id.
 */
export function collectClaude(state: HookState, currentPath: string | null, now: number, connectedAt?: number, dir = claudeProjectsDir()): Payload | null {
  const since = Math.max(state.lastSweepAt ?? connectedAt ?? now, connectedAt ?? 0) - 60_000;
  const paths = [...new Set([...(currentPath ? [currentPath] : []), ...findTranscripts(since, dir).slice(0, 30)])];
  state.lastSweepAt = now;
  const total: ChunkResult = { tokensDelta: 0, model: null, signals: { errors: 0, retries: 0, testsFailed: 0, interrupts: 0 }, activity: false };
  let best = -1;
  for (const p of paths) {
    let r: ChunkResult;
    try {
      r = collectFile(state, p, now, connectedAt);
    } catch {
      continue; // unreadable or removed
    }
    total.tokensDelta += r.tokensDelta;
    total.reread = (total.reread ?? 0) + (r.reread ?? 0);
    for (const k of Object.keys(total.signals) as (keyof Signals)[]) total.signals[k] += r.signals[k];
    total.activity ||= r.activity;
    if (r.model && r.tokensDelta > best) {
      best = r.tokensDelta;
      total.model = r.model;
    }
  }
  const model = total.model ?? (currentPath ? state.transcripts[currentPath]?.model : undefined) ?? 'unknown';
  const payload = total.activity ? buildPayload(total, model, activeSecondsFor(now, state.lastActivityAt)) : null;
  if (total.activity) state.lastActivityAt = now;
  return payload && { ...payload, tool: 'claude-code' };
}

/** Adds a send that failed to the next one. */
export function mergePayloads(a: Payload | null | undefined, b: Payload | null): Payload | null {
  if (!a) return b;
  if (!b) return a;
  const c = (x: number, max: number) => Math.min(max, x);
  return {
    tokensDelta: c(a.tokensDelta + b.tokensDelta, 50_000_000),
    ...(a.reread || b.reread ? { reread: c((a.reread ?? 0) + (b.reread ?? 0), 1_000_000_000) } : {}),
    model: b.model !== 'unknown' ? b.model : a.model,
    ...(b.tool ?? a.tool ? { tool: b.tool ?? a.tool } : {}),
    activeSeconds: c(a.activeSeconds + b.activeSeconds, 3600),
    signals: {
      errors: c(a.signals.errors + b.signals.errors, 1000),
      retries: c(a.signals.retries + b.signals.retries, 1000),
      testsFailed: c(a.signals.testsFailed + b.signals.testsFailed, 1000),
      interrupts: c(a.signals.interrupts + b.signals.interrupts, 1000),
    },
  };
}

/**
 * One Codex run: count new tokens in the newest rollout files since last time. Codex passes a JSON
 * description of the turn as an argument, which includes message text; it is deliberately never read.
 */
export function collectCodex(state: HookState, now: number, dir = codexSessionsDir()): Payload | null {
  const cursors = (state.codex ??= {});
  let tokens = 0;
  let reread = 0;
  let model: string | null = null;
  // Up to 25 sessions at once; only new bytes are read, so this stays cheap. A file seen for the first time
  // that hasn't changed for two hours is old history: it is noted, not counted.
  for (const f of findRollouts(dir).slice(0, MAX_CODEX_FILES)) {
    if (!cursors[f]) {
      let old = false;
      try {
        old = statSync(f).mtimeMs < now - 2 * 3_600_000;
      } catch {
        continue;
      }
      if (old) {
        const { offset, text } = readNewChunk(f, 0);
        const r = codexDelta(text, null);
        cursors[f] = { offset, total: r.total, model: r.model ?? undefined, touchedAt: now };
        continue;
      }
    }
    const cur = cursors[f] ?? { offset: 0, total: null };
    const { text, offset } = readNewChunk(f, cur.offset);
    const r = text ? codexDelta(text, cur.total) : { tokensDelta: 0, model: null, total: cur.total };
    tokens += r.tokensDelta;
    reread += r.reread ?? 0;
    const m = r.model && MODEL_RE.test(r.model) && r.model.length <= 80 ? r.model : cur.model;
    if (r.tokensDelta > 0 && m) model = m;
    cursors[f] = { offset, total: r.total, model: m, touchedAt: now };
  }
  const keep = Object.entries(cursors).sort((a, b) => (b[1].touchedAt ?? 0) - (a[1].touchedAt ?? 0));
  state.codex = Object.fromEntries(keep.slice(0, MAX_TRANSCRIPTS));
  if (tokens <= 0) return null;
  const zero = { errors: 0, retries: 0, testsFailed: 0, interrupts: 0 };
  const payload = buildPayload({ tokensDelta: tokens, reread, model, signals: zero, activity: true }, model ?? 'codex', activeSecondsFor(now, state.lastActivityAt));
  state.lastActivityAt = now;
  return payload && { ...payload, tool: 'codex' };
}

/** At connect: mark everything Codex has already logged as seen, so only new work is counted. */
export function seedCodex(state: HookState, now: number, dir = codexSessionsDir()): number {
  const cursors = (state.codex ??= {});
  const files = findRollouts(dir).slice(0, 20);
  for (const f of files) {
    const { text, offset } = readNewChunk(f, 0);
    const r = codexDelta(text, null);
    cursors[f] = { offset, total: r.total, model: r.model ?? undefined, touchedAt: now };
  }
  return files.length;
}

// ---------- Gemini CLI: ~/.gemini/tmp/<project>/chats/session-*.jsonl (older versions: .json) ----------

export const geminiTmpDir = () => join(process.env.GEMINI_CLI_HOME || homedir(), '.gemini', 'tmp');

/** Files under `dir` (to `depth`) whose name passes `ok` and that changed after `since`. */
function changedFiles(dir: string, since: number, ok: (name: string) => boolean, depth = 4, dirSince?: number): string[] {
  const out: string[] = [];
  const walk = (d: string, left: number) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      try {
        if (e.isDirectory()) {
          if (left > 0 && (dirSince === undefined || statSync(p).mtimeMs > dirSince)) walk(p, left - 1);
        } else if (ok(e.name) && statSync(p).mtimeMs > since) out.push(p);
      } catch {
        /* gone */
      }
    }
  };
  walk(dir, depth);
  return out;
}

/** New tokens in one Gemini reply: fresh input (not cached), output and thinking. */
const geminiTokens = (t: Json) => Math.max(0, num(t.input) - num(t.cached)) + num(t.output) + num(t.thoughts);

export function collectGemini(state: HookState, now: number, connectedAt?: number, dir = geminiTmpDir()): Payload | null {
  const g = (state.gemini ??= { files: {} });
  const since = Math.max(g.sweptAt ?? connectedAt ?? now, connectedAt ?? 0) - 60_000;
  g.sweptAt = now;
  let tokens = 0;
  let model: string | null = null;
  for (const f of changedFiles(dir, since, (n) => /\.jsonl?$/.test(n) && n.startsWith('session-'), 4).slice(0, 30)) {
    const known = g.files[f];
    const cur: Cursor = known ?? { offset: 0, seen: [] };
    const seen = new Set(cur.seen);
    let records: Json[] = [];
    let offset = cur.offset;
    try {
      if (f.endsWith('.jsonl')) {
        const chunk = readNewChunk(f, cur.offset);
        offset = chunk.offset;
        for (const line of chunk.text.split('\n')) {
          try {
            if (line.trim()) records.push(JSON.parse(line) as Json);
          } catch {
            /* partial or odd line */
          }
        }
      } else if (statSync(f).size < 32 * 1024 * 1024) {
        const all = JSON.parse(readFileSync(f, 'utf8')) as Json;
        records = Array.isArray(all.messages) ? (all.messages as Json[]) : [];
      }
    } catch {
      continue;
    }
    for (const r of records) {
      if (!r || r.type !== 'gemini' || !r.tokens || typeof r.tokens !== 'object' || typeof r.id !== 'string' || seen.has(r.id)) continue;
      const at = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
      seen.add(r.id);
      if (connectedAt && !(at >= connectedAt)) continue; // from before connect
      tokens += geminiTokens(r.tokens as Json);
      if (typeof r.model === 'string' && MODEL_RE.test(r.model) && r.model.length <= 80) model = r.model;
    }
    g.files[f] = { offset, seen: [...seen].slice(-MAX_SEEN), model: model ?? cur.model, touchedAt: now };
  }
  const keep = Object.entries(g.files).sort((a, b) => (b[1].touchedAt ?? 0) - (a[1].touchedAt ?? 0));
  g.files = Object.fromEntries(keep.slice(0, MAX_TRANSCRIPTS));
  return toolPayload(state, tokens, model ?? 'gemini', 'gemini-cli', now);
}

// ---------- OpenCode: one JSON file per message under ~/.local/share/opencode/storage/message/<session>/ ----------

export const opencodeDir = () =>
  process.env.OPENCODE_DATA_DIR || join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'opencode');

export function collectOpenCode(state: HookState, now: number, connectedAt?: number, dir = opencodeDir()): Payload | null {
  const o = (state.opencode ??= { seen: [] });
  const since = Math.max(o.sweptAt ?? connectedAt ?? now, connectedAt ?? 0) - 60_000;
  o.sweptAt = now;
  const seen = new Set(o.seen);
  let tokens = 0;
  let model: string | null = null;
  // A message file is created when a reply starts and rewritten when it finishes, so look in sessions that
  // gained a message in the last few hours.
  const files = changedFiles(join(dir, 'storage', 'message'), since, (n) => n.endsWith('.json'), 1, since - 6 * 3_600_000);
  for (const f of files.slice(0, 500)) {
    let m: Json;
    try {
      m = JSON.parse(readFileSync(f, 'utf8')) as Json;
    } catch {
      continue; // mid-write
    }
    const t = m.tokens as Json | undefined;
    const time = (m.time ?? {}) as Json;
    if (typeof m.id !== 'string' || seen.has(m.id) || !t || typeof t !== 'object' || typeof time.completed !== 'number') continue;
    seen.add(m.id);
    if (connectedAt && !(num(time.created) >= connectedAt)) continue;
    const cache = (t.cache ?? {}) as Json;
    tokens += num(t.input) + num(t.output) + num(t.reasoning) + num(cache.write);
    if (typeof m.modelID === 'string' && MODEL_RE.test(m.modelID) && m.modelID.length <= 80) model = m.modelID;
  }
  o.seen = [...seen].slice(-MAX_SEEN);
  return toolPayload(state, tokens, model ?? 'unknown', 'opencode', now);
}

function toolPayload(state: HookState, tokens: number, model: string, tool: Tool, now: number): Payload | null {
  if (tokens <= 0) return null;
  const zero = { errors: 0, retries: 0, testsFailed: 0, interrupts: 0 };
  const p = buildPayload({ tokensDelta: tokens, model, signals: zero, activity: true }, model, activeSecondsFor(now, state.lastActivityAt));
  state.lastActivityAt = now;
  return p && { ...p, tool };
}

/** Folds new payloads into the pending list, one per tool. */
export function queue(pending: Payload[] | undefined, add: (Payload | null)[]): Payload[] {
  const out = [...(pending ?? [])];
  for (const p of add) {
    if (!p) continue;
    const i = out.findIndex((x) => (x.tool ?? 'claude-code') === (p.tool ?? 'claude-code'));
    if (i >= 0) out[i] = mergePayloads(out[i], p)!;
    else out.push(p);
  }
  return out;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Mid-reply sends (after a tool call) happen at most this often; the end-of-reply send always runs. */
export const TOOL_SEND_GAP_MS = 20_000;

/** True when a mid-reply run should do nothing because one ran recently. */
export function throttled(state: HookState, event: unknown, now: number): boolean {
  return event === 'PostToolUse' && !!state.lastToolRunAt && now - state.lastToolRunAt < TOOL_SEND_GAP_MS;
}

/**
 * One run at a time, so two hooks firing together can't read the same cursor and count the same work twice.
 * A lock older than 15 s is left over from a crash and is taken over.
 */
async function lock(home: string, waitMs: number): Promise<(() => void) | null> {
  const file = join(home, 'hook.lock');
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(home, { recursive: true });
      closeSync(openSync(file, 'wx'));
      return () => {
        try {
          unlinkSync(file);
        } catch {
          /* already gone */
        }
      };
    } catch {
      try {
        if (Date.now() - statSync(file).mtimeMs > 15_000) unlinkSync(file);
      } catch {
        /* raced with another run */
      }
      if (Date.now() >= until) return null;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

type Mode = 'claude' | 'codex' | 'sync';

async function main(selfPath: string): Promise<void> {
  const home = vibepulseHome(selfPath);
  let config: { server?: string; token?: string; hookInstalledAt?: string };
  try {
    config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  } catch {
    return; // not connected
  }
  if (!config.server || !config.token) return;
  const mode: Mode = process.argv[2] === 'codex' ? 'codex' : process.argv[2] === 'sync' ? 'sync' : 'claude';
  let input: Json = {};
  if (mode === 'claude') {
    try {
      input = JSON.parse(await readStdin()) as Json;
    } catch {
      return;
    }
  }
  const midReply = input.hook_event_name === 'PostToolUse';
  if (midReply && throttled(loadState(home), input.hook_event_name, Date.now())) return;
  // The sync never waits: if a hook is mid-send, that run's cursors already cover this minute.
  const unlock = await lock(home, midReply || mode === 'sync' ? 0 : 4000);
  if (!unlock) return;
  try {
    await run(home, config as { server: string; token: string; hookInstalledAt?: string }, mode, input);
  } finally {
    unlock();
  }
}

async function send(server: string, token: string, payload: Payload): Promise<{ ok: boolean; status?: number; error?: string; accepted?: number }> {
  try {
    const res = await fetch(`${server.replace(/\/+$/, '')}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text().catch(() => '');
    let accepted: number | undefined;
    try {
      const a = res.ok ? (JSON.parse(text) as Json).accepted : undefined;
      if (typeof a === 'number' && Number.isInteger(a) && a >= 0) accepted = a;
    } catch {
      /* older server: it took everything */
    }
    return { ok: res.ok, status: res.status, accepted };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.name : 'error' };
  }
}

async function run(home: string, config: { server: string; token: string; hookInstalledAt?: string }, mode: Mode, input: Json): Promise<void> {
  const state = loadState(home);
  const now = Date.now();
  if (throttled(state, input.hook_event_name, now)) return;
  if (input.hook_event_name === 'PostToolUse') state.lastToolRunAt = now;
  const c = config.hookInstalledAt ? Date.parse(config.hookInstalledAt) : NaN;
  const connectedAt = Number.isFinite(c) ? c : undefined;
  const found: (Payload | null)[] = [];
  if (mode === 'codex') found.push(collectCodex(state, now));
  else {
    const transcriptPath = typeof input.transcript_path === 'string' && existsSync(input.transcript_path) ? input.transcript_path : null;
    found.push(collectClaude(state, transcriptPath, now, connectedAt));
  }
  if (mode === 'sync') {
    found.push(collectCodex(state, now), collectGemini(state, now, connectedAt), collectOpenCode(state, now, connectedAt));
  }
  // Earlier versions kept a single pending payload.
  const before = Array.isArray(state.pending) ? state.pending : state.pending ? [state.pending as unknown as Payload] : [];
  const out = queue(before, found);
  const left: Payload[] = [];
  for (const [i, payload] of out.entries()) {
    if (!isValidPayload(payload)) continue;
    // Only the first send of a run carries the active time, so several tools don't count it twice.
    const p = i === 0 ? payload : { ...payload, activeSeconds: 0 };
    const r = await send(config.server, config.token, p);
    state.lastSend = { at: now, ok: r.ok, status: r.status, error: r.error, tokensDelta: p.tokensDelta };
    // Keep what didn't arrive for next time, unless the server refused it for good (bad input, or this
    // computer was disconnected).
    if (!r.ok && r.status !== 400 && r.status !== 401 && r.status !== 403) left.push(payload);
    // The server's speed limit can take part of a big send (catching up after being offline, or the day's
    // earlier work on connect). Keep the rest, without active time or signals, for the next run.
    else if (r.ok && r.accepted !== undefined && r.accepted < p.tokensDelta) {
      const zero = { errors: 0, retries: 0, testsFailed: 0, interrupts: 0 };
      left.push({ tokensDelta: p.tokensDelta - r.accepted, model: p.model, activeSeconds: 0, signals: zero, ...(p.tool ? { tool: p.tool } : {}) });
    }
  }
  state.pending = left.length ? left : undefined;
  saveState(home, state);
}

function isMain(): boolean {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exitCode = 0;
  // Safety net. Calling process.exit() while fetch sockets close can trip a libuv assertion on Windows,
  // so normally we let the event loop drain; this unref'd timer only fires if something hangs.
  setTimeout(() => process.exit(0), 9500).unref();
  main(fileURLToPath(import.meta.url))
    .catch(() => undefined)
    .finally(() => {
      process.exitCode = 0;
    });
}
