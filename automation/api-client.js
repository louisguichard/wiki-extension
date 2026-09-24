'use strict';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createApiClient(fetchFn, { writesEnabled = false, bidsEnabled = writesEnabled } = {}) {
  if (typeof fetchFn !== 'function') throw new TypeError('fetchFn is required');

  async function request(path, init) {
    const response = await fetchFn(path, init);
    const data = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, data,
      retryAfterMs: response.retryAfterMs || null };
  }

  function requireWrites() {
    if (!writesEnabled) throw new Error('Writes are disabled');
  }

  return {
    getAuction(id) {
      if (!UUID.test(id)) throw new TypeError('Invalid auction ID');
      return request(`/api/marketplace/${id}`, { method: 'GET', credentials: 'include' });
    },
    getBalance() {
      return request('/api/wikibidous', { method: 'GET', credentials: 'include' });
    },
    getMine() {
      return request('/api/marketplace?page=1&limit=50&sort=recent&mine=1', {
        method: 'GET', credentials: 'include'
      });
    },
    getMarketPage(page = 1, limit = 50) {
      if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 50) {
        throw new TypeError('Invalid market page');
      }
      return request(`/api/marketplace?page=${page}&limit=${limit}&sort=ending_soon`, {
        method: 'GET', credentials: 'include'
      });
    },
    getSalesSummary(cardId) {
      if (!UUID.test(cardId)) throw new TypeError('Invalid card ID');
      return request(`/api/marketplace/cards/${cardId}/sales?scope=summary`, {
        method: 'GET', credentials: 'include'
      });
    },
    getCollection(page = 0) {
      if (!Number.isInteger(page) || page < 0) throw new TypeError('Invalid collection page');
      return request(`/api/my-collection?sort=rarity&page=${page}&stats=0`, {
        method: 'GET', credentials: 'include'
      });
    },
    placeBid(id, amount) {
      requireWrites();
      if (!bidsEnabled) throw new Error('Bids are disabled');
      if (!UUID.test(id) || !Number.isInteger(amount) || amount < 1) {
        throw new TypeError('Invalid bid');
      }
      return request(`/api/marketplace/${id}/bid`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount })
      });
    },
    createListing(userCardId, baseAmount, durationMinutes = 10) {
      requireWrites();
      if (!UUID.test(userCardId) || !Number.isInteger(baseAmount) || baseAmount < 1 ||
          durationMinutes !== 10) {
        throw new TypeError('Invalid listing');
      }
      return request('/api/marketplace', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ card_id: userCardId, base_amount: baseAmount, duration_minutes: 10 })
      });
    }
  };
}

module.exports = { createApiClient };
