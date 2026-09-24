'use strict';

const fs = require('node:fs');
const path = require('node:path');

const exclusionsPath = path.join(__dirname, 'exclusions.local.txt');
const normalizeName = (name) => String(name || '').normalize('NFKC')
  .replace(/\s+/g, ' ').trim().toLocaleLowerCase('fr');

function parseExclusions(text) {
  const names = new Set();
  const cardIds = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(line)) {
      cardIds.add(line.toLowerCase());
    } else names.add(normalizeName(line));
  }
  return { names, cardIds };
}

function loadExclusions() {
  // A missing or unreadable file must stop sales rather than silently removing protection.
  return parseExclusions(fs.readFileSync(exclusionsPath, 'utf8'));
}

function isExcluded(copy, cardId, exclusions) {
  const title = copy?.card?.wikipedia_title || copy?.card?.title ||
    copy?.card_title || copy?.snapshot_title;
  return exclusions.cardIds.has(String(cardId).toLowerCase()) ||
    (exclusions.names.size > 0 && (!title || exclusions.names.has(normalizeName(title))));
}

module.exports = { exclusionsPath, normalizeName, parseExclusions, loadExclusions, isExcluded };
