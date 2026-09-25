'use strict';

const path = require('node:path');
const { ARMS, SaleStudy, reportRows, summarize } = require('./sale-study.js');

const file = path.resolve(__dirname, '..', '.wmma-bot', 'sales-study.jsonl');
const rows = reportRows(new SaleStudy(file).records);
const experiment = rows.filter((row) => row.cohort === 'experiment');
const historical = rows.filter((row) => row.cohort !== 'experiment');

function groupBy(items, key) {
  const groups = new Map();
  for (const item of items) {
    const value = key(item);
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(item);
  }
  return groups;
}

function line(label, items) {
  const stats = summarize(items);
  const rate = stats.saleRate == null ? '—' : `${(stats.saleRate * 100).toLocaleString(
    'fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
  return `${label.padEnd(20)} ${String(stats.sold).padStart(3)}/${String(
    stats.sold + stats.unsold).padEnd(3)} vendues, ${String(stats.active).padStart(2)} en cours, ` +
    `taux ${rate.padStart(6)}, revenu net/enchère terminée ${
      stats.netPerListing == null ? '—' : `${stats.netPerListing} W`}`;
}

function cardFamily(row) {
  const category = String(row.category || '').toLocaleLowerCase('fr');
  if (category.includes('footballeur')) return 'Joueurs de foot';
  if (category.includes('homme politique') || category.includes("homme d'état") ||
      category.includes('femme politique')) return 'Politique';
  if (category.startsWith('pays ') || category.startsWith('état souverain')) return 'Pays';
  if (/acteur|actrice/.test(category)) return 'Acteurs';
  if (category.includes("championnat d'europe de football")) return 'Compétition de foot';
  if (/série télévisée|émission|romanesque/.test(category)) return 'TV et fiction';
  return 'Autres';
}

console.log(`Suivi des ventes WikiMasters — ${new Date().toLocaleString('fr-FR', {
  timeZone: 'Europe/Paris' })}`);
console.log(`Enchères observées : ${rows.length} (${historical.length} hors test, ` +
  `${experiment.length} avec prix assigné).`);
console.log('');
console.log('Test des prix de départ (0 %, -5 %, -10 %, -15 %, -20 %) :');
for (const arm of ARMS) console.log(line(`${Math.round(arm * 100)} % de remise`,
  experiment.filter((row) => row.targetDiscount === arm)));
console.log('');
console.log(line('Hors test', historical));
console.log('Remises historiques approximatives :');
for (const [label, lower, upper] of [['0 à <5 %', 0, 0.05],
  ['5 à <10 %', 0.05, 0.10], ['10 à <15 %', 0.10, 0.15],
  ['15 à 20 %', 0.15, 0.205]]) {
  console.log(line(label, historical.filter((row) =>
    row.observedDiscount >= lower && row.observedDiscount < upper)));
}
console.log('');
console.log('Cartes avec au moins 3 enchères terminées (taux décroissant) :');
const cards = [...groupBy(rows, (row) => row.cardId || row.title || '?')].filter(([, items]) =>
  summarize(items).sold + summarize(items).unsold >= 3).sort((a, b) =>
    (summarize(b[1]).saleRate - summarize(a[1]).saleRate) ||
    (summarize(b[1]).sold + summarize(b[1]).unsold) -
    (summarize(a[1]).sold + summarize(a[1]).unsold));
for (const [, items] of cards.slice(0, 20)) console.log(line(
  (items[0].title || items[0].cardId || '?').slice(0, 20), items));
if (!cards.length) console.log('Pas encore assez de répétitions par carte.');
console.log('');
console.log('Par valeur moyenne (toutes les enchères avec référence disponible) :');
const bands = [
  ['< 1 000 W', (x) => x < 1000],
  ['1 000–1 999 W', (x) => x >= 1000 && x < 2000],
  ['2 000–4 999 W', (x) => x >= 2000 && x < 5000],
  ['5 000–9 999 W', (x) => x >= 5000 && x < 10000],
  ['≥ 10 000 W', (x) => x >= 10000]
];
for (const [label, includes] of bands) console.log(line(label,
  rows.filter((row) => row.average > 0 && includes(row.average))));
console.log('');
console.log('Par famille de cartes (regroupement indicatif des descriptions WikiMasters) :');
for (const [label, items] of groupBy(rows, cardFamily)) {
  const models = new Set(items.map((row) => row.cardId)).size;
  console.log(`${line(label, items)}, ${models} modèle${models === 1 ? '' : 's'}`);
}
console.log('');
console.log('Par rareté et brillant :');
for (const [label, items] of groupBy(rows, (row) =>
  `${row.rarity || '?'}${row.shiny ? ' brillant' : ''}`)) {
  console.log(line(label, items));
}
console.log('');
console.log('Le taux utilise seulement les enchères terminées. Une vente rapporte ' +
  'ici 80 % du prix final après les frais supposés. Les références antérieures ' +
  'au test sont reconstruites avec un prix moyen possiblement plus récent. ' +
  'Chaque reliste de dix minutes compte comme une enchère distincte.');
