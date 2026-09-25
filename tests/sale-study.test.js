const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SaleStudy, summarize } = require('../automation/sale-study.js');
const { MarketBot } = require('../automation/bot.js');

test('captures an auction once, then records its result across restarts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmma-study-'));
  try {
    const file = path.join(dir, 'study.jsonl');
    const study = new SaleStudy(file, () => Date.parse('2026-09-25T00:00:00Z'));
    const listing = { id: 'auction-1', card_id: 'card-1',
      card: { wikipedia_title: 'Example', rarity: 'L', category: 'example' },
      status: 'active', created_at: '2026-09-24T23:00:00Z',
      end_at: '2026-09-24T23:10:00Z', base_amount: 900,
      listing_base_amount: 900, final_price: null };
    study.observeMine({ selling: [listing], history: [] });
    study.confirm('auction-1', { cardId: 'card-1', copyId: 'copy-1', average: 1000,
      salesCount: 10, targetDiscount: 0.1, baseAmount: 900, cohort: 'experiment' });
    study.observeMine({ selling: [listing], history: [] });
    const settled = { ...listing, status: 'settled_sold', final_price: 1000,
      settled_at: '2026-09-24T23:10:01Z' };
    study.observeMine({ selling: [], history: [settled] });
    assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 3);
    const reloaded = new SaleStudy(file);
    assert.equal(reloaded.records.get('auction-1').targetDiscount, 0.1);
    assert.equal(reloaded.records.get('auction-1').status, 'settled_sold');
    assert.equal(summarize([...reloaded.records.values()]).netPerListing, 800);
    reloaded.observeMine({ selling: [], history: [settled] });
    assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('experiment uses each discount once per five new listings', () => {
  const state = {};
  const bot = new MarketBot({ api: {}, config: { priceExperiment: true }, state,
    save: () => {} });
  assert.deepEqual(Array.from({ length: 5 }, () => bot.listingDiscount()).sort((a, b) => a - b),
    [0, 0.05, 0.1, 0.15, 0.2]);
});
