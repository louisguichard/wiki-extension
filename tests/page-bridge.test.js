const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.join(__dirname, '..');
const cardId = '11111111-1111-4111-8111-111111111111';
const auctionId = '22222222-2222-4222-8222-222222222222';

function makeResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    clone() { return this; },
    async json() { return data; }
  };
}

function setup(savedBrowse = null, resources = []) {
  const listeners = new Map();
  const events = [];
  const calls = [];
  const window = {
    fetch: async (input) => {
      const url = new URL(input, 'https://www.wiki-masters.com');
      calls.push(url.pathname + url.search);
      if (url.pathname.includes('/sales')) {
        return makeResponse({ summary: { SR: { average: 120, count: 5 } } });
      }
      if (url.pathname === '/api/marketplace/' + auctionId + '/bid') {
        return makeResponse({ code: 'bid_too_low', min: 75 }, 409);
      }
      if (url.pathname === '/api/my-collection') {
        return makeResponse({
          collection: [{
            id: 'copy-1', card_id: cardId,
            card: { id: cardId, wikipedia_title: 'Test', rarity: 'SR' }
          }]
        });
      }
      if (url.pathname === '/api/marketplace/' + auctionId) {
        return makeResponse({
          auction: {
            id: auctionId, card_id: cardId, effective_bid: 60,
            snapshot_rarity: 'SR', status: 'active',
            card: { wikipedia_title: 'Test' }
          },
          bids: []
        });
      }
      const page = Number(url.searchParams.get('page')) || 1;
      return makeResponse({
        auctions: [{
          id: auctionId, card_id: cardId,
          effective_bid: page === 1 ? 60 : 50,
          snapshot_rarity: 'SR', status: 'active',
          card: { wikipedia_title: 'Test' }
        }],
        total: 100,
        hasMore: page < 2
      });
    },
    addEventListener(name, callback) {
      const list = listeners.get(name) || [];
      list.push(callback);
      listeners.set(name, list);
    },
    dispatchEvent(event) {
      events.push(event);
      for (const callback of listeners.get(event.type) || []) callback(event);
      return true;
    }
  };
  window.postMessage = (data, origin) => window.dispatchEvent({
    type: 'message', source: window, origin, data
  });
  class CustomEvent {
    constructor(type, options) { this.type = type; this.detail = options?.detail; }
  }
  const sessionStorage = { getItem: () => savedBrowse ? JSON.stringify(savedBrowse) : null };
  const performance = { getEntriesByType: () => resources.map((name) => ({ name })), now: () => 100 };
  const context = vm.createContext({ window, location: { origin: 'https://www.wiki-masters.com' }, sessionStorage, performance, URL, URLSearchParams, CustomEvent, Number, Object, String, Boolean, AbortController, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(root, 'market-model.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'page-bridge.js'), 'utf8'), context);
  return { window, events, calls };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('captures the browsed page and ignores account-counter fetches', async () => {
  const { window, events } = setup();
  await window.fetch('/api/marketplace?page=1&limit=50&sort=recent&mine=1');
  await tick();
  assert.equal(events.filter((event) => event.type === 'wmma-listings').length, 1);
  assert.equal(events.find((event) => event.type === 'wmma-listings').detail.auctions[0].currentPrice, 60);

  await window.fetch('/api/marketplace?page=1&limit=1&mine=1');
  await tick();
  assert.equal(events.filter((event) => event.type === 'wmma-listings').length, 1);
});

test('recovers the site list when its first fetch was missed', async () => {
  const resources = [
    'https://www.wiki-masters.com/api/marketplace?page=1&limit=50&sort=recent&mine=1',
    'https://www.wiki-masters.com/api/marketplace?page=1&limit=1&mine=1'
  ];
  const { window, events, calls } = setup(null, resources);
  window.dispatchEvent(new globalThis.CustomEvent('wmma-list-request'));
  await tick();
  assert.equal(events.find((event) => event.type === 'wmma-listings')?.detail.auctions[0].cardId, cardId);
  assert.deepEqual(calls, ['/api/marketplace?page=1&limit=50&sort=recent&mine=1']);
});

test('captures a collection page and recovers its initial request', async () => {
  const resource = 'https://www.wiki-masters.com/api/my-collection?sort=rarity&page=0&stats=0';
  const { window, events, calls } = setup(null, [resource]);
  await window.fetch(new URL(resource));
  await tick();
  const first = events.find((event) => event.type === 'wmma-collection')?.detail;
  assert.equal(first.cards[0].cardId, cardId);
  assert.equal(first.cards[0].rarity, 'SR');
  window.dispatchEvent(new globalThis.CustomEvent('wmma-collection-request'));
  await tick();
  assert.equal(events.filter((event) => event.type === 'wmma-collection').length, 2);
  assert.deepEqual(calls, [
    '/api/my-collection?sort=rarity&page=0&stats=0',
    '/api/my-collection?sort=rarity&page=0&stats=0'
  ]);
});

test('captures a detail page and its auction rarity', async () => {
  const { window, events, calls } = setup();
  await window.fetch('/api/marketplace/' + auctionId);
  await tick();
  const detail = events.find((event) => event.type === 'wmma-detail')?.detail;
  assert.equal(detail.auction.cardId, cardId);
  assert.equal(detail.auction.currentPrice, 60);
  assert.equal(detail.auction.rarity, 'SR');
  assert.deepEqual(calls, ['/api/marketplace/' + auctionId]);
});

test('can fetch detail directly if the site response was missed', async () => {
  const { window, events, calls } = setup();
  window.dispatchEvent(new globalThis.CustomEvent('wmma-detail-request', { detail: { auctionId } }));
  await tick();
  assert.equal(events.find((event) => event.type === 'wmma-detail')?.detail.auction.id, auctionId);
  assert.deepEqual(calls, ['/api/marketplace/' + auctionId]);
});

test('reads sales summaries without submitting a bid', async () => {
  const { window, events, calls } = setup();
  window.dispatchEvent(new globalThis.CustomEvent('wmma-price-request', { detail: { cardId, requestId: 'price-1' } }));
  await tick();
  const result = events.find((event) => event.type === 'wmma-price-result')?.detail;
  assert.equal(result.ok, true);
  assert.equal(result.averages.SR, 120);
  assert.equal(result.saleStats.SR.count, 5);
  assert.ok(calls.some((url) => url.includes('/sales?scope=summary')));
  assert.ok(calls.every((url) => url.startsWith('/api/marketplace')));
});

test('observes a rejected manual bid without retrying it', async () => {
  const { window, events, calls } = setup();
  await window.fetch('/api/marketplace/' + auctionId + '/bid', {
    method: 'POST', body: JSON.stringify({ amount: 60 })
  });
  await tick();
  const result = events.find((event) => event.type === 'wmma-bid-observed')?.detail;
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'bid_too_low');
  assert.equal(result.status, 409);
  assert.deepEqual(calls, ['/api/marketplace/' + auctionId + '/bid']);
});

test('the local bot bridge only forwards allowed WikiMasters API calls', async () => {
  const { window, events, calls } = setup();
  window.dispatchEvent(new globalThis.CustomEvent('wmma-bot-api-request', {
    detail: { id: 1, path: '/api/marketplace/' + auctionId + '/bid',
      init: { method: 'POST', body: JSON.stringify({ amount: 60 }) } }
  }));
  await tick();
  const result = events.find((event) => event.type === 'wmma-bot-api-response')?.detail.result;
  assert.equal(result.status, 409);
  assert.equal(result.data.min, 75);
  assert.equal(calls.length, 1);

  window.dispatchEvent(new globalThis.CustomEvent('wmma-bot-api-request', {
    detail: { id: 2, path: 'https://example.com/steal', init: { method: 'GET' } }
  }));
  const rejected = events.filter((event) => event.type === 'wmma-bot-api-response').at(-1).detail.result;
  assert.equal(rejected.transportError, 'disallowed_request');
  assert.equal(calls.length, 1);
});

test('the bot bridge accepts structured messages across Chrome script worlds', async () => {
  const { window, events } = setup();
  window.postMessage({ source: 'wmma-bot-extension', type: 'api-request',
    id: 3, path: '/api/wikibidous', init: { method: 'GET' } },
  'https://www.wiki-masters.com');
  await tick();
  assert.equal(events.find((event) => event.type === 'wmma-bot-api-response')?.detail.id, 3);
  assert.equal(events.find((event) => event.type === 'wmma-bot-api-response')?.detail.result.ok, true);
});

test('restores the site browse cache after returning from a listing', async () => {
  const saved = {
    browse: [{
      id: auctionId, card_id: cardId, effective_bid: 42,
      snapshot_rarity: 'SR', status: 'active',
      card: { wikipedia_title: 'Test' }
    }],
    browseTotal: 100,
    browseHasMore: true,
    nextBrowsePage: 4,
    sort: 'price_asc',
    submittedSearch: 'test',
    rarityFilter: ['SR']
  };
  const { window, events, calls } = setup(saved);
  window.dispatchEvent(new globalThis.CustomEvent('wmma-content-ready'));
  const restored = events.find((event) => event.type === 'wmma-listings')?.detail;
  assert.equal(restored.auctions[0].currentPrice, 42);
  assert.equal(restored.total, 100);
  assert.equal(calls.length, 0);
});
