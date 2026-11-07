'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const S = require('../src/support.js');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const id = `${pkg.publisher}.${pkg.name}`;
const review = `https://marketplace.visualstudio.com/items?itemName=${id}&ssr=false#review-details`;

test('rate link: SELF_ID is this extension', () => {
  assert.equal(S.SELF_ID, id);
  assert.equal(S.reviewUrl(id), review);
  assert.equal(S.reviewUrl(''), '');
});

test('rate link: footer shows Rate after More free viewers and before Hide', () => {
  const html = S.footerHtml('x', true, '');
  assert.ok(html.includes(`<a href="${review}"`), html);
  const iMore = html.indexOf('More free viewers'), iRate = html.indexOf('>Rate<'), iHide = html.indexOf('>Hide<');
  assert.ok(iMore > 0 && iRate > iMore && iHide > iRate, html);
  assert.equal(S.footerHtml('x', false, ''), '', 'Hide setting removes the whole line, Rate too');
});

test('rate link: hover markdown has the Rate link', () => {
  assert.ok(S.footerMarkdown('x').endsWith(` · [Rate](${review})`));
});

test('rate link: a plain link, no new command and no prompt', () => {
  assert.deepEqual(Object.keys(S.commandIds('x')).sort(), ['more', 'sponsor']);
  assert.ok(!S.commandUris('x').some((c) => /rate/i.test(c)));
});
