const test = require('node:test');
const assert = require('node:assert/strict');
const { MarketBot, averageFor, chooseBid } = require('../automation/bot.js');
const { parseExclusions } = require('../automation/exclusions.js');

const time = Date.parse('2026-09-23T12:00:00Z');
const auctionId = '22222222-2222-4222-8222-222222222222';
const cardA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const cardB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const copyA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const copyB = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ok = (data) => ({ ok: true, status: 200, data });
const config = { live: true, resaleHaircut: 0.8, minSaleCount: 0,
  excludedCardIds: [], excludedCopyIds: [] };

function setup({ balance = 1000, selling = [], auctions = [], collection = [],
  average = { [cardA]: 1000, [cardB]: 500 }, bidResponse = ok({}),
  listingResponse = ok({}), randomIndex = () => 0,
  readExclusions = () => parseExclusions('') } = {}) {
  const calls = { bids: [], listings: [] };
  const mine = () => ({ selling, bidding: [], maxConcurrentAuctions: 5 });
  const api = {
    getBalance: async () => ok({ balance }),
    getMine: async () => ok(mine()),
    getMarketPage: async () => ok({ auctions }),
    getAuction: async () => ok({ auction: auctions[0] }),
    getSalesSummary: async (id) => ok({ summary: { L: { average: average[id] } } }),
    getCollection: async () => ok({ collection, pendingTradeCardIds: [] }),
    placeBid: async (id, value) => { calls.bids.push({ id, value }); return bidResponse; },
    createListing: async (id, value) => { calls.listings.push({ id, value }); return listingResponse; }
  };
  const state = {};
  const bot = new MarketBot({ api, config, state, save: () => {}, now: () => time,
    randomDiscount: () => 0.07, randomIndex, readExclusions });
  return { bot, state, calls };
}

function auction(base_amount = 300) {
  return { id: auctionId, card_id: cardA, snapshot_rarity: 'L', status: 'active',
    base_amount, current_bid: null, end_at: new Date(time + 20000).toISOString(), owned: false };
}
function copy(id, cardId, title) {
  return { id, card_id: cardId, card: { rarity: 'L', wikipedia_title: title } };
}

test('ranks by expected profit with a preference for the 50% target', () => {
  const selected = chooseBid([
    { plan: { tier: 'fallback', expectedProfit: 430 }, auction: { end_at: '2026-01-01' } },
    { plan: { tier: 'target', expectedProfit: 400 }, auction: { end_at: '2026-01-01' } }
  ]);
  assert.equal(selected.plan.tier, 'target');
  assert.deepEqual(averageFor({ summary: { L: { average: 100 } } }, 'L'),
    { average: 100, count: null });
});

test('bids at the minimum under the target, then refuses insufficient balance', async () => {
  const first = setup({ auctions: [auction(300)] });
  await first.bot.tick();
  assert.deepEqual(first.calls.bids, [{ id: auctionId, value: 300 }]);
  const poor = setup({ balance: 299, auctions: [auction(300)] });
  await poor.bot.tick();
  assert.equal(poor.calls.bids.length, 0);
});

test('unknown balance stops the cycle before any write', async () => {
  const env = setup({ balance: null, auctions: [auction(1)],
    collection: [copy(copyA, cardA)] });
  await assert.rejects(() => env.bot.tick(), /balance_unknown/);
  assert.equal(env.calls.bids.length, 0);
  assert.equal(env.calls.listings.length, 0);
});

test('uses current Paris-hour bid timings when enough samples exist', () => {
  const env = setup();
  env.state.bidSamples = [
    ...Array.from({ length: 20 }, () => ({ hourUtc: '2026-09-23T12:00:00Z',
      durationMs: 3000, outcome: 'accepted' })),
    ...Array.from({ length: 20 }, () => ({ hourUtc: '2026-09-23T19:00:00Z',
      durationMs: 9000, outcome: 'accepted' }))
  ];
  assert.equal(env.bot.bidLeadSeconds(), 15);
});

