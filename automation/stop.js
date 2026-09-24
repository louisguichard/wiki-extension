'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const lock = path.resolve(__dirname, '../.wmma-bot/run.lock');
if (!fs.existsSync(lock)) {
  console.log('Le bot est déjà arrêté.');
  process.exit(0);
}
const pid = Number(fs.readFileSync(lock, 'utf8'));
let command = '';
try { command = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='],
  { encoding: 'utf8' }); } catch {}
if (!Number.isInteger(pid) || pid < 1 || !/(?:^|\/)run\.js run --live/.test(command)) {
  console.error('Verrou ancien ou processus inconnu : aucun signal envoyé.');
  process.exit(1);
}
process.kill(pid, 'SIGINT');
console.log('Arrêt demandé au bot.');
