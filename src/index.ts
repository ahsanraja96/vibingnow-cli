#!/usr/bin/env node
// vibingnow: connect this computer's AI coding tools (Claude Code, Codex, Gemini CLI, OpenCode) to VibingNow.
// Sends numbers only, never prompts or code.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND } from './brand.js';
import { CodexConfigError, codexHome, codexHookState, defaultCodexConfig, installCodexHook, uninstallCodexHook } from './codex-config.js';
import { loadState, saveState, seedCodex } from './hook.js';
import { installSync, removeSync, syncInstalled, syncLabel, type SyncKind } from './schedule.js';
import { SettingsError, checkSettings, hasVibePulseHook, hookCommand, hookNode, installHook, parseSettings, uninstallHook } from './settings.js';

interface Config {
  server: string;
  token: string;
  personId: string;
  handle: string;
  settingsPath: string;
  hookInstalledAt: string;
  settingsCreated?: boolean;
  /** Set when the Codex notify hook was added. */
  codexConfigPath?: string;
  codexCreated?: boolean;
  /** The once-a-minute background sync, when it was set up. */
  sync?: SyncKind;
}

const HELP = `vibingnow - put your AI coding on the live globe (token counts, active minutes, mood signals; never prompts or code)

Usage:
  npx vibingnow                         connect this computer: opens your browser, you click Approve
  npx vibingnow connect [code]          same, or pair with a code shown on the site
  npx vibingnow connect --token TOKEN   cloud machines: connect with a token from the site, no browser
  npx vibingnow disconnect              remove the hooks, revoke the device, delete local files
  npx vibingnow status                  show connection and last send
  npx vibingnow test                    send a test ping (also: ping)
  npx vibingnow --help

Connecting covers every project on this computer. It adds two hooks (during and at the end of each reply)
to Claude Code's user settings, one notify line to Codex's config if Codex is installed, and a small job the
computer runs once a minute to count Claude Code, Codex, Gemini CLI and OpenCode. Your other settings are kept.

Options:
  --server URL         server to connect to (default ${BRAND.defaultServer})
  --settings PATH      Claude Code settings file (default ~/.claude/settings.json)
  --codex-config PATH  Codex config file (default ~/.codex/config.toml; used when Codex is installed)
  --no-codex           don't add the Codex hook
  --no-sync            don't add the once-a-minute job (hooks only)
  --no-browser         print the approval link instead of opening it
  --token TOKEN        connect with a cloud token from the site (no browser; also VIBINGNOW_TOKEN)
  --today              also count today's earlier Claude Code sessions (automatic on your first connection of the day)
  --from-now           only count work from now on

Environment:
  VIBINGNOW_HOME       where config.json, hook.mjs and state.json live (default ~/.vibingnow)
  VIBINGNOW_TOKEN      a cloud token: connects without a browser (for setup scripts)
`;

const home = () => process.env.VIBINGNOW_HOME || process.env.VIBEPULSE_HOME || join(homedir(), '.vibingnow');
const configPath = () => join(home(), 'config.json');
const hookPath = () => join(home(), 'hook.mjs');

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const opts: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) opts[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts[a.slice(2)] = argv[++i];
      else opts[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { pos, opts };
}

function readConfig(): Config | null {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8')) as Config;
  } catch {
    return null;
  }
}

function writeConfig(c: Config) {
  mkdirSync(home(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(c, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(configPath(), 0o600);
  } catch {
    /* not supported (Windows) */
  }
}

async function errorText(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string };
    if (j?.error) return j.error;
  } catch {
    /* not json */
  }
  return `HTTP ${res.status}`;
}

/** Opens a URL in the default browser. Best effort: the link is printed too. */
function openBrowser(url: string) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* printed link is the fallback */
  }
}

/** Link codes are long and random, so only someone holding this terminal's link can approve it. */
function newLinkCode(): string {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return 'VN-' + [...randomBytes(14)].map((x) => A[x % A.length]).join('');
}

