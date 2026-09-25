'use strict';

const fs = require('node:fs');

const ARMS = [0, 0.05, 0.10, 0.15, 0.20];

function auctionFields(item) {
  return {
    id: item.id,
    cardId: item.card_id || item.card?.id || null,
    title: item.card?.wikipedia_title || null,
    category: item.card?.category || null,
    rarity: item.snapshot_rarity || item.card?.rarity || null,
    shiny: Boolean(item.is_shiny),
    score: item.card?.q_score != null && Number.isFinite(Number(item.card.q_score)) ?
      Number(item.card.q_score) : null,
    pageviews: item.card?.pageviews != null && Number.isFinite(Number(item.card.pageviews)) ?
      Number(item.card.pageviews) : null,
    baseAmount: Number.isFinite(Number(item.listing_base_amount ?? item.base_amount)) ?
      Number(item.listing_base_amount ?? item.base_amount) : null,
    createdAt: item.created_at || null,
    endAt: item.end_at || null,
    settledAt: item.settled_at || null,
    status: item.status || null,
    finalPrice: item.final_price != null && Number.isFinite(Number(item.final_price)) ?
      Number(item.final_price) : null
  };
}

function applyEvent(records, event) {
  if (!event?.id) return;
  const previous = records.get(event.id) || {};
  records.set(event.id, { ...previous, ...event.fields });
}

class SaleStudy {
  constructor(file, now = () => Date.now()) {
    this.file = file;
    this.now = now;
    this.records = new Map();
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        applyEvent(this.records, JSON.parse(line));
      }
    }
  }

  update(id, fields) {
    if (!id) return false;
    const previous = this.records.get(id) || {};
    const changed = Object.fromEntries(Object.entries(fields).filter(([key, value]) =>
      value !== undefined && (previous[key] === undefined ||
        (value !== null && value !== previous[key]))));
    if (!Object.keys(changed).length) return false;
    const event = { at: new Date(this.now()).toISOString(), id, fields: changed };
    fs.appendFileSync(this.file, JSON.stringify(event) + '\n', { mode: 0o600 });
    applyEvent(this.records, event);
    return true;
  }

  observeMine(mine, averages = new Map()) {
    for (const item of [...(mine.selling || []), ...(mine.history || [])]) {
      if (!item?.id) continue;
      const fields = auctionFields(item);
      const cached = averages.get(`${fields.cardId}:${fields.rarity}`);
      if (cached?.value?.average > 0 && fields.baseAmount > 0 &&
          !this.records.get(item.id)?.average) {
        fields.average = cached.value.average;
        fields.salesCount = cached.value.count;
        fields.reference = 'reconstructed';
        fields.observedDiscount = 1 - fields.baseAmount / cached.value.average;
      }
      this.update(item.id, fields);
    }
  }

  confirm(id, { cardId, copyId, average, salesCount, targetDiscount, baseAmount,
    cohort = 'standard' }) {
    return this.update(id, { cardId, copyId, average, salesCount,
      targetDiscount, baseAmount, cohort, reference: 'at_listing',
      observedDiscount: 1 - baseAmount / average });
  }
}

function reportRows(records) {
  return [...records.values()].filter((row) => row.createdAt &&
    (row.status === 'active' || row.status === 'settled_sold' ||
      row.status === 'settled_unsold'));
}

function summarize(rows) {
  const sold = rows.filter((row) => row.status === 'settled_sold');
  const unsold = rows.filter((row) => row.status === 'settled_unsold');
  const gross = sold.reduce((sum, row) => sum + (row.finalPrice || 0), 0);
  return { total: rows.length, sold: sold.length, unsold: unsold.length,
    active: rows.length - sold.length - unsold.length,
    saleRate: sold.length + unsold.length ? sold.length / (sold.length + unsold.length) : null,
    netPerListing: sold.length + unsold.length ?
      Math.floor(gross * 0.8 / (sold.length + unsold.length)) : null };
}

module.exports = { ARMS, SaleStudy, reportRows, summarize };
