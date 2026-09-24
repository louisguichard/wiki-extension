'use strict';

try { importScripts('bot-token.js'); } catch {} // The price overlay also works without the bot.

const SOCKET_URL = /^[0-9a-f]{64}$/.test(self.WMMA_BOT_TOKEN || '') ?
  `ws://127.0.0.1:17887/?token=${self.WMMA_BOT_TOKEN}` : null;
const BOT_URL = 'https://www.wiki-masters.com/marketplace';
let socket = null;
let connecting = false;
let botTabId = null;
let tabPromise = null;
let recoveryPromise = null;
let lastRecoveryAt = 0;

async function findTab() {
  if (botTabId != null) {
    try {
      const current = await chrome.tabs.get(botTabId);
      if (current.url?.startsWith('https://www.wiki-masters.com/')) return current;
    } catch {}
    botTabId = null;
  }
  let tabs = await chrome.tabs.query({ url: 'https://www.wiki-masters.com/*' });
  let tab = tabs.find((candidate) => candidate.url?.includes('wmma_bot=1')) ||
    tabs.find((candidate) => candidate.url?.startsWith(BOT_URL)) || tabs[0];
  if (!tab) {
    const created = await chrome.tabs.create({
      url: BOT_URL, active: false
    });
    tab = created;
  }
  botTabId = tab.id;
  for (let attempt = 0; attempt < 10; attempt++) {
    const current = await chrome.tabs.get(tab.id);
    if (current.status === 'complete') return current;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return tab;
}

async function chooseTab() {
  tabPromise ||= findTab().finally(() => { tabPromise = null; });
  return tabPromise;
}

async function recoverTab(failedId) {
  if (botTabId !== failedId) return;
  if (Date.now() - lastRecoveryAt < 5 * 60000) throw new Error('bot_page_unavailable');
  recoveryPromise ||= (async () => {
    lastRecoveryAt = Date.now();
    const tab = await chrome.tabs.create({ url: BOT_URL, active: false });
    for (let attempt = 0; attempt < 10; attempt++) {
      const current = await chrome.tabs.get(tab.id);
      if (current.status === 'complete') {
        botTabId = tab.id;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    botTabId = tab.id;
  })().finally(() => { recoveryPromise = null; });
  return recoveryPromise;
}

async function sendToPage(message) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const tab = await chooseTab();
    try { return await chrome.tabs.sendMessage(tab.id, message); }
    catch {
      if (attempt === 0) await recoverTab(tab.id);
    }
  }
  throw new Error('bot_page_unavailable');
}

function connect() {
  if (!SOCKET_URL || connecting || socket?.readyState === WebSocket.OPEN ||
      socket?.readyState === WebSocket.CONNECTING) return;
  connecting = true;
  try { socket = new WebSocket(SOCKET_URL); }
  catch { connecting = false; return; }
  socket.onopen = async () => {
    connecting = false;
    try { await chooseTab(); } catch {}
    socket.send(JSON.stringify({ type: 'ready' }));
  };
  socket.onmessage = async ({ data }) => {
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message.type === 'ping') {
      socket.send(JSON.stringify({ type: 'pong' }));
      return;
    }
    if (message.type !== 'rpc' || !Number.isInteger(message.id)) return;
    try {
      const result = await sendToPage({ type: 'wmma-bot-rpc',
        id: message.id, path: message.path, init: message.init });
      socket.send(JSON.stringify({ type: 'rpc-result', id: message.id, result }));
    } catch {
      socket.send(JSON.stringify({ type: 'rpc-error', id: message.id,
        reason: 'page_unavailable' }));
    }
  };
  socket.onclose = () => { connecting = false; socket = null; };
  socket.onerror = () => {};
}

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.create('wmma-bot-connect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'wmma-bot-connect') connect();
});
connect();
