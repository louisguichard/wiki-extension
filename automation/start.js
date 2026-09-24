'use strict';

const { spawn } = require('node:child_process');
const args = [process.execPath, require.resolve('./run.js'), 'run', '--live'];
const command = process.platform === 'darwin' ? '/usr/bin/caffeinate' : process.execPath;
const commandArgs = process.platform === 'darwin' ? ['-i', ...args] : args.slice(1);
const child = spawn(command, commandArgs, { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code == null ? (signal ? 1 : 0) : code;
});
