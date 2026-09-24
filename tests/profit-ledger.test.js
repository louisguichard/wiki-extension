const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcilePurchases, recordListing, realizedSale } =
  require('../automation/profit-ledger.js');

const cardId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const copyId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const purchaseId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const saleId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const settledAt = '2026-09-23T12:00:00Z';
const won = { id: purchaseId, card_id: cardId, snapshot_rarity: 'L',
  status: 'settled_sold', final_price: 300, settled_at: settledAt };
const copy = { id: copyId, card_id: cardId, card: { rarity: 'L' },
  obtained_at: '2026-09-23T12:00:30Z' };
const sale = { id: saleId, card_id: cardId, final_price: 700,
  settled_at: '2026-09-24T12:00:00Z' };

test('links a unique won auction to its copy and persists realized gross profit', () => {
  const state = {};
  assert.equal(reconcilePurchases(state, [won], [copy]), true);
  assert.equal(recordListing(state, saleId, copyId, cardId), true);
  const restored = JSON.parse(JSON.stringify(state));
  assert.deepEqual(realizedSale(restored, sale),
    { purchaseId, cost: 300, profit: 400 });
  assert.equal(reconcilePurchases(restored, [won], [copy]), false);
});

test('leaves duplicates and overlapping purchases without an inferred cost', () => {
  const state = {};
  assert.equal(reconcilePurchases(state, [won], [copy,
    { ...copy, id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }]), false);
  recordListing(state, saleId, copyId, cardId);
  assert.equal(realizedSale(state, sale), null);
  const second = { ...won, id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' };
  assert.equal(reconcilePurchases(state, [won, second], [copy]), false);
  assert.equal(realizedSale(state, sale), null);
});

test('requires the exact sold copy and a prior purchase', () => {
  const state = {};
  reconcilePurchases(state, [won], [copy]);
  recordListing(state, saleId, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', cardId);
  assert.equal(realizedSale(state, sale), null);
  assert.equal(realizedSale(state, { ...sale, id: purchaseId }), null);
});
