const test = require('node:test');
const assert = require('node:assert/strict');
const { RequestPacer } = require('../automation/run.js');

test('spaces requests and serves urgent requests before queued price lookups', async () => {
  const pacer = new RequestPacer({ gapMs: 20 });
  const calls = [];
  const queue = (name, priority) => pacer.request(priority, async () => {
    calls.push({ name, at: Date.now() });
    return name;
  });
  await Promise.all([queue('first', 0), queue('price', 0), queue('bid', 3)]);
  assert.deepEqual(calls.map((call) => call.name), ['first', 'bid', 'price']);
  assert.ok(calls[1].at - calls[0].at >= 15);
  assert.ok(calls[2].at - calls[1].at >= 15);
});

test('keeps a lane free for urgent checks while two price reads are slow', async () => {
  const pacer = new RequestPacer({ gapMs: 10 });
  const started = [];
  const releases = [];
  const slow = (name) => pacer.request(0, () => new Promise((resolve) => {
    started.push(name);
    releases.push(resolve);
  }));
  const first = slow('first');
  const second = slow('second');
  const third = slow('third');
  const urgent = pacer.request(2, async () => { started.push('urgent'); });
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.deepEqual(started, ['first', 'urgent', 'second']);
  releases[0]();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(started[3], 'third');
  releases[1]();
  releases[2]();
  await Promise.all([first, second, third, urgent]);
});
