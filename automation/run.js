'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomInt } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { WebSocketServer, WebSocket } = require('ws');
const { createApiClient } = require('./api-client.js');
const { MarketBot } = require('./bot.js');
const { TradeNotifier, sendViaPython } = require('./notifications.js');
const { SaleStudy } = require('./sale-study.js');

const root = path.resolve(__dirname, '..');
const privateDir = path.join(root, '.wmma-bot');
const statePath = path.join(privateDir, 'state.json');
const lockPath = path.join(privateDir, 'run.lock');
const stopPath = path.join(privateDir, 'STOP');
const studyPath = path.join(privateDir, 'sales-study.jsonl');
const live = process.argv.includes('--live');

function loadToken() {
  const token = JSON.parse(fs.readFileSync(path.join(__dirname, 'bridge-token.json'), 'utf8')).token;
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('Invalid local bridge token');
  return token;
}

function loadConfig() {
  const example = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.example.json'), 'utf8'));
  const localPath = path.join(__dirname, 'config.local.json');
  const local = fs.existsSync(localPath) ? JSON.parse(fs.readFileSync(localPath, 'utf8')) : {};
  const config = { ...example, ...local, live };
  if (!Number.isInteger(config.scanIntervalSeconds) || config.scanIntervalSeconds < 10 ||
      !Number.isFinite(config.resaleHaircut) || config.resaleHaircut <= 0 ||
      config.resaleHaircut > 1 || !Number.isInteger(config.minSaleCount) ||
      config.minSaleCount < 0 || !Array.isArray(config.excludedCardIds) ||
      !Array.isArray(config.excludedCopyIds) ||
      typeof config.buyEnabled !== 'boolean' ||
      typeof config.priceExperiment !== 'boolean' ||
      typeof config.emailNotifications !== 'boolean' ||
      (config.mailSource != null && typeof config.mailSource !== 'string') ||
      (config.mailTo != null && typeof config.mailTo !== 'string') ||
      (config.notificationSince != null &&
        !Number.isFinite(Date.parse(config.notificationSince)))) {
    throw new Error('Invalid bot configuration');
  }
  return config;
}

class RequestPacer {
  constructor({ gapMs = 1500 } = {}) {
    this.gapMs = gapMs;
    this.nextAt = 0;
    this.active = 0;
    this.activeLow = 0;
    this.queue = [];
    this.stopped = false;
    this.timer = null;
  }

  request(priority, fn) {
    if (this.stopped) return Promise.reject(new Error('bot_stopping'));
    return new Promise((resolve, reject) => {
      this.queue.push({ priority, fn, resolve, reject });
      this.queue.sort((a, b) => b.priority - a.priority);
      this.drain();
    });
  }

  drain() {
    if (this.stopped || this.timer || this.active >= 3) return;
    const index = this.queue.findIndex((job) => job.priority > 0 || this.activeLow < 2);
    if (index < 0) return;
    const delay = Math.max(0, this.nextAt - Date.now());
    if (delay) {
      this.timer = setTimeout(() => { this.timer = null; this.drain(); }, delay);
      return;
    }
    const [job] = this.queue.splice(index, 1);
    this.active++;
    if (job.priority === 0) this.activeLow++;
    this.nextAt = Date.now() + this.gapMs;
    Promise.resolve().then(job.fn).then(job.resolve, job.reject).finally(() => {
      this.active--;
      if (job.priority === 0) this.activeLow--;
      this.drain();
    });
    this.drain();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const job of this.queue.splice(0)) job.reject(new Error('bot_stopping'));
  }
}

function saveState(state) {
  const temp = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(temp, statePath);
}

function acquireLock() {
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(lockPath, 'utf8'));
    try { process.kill(pid, 0); throw new Error('Bot already running'); }
    catch (probe) {
      if (probe.message === 'Bot already running' || probe.code === 'EPERM') throw probe;
      fs.unlinkSync(lockPath);
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
    }
  }
  process.on('exit', () => { try { fs.unlinkSync(lockPath); } catch {} });
}

function log(event, fields = {}) {
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), event, ...fields }) + '\n');
}

