const test = require('node:test');
const assert = require('node:assert/strict');
const { createApiClient } = require('../automation/api-client.js');

const auctionId = '22222222-2222-4222-8222-222222222222';
const copyId = '33333333-3333-4333-8333-333333333333';

test('the API client is read-only unless writes are explicitly enabled', async () => {
  const calls = [];
  const fetchFn = async (path, init) => {
    calls.push({ path, init });
    return { ok: true, status: 200, json: async () => ({ balance: 100 }) };
  };
  const client = createApiClient(fetchFn);
  await client.getBalance();
  assert.equal(calls[0].path, '/api/wikibidous');
  assert.throws(() => client.placeBid(auctionId, 100), /Writes are disabled/);
  assert.throws(() => client.createListing(copyId, 900), /Writes are disabled/);
  assert.equal(calls.length, 1);
});

test('bid and listing requests have the contract used by the site UI', async () => {
  const calls = [];
  const client = createApiClient(async (path, init) => {
    calls.push({ path, init });
    return { ok: true, status: 200, json: async () => ({}) };
  }, { writesEnabled: true });
  await client.placeBid(auctionId, 700);
  await client.createListing(copyId, 950);
  assert.equal(calls[0].path, `/api/marketplace/${auctionId}/bid`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { amount: 700 });
  assert.equal(calls[1].path, '/api/marketplace');
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    card_id: copyId, base_amount: 950, duration_minutes: 10
  });
});

test('bids can be disabled while listings remain enabled', async () => {
  const calls = [];
  const client = createApiClient(async (path, init) => {
    calls.push({ path, init });
    return { ok: true, status: 200, json: async () => ({}) };
  }, { writesEnabled: true, bidsEnabled: false });
  assert.throws(() => client.placeBid(auctionId, 700), /Bids are disabled/);
  await client.createListing(copyId, 950);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/marketplace');
});
