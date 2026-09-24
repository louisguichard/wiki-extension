const test = require('node:test');
const assert = require('node:assert/strict');
const { TradeNotifier, completedEvents } = require('../automation/notifications.js');
const { recordListing, reconcilePurchases } = require('../automation/profit-ledger.js');

const saleId = '11111111-1111-4111-8111-111111111111';
const purchaseId = '22222222-2222-4222-8222-222222222222';
const cardId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const since = '2026-09-23T21:33:00Z';
const settled = '2026-09-23T21:35:00Z';
const sale = { id: saleId, card_id: cardId, snapshot_rarity: 'L',
  card: { wikipedia_title: 'Louis XIV' }, status: 'settled_sold',
  final_price: 700, settled_at: settled };
const purchase = { id: purchaseId, card_id: cardId, snapshot_rarity: 'L',
  card: { wikipedia_title: 'Manuel Bompard' }, status: 'settled_sold',
  final_price: 300, settled_at: settled };

test('detects only completed sales and purchases since activation', () => {
  const events = completedEvents({ history: [sale, { ...sale,
    id: '33333333-3333-4333-8333-333333333333', status: 'settled_unsold' }],
  won: [purchase, { ...purchase,
    id: '44444444-4444-4444-8444-444444444444', settled_at: '2026-09-22T12:00:00Z' }] },
  Date.parse(since));
  assert.deepEqual(events.map((event) => event.kind), ['sale', 'purchase']);
});

test('sends each outcome once with fee-adjusted purchase profit', async () => {
  const sent = [];
  const state = {};
  const mine = { history: [sale], won: [purchase] };
  const api = { getMine: async () => ({ ok: true, data: mine }) };
  const bot = { api, config: { resaleHaircut: 0.8 },
    averages: new Map([[`${cardId}:L`, { value: { average: 1000 } }]]),
    read: async (_, fn) => (await fn()).data,
    saleValue: async () => ({ average: 1000 }) };
  const notifier = new TradeNotifier({ bot, api, state, save: () => {},
    since, now: () => Date.parse('2026-09-23T21:36:00Z'),
    send: async (message) => { sent.push(message); } });
  await notifier.tick();
  await notifier.tick();
  assert.equal(sent.length, 2);
  assert.equal(sent[0].subject, 'Louis XIV vendu (PV non calculable)');
  assert.match(sent[0].body, /700 wikibidous/);
  assert.match(sent[0].body, /Plus-value réalisée après frais : non calculable\n\nEnchère :/);
  assert.match(sent[0].htmlBody, /<strong>Plus-value réalisée après frais : non calculable<\/strong><br><br>Enchère :/);
  assert.equal(sent[1].subject, 'Acheté : Manuel Bompard (500 PV)');
  assert.match(sent[1].body, /Prix moyen de vente : 1\s?000 wikibidous/);
  assert.match(sent[1].body, /Plus-value estimée après frais : 500 wikibidous\n\nEnchère :/);
  assert.match(sent[1].htmlBody, /<strong>Plus-value estimée après frais : 500 wikibidous<\/strong><br><br>Enchère :/);
  assert.equal(Object.keys(state.notifications.sent).length, 2);
});

test('sale email includes realized profit after fees for a uniquely tracked copy', async () => {
  const state = {};
  const copyId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  reconcilePurchases(state, [purchase], [{ id: copyId, card_id: cardId,
    card: { rarity: 'L' }, obtained_at: settled }]);
  recordListing(state, saleId, copyId, cardId);
  const bot = { averages: new Map(), config: { resaleHaircut: 0.8 } };
  const notifier = new TradeNotifier({ bot, api: {}, state, save: () => {}, since });
  const message = await notifier.emailFor({ kind: 'sale', item: sale, key: `sale:${saleId}` });
  assert.match(message.body, /Prix d'achat : 300 wikibidous/);
  assert.equal(message.subject, 'Louis XIV vendu (260 PV)');
  assert.match(message.body, /Plus-value réalisée après frais : 260 wikibidous\n\nEnchère :/);
  assert.match(message.htmlBody, /<strong>Plus-value réalisée après frais : 260 wikibidous<\/strong>/);
});

test('escapes card titles in HTML while keeping the subject readable', async () => {
  const state = {};
  const bot = { averages: new Map([[`${cardId}:L`, { value: { average: 1000 } }]]),
    config: { resaleHaircut: 0.8 } };
  const notifier = new TradeNotifier({ bot, api: {}, state, save: () => {}, since });
  const item = { ...purchase, card: { wikipedia_title: 'A < B & C' } };
  const message = await notifier.emailFor({ kind: 'purchase', item, key: `purchase:${purchaseId}` });
  assert.equal(message.subject, 'Acheté : A < B & C (500 PV)');
  assert.match(message.htmlBody, /A &lt; B &amp; C/);
  assert.doesNotMatch(message.htmlBody, /A < B/);
});

test('groups thousands in the profit shown in the subject', async () => {
  const bot = { averages: new Map([[`${cardId}:L`, { value: { average: 4000 } }]]),
    config: { resaleHaircut: 0.8 } };
  const notifier = new TradeNotifier({ bot, api: {}, state: {}, save: () => {}, since });
  const item = { ...purchase, final_price: 885 };
  const message = await notifier.emailFor({ kind: 'purchase', item, key: `purchase:${purchaseId}` });
  assert.match(message.subject, /^Acheté : Manuel Bompard \(2\s315 PV\)$/);
});

test('retries a failed email after backoff without duplicate successful mail', async () => {
  let now = Date.parse('2026-09-23T21:36:00Z');
  let calls = 0;
  const state = {};
  const mine = { history: [sale], won: [] };
  const api = { getMine: async () => ({ ok: true, data: mine }) };
  const bot = { api, config: { resaleHaircut: 1 }, averages: new Map(),
    read: async (_, fn) => (await fn()).data };
  const notifier = new TradeNotifier({ bot, api, state, save: () => {},
    since, now: () => now, send: async () => {
      calls++;
      if (calls === 1) throw new Error('smtp_unavailable');
    } });
  await notifier.tick();
  await notifier.tick();
  assert.equal(calls, 1);
  now += 61000;
  await notifier.tick();
  await notifier.tick();
  assert.equal(calls, 2);
});