test('persists sale averages for faster subsequent cycles', async () => {
  const env = setup({ auctions: [auction(300)] });
  await env.bot.tick();
  assert.equal(env.state.averages[`${cardA}:L`].value.average, 1000);
});

test('rechecks a missing sale average after one hour and lists a newly priced card', async () => {
  const selling = [];
  const env = setup({ selling, collection: [copy(copyA, cardA, 'Emma Watson')] });
  env.bot.averages.set(`${cardA}:L`, { at: time - 2 * 3600000, value: null });
  let priceReads = 0;
  env.bot.api.getSalesSummary = async () => {
    priceReads++;
    return ok({ summary: { L: { average: 15762 } } });
  };
  env.bot.api.createListing = async (id, value) => {
    env.calls.listings.push({ id, value });
    selling.push({ id: auctionId, card_id: cardA });
    return ok({});
  };
  await env.bot.listingTick();
  assert.equal(priceReads, 1);
  assert.deepEqual(env.calls.listings, [{ id: copyA, value: 14659 }]);
  assert.equal(env.state.averages[`${cardA}:L`].value.average, 15762);
});

test('backfills only one known historical listing per sale cycle', async () => {
  const env = setup();
  const oldId = '11111111-1111-4111-8111-111111111111';
  env.state.tradeLedger = { listings: { [oldId]: { copyId: copyA, cardId: cardA },
    [auctionId]: { copyId: copyB, cardId: cardB } } };
  const observed = [];
  env.bot.saleStudy = { records: new Map(), observeMine: (mine) =>
    observed.push(...mine.history) };
  env.bot.api.getAuction = async (id) => ok({ auction: { id, status: 'settled_unsold' } });
  await env.bot.backfillOne();
  assert.deepEqual(observed.map((item) => item.id), [oldId]);
});

test('accepts overlapping marketplace pages and stops when pagination repeats', async () => {
  const env = setup();
  const firstPage = Array.from({ length: 50 }, (_, i) => ({ ...auction(300),
    id: `${String(i).padStart(8, '0')}-2222-4222-8222-222222222222` }));
  let reads = 0;
  env.bot.api.getMarketPage = async () => {
    reads++;
    return ok({ auctions: firstPage, hasMore: true });
  };
  const items = await env.bot.market();
  assert.equal(items.length, 50);
  assert.equal(reads, 2);
});

test('enters only below 50% of the sale average and bids the required minimum', async () => {
  const atHalf = setup({ auctions: [auction(500)] });
  await atHalf.bot.bidTick();
  assert.equal(atHalf.calls.bids.length, 0);
  const belowHalf = setup({ auctions: [{ ...auction(300), current_bid: 480 }] });
  await belowHalf.bot.bidTick();
  assert.equal(belowHalf.calls.bids[0].value, 528);
});

test('rebids after another bidder, but never above 70% of conservative resale', async () => {
  const item = auction(300);
  const env = setup({ auctions: [item] });
  await env.bot.bidTick();
  item.current_bid = 300;
  await env.bot.bidTick();
  assert.deepEqual(env.calls.bids.map((bid) => bid.value), [300]);
  item.current_bid = 490;
  await env.bot.bidTick();
  assert.deepEqual(env.calls.bids.map((bid) => bid.value), [300, 539]);
  item.current_bid = 510;
  await env.bot.bidTick();
  assert.deepEqual(env.calls.bids.map((bid) => bid.value), [300, 539]);
});

test('does not create a sixth listing', async () => {
  const selling = Array.from({ length: 5 }, (_, i) => ({ id: String(i) }));
  const env = setup({ selling, collection: [copy(copyA, cardA)] });
  await env.bot.tick();
  assert.equal(env.calls.listings.length, 0);
});

