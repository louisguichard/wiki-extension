const test = require('node:test');
const assert = require('node:assert/strict');
const {
  minimumBidFromAuction, planBid, planListing, recommendBidLead, bidLatencyByHour
} = require('../automation/strategy.js');

test('calculates the current minimum from the auction snapshot', () => {
  assert.equal(minimumBidFromAuction({ base_amount: 2500, current_bid: null }), 2500);
  assert.equal(minimumBidFromAuction({ base_amount: 2500, current_bid: 2500 }), 2750);
  assert.equal(minimumBidFromAuction({ base_amount: 1, current_bid: 1 }), 2);
  assert.equal(minimumBidFromAuction({ base_amount: null, current_bid: null }), null);
});

test('never bids above 70% of a net resale estimate or the available budgets', () => {
  const base = {
    minimumBid: 700, resaleNetEstimate: 1000, spendableBalance: 900,
    reservedBalance: 100, activeExposure: 0, maxTotalExposure: 1000
  };
  assert.deepEqual(planBid(base), {
    eligible: true, amount: 700, maximumBid: 700, targetBid: 500,
    tier: 'fallback', expectedProfit: 300
  });
  assert.equal(planBid({ ...base, minimumBid: 500 }).tier, 'target');
  assert.equal(planBid({ ...base, minimumBid: 701 }).reason, 'minimum_above_cap');
  assert.equal(planBid({ ...base, spendableBalance: 750 }).maximumBid, 650);
  assert.equal(planBid({ ...base, activeExposure: 400 }).maximumBid, 600);
  assert.equal(planBid({ ...base, maxBidFraction: 0.8 }).reason, 'invalid_bid_fraction');
});

test('requires a known resale value and a current minimum', () => {
  const base = { minimumBid: 100, resaleNetEstimate: 200, spendableBalance: 500, maxTotalExposure: 500 };
  assert.equal(planBid({ ...base, resaleNetEstimate: null }).reason, 'resale_value_unknown');
  assert.equal(planBid({ ...base, minimumBid: null }).reason, 'minimum_bid_unknown');
  assert.equal(planBid({ ...base, ownAuction: true }).reason, 'auction_not_eligible');
});

test('lists only an unprotected owned copy with enough sales and a free slot', () => {
  const base = {
    userCardId: 'owned-copy-1', saleAverage: 1000, saleCount: 5,
    activeListings: 4, maxListings: 5
  };
  assert.deepEqual(planListing(base), {
    eligible: true, userCardId: 'owned-copy-1', baseAmount: 950, durationMinutes: 10
  });
  assert.equal(planListing({ ...base, saleCount: 0 }).reason, 'insufficient_sales_history');
  assert.equal(planListing({ ...base, activeListings: 5 }).reason, 'no_listing_slot');
  assert.equal(planListing({ ...base, protectedCard: true }).reason, 'card_not_eligible');
  assert.equal(planListing({ ...base, discountFraction: 0.21 }).reason, 'invalid_discount');
});

test('does not choose a sniping lead before enough manual bid samples', () => {
  assert.equal(recommendBidLead([{ durationMs: 1000, outcome: 'accepted' }]).ready, false);
  const samples = Array.from({ length: 20 }, (_, index) => ({
    durationMs: index === 19 ? 4100 : 1200, outcome: 'accepted'
  }));
  assert.deepEqual(recommendBidLead(samples), {
    ready: true, sampleCount: 20, p99Ms: 4100, leadSeconds: 17
  });
});

test('keeps separate latency estimates for different local hours', () => {
  const samples = Array.from({ length: 20 }, () => ({
    hourUtc: '2026-09-23T12:00:00.000Z', durationMs: 3500, outcome: 'accepted'
  }));
  samples.push({ hourUtc: '2026-09-23T19:00:00.000Z', durationMs: 9000, outcome: 'bid_too_low' });
  const hours = bidLatencyByHour(samples);
  assert.equal(hours[0].hour, '14');
  assert.equal(hours[0].leadSeconds, 16);
  assert.equal(hours[1].hour, '21');
  assert.equal(hours[1].ready, false);
  assert.equal(hours[1].bidTooLow, 1);
});
