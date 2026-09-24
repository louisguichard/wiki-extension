'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { planBid, planListing, recommendBidLead, bidLatencyByHour } = require('./strategy.js');

const inputPath = process.argv[2];
if (!inputPath) {
  process.stderr.write('Usage: node automation/simulate.js <scenario.json>\n');
  process.exit(2);
}

const scenario = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
const result = {
  bidTiming: recommendBidLead(scenario.bidSamples || []),
  hourlyLatency: bidLatencyByHour(scenario.bidSamples || []),
  bids: (scenario.auctions || []).map((auction) => ({
    label: auction.label || null,
    ...planBid({ ...scenario.bidBudget, ...auction })
  })),
  listings: (scenario.cards || []).map((card) => ({
    label: card.label || null,
    ...planListing({ ...scenario.listingLimits, ...card })
  }))
};
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
