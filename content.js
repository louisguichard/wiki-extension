(() => {
  if (window.__wmmaContent) return;
  window.__wmmaContent = true;

  const model = window.WMMAModel;
  const CACHE_PREFIX = 'wmma_average_v1_';
  const CACHE_TTL = 24 * 60 * 60 * 1000;
  const STALE_TTL = 7 * 24 * 60 * 60 * 1000;
  const ERROR_TTL = 60 * 1000;
  const CACHE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
  const CACHE_CLEANUP_KEY = 'wmma_cache_cleanup_v1';
  const BID_SAMPLES_KEY = 'wmma_bid_samples_v1';
  const MAX_CONCURRENT = 8;
  const listings = new Map();
  const priceCache = new Map();
  const queued = [];
  const queuedIds = new Set();
  const pending = new Map();
  const pendingIds = new Set();
  const detailRetries = new Set();
  const observedCards = new Set();
  const intersectingCards = new Set();
  const collectionByTitle = new Map();
  const observedCollectionCards = new Set();
  const intersectingCollectionCards = new Set();
  let queryKey = '';
  let collectionQueryKey = '';
  let detailAuction = null;
  let detailFallbackId = null;
  let detailFallbackDelay = Infinity;
  let detailFallbackTimer = null;
  let listingFallbackScheduled = false;
  let collectionFallbackScheduled = false;
  let lastListingFallbackResource = '';
  let lastCollectionFallbackResource = '';
  let activeRequests = 0;
  let concurrency = MAX_CONCURRENT;
  let cooldownUntil = 0;
  let cooldownTimer = null;
  let syncScheduled = false;
  let lastPath = location.pathname;

  const format = (value) => new Intl.NumberFormat('fr-FR', {
    maximumFractionDigits: 2
  }).format(value);

  function readCache(cardId, allowStale = false) {
    const now = Date.now();
    const memory = priceCache.get(cardId);
    const validFor = (entry) => entry.ok ? (allowStale ? STALE_TTL : CACHE_TTL) : ERROR_TTL;
    if (memory && now - memory.fetchedAt < validFor(memory)) return memory;
    try {
      const stored = JSON.parse(localStorage.getItem(CACHE_PREFIX + cardId) || 'null');
      if (stored && now - stored.fetchedAt < validFor(stored)) {
        priceCache.set(cardId, stored);
        return stored;
      }
    } catch {}
    return null;
  }

  function saveCache(cardId, entry) {
    priceCache.set(cardId, entry);
    try { localStorage.setItem(CACHE_PREFIX + cardId, JSON.stringify(entry)); } catch {}
  }

  function cleanupCache() {
    try {
      const now = Date.now();
      if (now - Number(localStorage.getItem(CACHE_CLEANUP_KEY)) < CACHE_TTL) return;
      const stale = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (!key?.startsWith(CACHE_PREFIX)) continue;
        let fetchedAt = 0;
        try { fetchedAt = Number(JSON.parse(localStorage.getItem(key))?.fetchedAt) || 0; } catch {}
        if (!fetchedAt || now - fetchedAt > CACHE_MAX_AGE) stale.push(key);
      }
      stale.forEach((key) => localStorage.removeItem(key));
      localStorage.setItem(CACHE_CLEANUP_KEY, String(now));
    } catch {}
  }

  function averageFor(auction, allowStale = true) {
    const cache = readCache(auction.cardId, allowStale);
    return cache?.ok ? model.averageFor(cache.averages, auction.rarity) : null;
  }

  function setPriceText(
    element, average, cache,
    prefix = 'Prix moyen ',
    unavailable = 'Prix moyen indisponible',
    error = 'Prix moyen : erreur temporaire'
  ) {
    if (average != null) {
      const label = prefix + format(average) + ' W';
      if (element.textContent !== label) element.textContent = label;
    } else if (cache) {
      const label = cache.ok ? unavailable : error;
      if (element.textContent !== label) element.textContent = label;
    } else if (!element.querySelector('.wmma-loading-dots')) {
      element.textContent = prefix;
      const dots = document.createElement('span');
      dots.className = 'wmma-loading-dots';
      dots.textContent = '...';
      dots.setAttribute('aria-label', 'Chargement');
      element.append(dots);
    }
  }

  function queuePrice(cardId) {
    if (readCache(cardId) || queuedIds.has(cardId) || pendingIds.has(cardId)) return;
    queued.push(cardId);
    queuedIds.add(cardId);
    pumpQueue();
  }

  function clearQueuedPrices() {
    queued.length = 0;
    queuedIds.clear();
  }

  function pumpQueue() {
    if (Date.now() < cooldownUntil) {
      if (!cooldownTimer) {
        cooldownTimer = setTimeout(() => {
          cooldownTimer = null;
          pumpQueue();
        }, cooldownUntil - Date.now());
      }
      return;
    }
    while (activeRequests < concurrency && queued.length) {
      const cardId = queued.shift();
      queuedIds.delete(cardId);
      if (readCache(cardId)) continue;
      const requestId = cardId + ':' + Date.now() + ':' + Math.random().toString(36).slice(2);
      pending.set(requestId, cardId);
      pendingIds.add(cardId);
      activeRequests += 1;
      window.dispatchEvent(new CustomEvent('wmma-price-request', { detail: { requestId, cardId } }));
    }
  }

  function renderCard(wrapper) {
    const auction = listings.get(wrapper.id.slice('marketplace-auction-'.length));
    const frame = wrapper.querySelector('a.card-frame');
    if (!auction || !frame) {
      frame?.classList.remove('wmma-deal');
      frame?.querySelector('.wmma-average')?.remove();
      return;
    }
    const average = averageFor(auction);
    frame.classList.toggle('wmma-deal', model.isDeal(auction, averageFor(auction, false)));

    let price = frame.querySelector('.wmma-average');
    if (!price) {
      price = document.createElement('div');
      price.className = 'wmma-average';
      const seller = frame.querySelector(':scope > div > p:last-child');
      if (seller) seller.before(price);
      else frame.querySelector(':scope > div')?.append(price);
    }
    const cache = readCache(auction.cardId, true);
    setPriceText(price, average, cache);
    price.title = 'Moyenne des ventes passées pour cette rareté. Le prix de l’enchère peut encore monter.' +
      (cache?.ok && Date.now() - cache.fetchedAt >= CACHE_TTL ? ' Valeur en cache en cours d’actualisation.' : '');
  }

  const visibleCards = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) {
        intersectingCards.delete(entry.target);
        continue;
      }
      intersectingCards.add(entry.target);
      const auction = listings.get(entry.target.id.slice('marketplace-auction-'.length));
      if (auction) queuePrice(auction.cardId);
    }
  }, { rootMargin: '300px 0px' });

  function collectionForWrapper(wrapper) {
    const title = wrapper.querySelector('h3')?.textContent.trim();
    return title ? collectionByTitle.get(title) : null;
  }

  function latestPageResource(pathname) {
    const entries = performance.getEntriesByType('resource');
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      try {
        const url = new URL(entries[index].name, location.origin);
        if (url.origin !== location.origin || url.pathname !== pathname) continue;
        if (pathname === '/api/marketplace' && (Number(url.searchParams.get('limit')) || 0) < 20) continue;
        return entries[index].name;
      } catch {}
    }
    return '';
  }

  function renderCollectionCard(wrapper) {
    const card = collectionForWrapper(wrapper);
    let price = wrapper.querySelector('.wmma-collection-average');
    if (!card) {
      price?.remove();
      return;
    }
    if (!price) {
      const stats = wrapper.querySelector('h3')?.parentElement?.querySelector('.mt-auto');
      if (!stats) return;
      price = document.createElement('div');
      price.className = 'wmma-collection-average';
      stats.prepend(price);
    }
    setPriceText(price, averageFor(card), readCache(card.cardId, true));
    price.title = 'Moyenne des ventes passées pour cette rareté.';
  }

  const visibleCollectionCards = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) {
        intersectingCollectionCards.delete(entry.target);
        continue;
      }
      intersectingCollectionCards.add(entry.target);
      const card = collectionForWrapper(entry.target);
      if (card) queuePrice(card.cardId);
    }
  }, { rootMargin: '300px 0px' });

  function syncCollectionCards() {
    if (location.pathname !== '/collection') return;
    const wrappers = [...document.querySelectorAll('main h3')]
      .map((heading) => heading.closest('.relative.isolate.group')).filter(Boolean);
    const missing = wrappers.some((wrapper) => !collectionForWrapper(wrapper));
    const resource = missing ? latestPageResource('/api/my-collection') : '';
    if (missing && resource && resource !== lastCollectionFallbackResource && !collectionFallbackScheduled) {
      collectionFallbackScheduled = true;
      setTimeout(() => {
        collectionFallbackScheduled = false;
        if (location.pathname === '/collection' &&
            wrappers.some((wrapper) => wrapper.isConnected && !collectionForWrapper(wrapper))) {
          lastCollectionFallbackResource = resource;
          window.dispatchEvent(new CustomEvent('wmma-collection-request'));
        }
      }, 500);
    }
    for (const wrapper of observedCollectionCards) {
      if (!wrapper.isConnected) {
        visibleCollectionCards.unobserve(wrapper);
        observedCollectionCards.delete(wrapper);
        intersectingCollectionCards.delete(wrapper);
      }
    }
    for (const wrapper of wrappers) {
      renderCollectionCard(wrapper);
      const card = collectionForWrapper(wrapper);
      if (card && intersectingCollectionCards.has(wrapper)) queuePrice(card.cardId);
      if (!observedCollectionCards.has(wrapper)) {
        observedCollectionCards.add(wrapper);
        visibleCollectionCards.observe(wrapper);
      }
    }
  }

  function syncListingCards() {
    if (location.pathname !== '/marketplace') return;
    const wrappers = document.querySelectorAll('[id^="marketplace-auction-"]');
    const missing = [...wrappers].some((wrapper) => !listings.has(wrapper.id.slice('marketplace-auction-'.length)));
    const resource = missing ? latestPageResource('/api/marketplace') : '';
    if (missing && resource && resource !== lastListingFallbackResource && !listingFallbackScheduled) {
      listingFallbackScheduled = true;
      setTimeout(() => {
        listingFallbackScheduled = false;
        if (location.pathname === '/marketplace' &&
            [...wrappers].some((wrapper) => wrapper.isConnected &&
              !listings.has(wrapper.id.slice('marketplace-auction-'.length)))) {
          lastListingFallbackResource = resource;
          window.dispatchEvent(new CustomEvent('wmma-list-request'));
        }
      }, 500);
    }
    for (const wrapper of observedCards) {
      if (!wrapper.isConnected) {
        visibleCards.unobserve(wrapper);
        observedCards.delete(wrapper);
        intersectingCards.delete(wrapper);
      }
    }
    for (const wrapper of wrappers) {
      renderCard(wrapper);
      const auction = listings.get(wrapper.id.slice('marketplace-auction-'.length));
      if (auction && intersectingCards.has(wrapper)) {
        queuePrice(auction.cardId);
      }
      if (!observedCards.has(wrapper)) {
        observedCards.add(wrapper);
        visibleCards.observe(wrapper);
      }
    }
  }

  function detailId() {
    const match = /^\/marketplace\/([0-9a-f-]{36})$/i.exec(location.pathname);
    return match?.[1] || null;
  }

  function detailPriceFrame() {
    return [...document.querySelectorAll('main .card-frame')].find((frame) =>
      [...frame.querySelectorAll('span')].some((span) =>
        /^(Mise actuelle|Mise de départ)$/.test(span.textContent.trim())));
  }

  function scheduleDetailFallback(id, delay) {
    if (detailFallbackId === id && (!detailFallbackTimer || detailFallbackDelay <= delay)) return;
    clearTimeout(detailFallbackTimer);
    detailFallbackId = id;
    detailFallbackDelay = delay;
    detailFallbackTimer = setTimeout(() => {
      detailFallbackTimer = null;
      if (detailId() === id && detailAuction?.id !== id) {
        window.dispatchEvent(new CustomEvent('wmma-detail-request', { detail: { auctionId: id } }));
      }
    }, delay);
  }

  function renderDetail() {
    const id = detailId();
    if (!id) {
      clearTimeout(detailFallbackTimer);
      detailFallbackTimer = null;
      detailFallbackId = null;
      detailFallbackDelay = Infinity;
      document.body?.classList.remove('wmma-has-detail-price');
      return;
    }
    if (!detailAuction || detailAuction.id !== id) {
      document.body?.classList.remove('wmma-has-detail-price');
      // Once the site has rendered its price block, its detail response has
      // normally arrived. Recover promptly if the initial fetch was missed.
      scheduleDetailFallback(id, detailPriceFrame() ? 500 : 10000);
      return;
    }
    clearTimeout(detailFallbackTimer);
    detailFallbackTimer = null;
    const frame = detailPriceFrame();
    if (!frame?.firstElementChild) {
      document.body?.classList.remove('wmma-has-detail-price');
      return;
    }
    const average = averageFor(detailAuction);
    const cache = readCache(detailAuction.cardId, true);
    let row = frame.querySelector('#wmma-detail-average');
    if (!row) {
      row = document.createElement('div');
      row.id = 'wmma-detail-average';
      row.innerHTML = '<span>Prix moyen</span><strong></strong>';
      frame.firstElementChild.after(row);
    }
    setPriceText(row.querySelector('strong'), average, cache, '', 'Indisponible', 'Erreur temporaire');
    document.body.classList.add('wmma-has-detail-price');
  }

  function sync() {
    syncScheduled = false;
    if (location.pathname !== lastPath) {
      if (lastPath === '/marketplace') {
        const auction = listings.get(detailId());
        clearQueuedPrices();
        if (auction) {
          detailAuction = auction;
          queuePrice(auction.cardId);
        }
        listings.clear();
        listingFallbackScheduled = false;
        lastListingFallbackResource = '';
      }
      if (lastPath === '/collection') {
        collectionByTitle.clear();
        collectionFallbackScheduled = false;
        lastCollectionFallbackResource = '';
      }
      lastPath = location.pathname;
    }
    syncListingCards();
    syncCollectionCards();
    renderDetail();
  }

  function scheduleSync() {
    if (syncScheduled) return;
    syncScheduled = true;
    requestAnimationFrame(sync);
  }

  window.addEventListener('wmma-listings', (event) => {
    if (location.pathname !== '/marketplace') return;
    const detail = event.detail || {};
    if (detail.reset || detail.queryKey !== queryKey) {
      queryKey = detail.queryKey || '';
      listings.clear();
      clearQueuedPrices();
    }
    for (const auction of detail.auctions || []) listings.set(auction.id, auction);
    scheduleSync();
  });

  window.addEventListener('wmma-collection', (event) => {
    if (location.pathname !== '/collection') return;
    const detail = event.detail || {};
    if (detail.reset || detail.queryKey !== collectionQueryKey) {
      collectionQueryKey = detail.queryKey || '';
      collectionByTitle.clear();
      clearQueuedPrices();
    }
    for (const card of detail.cards || []) {
      const previous = collectionByTitle.get(card.title);
      if (previous && (previous.cardId !== card.cardId || previous.rarity !== card.rarity)) {
        collectionByTitle.set(card.title, null);
      } else if (!collectionByTitle.has(card.title)) {
        collectionByTitle.set(card.title, card);
      }
    }
    scheduleSync();
  });

  window.addEventListener('wmma-detail', (event) => {
    const auction = event.detail?.auction;
    if (!auction || auction.id !== detailId()) return;
    detailAuction = auction;
    clearQueuedPrices();
    queuePrice(auction.cardId);
    scheduleSync();
  });

  window.addEventListener('wmma-price-result', (event) => {
    const detail = event.detail || {};
    const cardId = pending.get(detail.requestId);
    if (!cardId) return;
    pending.delete(detail.requestId);
    pendingIds.delete(cardId);
    activeRequests = Math.max(0, activeRequests - 1);
    const previous = readCache(cardId, true);
    if (detail.ok) {
      saveCache(cardId, {
        ok: true, averages: detail.averages || {}, saleStats: detail.saleStats || {},
        fetchedAt: Date.now()
      });
    } else if (detail.status !== 429 && !previous?.ok) {
      saveCache(cardId, { ok: false, averages: {}, fetchedAt: Date.now() });
    }
    if (detail.status === 429) {
      cooldownUntil = Date.now() + (Number(detail.retryAfterMs) || 60_000);
      concurrency = Math.max(2, Math.floor(concurrency / 2));
      if (!queuedIds.has(cardId)) {
        queued.unshift(cardId);
        queuedIds.add(cardId);
      }
    }
    if (!detail.ok && detail.status !== 429 &&
        (!detail.status || detail.status >= 500) &&
        detailAuction?.cardId === cardId && !detailRetries.has(cardId)) {
      detailRetries.add(cardId);
      const auctionId = detailAuction.id;
      setTimeout(() => {
        if (detailId() === auctionId && detailAuction?.cardId === cardId) {
          queuePrice(cardId);
          renderDetail();
        }
      }, ERROR_TTL + 100);
    }
    for (const wrapper of observedCards) {
      const auction = listings.get(wrapper.id.slice('marketplace-auction-'.length));
      if (auction?.cardId === cardId && wrapper.isConnected) renderCard(wrapper);
    }
    for (const wrapper of observedCollectionCards) {
      if (collectionForWrapper(wrapper)?.cardId === cardId && wrapper.isConnected) renderCollectionCard(wrapper);
    }
    if (detailAuction?.cardId === cardId) renderDetail();
    pumpQueue();
  });

  window.addEventListener('wmma-bid-observed', (event) => {
    const observation = event.detail || {};
    if (!Number.isFinite(observation.startedAt) || !Number.isFinite(observation.durationMs)) return;
    const leadMs = detailAuction?.id === observation.auctionId && detailAuction.endAt
      ? Date.parse(detailAuction.endAt) - observation.startedAt : null;
    const sample = {
      hourUtc: new Date(Math.floor(observation.startedAt / 3600000) * 3600000).toISOString(),
      durationMs: Math.max(0, Math.round(observation.durationMs)),
      outcome: observation.accepted ? 'accepted' :
        observation.code === 'bid_too_low' ? 'bid_too_low' :
          observation.code === 'insufficient_balance' ? 'insufficient_balance' :
            observation.status == null ? 'network_error' : 'rejected',
      leadSeconds: Number.isFinite(leadMs) && leadMs >= -120000 && leadMs < 86400000
        ? Math.round(leadMs / 1000) : null
    };
    try {
      const samples = JSON.parse(localStorage.getItem(BID_SAMPLES_KEY) || '[]');
      const recent = Array.isArray(samples) ? samples.filter((entry) =>
        Date.parse(entry.hourUtc) > Date.now() - 30 * 24 * 3600000) : [];
      recent.push(sample);
      localStorage.setItem(BID_SAMPLES_KEY, JSON.stringify(recent.slice(-500)));
    } catch {}
  });

  function start() {
    if (!document.body) return requestAnimationFrame(start);
    new MutationObserver((mutations) => {
      if (mutations.some(({ addedNodes, removedNodes }) =>
        [...addedNodes, ...removedNodes].some((node) =>
          node.nodeType === 1 &&
          !node.closest?.('.wmma-average, .wmma-collection-average, #wmma-detail-average') &&
          (node.matches?.('[id^="marketplace-auction-"], main, .card-frame, .relative.isolate.group') ||
            node.querySelector?.('[id^="marketplace-auction-"], .card-frame, .relative.isolate.group'))))) scheduleSync();
    }).observe(document.body, { childList: true, subtree: true });
    scheduleSync();
    setTimeout(cleanupCache, 5000);
  }

  window.dispatchEvent(new CustomEvent('wmma-content-ready'));
  start();
})();