class BrowserBridge {
  constructor({ port = 17887, token } = {}) {
    if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('Invalid local bridge token');
    this.socket = null;
    this.pending = new Map();
    this.nextId = randomInt(1, 1000000000);
    this.server = new WebSocketServer({ host: '127.0.0.1', port,
      verifyClient: ({ req }) => {
        const origin = req.headers.origin || '';
        const supplied = new URL(req.url, 'http://127.0.0.1').searchParams.get('token');
        return origin.startsWith('chrome-extension://') && supplied === token;
      }
    });
    this.server.on('connection', (socket) => {
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.close();
      this.socket = socket;
      log('browser_connected');
      socket.on('message', (raw) => {
        let message;
        try { message = JSON.parse(raw); } catch { return; }
        if (message.type !== 'rpc-result' && message.type !== 'rpc-error') return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.type === 'rpc-error' || message.result?.transportError) {
          const reason = message.result?.transportError || message.reason;
          log('browser_request_failed', { reason: ['network_error', 'page_timeout',
            'page_unavailable', 'disallowed_request'].includes(reason) ? reason : 'unknown' });
          pending.reject(new Error('browser_request_failed'));
        } else pending.resolve(message.result);
      });
      socket.on('close', () => {
        if (this.socket === socket) this.socket = null;
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error('browser_disconnected'));
        }
        this.pending.clear();
        log('browser_disconnected');
      });
    });
    this.heartbeat = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: 'ping' }));
      }
    }, 20000);
  }

  async request(path, init) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('browser_unavailable');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('browser_request_timeout'));
      }, init.method === 'POST' ? 19000 : 29000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ type: 'rpc', id, path, init }));
    });
  }

  async close() {
    clearInterval(this.heartbeat);
    this.socket?.close();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

async function main() {
  fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  acquireLock();
  const config = loadConfig();
  const launchChrome = () => {
    if (!live || process.platform !== 'darwin') return;
    try { execFileSync('/usr/bin/open', ['-a', 'Google Chrome'], { stdio: 'ignore' }); }
    catch { log('chrome_launch_failed'); }
  };
  launchChrome();
  let lastChromeLaunch = Date.now();
  const bridge = new BrowserBridge({ token: loadToken() });
  const pacer = new RequestPacer();
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
  const saleStudy = new SaleStudy(studyPath);
  const api = createApiClient(async (apiPath, init) => {
    const priority = init.method === 'POST' ? 3 :
      apiPath.includes('/sales') || apiPath.startsWith('/api/my-collection') ? 0 : 2;
    const result = await pacer.request(priority, () => bridge.request(apiPath, init));
    return { ok: result.ok, status: result.status, retryAfterMs: result.retryAfterMs,
      json: async () => result.data };
  }, { writesEnabled: live, bidsEnabled: live && config.buyEnabled });
  const bot = new MarketBot({ api, config, state, save: saveState, log, saleStudy });
  const notifier = live && config.emailNotifications ? new TradeNotifier({
    bot, api, state, save: saveState, log, since: config.notificationSince,
    send: (message) => sendViaPython(message, { source: config.mailSource, to: config.mailTo })
  }) : null;
  log(live ? 'live_started' : 'dry_run_started');
  if (!config.buyEnabled) log('buys_disabled');
  if (config.priceExperiment) log('sale_price_experiment_started', { discounts: [0, 5, 10, 15, 20] });
  let stopping = false;
  let waitingForBrowser = false;
  process.on('SIGTERM', () => { stopping = true; pacer.stop(); });
  process.on('SIGINT', () => { stopping = true; pacer.stop(); });
  async function loop(name, action, intervalMs) {
    let failures = 0;
    while (!stopping && !fs.existsSync(stopPath)) {
      if (bridge.socket?.readyState !== WebSocket.OPEN) {
        if (!waitingForBrowser) log('waiting_for_browser');
        waitingForBrowser = true;
        if (Date.now() - lastChromeLaunch > 5 * 60000) {
          launchChrome();
          lastChromeLaunch = Date.now();
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }
      waitingForBrowser = false;
      const started = Date.now();
      try {
        await action();
        failures = 0;
        log(`${name}_cycle_ok`);
      } catch (error) {
        if (error.message === 'session_expired') {
          failures++;
          log('session_unavailable', { loop: name, resource: error.resource || null });
        } else {
          failures++;
          log(`${name}_cycle_failed`, { reason: error.message });
        }
      }
      const delay = Math.max(1000, Math.min(300000,
        intervalMs * (failures ? 2 ** Math.min(failures, 4) : 1)) -
        (Date.now() - started));
      const until = Date.now() + delay;
      while (!stopping && !fs.existsSync(stopPath) && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000, until - Date.now())));
      }
    }
  }
  const loops = [
    loop('sale', () => bot.listingTick(), 60000)
  ];
  if (config.buyEnabled) loops.push(loop('buy', () => bot.bidTick(), config.scanIntervalSeconds * 1000));
  if (notifier) loops.push(loop('mail', () => notifier.tick(), 60000));
  await Promise.all(loops);
  log('stopped');
  await bridge.close();
}

if (require.main === module) {
  main().catch((error) => { log('fatal', { reason: error.message }); process.exitCode = 1; });
}

module.exports = { BrowserBridge, RequestPacer };
