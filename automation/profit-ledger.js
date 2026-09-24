'use strict';

const MATCH_WINDOW_MS = 10 * 60000;
const positive = (value) => Number.isFinite(Number(value)) && Number(value) > 0 ?
  Number(value) : null;
const time = (value) => value ? Date.parse(value) : NaN;

function ledgerFor(state) {
  state.tradeLedger ||= { purchases: {}, listings: {} };
  return state.tradeLedger;
}

function reconcilePurchases(state, won, copies) {
  if (!Array.isArray(won) || !Array.isArray(copies)) return false;
  const ledger = ledgerFor(state);
  const unresolved = won.filter((item) => item?.status === 'settled_sold' &&
    item.id && item.card_id && positive(item.final_price) != null &&
    !ledger.purchases[item.id] && Number.isFinite(time(item.settled_at)));
  const available = copies.filter((copy) => copy?.id && copy.card_id &&
    Number.isFinite(time(copy.obtained_at)) &&
    !Object.values(ledger.purchases).some((purchase) => purchase.copyId === copy.id));
  const candidates = new Map(unresolved.map((item) => [item.id, available.filter((copy) =>
    copy.card_id === item.card_id &&
    copy.card?.rarity === (item.snapshot_rarity || item.card?.rarity) &&
    Boolean(copy.is_shiny) === Boolean(item.is_shiny) &&
    Math.abs(time(copy.obtained_at) - time(item.settled_at)) <= MATCH_WINDOW_MS
  )]));
  let changed = false;
  for (const item of unresolved) {
    const matches = candidates.get(item.id);
    if (matches.length !== 1 || [...candidates.values()].filter((group) =>
      group.some((copy) => copy.id === matches[0].id)).length !== 1) continue;
    ledger.purchases[item.id] = { copyId: matches[0].id, cardId: item.card_id,
      cost: positive(item.final_price), settledAt: item.settled_at };
    changed = true;
  }
  return changed;
}

function recordListing(state, auctionId, copyId, cardId) {
  if (!auctionId || !copyId || !cardId) return false;
  const ledger = ledgerFor(state);
  if (ledger.listings[auctionId]) return false;
  ledger.listings[auctionId] = { copyId, cardId };
  return true;
}

function realizedSale(state, sale) {
  const ledger = ledgerFor(state);
  const listing = ledger.listings[sale.id];
  const price = positive(sale.final_price);
  if (!listing || listing.cardId !== sale.card_id || price == null) return null;
  const purchases = Object.entries(ledger.purchases).filter(([, purchase]) =>
    purchase.copyId === listing.copyId && purchase.cardId === listing.cardId &&
    positive(purchase.cost) != null && time(purchase.settledAt) <=
      time(sale.settled_at || sale.end_at));
  if (purchases.length !== 1) return null;
  const [purchaseId, purchase] = purchases[0];
  return { purchaseId, cost: purchase.cost, profit: price - purchase.cost };
}

module.exports = { ledgerFor, reconcilePurchases, recordListing, realizedSale };
