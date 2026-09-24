'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const configPath = path.join(__dirname, 'bridge-token.json');
const workerPath = path.join(root, 'bot-token.js');
const exclusionsPath = path.join(__dirname, 'exclusions.local.txt');
let token;
if (fs.existsSync(configPath)) {
  token = JSON.parse(fs.readFileSync(configPath, 'utf8')).token;
} else {
  token = randomBytes(32).toString('hex');
  fs.writeFileSync(configPath, JSON.stringify({ token }), { mode: 0o600 });
}
if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('Invalid local bridge token');
fs.writeFileSync(workerPath, `self.WMMA_BOT_TOKEN = '${token}';\n`, { mode: 0o600 });
if (!fs.existsSync(exclusionsPath)) {
  fs.copyFileSync(path.join(__dirname, 'exclusions.example.txt'), exclusionsPath);
  fs.chmodSync(exclusionsPath, 0o600);
}
process.stdout.write('Local bridge configured. Reload the extension after token changes.\n');
