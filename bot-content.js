'use strict';

const pending = new Map();

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== location.origin ||
      event.data?.source !== 'wmma-bot-page' || event.data?.type !== 'api-response') return;
  const id = event.data.id;
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  clearTimeout(entry.timer);
  entry.reply(event.data.result);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'wmma-bot-rpc' || !Number.isInteger(message.id)) return;
  const timer = setTimeout(() => {
    pending.delete(message.id);
    sendResponse({ transportError: 'page_timeout' });
  }, message.init?.method === 'POST' ? 15000 : 25000);
  pending.set(message.id, { timer, reply: sendResponse });
  window.postMessage({ source: 'wmma-bot-extension', type: 'api-request',
    id: message.id, path: message.path, init: message.init }, location.origin);
  return true;
});
