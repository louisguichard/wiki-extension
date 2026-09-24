'use strict';

const { randomInt } = require('node:crypto');
const { minimumBidFromAuction, displayedPrice, planBid, planListing,
  recommendBidLead } = require('./strategy.js');
const { loadExclusions, isExcluded } = require('./exclusions.js');
const { reconcilePurchases, recordListing } = require('./profit-ledger.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const amount = (value) => value != null && value !== '' &&
  Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const active = (auction, now) => auction?.status === 'active' && Date.parse(auction.end_at) > now;
const key = (cardId, rarity) => `${cardId}:${rarity}`;
const PRICE_CACHE_MS = 24 * 3600000;
const SALE_PRICE_SCAN_BATCH = 12;
const SALE_POOL_SIZE = 10;
async function mapInGroups(items, size, fn) {
  const result = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  }
  return result;
}

function averageFor(summary, rarity) {
  const entry = summary?.summary?.[rarity];
  const average = Number(entry?.average);
  return Number.isFinite(average) && average > 0 ? {
    average, count: Number.isInteger(entry?.count) ? entry.count : null
  } : null;
}

function validateMine(data) {
  if (!Array.isArray(data?.selling) || !Array.isArray(data?.bidding) ||
      !Number.isInteger(data.maxConcurrentAuctions) || data.maxConcurrentAuctions < 1) {
    throw new Error('account_state_unknown');
  }
  return data;
}

function chooseBid(candidates) {
  return candidates.sort((a, b) =>
    b.plan.expectedProfit * (b.plan.tier === 'target' ? 1.1 : 1) -
      a.plan.expectedProfit * (a.plan.tier === 'target' ? 1.1 : 1) ||
    Date.parse(a.auction.end_at) - Date.parse(b.auction.end_at)
  )[0] || null;
}

class MarketBot {
  constructor({ api, config, state, save, log = () => {}, now = () => Date.now(),
    randomDiscount = () => randomInt(0, 1001) / 10000,
    randomIndex = (length) => randomInt(length), readExclusions = loadExclusions }) {
    this.api = api;
    this.config = config;
    this.state = state;
    this.save = save;
    this.log = log;
    this.now = now;
    this.randomDiscount = randomDiscount;
    this.randomIndex = randomIndex;
    this.readExclusions = readExclusions;
    this.averages = new Map(Object.entries(state.averages || {}).filter(([, entry]) =>
      (Number.isFinite(entry?.at) && now() - entry.at < PRICE_CACHE_MS) ||
      entry?.retryAt > now()));
    this.collectionCache = { at: 0, cards: [] };
    this.collectionProgress = null;
    this.marketCursor = 2;
  }

