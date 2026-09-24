'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const label = 'com.wikimasters.marketlens.bot';
const root = path.resolve(__dirname, '..');
const privateDir = path.join(root, '.wmma-bot');
const agentDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
const plistPath = path.join(agentDir, `${label}.plist`);
const domain = `gui/${process.getuid()}`;
const xml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const command = process.argv[2];

function plist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>
<string>/usr/bin/caffeinate</string><string>-i</string>
<string>${xml(process.execPath)}</string>
<string>${xml(path.join(__dirname, 'run.js'))}</string>
<string>run</string><string>--live</string>
</array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>${xml(path.join(privateDir, 'stdout.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(privateDir, 'stderr.log'))}</string>
</dict></plist>\n`;
}

if (command === 'preview') {
  process.stdout.write(plist());
} else if (command === 'install') {
  if (fs.existsSync(plistPath)) throw new Error('Service already installed');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(plistPath, plist(), { mode: 0o600 });
  execFileSync('/usr/bin/plutil', ['-lint', plistPath], { stdio: 'inherit' });
  try { execFileSync('/bin/launchctl', ['bootstrap', domain, plistPath], { stdio: 'inherit' }); }
  catch (error) { fs.unlinkSync(plistPath); throw error; }
  process.stdout.write(`Installed ${label}\n`);
} else if (command === 'uninstall') {
  try { execFileSync('/bin/launchctl', ['bootout', `${domain}/${label}`], { stdio: 'inherit' }); }
  catch {}
  if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
  process.stdout.write(`Removed ${label}\n`);
} else if (command === 'status') {
  const lockPath = path.join(privateDir, 'run.lock');
  if (fs.existsSync(plistPath)) {
    try {
      execFileSync('/bin/launchctl', ['print', `${domain}/${label}`], { stdio: 'inherit' });
    } catch {
      process.stdout.write('LaunchAgent installé, mais bot actuellement arrêté.\n');
    }
  } else if (fs.existsSync(lockPath)) {
    const pid = Number(fs.readFileSync(lockPath, 'utf8'));
    let processCommand = '';
    try { processCommand = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='],
      { encoding: 'utf8' }); } catch {}
    process.stdout.write(/(?:^|\/)run\.js run --live/.test(processCommand) ?
      `Bot actif dans un terminal (PID ${pid}).\n` : 'Bot arrêté (verrou ancien).\n');
  } else {
    process.stdout.write('Bot arrêté.\n');
  }
} else {
  process.stderr.write('Usage: node automation/service.js preview|install|uninstall|status\n');
  process.exitCode = 2;
}
