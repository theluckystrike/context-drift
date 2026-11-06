'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
// The "More free viewers" list (QuickPick and README) puts live extensions first and, in each group,
// the extensions people use together with this one first. Pairs come from mon1-work/products.json.
const support = require('../src/support.js');

const SELF = 'zovo.context-drift';

test('More free viewers lists live extensions first, once each, without this one', () => {
  const list = support.otherProducts(SELF);
  assert.ok(list.length >= 25);
  assert.ok(list.every((p) => p.id !== SELF));
  assert.equal(new Set(list.map((p) => p.id)).size, list.length);
  const firstQueued = list.findIndex((p) => !p.live);
  assert.ok(firstQueued > 0);
  assert.ok(list.slice(firstQueued).every((p) => !p.live));
});

test('More free viewers puts the closest pairs first in each group', () => {
  const list = support.otherProducts(SELF);
  for (const live of [true, false]) {
    const w = list.filter((p) => p.live === live).map((p) => support.pairWeight(SELF, p.id));
    for (let i = 1; i < w.length; i++) assert.ok(w[i - 1] >= w[i], `${live ? 'live' : 'queued'} row ${i} is out of order`);
  }
  assert.equal(list[0].id, 'zovo.skill-shelf');
});