  async read(label, fn) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let retryAfterMs = 0;
      try {
        const response = await fn();
        if (response.ok && response.data) return response.data;
        if (response.status === 401 || response.status === 403) {
          const error = new Error('session_expired');
          error.resource = label;
          error.status = response.status;
          throw error;
        }
        if (response.status === 429) retryAfterMs = Math.min(120000, response.retryAfterMs || 0);
        if (response.status < 500 && response.status !== 429) throw new Error(`${label}_http_${response.status}`);
      } catch (error) {
        if (error.message === 'session_expired' || error.message === 'bot_stopping') throw error;
        if (/_http_4\d\d$/.test(error.message)) throw error;
        if (attempt === 2) throw new Error(`${label}_unavailable`);
      }
      await sleep(Math.max(retryAfterMs, (attempt + 1) * 750 + randomInt(0, 500)));
    }
    throw new Error(`${label}_unavailable`);
  }

  async saleValue(cardId, rarity, maxAgeMs = PRICE_CACHE_MS) {
    if (!cardId || !rarity) return null;
    const cacheKey = key(cardId, rarity);
    const cached = this.averages.get(cacheKey);
    if (this.state.pricePausedUntil > this.now()) return cached?.value || null;
    if (cached && (this.now() - cached.at < maxAgeMs || cached.retryAt > this.now())) {
      return cached.value;
    }
    try {
      const data = await this.read('sales', () => this.api.getSalesSummary(cardId));
      const value = averageFor(data, rarity);
      this.state.priceForbiddenStreak = 0;
      this.averages.set(cacheKey, { at: this.now(), value });
      this.state.averages = Object.fromEntries(this.averages);
      this.save(this.state);
      return value;
    } catch (error) {
      if (error.message === 'bot_stopping' ||
          (error.message === 'session_expired' && error.resource !== 'sales')) throw error;
      if (error.message === 'sales_http_404') {
        this.state.priceForbiddenStreak = 0;
        this.averages.set(cacheKey, { at: this.now(), value: null });
      } else {
        if (error.message === 'session_expired' && error.resource === 'sales') {
          this.state.priceForbiddenStreak = (this.state.priceForbiddenStreak || 0) + 1;
          if (this.state.priceForbiddenStreak >= 3) {
            this.state.pricePausedUntil = this.now() + 30 * 60000;
            this.log('sale_price_api_paused', { minutes: 30 });
          }
        }
        this.averages.set(cacheKey, { at: cached?.at || 0, value: cached?.value || null,
          retryAt: this.now() + 10 * 60000 });
        this.log('sale_price_deferred', { reason: error.message === 'session_expired' ?
          'price_api_forbidden' : error.message });
      }
      this.state.averages = Object.fromEntries(this.averages);
      this.save(this.state);
      return this.averages.get(cacheKey).value;
    }
  }

  async account() {
    const [balance, mine] = await Promise.all([
      this.read('balance', () => this.api.getBalance()),
      this.read('mine', () => this.api.getMine())
    ]);
    const available = amount(balance.balance);
    if (available == null) throw new Error('balance_unknown');
    return { balance: available, mine: validateMine(mine) };
  }

  async market() {
    const auctions = [];
    const seen = new Set();
    for (const page of [1, this.marketCursor]) {
      const data = await this.read('market', () => this.api.getMarketPage(page, 50));
      if (!Array.isArray(data.auctions)) throw new Error('market_shape_unknown');
      let beyondWindow = false;
      let newCount = 0;
      for (const auction of data.auctions) {
        if (seen.has(auction.id)) continue;
        seen.add(auction.id);
        newCount++;
        if (Date.parse(auction.end_at) - this.now() > 5 * 60000) beyondWindow = true;
        else auctions.push(auction);
      }
      if (!newCount || beyondWindow || !data.hasMore || data.auctions.length < 50) {
        this.marketCursor = 2;
        return auctions;
      }
      if (page !== 1) this.marketCursor++;
    }
    return auctions;
  }

  async collection() {
    if (this.now() - this.collectionCache.at < 10 * 60000) return this.collectionCache.cards;
    this.collectionProgress ||= { cards: [], seen: new Set(), nextPage: 0 };
    const progress = this.collectionProgress;
    for (;; progress.nextPage++) {
      const page = progress.nextPage;
      const data = await this.read('collection', () => this.api.getCollection(page));
      if (!Array.isArray(data.collection)) throw new Error('collection_shape_unknown');
      const pendingTrades = new Set(data.pendingTradeCardIds || []);
      let newCount = 0;
      for (const copy of data.collection) {
        if (progress.seen.has(copy.id)) continue;
        progress.seen.add(copy.id);
        newCount++;
        if (!pendingTrades.has(copy.id) && !pendingTrades.has(copy.card_id)) {
          progress.cards.push(copy);
        }
      }
      if (!newCount && data.collection.length === 50) {
        progress.nextPage = page + 1;
        this.log('collection_page_repeated', { page, copies: progress.cards.length });
        return progress.cards;
      }
      if (data.collection.length < 50) {
        break;
      }
    }
    this.collectionCache = { at: this.now(), cards: progress.cards };
    this.collectionProgress = null;
    this.log('collection_loaded', { copies: this.collectionCache.cards.length });
    return this.collectionCache.cards;
  }

  bidLeadSeconds() {
    const samples = (this.state.bidSamples || []).filter((sample) =>
      Date.parse(sample.hourUtc) > this.now() - 30 * 24 * 3600000);
    const hour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris',
      hour: '2-digit', hourCycle: 'h23' }).format(new Date(this.now()));
    const hourFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris',
      hour: '2-digit', hourCycle: 'h23' });
    const local = samples.filter((sample) => hourFormat.format(new Date(sample.hourUtc)) === hour);
    const hourlyLead = recommendBidLead(local, { minSamples: 20 });
    const lead = hourlyLead.ready ? hourlyLead : recommendBidLead(samples, { minSamples: 20 });
    return Math.max(15, Math.min(45, lead.ready ? lead.leadSeconds : 25));
  }

  async bid(account, auctions) {
    this.state.pursuits ||= {};
    if (this.state.uncertainBid) {
      const { id, amount: previousAmount } = this.state.uncertainBid;
      if (account.mine.bidding.some((item) => item.id === id)) {
        if (Number.isInteger(previousAmount)) {
          this.state.pursuits[id] ||= { lastAcceptedAmount: previousAmount };
        }
        this.state.uncertainBid = null;
        this.save(this.state);
      } else {
        let detail;
        try { detail = await this.read('auction', () => this.api.getAuction(id)); }
        catch (error) {
          if (error.message !== 'auction_http_404') throw error;
          this.state.uncertainBid = null;
          this.save(this.state);
          return;
        }
        if (!active(detail.auction, this.now())) {
          this.state.uncertainBid = null;
          this.save(this.state);
        } else {
          this.log('bid_waiting_for_reconciliation');
          return;
        }
      }
    }
    const leadMs = this.bidLeadSeconds() * 1000;
    const participated = new Set(account.mine.bidding.map((item) => item.id));
    const marketIds = new Set(auctions.map((item) => item.id));
    for (const id of Object.keys(this.state.pursuits)) {
      if (marketIds.has(id)) continue;
      try {
        const detail = await this.read('auction', () => this.api.getAuction(id));
        if (active(detail.auction, this.now())) auctions.push(detail.auction);
        else delete this.state.pursuits[id];
      } catch (error) {
        if (error.message === 'session_expired' || error.message === 'bot_stopping') throw error;
        if (error.message === 'auction_http_404') delete this.state.pursuits[id];
      }
    }
    const relevant = [];
    for (const auction of auctions) {
      const end = Date.parse(auction.end_at);
      const pursuit = this.state.pursuits[auction.id];
      if (!active(auction, this.now())) {
        delete this.state.pursuits[auction.id];
        continue;
      }
      if (auction.owned || (participated.has(auction.id) && !pursuit) ||
          end - this.now() > 5 * 60000 || end - this.now() < 11000) continue;
      if (pursuit && amount(auction.current_bid) != null &&
          amount(auction.current_bid) <= pursuit.lastAcceptedAmount) continue;
      relevant.push(auction);
    }
    const toPrice = [];
    const pricingKeys = new Set();
    for (const auction of relevant) {
      const cacheKey = key(auction.card_id, auction.snapshot_rarity);
      if (pricingKeys.has(cacheKey)) continue;
      pricingKeys.add(cacheKey);
      const cached = this.averages.get(cacheKey);
      if (cached && this.now() - cached.at < 6 * 3600000) continue;
      toPrice.push(auction);
      if (toPrice.length >= 8) break;
    }
    const hasDuePriced = relevant.some((auction) => {
      const cached = this.averages.get(key(auction.card_id, auction.snapshot_rarity));
      return cached?.value && this.now() - cached.at < 6 * 3600000 &&
        Date.parse(auction.end_at) - this.now() <= leadMs;
    });
    if (!hasDuePriced) {
      await mapInGroups(toPrice, 3, (auction) =>
        this.saleValue(auction.card_id, auction.snapshot_rarity, 6 * 3600000));
    }
    const candidates = (await mapInGroups(relevant, 3, async (auction) => {
      const end = Date.parse(auction.end_at);
      const cached = this.averages.get(key(auction.card_id, auction.snapshot_rarity));
      const sale = cached && this.now() - cached.at < 6 * 3600000 ? cached.value : null;
      if (!sale) return null;
      const pursuit = this.state.pursuits[auction.id];
      const currentPrice = displayedPrice(auction);
      if (!pursuit && (currentPrice == null || currentPrice >= sale.average * 0.5)) return null;
      const conservative = Math.floor(sale.average * this.config.resaleHaircut);
      const minimum = minimumBidFromAuction(auction);
      if (this.state.bidAttempts?.[auction.id]?.amount >= minimum) return null;
      const plan = planBid({ minimumBid: minimum, resaleNetEstimate: conservative,
        spendableBalance: account.balance, reservedBalance: 0 });
      if (plan.eligible && end - this.now() <= leadMs) {
        return { auction, sale, plan };
      }
      return null;
    })).filter(Boolean);
    const selected = chooseBid(candidates);
    if (!selected) return;
    let fresh;
    try { fresh = await this.read('auction', () => this.api.getAuction(selected.auction.id)); }
    catch (error) {
      if (error.message === 'auction_http_404') return;
      throw error;
    }
    const auction = fresh.auction;
    if (!active(auction, this.now()) || auction.owned ||
        Date.parse(auction.end_at) - this.now() < 10500) return;
    const current = await this.account();
    const pursuit = this.state.pursuits[auction.id];
    if (current.mine.bidding.some((item) => item.id === auction.id) && !pursuit) return;
    if (pursuit && amount(auction.current_bid) != null &&
        amount(auction.current_bid) <= pursuit.lastAcceptedAmount) return;
    const currentPrice = displayedPrice(auction);
    if (!pursuit && (currentPrice == null || currentPrice >= selected.sale.average * 0.5)) return;
    const plan = planBid({ minimumBid: minimumBidFromAuction(auction),
      resaleNetEstimate: Math.floor(selected.sale.average * this.config.resaleHaircut),
      spendableBalance: current.balance, reservedBalance: 0 });
    if (!plan.eligible) return;
    if (this.state.bidAttempts?.[auction.id]?.amount >= plan.amount) return;
    if (!this.config.live) {
      this.log('bid_dry_run', { amount: plan.amount, tier: plan.tier, expectedProfit: plan.expectedProfit });
      return;
    }
    let bidAmount = plan.amount;
    for (let attempt = 0; attempt < 2; attempt++) {
      const started = this.now();
      let response;
      try {
        response = await this.api.placeBid(auction.id, bidAmount);
      } catch (error) {
        if (error.message === 'bot_stopping') throw error;
        this.state.uncertainBid = { id: auction.id, amount: bidAmount };
        this.save(this.state);
        this.log('bid_ambiguous');
        return;
      }
      this.state.bidSamples = [...(this.state.bidSamples || []), {
        hourUtc: new Date(Math.floor(started / 3600000) * 3600000).toISOString(),
        durationMs: this.now() - started, outcome: response.ok ? 'accepted' :
          response.data?.code || 'rejected'
      }].slice(-500);
      if (!response.ok && response.status === 409 && attempt === 0) {
        let latest;
        try { latest = await this.read('auction', () => this.api.getAuction(auction.id)); }
        catch (error) {
          if (error.message === 'auction_http_404') break;
          throw error;
        }
        const freshAccount = await this.account();
        if (active(latest.auction, this.now()) &&
            Date.parse(latest.auction.end_at) - this.now() > 10500 &&
            (!freshAccount.mine.bidding.some((item) => item.id === auction.id) ||
              this.state.pursuits[auction.id])) {
          const latestPrice = displayedPrice(latest.auction);
          if (!this.state.pursuits[auction.id] &&
              (latestPrice == null || latestPrice >= selected.sale.average * 0.5)) break;
          const serverMinimum = Number.isInteger(response.data?.min) ? response.data.min : 0;
          const revised = planBid({ minimumBid: Math.max(serverMinimum,
            minimumBidFromAuction(latest.auction) || 0),
            resaleNetEstimate: Math.floor(selected.sale.average * this.config.resaleHaircut),
            spendableBalance: freshAccount.balance, reservedBalance: 0 });
          if (revised.eligible && revised.amount > bidAmount) {
            bidAmount = revised.amount;
            continue;
          }
        }
      }
      if (response.ok) {
        this.state.pursuits[auction.id] = { lastAcceptedAmount: bidAmount };
        delete this.state.bidAttempts?.[auction.id];
      } else {
        this.state.bidAttempts ||= {};
        this.state.bidAttempts[auction.id] = { amount: bidAmount, at: this.now() };
        if (response.status >= 500) {
          this.state.uncertainBid = { id: auction.id, amount: bidAmount };
        }
      }
      this.save(this.state);
      this.log(response.ok ? 'bid_accepted' : 'bid_rejected', { status: response.status,
        code: response.data?.code || null, amount: bidAmount });
      return;
    }
  }

  async list(account) {
    const exclusions = this.readExclusions();
    this.state.uncertainListings ||= this.state.uncertainListing ? [this.state.uncertainListing] : [];
    delete this.state.uncertainListing;
    this.state.uncertainListings = this.state.uncertainListings.filter((uncertain) =>
      this.now() - (uncertain.at || 0) < 11 * 60000 &&
      !account.mine.selling.some((item) => item.card_id === uncertain.cardId));
    const cards = await this.collection();
    if (this.collectionProgress) return;
    if (reconcilePurchases(this.state, account.mine.won, cards)) this.save(this.state);
    const listedIds = new Set(account.mine.selling.map((item) => item.card_id || item.card?.id)
      .filter(Boolean));
    const rankedCopies = new Map();
    const uncertain = (copy, cardId) => this.state.uncertainListings.some((item) =>
      item.copyId === copy.id || item.cardId === cardId);
    for (const copy of cards) {
      const cardId = copy.card_id || copy.card?.id;
      const rarity = copy.card?.rarity;
      if (!copy.id || !cardId || this.config.excludedCardIds.includes(cardId) ||
          this.config.excludedCopyIds.includes(copy.id) ||
          isExcluded(copy, cardId, exclusions) || !rarity) continue;
      const previous = rankedCopies.get(cardId);
      if (!previous || (uncertain(previous.copy, cardId) && !uncertain(copy, cardId))) {
        rankedCopies.set(cardId, { cardId, rarity, copy });
      }
    }
    for (const listing of account.mine.selling) {
      const cardId = listing.card_id || listing.card?.id;
      const rarity = listing.snapshot_rarity || listing.card?.rarity;
      if (cardId && rarity && !rankedCopies.has(cardId) &&
          !isExcluded(listing, cardId, exclusions)) {
        rankedCopies.set(cardId, { cardId, rarity, copy: null });
      }
    }
    const allCards = [...rankedCopies.values()];
    if (!allCards.length) return;
    const needsPrice = (item) => {
      const cached = this.averages.get(key(item.cardId, item.rarity));
      return !cached || !Number.isFinite(cached.at) || cached.at <= 0 ||
        this.now() - cached.at >= PRICE_CACHE_MS;
    };
    const scan = allCards.filter((item) => needsPrice(item) &&
      !(this.averages.get(key(item.cardId, item.rarity))?.retryAt > this.now()))
      .slice(0, SALE_PRICE_SCAN_BATCH);
    for (let index = 0; index < scan.length && !(this.state.pricePausedUntil > this.now()); index += 3) {
      const group = scan.slice(index, index + 3);
      await Promise.all(group.map((item) => this.saleValue(item.cardId, item.rarity)));
    }
    const remainingPrices = allCards.filter(needsPrice).length;
    if (remainingPrices) {
      this.log('sale_waiting_for_prices', { remaining: remainingPrices,
        known: allCards.length - remainingPrices });
      return;
    }
    const ranked = allCards.map((item) => ({ ...item,
      sale: this.averages.get(key(item.cardId, item.rarity))?.value || null
    })).filter((item) => item.sale).sort((a, b) =>
      b.sale.average - a.sale.average || a.cardId.localeCompare(b.cardId));
    const top = ranked.slice(0, SALE_POOL_SIZE);
    const candidates = top.filter((item) => item.copy && !listedIds.has(item.cardId) &&
      !uncertain(item.copy, item.cardId));
    this.log('sale_top_pool', { priced: ranked.length, pool: top.length,
      alreadyListed: top.filter((item) => listedIds.has(item.cardId)).length });
    let planned = 0;
    while (candidates.length && account.mine.selling.length + planned < account.mine.maxConcurrentAuctions) {
      const index = this.randomIndex(candidates.length);
      if (!Number.isInteger(index) || index < 0 || index >= candidates.length) {
        throw new Error('invalid_sale_random_index');
      }
      const [candidate] = candidates.splice(index, 1);
      const discount = this.randomDiscount();
      const plan = planListing({ userCardId: candidate.copy.id,
        saleAverage: candidate.sale.average, saleCount: candidate.sale.count ?? 0,
        minSalesCount: this.config.minSaleCount,
        activeListings: account.mine.selling.length + planned,
        maxListings: account.mine.maxConcurrentAuctions, discountFraction: discount });
      if (!plan.eligible) continue;
      if (!this.config.live) {
        this.log('listing_dry_run', { baseAmount: plan.baseAmount, discount });
        planned++;
        continue;
      }
      const fresh = await this.account();
      if (fresh.mine.selling.length >= fresh.mine.maxConcurrentAuctions) break;
      if (fresh.mine.selling.some((item) => item.card_id === candidate.cardId)) continue;
      if (isExcluded(candidate.copy, candidate.cardId, this.readExclusions())) {
        this.log('listing_excluded');
        continue;
      }
      try {
        const previousIds = new Set(fresh.mine.selling.map((item) => item.id));
        const response = await this.api.createListing(plan.userCardId, plan.baseAmount);
        if (response.ok) {
          let confirmed = false;
          let listingId = null;
          for (let check = 0; check < 2; check++) {
            try {
              const snapshot = await this.account();
              const matches = snapshot.mine.selling.filter((item) =>
                !previousIds.has(item.id) && item.card_id === candidate.cardId);
              if (snapshot.mine.selling.length > fresh.mine.selling.length ||
                  snapshot.mine.selling.some((item) =>
                    item.card_id === candidate.cardId || item.card_id === plan.userCardId)) {
                account = snapshot;
                confirmed = true;
                if (matches.length === 1) listingId = matches[0].id || null;
                break;
              }
            } catch (error) {
              if (error.message === 'bot_stopping' || error.message === 'session_expired') throw error;
            }
            if (check === 0) await sleep(2000);
          }
          if (confirmed) {
            if (recordListing(this.state, listingId, plan.userCardId, candidate.cardId)) {
              this.save(this.state);
            }
            this.log('listing_confirmed', { baseAmount: plan.baseAmount,
              sellingCount: account.mine.selling.length });
            this.collectionCache.cards = this.collectionCache.cards.filter((copy) =>
              copy.id !== plan.userCardId);
          } else {
            this.state.uncertainListings.push({ copyId: plan.userCardId,
              cardId: candidate.cardId, at: this.now() });
            this.save(this.state);
            this.log('listing_unconfirmed');
            break;
          }
        } else if (response.status >= 500) {
          this.state.uncertainListings.push({ copyId: plan.userCardId,
            cardId: candidate.cardId, at: this.now() });
          this.save(this.state);
          this.log('listing_ambiguous');
          break;
        } else {
          this.state.uncertainListings.push({ copyId: plan.userCardId,
            cardId: candidate.cardId, at: this.now() });
          this.save(this.state);
          this.log('listing_rejected', { status: response.status, code: response.data?.code || null });
          break;
        }
      } catch (error) {
        if (error.message === 'bot_stopping' || error.message === 'session_expired') throw error;
        this.state.uncertainListings.push({ copyId: plan.userCardId,
          cardId: candidate.cardId, at: this.now() });
        this.save(this.state);
        this.log('listing_ambiguous');
        break;
      }
    }
  }

  persist() {
    const oldest = this.now() - 24 * 3600000;
    delete this.state.attemptedBids;
    this.state.bidAttempts = Object.fromEntries(Object.entries(this.state.bidAttempts || {})
      .filter(([, attempt]) => attempt.at > oldest));
    this.averages = new Map([...this.averages].filter(([, entry]) =>
      this.now() - entry.at < PRICE_CACHE_MS || entry.retryAt > this.now()).slice(-3000));
    this.state.averages = Object.fromEntries(this.averages);
    this.save(this.state);
  }

  async bidTick() {
    const account = await this.account();
    const auctions = await this.market();
    await this.bid(account, auctions);
    this.persist();
  }

  async listingTick() {
    const account = await this.account();
    await this.list(account);
    this.persist();
  }

  async tick() {
    await this.bidTick();
    await this.listingTick();
  }
}

module.exports = { MarketBot, averageFor, validateMine, chooseBid };
