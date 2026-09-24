const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('the extension overlay loads without a local bot token', () => {
  let connections = 0;
  const chrome = {
    runtime: { onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
    alarms: { create() {}, onAlarm: { addListener() {} } }
  };
  class FakeWebSocket { constructor() { connections++; } }
  const context = vm.createContext({ chrome, WebSocket: FakeWebSocket,
    self: {}, importScripts() { throw new Error('missing token file'); } });
  assert.doesNotThrow(() => vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../bot-worker.js'), 'utf8'), context));
  assert.equal(connections, 0);
});

test('the bridge replaces an unresponsive tab and reuses the replacement', async () => {
  const tabs = new Map([[1, { id: 1, status: 'complete',
    url: 'https://www.wiki-masters.com/marketplace' }]]);
  const createdUrls = [];
  const messages = [];
  const chrome = {
    tabs: {
      query: async () => [...tabs.values()],
      get: async (id) => tabs.get(id),
      create: async ({ url }) => {
        createdUrls.push(url);
        const tab = { id: 2, url, status: 'complete' };
        tabs.set(2, tab);
        return tab;
      },
      sendMessage: async (id) => {
        messages.push(id);
        if (id === 1) throw new Error('old content script');
        return { ok: true, status: 200, data: {} };
      }
    },
    runtime: { onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
    alarms: { create() {}, onAlarm: { addListener() {} } }
  };
  class FakeWebSocket { constructor() {} }
  const context = vm.createContext({ chrome, WebSocket: FakeWebSocket,
    self: { WMMA_BOT_TOKEN: '0'.repeat(64) }, importScripts() {}, setTimeout,
    Date, Promise });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../bot-worker.js'), 'utf8'), context);
  const first = await vm.runInContext('sendToPage({ type: "test" })', context);
  const second = await vm.runInContext('sendToPage({ type: "test" })', context);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(createdUrls, ['https://www.wiki-masters.com/marketplace']);
  assert.deepEqual(messages, [1, 2, 2]);
});
