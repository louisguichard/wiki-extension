const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const model = require('../market-model.js');

const root = path.join(__dirname, '..');
const auctionId = '67c89e96-5d0b-4f62-bfea-b4d8f8020527';
const cardId = '16680594-d801-43bf-a660-48a44d0c1eb8';

function setup(label) {
  const listeners = new Map();
  const events = [];
  const frames = [];
  const timers = new Map();
  const classes = new Set();
  const stored = new Map();
  let nextTimer = 0;
  let averageRow = null;
  const strong = {
    textContent: '',
    querySelector: () => null,
    append() {}
  };
  const frame = {
    querySelectorAll: (selector) => selector === 'span' ? [{ textContent: label }] : [],
    querySelector: (selector) => selector === '#wmma-detail-average' ? averageRow : null,
    firstElementChild: { after(row) { averageRow = row; } }
  };
  const document = {
    body: { classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) } },
    querySelectorAll: (selector) => selector === 'main .card-frame' ? [frame] : [],
    createElement: (tag) => tag === 'div' ? {
      id: '', innerHTML: '',
      querySelector: (selector) => selector === 'strong' ? strong : null
    } : { className: '', textContent: '', setAttribute() {} }
  };
  const window = {
    WMMAModel: model,
    addEventListener(name, listener) {
      listeners.set(name, [...(listeners.get(name) || []), listener]);
    },
    dispatchEvent(event) {
      events.push(event);
      for (const listener of listeners.get(event.type) || []) listener(event);
    }
  };
  class CustomEvent {
    constructor(type, options) { this.type = type; this.detail = options?.detail; }
  }
  const context = vm.createContext({
    window, document, CustomEvent, IntersectionObserver: class {},
    MutationObserver: class { observe() {} },
    location: { pathname: '/marketplace/' + auctionId },
    performance: { getEntriesByType: () => [] },
    localStorage: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, value)
    },
    requestAnimationFrame: (callback) => frames.push(callback),
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id)
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'content.js'), 'utf8'), context);
  return {
    window, events, timers, classes, strong, stored,
    row: () => averageRow,
    flushFrames() { while (frames.length) frames.shift()(); },
    fireTimer(delay) {
      const [id, timer] = [...timers].find(([, value]) => value.delay === delay) || [];
      assert.ok(timer, `expected a ${delay} ms timer`);
      timers.delete(id);
      timer.callback();
    }
  };
}

function noBidAuction() {
  return model.normalizeAuction({
    id: auctionId, card_id: cardId, base_amount: 2500,
    effective_bid: 2500, current_bid: null, snapshot_rarity: 'L', status: 'active'
  });
}

for (const label of ['Mise de départ', 'Mise actuelle']) {
  test(`renders the average beside ${label}`, () => {
    const page = setup(label);
    page.flushFrames();
    page.window.dispatchEvent(new globalThis.CustomEvent('wmma-detail', {
      detail: { auction: noBidAuction() }
    }));
    page.flushFrames();

    const request = page.events.find((event) => event.type === 'wmma-price-request');
    assert.equal(request?.detail.cardId, cardId);
    assert.equal(page.row()?.id, 'wmma-detail-average');
    assert.ok(page.classes.has('wmma-has-detail-price'));

    page.window.dispatchEvent(new globalThis.CustomEvent('wmma-price-result', {
      detail: { requestId: request.detail.requestId, ok: true, averages: { L: 6000 } }
    }));
    assert.equal(page.strong.textContent, new Intl.NumberFormat('fr-FR').format(6000) + ' W');
  });
}

test('recovers a missed detail response after the price block appears', () => {
  const page = setup('Mise de départ');
  page.flushFrames();
  page.fireTimer(500);
  assert.equal(page.events.find((event) => event.type === 'wmma-detail-request')?.detail.auctionId, auctionId);

  page.window.dispatchEvent(new globalThis.CustomEvent('wmma-detail', {
    detail: { auction: noBidAuction() }
  }));
  assert.equal(page.events.find((event) => event.type === 'wmma-price-request')?.detail.cardId, cardId);
});

test('injects the bridge before content at document start', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.content_scripts[0].js, ['market-model.js', 'page-bridge.js', 'content.js']);
  assert.equal(manifest.content_scripts[0].run_at, 'document_start');
  assert.equal(manifest.content_scripts[0].world, 'MAIN');
});

test('keeps only bounded, anonymous timing data from manual bids', () => {
  const page = setup('Mise actuelle');
  page.window.dispatchEvent(new globalThis.CustomEvent('wmma-detail', {
    detail: { auction: { ...noBidAuction(), endAt: new Date(Date.now() + 20000).toISOString() } }
  }));
  page.window.dispatchEvent(new globalThis.CustomEvent('wmma-bid-observed', {
    detail: {
      auctionId, startedAt: Date.now(), durationMs: 1430,
      status: 409, accepted: false, code: 'bid_too_low'
    }
  }));
  const samples = JSON.parse(page.stored.get('wmma_bid_samples_v1'));
  assert.equal(samples.length, 1);
  assert.equal(samples[0].durationMs, 1430);
  assert.equal(samples[0].outcome, 'bid_too_low');
  assert.ok(samples[0].leadSeconds >= 19 && samples[0].leadSeconds <= 20);
  assert.equal(JSON.stringify(samples).includes(auctionId), false);
});
