(() => {
  if (window.__wmmaBridge) return;
  window.__wmmaBridge = true;

  const originalFetch = window.fetch.bind(window);
  const model = window.WMMAModel;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let lastQueryKey = '';
  let lastCollectionQueryKey = '';
  let savedBrowse = null;
  try {
    savedBrowse = JSON.parse(sessionStorage.getItem('marketplace_list_v3') || 'null');
  } catch {}

  function parseUrl(input) {
    try {
      const url = new URL(typeof input === 'string' ? input : input?.url || input?.href, location.origin);
      return url.origin === location.origin ? url : null;
    } catch {
      return null;
    }
  }

  function listingUrl(input) {
    const url = parseUrl(input);
    return url?.pathname === '/api/marketplace' ? url : null;
  }

  function collectionUrl(input) {
    const url = parseUrl(input);
    return url?.pathname === '/api/my-collection' ? url : null;
  }

  function detailUrl(input) {
    const url = parseUrl(input);
    return url && UUID.test(url.pathname.split('/')[3] || '') &&
      url.pathname.split('/').length === 4 && url.pathname.startsWith('/api/marketplace/') ? url : null;
  }

  function bidUrl(input) {
    const url = parseUrl(input);
    const parts = url?.pathname.split('/') || [];
    return parts.length === 5 && parts[1] === 'api' && parts[2] === 'marketplace' &&
      UUID.test(parts[3]) && parts[4] === 'bid' ? url : null;
  }

  function queryKey(params) {
    const copy = new URLSearchParams(params);
    copy.delete('page');
    copy.delete('mine');
    copy.sort();
    return copy.toString();
  }

  function emitListings(json, url) {
    if (!Array.isArray(json?.auctions)) return;
    const params = url.searchParams;
    // The site also requests limit=1 to refresh account counters. That is not
    // the browsed page and must not reset our analysis.
    if ((Number(params.get('limit')) || 0) < 20) return;
    const key = queryKey(params);
    const page = Math.max(1, Number(params.get('page')) || 1);
    const reset = key !== lastQueryKey || page === 1;
    if (reset) lastQueryKey = key;

    window.dispatchEvent(new CustomEvent('wmma-listings', {
      detail: {
        queryKey: key,
        reset,
        page,
        auctions: json.auctions.map(model.normalizeAuction).filter(Boolean),
        total: Number(json.total) || 0
      }
    }));
  }

  function emitDetail(json) {
    const auction = model.normalizeAuction(json?.auction || json);
    if (auction) window.dispatchEvent(new CustomEvent('wmma-detail', { detail: { auction } }));
  }

  function emitCollection(json, url) {
    if (!Array.isArray(json?.collection)) return;
    const params = url.searchParams;
    const key = queryKey(params);
    const page = Math.max(0, Number(params.get('page')) || 0);
    const reset = key !== lastCollectionQueryKey || page === 0;
    if (reset) lastCollectionQueryKey = key;
    const cards = json.collection.map((copy) => ({
      cardId: String(copy.card_id || copy.card?.id || ''),
      title: String(copy.card?.wikipedia_title || ''),
      rarity: String(copy.card?.rarity || '')
    })).filter((card) => UUID.test(card.cardId) && card.title && card.rarity);
    window.dispatchEvent(new CustomEvent('wmma-collection', {
      detail: { queryKey: key, reset, cards }
    }));
  }

  function latestResource(pathname) {
    const entries = performance.getEntriesByType('resource');
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const url = parseUrl(entries[index].name);
      if (pathname === '/api/marketplace' && (Number(url?.searchParams.get('limit')) || 0) < 20) continue;
      if (url?.pathname === pathname) return url;
    }
    return null;
  }

  async function recoverList(pathname, emit) {
    const url = latestResource(pathname);
    if (!url) return;
    try {
      const response = await originalFetch(url.pathname + url.search, {
        method: 'GET', credentials: 'include', headers: { accept: 'application/json' }
      });
      if (response.ok) emit(await response.json(), url);
    } catch {}
  }

  window.fetch = (...args) => {
    const method = String(args[1]?.method || args[0]?.method || 'GET').toUpperCase();
    const bid = method === 'POST' ? bidUrl(args[0]) : null;
    const bidStartedAt = bid ? Date.now() : null;
    const bidStartedPerf = bid ? performance.now() : null;
    const promise = originalFetch(...args);
    const url = listingUrl(args[0]);
    const detail = detailUrl(args[0]);
    const collection = collectionUrl(args[0]);
    if (bid) {
      const report = (response, code = null) => {
        window.dispatchEvent(new CustomEvent('wmma-bid-observed', {
          detail: {
            auctionId: bid.pathname.split('/')[3],
            startedAt: bidStartedAt,
            durationMs: Math.round(performance.now() - bidStartedPerf),
            status: response?.status || null,
            accepted: Boolean(response?.ok),
            code: ['bid_too_low', 'insufficient_balance'].includes(code) ? code : null
          }
        }));
      };
      promise.then((response) => {
        response.clone().json().then((json) => report(response, json?.code)).catch(() => report(response));
      }).catch(() => report(null));
    }
    if (url && method === 'GET') {
      promise.then((response) => {
        if (response.ok) response.clone().json().then((json) => emitListings(json, url)).catch(() => {});
      }).catch(() => {});
    }
    if (detail && method === 'GET') {
      promise.then((response) => {
        if (response.ok) response.clone().json().then(emitDetail).catch(() => {});
      }).catch(() => {});
    }
    if (collection && method === 'GET') {
      promise.then((response) => {
        if (response.ok) response.clone().json().then((json) => emitCollection(json, collection)).catch(() => {});
      }).catch(() => {});
    }
    return promise;
  };

  window.addEventListener('wmma-list-request', () => recoverList('/api/marketplace', emitListings));
  window.addEventListener('wmma-collection-request', () => recoverList('/api/my-collection', emitCollection));

  function sendBotResult(id, result) {
    window.dispatchEvent(new CustomEvent('wmma-bot-api-response', {
      detail: { id, result }
    }));
    window.postMessage?.({ source: 'wmma-bot-page', type: 'api-response', id, result },
      location.origin);
  }

  async function handleBotRequest(request) {
    const { id, path, init } = request || {};
    if (!Number.isInteger(id) || typeof path !== 'string') return;
    const method = String(init?.method || 'GET').toUpperCase();
    const url = parseUrl(path);
    const pathname = url?.pathname || '';
    const readAllowed = method === 'GET' && (
      pathname === '/api/marketplace' || pathname === '/api/my-collection' ||
      pathname === '/api/wikibidous' ||
      /^\/api\/marketplace\/[0-9a-f-]{36}$/i.test(pathname) ||
      /^\/api\/marketplace\/cards\/[0-9a-f-]{36}\/sales$/i.test(pathname)
    );
    let bidAllowed = false;
    if (method === 'POST' && bidUrl(path)) {
      try {
        const body = JSON.parse(init?.body || '{}');
        bidAllowed = Number.isInteger(body.amount) && body.amount > 0;
      } catch {}
    }
    let listingAllowed = false;
    if (method === 'POST' && pathname === '/api/marketplace') {
      try {
        const body = JSON.parse(init?.body || '{}');
        listingAllowed = UUID.test(body.card_id) && Number.isInteger(body.base_amount) &&
          body.base_amount > 0 && body.duration_minutes === 10;
      } catch {}
    }
    if (!readAllowed && !bidAllowed && !listingAllowed) {
      sendBotResult(id, { transportError: 'disallowed_request' });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), method === 'POST' ? 12000 : 20000);
    let result;
    try {
      const response = await originalFetch(path, { ...init, signal: controller.signal,
        credentials: 'include', cache: 'no-store' });
      const retryAfter = Number(response.headers?.get('retry-after'));
      result = { ok: response.ok, status: response.status,
        data: await response.json().catch(() => null),
        retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ?
          Math.min(120000, retryAfter * 1000) : null };
    } catch {
      result = { transportError: 'network_error' };
    } finally { clearTimeout(timer); }
    sendBotResult(id, result);
  }

  window.addEventListener('wmma-bot-api-request', (event) => handleBotRequest(event.detail));
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin ||
        event.data?.source !== 'wmma-bot-extension' || event.data?.type !== 'api-request') return;
    handleBotRequest(event.data);
  });

  window.addEventListener('wmma-detail-request', async (event) => {
    const auctionId = event.detail?.auctionId;
    if (!UUID.test(String(auctionId))) return;
    try {
      const response = await originalFetch('/api/marketplace/' + encodeURIComponent(auctionId), {
        method: 'GET', credentials: 'include', headers: { accept: 'application/json' }
      });
      if (response.ok) emitDetail(await response.json());
    } catch {}
  });

  window.addEventListener('wmma-price-request', async (event) => {
    const { cardId, requestId } = event.detail || {};
    if (!UUID.test(String(cardId)) || !requestId) return;
    try {
      const response = await originalFetch(
        `/api/marketplace/cards/${encodeURIComponent(cardId)}/sales?scope=summary`,
        { method: 'GET', credentials: 'include', headers: { accept: 'application/json' } }
      );
      if (!response.ok) {
        let retryAfterMs = 60_000;
        const seconds = Number(response.headers.get('retry-after'));
        if (Number.isFinite(seconds) && seconds > 0) retryAfterMs = seconds * 1000;
        throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status, retryAfterMs });
      }
      const json = await response.json();
      const averages = {};
      const saleStats = {};
      for (const [rarity, summary] of Object.entries(json?.summary || {})) {
        const average = Number(summary?.average);
        if (Number.isFinite(average) && average > 0) {
          averages[rarity] = average;
          const count = Number(summary?.count);
          if (Number.isInteger(count) && count >= 0) {
            saleStats[rarity] = { count, average };
          }
        }
      }
      window.dispatchEvent(new CustomEvent('wmma-price-result', {
        detail: { requestId, cardId, ok: true, averages, saleStats }
      }));
    } catch (error) {
      window.dispatchEvent(new CustomEvent('wmma-price-result', {
        detail: {
          requestId, cardId, ok: false,
          status: error?.status || null,
          retryAfterMs: error?.retryAfterMs || 60_000
        }
      }));
    }
  });

  window.addEventListener('wmma-content-ready', () => {
    if (!Array.isArray(savedBrowse?.browse) || !savedBrowse.browse.length) return;
    const params = new URLSearchParams({
      page: '1', limit: '50', sort: savedBrowse.sort || 'recent'
    });
    if (savedBrowse.submittedSearch) params.set('q', savedBrowse.submittedSearch);
    for (const rarity of savedBrowse.rarityFilter || []) params.append('rarity', rarity);
    const url = new URL(`/api/marketplace?${params}`, location.origin);
    emitListings({
      auctions: savedBrowse.browse,
      total: savedBrowse.browseTotal,
      hasMore: savedBrowse.browseHasMore
    }, url);
    savedBrowse = null;
  });
})();
