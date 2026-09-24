'use strict';

function positive(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function nonNegative(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function minimumBidFromAuction(auction) {
  const current = auction?.current_bid;
  if (current == null) {
    const base = Number(auction?.base_amount);
    return Number.isInteger(base) && base > 0 ? base : null;
  }
  const amount = Number(current);
  return Number.isInteger(amount) && amount > 0
    ? Math.max(Math.ceil(amount * 11 / 10), amount + 1) : null;
}

function displayedPrice(auction) {
  for (const value of [auction?.effective_bid, auction?.current_bid, auction?.base_amount]) {
    const price = Number(value);
    if (Number.isInteger(price) && price > 0) return price;
  }
  return null;
}

function planBid(input) {
  const {
    minimumBid, resaleNetEstimate, spendableBalance, reservedBalance = 0,
    activeExposure = 0, maxTotalExposure = Infinity, maxBidFraction = 0.7,
    ownAuction = false, active = true
  } = input;
  if (!active || ownAuction) return { eligible: false, reason: 'auction_not_eligible' };
  if (!positive(minimumBid) || !Number.isInteger(minimumBid)) {
    return { eligible: false, reason: 'minimum_bid_unknown' };
  }
  if (!positive(resaleNetEstimate)) return { eligible: false, reason: 'resale_value_unknown' };
  if (!positive(maxBidFraction) || maxBidFraction > 0.7) {
    return { eligible: false, reason: 'invalid_bid_fraction' };
  }
  if (nonNegative(spendableBalance) == null || nonNegative(reservedBalance) == null ||
      nonNegative(activeExposure) == null ||
      (maxTotalExposure !== Infinity && nonNegative(maxTotalExposure) == null)) {
    return { eligible: false, reason: 'budget_unknown' };
  }

  const maxByValue = Math.floor(resaleNetEstimate * maxBidFraction);
  const maxByBalance = Math.floor(spendableBalance - reservedBalance);
  const maxByExposure = maxTotalExposure === Infinity ? Infinity :
    Math.floor(maxTotalExposure - activeExposure);
  const maximumBid = Math.max(0, Math.min(maxByValue, maxByBalance, maxByExposure));
  if (minimumBid > maximumBid) {
    return { eligible: false, reason: 'minimum_above_cap', maximumBid };
  }
  return {
    eligible: true, amount: minimumBid, maximumBid,
    targetBid: Math.floor(resaleNetEstimate * 0.5),
    tier: minimumBid <= Math.floor(resaleNetEstimate * 0.5) ? 'target' : 'fallback',
    expectedProfit: Math.floor(resaleNetEstimate - minimumBid)
  };
}

function planListing(input) {
  const {
    userCardId, saleAverage, saleCount, minSalesCount = 3,
    activeListings, maxListings, alreadyListed = false, protectedCard = false,
    discountFraction = 0.05
  } = input;
  if (!userCardId || alreadyListed || protectedCard) {
    return { eligible: false, reason: 'card_not_eligible' };
  }
  if (!positive(saleAverage) || !Number.isInteger(saleCount) || saleCount < minSalesCount) {
    return { eligible: false, reason: 'insufficient_sales_history' };
  }
  if (!Number.isInteger(activeListings) || !Number.isInteger(maxListings) ||
      activeListings < 0 || maxListings < 1 || activeListings >= maxListings) {
    return { eligible: false, reason: 'no_listing_slot' };
  }
  if (!Number.isFinite(discountFraction) || discountFraction < 0 || discountFraction > 0.1) {
    return { eligible: false, reason: 'invalid_discount' };
  }
  return {
    eligible: true,
    userCardId,
    baseAmount: Math.max(1, Math.ceil(saleAverage * (1 - discountFraction))),
    durationMinutes: 10
  };
}

function recommendBidLead(samples, options = {}) {
  const extensionWindowSeconds = options.extensionWindowSeconds ?? 10;
  const clockMarginSeconds = options.clockMarginSeconds ?? 2;
  const minSamples = options.minSamples ?? 20;
  const durations = samples.filter((sample) =>
    sample && sample.outcome !== 'network_error' &&
    positive(sample.durationMs) && sample.durationMs <= 60000
  ).map((sample) => sample.durationMs).sort((a, b) => a - b);
  if (durations.length < minSamples) {
    return { ready: false, sampleCount: durations.length, reason: 'insufficient_bid_samples' };
  }
  const p99Ms = durations[Math.ceil(durations.length * 0.99) - 1];
  return {
    ready: true,
    sampleCount: durations.length,
    p99Ms,
    leadSeconds: Math.ceil(extensionWindowSeconds + p99Ms / 1000 + clockMarginSeconds)
  };
}

function bidLatencyByHour(samples, options = {}) {
  const timeZone = options.timeZone || 'Europe/Paris';
  const hourFormat = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', hourCycle: 'h23'
  });
  const groups = new Map();
  for (const sample of samples) {
    const date = new Date(sample?.hourUtc);
    if (!Number.isFinite(date.getTime())) continue;
    const hour = hourFormat.format(date);
    if (!groups.has(hour)) groups.set(hour, []);
    groups.get(hour).push(sample);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([hour, entries]) => ({
    hour,
    accepted: entries.filter((entry) => entry.outcome === 'accepted').length,
    bidTooLow: entries.filter((entry) => entry.outcome === 'bid_too_low').length,
    ...recommendBidLead(entries, options)
  }));
}

module.exports = { minimumBidFromAuction, displayedPrice, planBid, planListing,
  recommendBidLead, bidLatencyByHour };
