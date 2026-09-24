'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

const mailScript = path.join(__dirname, 'mail.py');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const numeric = (value) => Number.isFinite(Number(value)) && Number(value) > 0 ?
  Number(value) : null;
const format = (value) => new Intl.NumberFormat('fr-FR', {
  maximumFractionDigits: 0
}).format(value);
const titleFor = (item) => String(item.card?.wikipedia_title || 'Carte WikiMasters')
  .replace(/[\r\n\t]+/g, ' ').slice(0, 120);

function sendViaPython(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [mailScript], {
      stdio: ['pipe', 'ignore', 'ignore']
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error('mail_timeout')); }, 30000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('smtp_unavailable'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

function completedEvents(mine, since) {
  const events = [];
  for (const [kind, items] of [['sale', mine.history], ['purchase', mine.won]]) {
    for (const item of Array.isArray(items) ? items : []) {
      if (!uuid.test(item?.id) || item.status !== 'settled_sold' ||
          numeric(item.final_price) == null) continue;
      const settledAt = Date.parse(item.settled_at || item.end_at);
      if (!Number.isFinite(settledAt) || settledAt < since) continue;
      events.push({ kind, item, settledAt, key: `${kind}:${item.id}` });
    }
  }
  return events.sort((a, b) => a.settledAt - b.settledAt);
}

class TradeNotifier {
  constructor({ bot, api, state, save, log = () => {}, send = sendViaPython,
    now = () => Date.now(), since = null }) {
    this.bot = bot;
    this.api = api;
    this.state = state;
    this.save = save;
    this.log = log;
    this.send = send;
    this.now = now;
    this.state.notifications ||= { since: since || new Date(now()).toISOString(),
      sent: {}, attempts: {} };
    this.save(this.state);
  }

  async emailFor(event) {
    const { kind, item, key } = event;
    const title = titleFor(item);
    const paid = numeric(item.final_price);
    const link = `https://www.wiki-masters.com/marketplace/${item.id}`;
    if (kind === 'sale') return { eventKey: key,
      subject: `WikiMasters : vente conclue — ${title}`,
      body: `${title}\nPrix de vente final : ${format(paid)} wikibidous\n` +
        `Enchère : ${link}\n` };
    const rarity = item.snapshot_rarity || item.card?.rarity;
    const cached = this.bot.averages.get(`${item.card_id}:${rarity}`);
    const sale = cached?.value || await this.bot.saleValue(item.card_id, rarity);
    const average = numeric(sale?.average);
    const conservative = average == null ? null : Math.floor(average * this.bot.config.resaleHaircut);
    const profit = conservative == null ? null : conservative - paid;
    return { eventKey: key,
      subject: `WikiMasters : achat remporté — ${title}`,
      body: `${title}\nPrix payé : ${format(paid)} wikibidous\n` +
        `Prix moyen de vente : ${average == null ? 'indisponible' : `${format(average)} wikibidous`}\n` +
        `Plus-value estimée avant frais : ${profit == null ? 'non calculable' : `${format(profit)} wikibidous`}\n` +
        `Enchère : ${link}\n` };
  }

  async tick() {
    const mine = await this.bot.read('mine', () => this.api.getMine());
    if (!Array.isArray(mine.history) || !Array.isArray(mine.won)) {
      throw new Error('notification_history_unknown');
    }
    const notifications = this.state.notifications;
    const since = Date.parse(notifications.since);
    for (const event of completedEvents(mine, since)) {
      if (notifications.sent[event.key]) continue;
      const attempt = notifications.attempts[event.key];
      if (attempt?.nextAt > this.now()) continue;
      try {
        await this.send(await this.emailFor(event));
        notifications.sent[event.key] = this.now();
        delete notifications.attempts[event.key];
        this.save(this.state);
        this.log('mail_accepted', { kind: event.kind });
      } catch (error) {
        if (error.message === 'bot_stopping' || error.message === 'session_expired') throw error;
        const count = (attempt?.count || 0) + 1;
        notifications.attempts[event.key] = { count,
          nextAt: this.now() + Math.min(3600000, 60000 * 2 ** Math.min(count - 1, 6)) };
        this.save(this.state);
        this.log('mail_failed', { kind: event.kind });
        return;
      }
    }
  }
}

module.exports = { TradeNotifier, completedEvents, sendViaPython };