test('skips a repeated collection page and keeps the copies already seen', async () => {
  const collection = Array.from({ length: 50 }, (_, i) => copy(String(i), cardA));
  const env = setup({ collection });
  let reads = 0;
  env.bot.api.getCollection = async () => { reads++; return ok({ collection }); };
  const cards = await env.bot.collection();
  assert.equal(cards.length, 50);
  assert.equal(reads, 2);
  assert.equal(env.bot.collectionProgress.nextPage, 2);
  env.bot.api.getCollection = async (page) => ok({ collection: page === 2 ?
    [copy(copyB, cardB)] : collection });
  assert.equal((await env.bot.collection()).length, 51);
  assert.equal(env.bot.collectionProgress, null);
});

test('resumes collection pagination after a page keeps failing', async () => {
  const env = setup();
  let pageZeroReads = 0;
  let pageOneReads = 0;
  env.bot.api.getCollection = async (page) => {
    if (page === 0) {
      pageZeroReads++;
      return ok({ collection: Array.from({ length: 50 }, (_, i) =>
        copy(String(i), cardA)), pendingTradeCardIds: [] });
    }
    pageOneReads++;
    if (pageOneReads <= 3) return { ok: false, status: 500, data: null };
    return ok({ collection: [copy(copyB, cardB)], pendingTradeCardIds: [] });
  };
  await assert.rejects(() => env.bot.collection(), /collection_unavailable/);
  const cards = await env.bot.collection();
  assert.equal(cards.length, 51);
  assert.equal(pageZeroReads, 1);
  assert.equal(pageOneReads, 4);
});

test('lists the most valuable available copy first at a random 0–10% discount', async () => {
  const selling = Array.from({ length: 4 }, (_, i) => ({ id: String(i) }));
  const env = setup({ selling, collection: [copy(copyB, cardB), copy(copyA, cardA)] });
  await env.bot.tick();
  assert.deepEqual(env.calls.listings, [{ id: copyA, value: 930 }]);
});

test('never lists a named protected card and reloads exclusions before the sale write', async () => {
  let list = '  ADa   Lovelace  ';
  const readExclusions = () => parseExclusions(list);
  const first = setup({ collection: [copy(copyA, cardA, 'Ada Lovelace'),
    copy(copyB, cardB, 'Grace Hopper')], readExclusions });
  await first.bot.listingTick();
  assert.deepEqual(first.calls.listings, [{ id: copyB, value: 465 }]);

  list = '';
  const second = setup({ collection: [copy(copyA, cardA, 'Ada Lovelace')],
    readExclusions });
  const account = second.bot.account.bind(second.bot);
  second.bot.account = async () => { list = 'Ada Lovelace'; return account(); };
  await second.bot.listingTick();
  assert.deepEqual(second.calls.listings, []);
});

test('defers another listing when the first cannot be confirmed', async () => {
  const env = setup({ collection: [copy(copyB, cardB), copy(copyA, cardA)] });
  await env.bot.listingTick();
  assert.deepEqual(env.calls.listings, [{ id: copyA, value: 930 }]);
  env.bot.now = () => time + 2 * 60000;
  await env.bot.listingTick();
  assert.deepEqual(env.calls.listings.map((item) => item.id), [copyA, copyB]);
});

test('confirms an accepted listing against fresh account state', async () => {
  const selling = [];
  const env = setup({ selling, collection: [copy(copyA, cardA)] });
  const events = [];
  env.bot.log = (event, fields) => events.push({ event, ...fields });
  env.bot.api.createListing = async (id, value) => {
    env.calls.listings.push({ id, value });
    selling.push({ id: auctionId, card_id: cardA });
    return ok({});
  };
  await env.bot.listingTick();
  assert.ok(events.some((entry) => entry.event === 'listing_confirmed' &&
    entry.sellingCount === 1));
  assert.equal(env.state.uncertainListings.length, 0);
  assert.deepEqual(env.state.tradeLedger.listings[auctionId],
    { copyId: copyA, cardId: cardA });
});