/**
 * Browser approval: open <server>/link?c=CODE, the signed-in person clicks Approve, and this terminal picks
 * the pairing up by redeeming the same code. Gives up after 10 minutes.
 */
async function approveInBrowser(server: string, noBrowser: boolean): Promise<{ token: string; personId: string; handle: string } | null> {
  const code = newLinkCode();
  const url = `${server}/link?c=${code}&d=${encodeURIComponent(hostname().slice(0, 60))}`;
  console.log(`Approve this computer in your browser:\n\n  ${url}\n`);
  if (!noBrowser) openBrowser(url);
  console.log('Waiting for you to click Approve… (Ctrl+C to cancel)');
  const until = Date.now() + 10 * 60_000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 2500));
    try {
      const res = await fetch(`${server}/api/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, device: hostname() }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const paired = (await res.json()) as { token: string; personId: string; handle: string };
        if (paired?.token) return paired;
      } else if (res.status !== 404 && res.status !== 429) {
        console.error(`Pairing failed: ${await errorText(res)}`);
        return null;
      }
    } catch {
      /* offline for a moment: keep waiting */
    }
  }
  console.error('Timed out after 10 minutes. Run the command again to get a new link.');
  return null;
}

/**
 * Where counting starts. On the first connection of a day (nothing counted yet today) it goes back to this
 * computer's midnight, so earlier sessions show up; otherwise from now, so reconnecting never counts twice.
 */
export function countFrom(opts: Record<string, string | boolean>, tokensToday: number | undefined, now = new Date()): number {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (opts['from-now'] === true) return now.getTime();
  if (opts.today === true || tokensToday === 0) return midnight;
  return now.getTime();
}

async function connect(code: string | undefined, opts: Record<string, string | boolean>): Promise<number> {
  const server = (typeof opts.server === 'string' ? opts.server : BRAND.defaultServer).replace(/\/+$/, '');
  const settingsPath = typeof opts.settings === 'string' ? opts.settings : join(homedir(), '.claude', 'settings.json');
  try {
    checkSettings(settingsPath); // refuse before using up the code
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
  let paired: { token: string; personId: string; handle: string; tokensToday?: number };
  const cloudToken = typeof opts.token === 'string' ? opts.token : process.env.VIBINGNOW_TOKEN;
  if (cloudToken && !code) {
    // Cloud machines: the token was made on the site, so there is nothing to approve here.
    try {
      const res = await fetch(`${server}/api/devices/me`, { headers: { authorization: `Bearer ${cloudToken.trim()}` }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        console.error(`That token didn't work: ${await errorText(res)}`);
        return 1;
      }
      const who = (await res.json()) as { personId: string; handle: string; tokensToday: number };
      paired = { token: cloudToken.trim(), ...who };
    } catch (e) {
      console.error(`Could not reach ${server}: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  } else if (!code) {
    const linked = await approveInBrowser(server, opts['no-browser'] === true);
    if (!linked) return 1;
    paired = linked;
  } else try {
    const res = await fetch(`${server}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, device: hostname() }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`Pairing failed: ${await errorText(res)}`);
      return 1;
    }
    paired = (await res.json()) as typeof paired;
    if (!paired?.token) throw new Error('the server did not return a token');
  } catch (e) {
    console.error(`Could not reach ${server}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  mkdirSync(home(), { recursive: true });
  copyFileSync(fileURLToPath(new URL('./hook.js', import.meta.url)), hookPath());
  const previous = readConfig();
  const settingsExisted = existsSync(settingsPath);
  mkdirSync(join(settingsPath, '..'), { recursive: true });
  let result;
  try {
    result = installHook(settingsPath, hookCommand(hookPath()));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
  // Codex: only when it's installed (or a config path was given), and never fatal.
  let codexNote: string | null = null;
  let codexConfigPath: string | undefined;
  let codexCreated: boolean | undefined;
  const wantCodex = opts['no-codex'] !== true && (typeof opts['codex-config'] === 'string' || existsSync(codexHome()));
  if (wantCodex) {
    const file = typeof opts['codex-config'] === 'string' ? opts['codex-config'] : defaultCodexConfig();
    try {
      mkdirSync(join(file, '..'), { recursive: true });
      const keepCreated = previous?.codexConfigPath === file && previous.codexCreated;
      const r = installCodexHook(file, hookPath());
      codexConfigPath = file;
      codexCreated = keepCreated ? true : r.created;
      const state = loadState(home());
      seedCodex(state, Date.now());
      saveState(home(), state);
      codexNote = `Added a notify hook to ${file}${r.backup ? ` (backup: ${r.backup})` : ''}.`;
    } catch (e) {
      codexNote = e instanceof CodexConfigError ? e.message : `Could not add the Codex hook: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  // The background sync. Not fatal: the hooks still count Claude Code and Codex without it.
  if (previous?.sync) removeSync(home(), previous.sync);
  let sync: SyncKind | undefined;
  let syncNote: string;
  if (opts['no-sync'] === true || process.env.VIBINGNOW_NO_SCHEDULE === '1') syncNote = 'Background sync: off (--no-sync).';
  else {
    const r = installSync(home(), process.execPath, hookPath());
    if ('kind' in r) {
      sync = r.kind;
      syncNote = `Added a once-a-minute sync to ${syncLabel[r.kind]}.`;
    } else syncNote = `Could not add the once-a-minute sync (${r.error}). Claude Code and Codex are still counted by the hooks.`;
  }
  writeConfig({
    sync,
    codexConfigPath,
    codexCreated,
    server,
    token: paired.token,
    personId: paired.personId,
    handle: paired.handle,
    settingsPath,
    hookInstalledAt: new Date(countFrom(opts, paired.tokensToday)).toISOString(),
    settingsCreated: previous?.settingsPath === settingsPath && previous.settingsCreated ? true : !settingsExisted,
  });
  console.log(`Connected as ${paired.handle}.`);
  if (countFrom(opts, paired.tokensToday) < Date.now() - 60_000) console.log('Your earlier Claude Code sessions from today will be counted too.');
  console.log(`Added the VibingNow hooks to ${settingsPath}${result.backup ? ` (backup: ${result.backup})` : ''}.`);
  if (codexNote) console.log(codexNote);
  console.log(syncNote);
  console.log(`${BRAND.name} sends token counts, active minutes and four mood counters. Never prompts, code or file names.`);
  console.log('This covers every project on this computer.');
  console.log('');
  await test();
  return 0;
}

/**
 * Send a test ping: an all-zero payload the server records as "test received" without touching your stats.
 * The connection check page (<server>/connected) lights up when it arrives.
 */
async function test(): Promise<number> {
  const c = readConfig();
  if (!c) {
    console.log(`Not connected. Run: npx ${BRAND.cliPackage}`);
    return 1;
  }
  try {
    const res = await fetch(`${c.server}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${c.token}` },
      body: JSON.stringify({ tokensDelta: 0, model: 'vibepulse-test', activeSeconds: 0, signals: { errors: 0, retries: 0, testsFailed: 0, interrupts: 0 } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`Test ping failed: ${await errorText(res)}`);
      return 1;
    }
    console.log('Test ping received by the server.');
    console.log(`Watch your data arrive: ${c.server}/connected`);
    console.log('Real numbers appear within a minute of your next reply in any connected tool.');
    return 0;
  } catch (e) {
    console.error(`Could not reach ${c.server}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

async function disconnect(): Promise<number> {
  const c = readConfig();
  if (!c) {
    console.log('Not connected.');
    return 0;
  }
  try {
    const r = uninstallHook(c.settingsPath, hookCommand(hookPath()), !!c.settingsCreated);
    if (r.removed) console.log(`Removed the hook from ${c.settingsPath}${r.deletedFile ? ' (file removed; connect had created it)' : ''}.`);
    else console.log(`No ${BRAND.name} hook found in ${c.settingsPath}.`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    if (!(e instanceof SettingsError)) return 1;
  }
  if (c.codexConfigPath) {
    try {
      const r = uninstallCodexHook(c.codexConfigPath, !!c.codexCreated);
      if (r.removed) console.log(`Removed the notify hook from ${c.codexConfigPath}${r.deletedFile ? ' (file removed; connect had created it)' : ''}.`);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
    }
  }
  if (c.sync) console.log(removeSync(home(), c.sync) ? 'Removed the once-a-minute sync.' : `Could not remove the once-a-minute sync from ${syncLabel[c.sync]}; it stops on its own now that this computer is disconnected.`);
  try {
    const res = await fetch(`${c.server}/api/devices/current`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${c.token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.warn(`Warning: the server did not revoke this device (${await errorText(res)}).`);
  } catch {
    console.warn(`Warning: could not reach ${c.server} to revoke this device. Revoke it on the site if needed.`);
  }
  rmSync(configPath(), { force: true });
  rmSync(hookPath(), { force: true });
  rmSync(join(home(), 'state.json'), { force: true });
  console.log('Disconnected.');
  return 0;
}

function status(): number {
  const c = readConfig();
  if (!c) {
    console.log(`Not connected. Run: npx ${BRAND.cliPackage}`);
    return 0;
  }
  let hook = 'missing';
  try {
    if (existsSync(c.settingsPath)) {
      const p = parseSettings(readFileSync(c.settingsPath, 'utf8'));
      if (!p.ok) hook = 'settings file is not valid JSON';
      else if (hasVibePulseHook(p.value, hookCommand(hookPath()))) {
        const node = hookNode(p.value);
        hook =
          node === null
            ? `installed, but it runs plain "node", which Claude Code may not find. Run: npx ${BRAND.cliPackage}@latest`
            : node && !existsSync(node)
              ? `installed, but its node (${node}) is gone. Run: npx ${BRAND.cliPackage}@latest`
              : 'installed';
      }
    }
  } catch {
    hook = 'unreadable';
  }
  console.log(`Server:   ${c.server}`);
  console.log(`Handle:   ${c.handle}`);
  console.log(`Hook:     ${hook} (${c.settingsPath})`);
  if (c.codexConfigPath) {
    let codex = 'missing';
    try {
      codex = existsSync(c.codexConfigPath) ? codexHookState(readFileSync(c.codexConfigPath, 'utf8')) : 'missing';
    } catch {
      codex = 'unreadable';
    }
    console.log(`Codex:    ${codex} (${c.codexConfigPath})`);
  }
  console.log(`Sync:     ${c.sync ? `${syncInstalled(c.sync) ? 'every minute' : 'missing'} (${syncLabel[c.sync]})` : `off. Run: npx ${BRAND.cliPackage}@latest`}`);
  let last = 'never';
  try {
    const s = JSON.parse(readFileSync(join(home(), 'state.json'), 'utf8')) as { lastSend?: { at: number; ok: boolean; status?: number; error?: string } };
    if (s.lastSend) last = `${new Date(s.lastSend.at).toLocaleString()} - ${s.lastSend.ok ? 'ok' : `failed (${s.lastSend.status ?? s.lastSend.error ?? 'error'})`}`;
  } catch {
    /* none yet */
  }
  console.log(`Last send: ${last}`);
  return 0;
}

async function run(argv: string[]): Promise<number> {
  const { pos, opts } = parseArgs(argv);
  const cmd = pos[0];
  if (!cmd && !opts.help) return connect(undefined, opts);
  if (opts.help || cmd === 'help') {
    console.log(HELP);
    return 0;
  }
  if (cmd === 'connect') return connect(pos[1], opts);
  if (cmd === 'disconnect') return disconnect();
  if (cmd === 'status') return status();
  if (cmd === 'test' || cmd === 'ping') return test();
  console.error(`Unknown command "${cmd}".\n\n${HELP}`);
  return 1;
}

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  },
);
