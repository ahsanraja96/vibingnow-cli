import { describe, expect, it } from 'vitest';
import { cronLine, launchdPlist, systemdUnits, windowsLauncher, windowsTaskXml } from '../src/schedule.js';

describe('background sync definitions', () => {
  it('Windows: hidden launcher, every minute, also on battery, one at a time', () => {
    expect(windowsLauncher('C:\\Program Files\\nodejs\\node.exe', 'D:\\Business Try\\.vibingnow\\hook.mjs')).toBe(
      'CreateObject("WScript.Shell").Run """C:\\Program Files\\nodejs\\node.exe"" ""D:\\Business Try\\.vibingnow\\hook.mjs"" sync", 0, False\r\n',
    );
    const x = windowsTaskXml('C:\\Users\\a & b\\.vibingnow\\sync.vbs', new Date('2026-10-20T10:00:00Z'));
    for (const want of ['<Interval>PT1M</Interval>', '<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>', '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>', '<Command>wscript.exe</Command>', '//B //Nologo &quot;C:\\Users\\a &amp; b\\.vibingnow\\sync.vbs&quot;', '<RunLevel>LeastPrivilege</RunLevel>']) expect(x).toContain(want);
  });
  it('macOS, Linux: node by full path, quiet, once a minute', () => {
    const p = launchdPlist('/Users/me/.nvm/versions/node/v22/bin/node', '/Users/me/.vibingnow/hook.mjs');
    expect(p).toContain('<key>StartInterval</key><integer>60</integer>');
    expect(p).toContain('<string>/Users/me/.nvm/versions/node/v22/bin/node</string><string>/Users/me/.vibingnow/hook.mjs</string><string>sync</string>');
    expect(systemdUnits('/usr/bin/node', '/home/me/.vibingnow/hook.mjs').service).toContain('ExecStart="/usr/bin/node" "/home/me/.vibingnow/hook.mjs" sync');
    expect(cronLine("/home/o'k/node", '/home/me/hook.mjs')).toBe(`* * * * * '/home/o'\\''k/node' '/home/me/hook.mjs' sync >/dev/null 2>&1 # vibingnow-sync`);
  });
});