test('values every available card before filling all free sale slots by average', async () => {
  const selling = [];
  const env = setup({ selling, collection: [copy(copyB, cardB), copy(copyA, cardA)] });
  env.bot.api.createListing = async (id, value) => {
    env.calls.listings.push({ id, value });
    selling.push({ card_id: id === copyA ? cardA : cardB });
    return ok({});
  };
  await env.bot.listingTick();
  assert.deepEqual(env.calls.listings.map((item) => item.id), [copyA, copyB]);
});

test('a temporarily forbidden sale price blocks listings until ranking is complete', async () => {
  const selling = [];
  const env = setup({ selling, collection: [copy(copyB, cardB), copy(copyA, cardA)] });
  env.bot.api.getSalesSummary = async (id) => id === cardA ?
    { ok: false, status: 403, data: null } :
    ok({ summary: { L: { average: 500 } } });
  env.bot.api.createListing = async (id, value) => {
    env.calls.listings.push({ id, value });
    selling.push({ card_id: cardB });
    return ok({});
  };
  await env.bot.listingTick();
  assert.deepEqual(env.calls.listings, []);
  assert.ok(env.state.averages[`${cardA}:L`].retryAt > time);
});

test('repeated forbidden prices pause price reads without selling from a partial ranking', async () => {
  const cardC = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const cardD = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const selling = [];
  const env = setup({ selling, collection: [copy(copyA, cardA), copy(copyB, cardB),
    copy('11111111-1111-4111-8111-111111111111', cardC),
    copy('22222222-2222-4222-8222-222222222222', cardD)] });
  env.bot.averages.set(`${cardA}:L`, { at: time, value: { average: 1000, count: 1 } });
  let priceReads = 0;
  env.bot.api.getSalesSummary = async () => {
    priceReads++;
    return { ok: false, status: 403, data: null };
  };
  env.bot.api.createListing = async (id, value) => {
    env.calls.listings.push({ id, value });
    selling.push({ card_id: cardA });
    return ok({});
  };
  await env.bot.listingTick();
  assert.equal(priceReads, 3);
  assert.ok(env.state.pricePausedUntil > time);
  assert.deepEqual(env.calls.listings, []);
});

test('random selection stays within the top ten including active listings', async () => {
  const rows = Array.from({ length: 11 }, (_, i) => ({
    cardId: `${String(i + 1).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    copyId: `${String(i + 1).padStart(8, '0')}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
    average: 1100 - i * 100
  }));
  const selling = [{ card_id: rows[0].cardId, snapshot_rarity: 'L' }];
  const env = setup({ selling, collection: rows.map((row) => copy(row.copyId, row.cardId)),
    randomIndex: (length) => length - 1 });
  env.bot.api.getSalesSummary = async (id) => ok({ summary: {
    L: { average: rows.find((row) => row.cardId === id).average }
  } });
  env.bot.api.createListing = async (id, value) => {
    env.calls.listings.push({ id, value });
    selling.push({ card_id: rows.find((row) => row.copyId === id).cardId });
    return ok({});
  };
  await env.bot.listingTick();
  assert.deepEqual(env.calls.listings.map((item) => item.id),
    [rows[9], rows[8], rows[7], rows[6]].map((row) => row.copyId));
  assert.ok(!env.calls.listings.some((item) => item.id === rows[10].copyId));
});

test('price scanning is paced across cycles before any listing', async () => {
  const rows = Array.from({ length: 13 }, (_, i) => ({
    cardId: `${String(i + 1).padStart(8, '0')}-cccc-4ccc-8ccc-cccccccccccc`,
    copyId: `${String(i + 1).padStart(8, '0')}-dddd-4ddd-8ddd-dddddddddddd`
  }));
  const selling = [];
  const env = setup({ selling, collection: rows.map((row) => copy(row.copyId, row.cardId)) });
  let priceReads = 0;
  env.bot.api.getSalesSummary = async () => {
    priceReads++;
    return ok({ summary: { L: { average: 500 } } });
  };
  env.bot.api.createListing = async (id, value) => {
    env.calls.listings.push({ id, value });
    selling.push({ card_id: rows.find((row) => row.copyId === id).cardId });
    return ok({});
  };
  await env.bot.listingTick();
  assert.equal(priceReads, 12);
  assert.equal(env.calls.listings.length, 0);
  await env.bot.listingTick();
  assert.equal(priceReads, 13);
  assert.equal(env.calls.listings.length, 5);
});

