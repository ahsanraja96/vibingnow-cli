// The once-a-minute background sync: the computer itself runs `node hook.mjs sync`, so counting doesn't
// depend on any app calling a hook. One small scheduled job per platform, removed again by disconnect:
//   Windows  a Task Scheduler task that starts node through a hidden wscript launcher (no window flashes)
//   macOS    a LaunchAgent in ~/Library/LaunchAgents
//   Linux    a systemd user timer, or a crontab line where systemd isn't available
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

export type SyncKind = 'schtasks' | 'launchd' | 'systemd' | 'cron';

const NAME = 'VibingNow sync';
const LABEL = 'online.vibingnow.sync';
const UNIT = 'vibingnow-sync';
const CRON_MARK = '# vibingnow-sync';

const quiet = { stdio: 'pipe' as const, timeout: 15_000, windowsHide: true };
const run = (cmd: string, args: string[], input?: string) => execFileSync(cmd, args, { ...quiet, input, encoding: 'utf8' });

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Task Scheduler definition: every minute, forever, also on battery, never two at once, at most one minute. */
export function windowsTaskXml(vbsPath: string, start: Date): string {
  const at = new Date(start.getTime() - start.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Sends your AI coding token counts to VibingNow once a minute. Remove with: npx vibingnow disconnect</Description></RegistrationInfo>
  <Triggers>
    <TimeTrigger><StartBoundary>${at}</StartBoundary><Enabled>true</Enabled><Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition></TimeTrigger>
  </Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT1M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>${xml(`//B //Nologo "${vbsPath}"`)}</Arguments></Exec></Actions>
</Task>
`;
}

/** Runs node hidden: wscript has no console, and Run's 0 means "no window". */
export function windowsLauncher(nodePath: string, hookPath: string): string {
  const q = (s: string) => `""${s}""`;
  return `CreateObject("WScript.Shell").Run "${q(nodePath)} ${q(hookPath)} sync", 0, False\r\n`;
}

export function launchdPlist(nodePath: string, hookPath: string): string {
  const s = (v: string) => `<string>${xml(v)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${s(LABEL)}
  <key>ProgramArguments</key><array>${s(nodePath)}${s(hookPath)}${s('sync')}</array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key>${s('Background')}
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>StandardOutPath</key>${s('/dev/null')}
  <key>StandardErrorPath</key>${s('/dev/null')}
</dict>
</plist>
`;
}

export function systemdUnits(nodePath: string, hookPath: string): { service: string; timer: string } {
  const q = (v: string) => `"${v.replace(/(["\\])/g, '\\$1')}"`;
  return {
    service: `[Unit]\nDescription=VibingNow sync (token counts, once a minute)\n\n[Service]\nType=oneshot\nExecStart=${q(nodePath)} ${q(hookPath)} sync\nNice=10\nTimeoutStartSec=60\n`,
    timer: `[Unit]\nDescription=VibingNow sync every minute\n\n[Timer]\nOnBootSec=1min\nOnUnitActiveSec=1min\nAccuracySec=15s\n\n[Install]\nWantedBy=timers.target\n`,
  };
}

export function cronLine(nodePath: string, hookPath: string): string {
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  return `* * * * * ${q(nodePath)} ${q(hookPath)} sync >/dev/null 2>&1 ${CRON_MARK}`;
}

const launchAgent = () => join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const unitDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user');

