const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { BrowserBridge } = require('../automation/run.js');

const token = 'a'.repeat(64);

test('the local bridge accepts an authenticated extension and correlates responses', async () => {
  const bridge = new BrowserBridge({ port: 0, token });
  await once(bridge.server, 'listening');
  const port = bridge.server.address().port;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`, {
    headers: { Origin: 'chrome-extension://local-test' }
  });
  await once(socket, 'open');
  socket.on('message', (raw) => {
    const message = JSON.parse(raw);
    if (message.type === 'rpc') socket.send(JSON.stringify({
      type: 'rpc-result', id: message.id,
      result: { ok: true, status: 200, data: { balance: 123 } }
    }));
  });
  const result = await bridge.request('/api/wikibidous', { method: 'GET' });
  assert.deepEqual(result, { ok: true, status: 200, data: { balance: 123 } });
  socket.close();
  await bridge.close();
});

test('the local bridge rejects a connection without the token', async () => {
  const bridge = new BrowserBridge({ port: 0, token });
  await once(bridge.server, 'listening');
  const port = bridge.server.address().port;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=invalid`, {
    headers: { Origin: 'chrome-extension://local-test' }
  });
  const status = await new Promise((resolve) => {
    socket.on('error', () => {});
    socket.on('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
  });
  assert.equal(status, 401);
  await bridge.close();
});