test('ambiguous bid blocks further bidding until reconciled', async () => {
  const env = setup({ auctions: [auction(300)], bidResponse: null });
  env.bot.api.placeBid = async (id, value) => {
    env.calls.bids.push({ id, value });
    throw new Error('timeout');
  };
  await env.bot.tick();
  await env.bot.tick();
  assert.equal(env.calls.bids.length, 1);
  assert.equal(env.state.uncertainBid.id, auctionId);
});

test('a too-low bid gets at most one revised attempt within the cap', async () => {
  const env = setup({ auctions: [auction(300)], bidResponse: {
    ok: false, status: 409, data: { code: 'bid_too_low', min: 400 }
  } });
  await env.bot.tick();
  await env.bot.tick();
  assert.deepEqual(env.calls.bids.map((call) => call.value), [300, 400]);
});

test('a generic conflict retries once only when the current minimum has risen', async () => {
  const item = auction(300);
  const env = setup({ auctions: [item] });
  env.bot.api.placeBid = async (id, value) => {
    env.calls.bids.push({ id, value });
    if (env.calls.bids.length === 1) {
      item.current_bid = 400;
      return { ok: false, status: 409, data: null };
    }
    return ok({});
  };
  await env.bot.bidTick();
  assert.deepEqual(env.calls.bids.map((bid) => bid.value), [300, 440]);
});

test('a server minimum above the cap ends the bid without another write', async () => {
  const env = setup({ auctions: [auction(300)], bidResponse: {
    ok: false, status: 409, data: { code: 'bid_too_low', min: 561 }
  } });
  await env.bot.tick();
  assert.deepEqual(env.calls.bids.map((call) => call.value), [300]);
});

test('an auction removed after discovery does not fail the buying cycle', async () => {
  const env = setup({ auctions: [auction(300)] });
  env.bot.api.getAuction = async () => ({ ok: false, status: 404, data: null });
  await env.bot.bidTick();
  assert.equal(env.calls.bids.length, 0);
});

test('an ambiguous listing sets aside its copy while other cards remain eligible', async () => {
  const env = setup({ collection: [copy(copyA, cardA), copy(copyB, cardB)] });
  let first = true;
  env.bot.api.createListing = async (id, value) => {
    env.calls.listings.push({ id, value });
    if (first) { first = false; throw new Error('timeout'); }
    return ok({});
  };
  await env.bot.tick();
  assert.equal(env.state.uncertainListings[0].copyId, copyA);
  env.bot.now = () => time + 2 * 60000;
  await env.bot.tick();
  assert.deepEqual(env.calls.listings.map((call) => call.id), [copyA, copyB]);
});

test('repeated listing conflicts back off instead of trying another card every minute', async () => {
  const env = setup({ collection: [copy(copyA, cardA), copy(copyB, cardB)],
    listingResponse: { ok: false, status: 409, data: null } });
  let now = time;
  env.bot.now = () => now;
  await env.bot.listingTick();
  assert.deepEqual(env.calls.listings.map((call) => call.id), [copyA]);
  assert.equal(env.state.listingFailure.retryAt, time + 2 * 60000);
  now += 60000;
  await env.bot.listingTick();
  assert.equal(env.calls.listings.length, 1);
  now += 60000;
  await env.bot.listingTick();
  assert.deepEqual(env.calls.listings.map((call) => call.id), [copyA, copyB]);
  assert.equal(env.state.listingFailure.retryAt, now + 4 * 60000);
});