/** Sets up the background sync. Returns what was installed, or why it couldn't be (connect carries on). */
export function installSync(home: string, nodePath: string, hookPath: string): { kind: SyncKind } | { error: string } {
  try {
    if (process.platform === 'win32') {
      const vbs = join(home, 'sync.vbs');
      writeFileSync(vbs, windowsLauncher(nodePath, hookPath), 'utf8');
      const def = join(home, 'sync-task.xml');
      writeFileSync(def, Buffer.from(`\ufeff${windowsTaskXml(vbs, new Date())}`, 'utf16le'));
      try {
        run('schtasks', ['/Create', '/F', '/TN', NAME, '/XML', def]);
      } finally {
        rmSync(def, { force: true });
      }
      return { kind: 'schtasks' };
    }
    if (process.platform === 'darwin') {
      const file = launchAgent();
      mkdirSync(join(file, '..'), { recursive: true });
      try {
        run('launchctl', ['bootout', `gui/${userInfo().uid}`, file]);
      } catch {
        /* wasn't loaded */
      }
      writeFileSync(file, launchdPlist(nodePath, hookPath), 'utf8');
      try {
        run('launchctl', ['bootstrap', `gui/${userInfo().uid}`, file]);
      } catch {
        run('launchctl', ['load', '-w', file]);
      }
      return { kind: 'launchd' };
    }
    try {
      run('systemctl', ['--user', 'show-environment']);
      const dir = unitDir();
      mkdirSync(dir, { recursive: true });
      const u = systemdUnits(nodePath, hookPath);
      writeFileSync(join(dir, `${UNIT}.service`), u.service, 'utf8');
      writeFileSync(join(dir, `${UNIT}.timer`), u.timer, 'utf8');
      run('systemctl', ['--user', 'daemon-reload']);
      run('systemctl', ['--user', 'enable', '--now', `${UNIT}.timer`]);
      return { kind: 'systemd' };
    } catch {
      /* no user systemd (WSL, containers, some distros): fall back to cron */
    }
    const current = readCrontab();
    const lines = current.split('\n').filter((l) => l.trim() && !l.includes(CRON_MARK));
    run('crontab', ['-'], [...lines, cronLine(nodePath, hookPath)].join('\n') + '\n');
    return { kind: 'cron' };
  } catch (e) {
    return { error: e instanceof Error ? e.message.split('\n')[0] : String(e) };
  }
}

function readCrontab(): string {
  try {
    return run('crontab', ['-l']);
  } catch {
    return ''; // none yet
  }
}

/** Removes whatever installSync set up. Never throws. */
export function removeSync(home: string, kind: SyncKind | undefined): boolean {
  try {
    if (kind === 'schtasks') {
      try {
        run('schtasks', ['/Delete', '/F', '/TN', NAME]);
      } finally {
        rmSync(join(home, 'sync.vbs'), { force: true });
      }
    } else if (kind === 'launchd') {
      try {
        run('launchctl', ['bootout', `gui/${userInfo().uid}`, launchAgent()]);
      } catch {
        try {
          run('launchctl', ['unload', '-w', launchAgent()]);
        } catch {
          /* not loaded */
        }
      }
      rmSync(launchAgent(), { force: true });
    } else if (kind === 'systemd') {
      try {
        run('systemctl', ['--user', 'disable', '--now', `${UNIT}.timer`]);
      } catch {
        /* already gone */
      }
      rmSync(join(unitDir(), `${UNIT}.service`), { force: true });
      rmSync(join(unitDir(), `${UNIT}.timer`), { force: true });
      try {
        run('systemctl', ['--user', 'daemon-reload']);
      } catch {
        /* fine */
      }
    } else if (kind === 'cron') {
      const current = readCrontab();
      if (current.includes(CRON_MARK)) {
        const lines = current.split('\n').filter((l) => l.trim() && !l.includes(CRON_MARK));
        run('crontab', ['-'], lines.length ? lines.join('\n') + '\n' : '');
      }
    } else return false;
    return true;
  } catch {
    return false;
  }
}

/** For `status`: is the scheduled job still there? */
export function syncInstalled(kind: SyncKind | undefined): boolean {
  try {
    if (kind === 'schtasks') return (run('schtasks', ['/Query', '/TN', NAME]), true);
    if (kind === 'launchd') return existsSync(launchAgent());
    if (kind === 'systemd') return run('systemctl', ['--user', 'is-enabled', `${UNIT}.timer`]).trim() === 'enabled';
    if (kind === 'cron') return readCrontab().includes(CRON_MARK);
  } catch {
    /* missing */
  }
  return false;
}

export const syncLabel: Record<SyncKind, string> = {
  schtasks: 'Windows Task Scheduler ("VibingNow sync")',
  launchd: `a LaunchAgent (${LABEL})`,
  systemd: `a systemd user timer (${UNIT}.timer)`,
  cron: 'a crontab line',
};

