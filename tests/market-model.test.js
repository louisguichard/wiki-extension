const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../market-model.js');

const future = new Date(Date.now() + 3600_000).toISOString();
const past = new Date(Date.now() - 3600_000).toISOString();

function auction(overrides = {}) {
  return model.normalizeAuction({
    id: 'auction-1', card_id: 'card-1', base_amount: 10,
    current_bid: 60, effective_bid: 60,
    snapshot_rarity: 'SR', status: 'active', end_at: future,
    card: { wikipedia_title: 'Exemple', rarity: 'R' },
    ...overrides
  });
}

test('uses the effective current bid and the auction rarity', () => {
  const item = auction();
  assert.equal(item.currentPrice, 60);
  assert.equal(item.rarity, 'SR');
  assert.equal(model.averageFor({ SR: 120, R: 500 }, item.rarity), 120);
  assert.equal(model.metrics(item, 120).ratio, 2);
  assert.equal(model.metrics(item, 120).discountPercent, 50);
});

test('the 2x threshold includes its boundary', () => {
  const item = auction();
  assert.equal(model.isDeal(item, 120), true);
  assert.equal(model.isDeal(item, 119), false);
});

test('expired auctions and unknown averages are excluded from deals', () => {
  const item = auction({ end_at: past });
  assert.equal(model.isDeal(item, 120), false);
  assert.equal(model.isDeal(auction(), null), false);
  assert.equal(model.averageFor({ R: 100, C: 20 }, 'SR'), null);
});
