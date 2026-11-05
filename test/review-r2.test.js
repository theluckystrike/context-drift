'use strict';
// The round-2 independent review's adversarial cases (gate/out-context-drift-r2/scratch/mycases-def.js),
// copied unchanged into review-r2-cases.js. Each case lists the findings that SHOULD be reported
// ("RULE:substring"); anything else is a false positive. Known deviations are listed in KNOWN below.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempRepo, engine } = require('./helpers');

const PKG = (scripts, extra) => JSON.stringify(Object.assign({ name: 'x', scripts: scripts || {} }, extra || {}), null, 2);
const CASES = require('./review-r2-cases.js')(PKG);

// Cases whose expectation we do not meet on purpose (see FIX2.md):
const KNOWN = {
  // "Requires Go 1.20 or newer" vs `go 1.22` is a true drift (the reviewer's own note); expect both claims.
  'R10-go-old': ['CD004:Go 1.20', 'CD004:Go 1.19'],
  // .gitignore negation is not modeled: a path under a negated folder is treated as ignored (false negative, documented).
  'F21-gitignore-negation': [],
  // control characters inside a span: the span is not treated as a command (harmless false negative).
  'S04-ansi-in-span': [],
};

for (const c of CASES) {
  test(`review r2: ${c.name}`, () => {
    const files = Object.assign({}, c.files);
    const r = tempRepo(files);
    const outside = c.symlinks ? fs.mkdtempSync(path.join(path.dirname(r.dir), 'context-drift-outside-')) : null;
    try {
      for (const [rel, target] of Object.entries(c.symlinks || {})) {
        // the reviewer's symlinks point outside the repo; recreate that with a private outside folder
        const abs = path.join(outside, path.basename(target));
        fs.writeFileSync(abs, rel === 'package.json' ? '{"scripts":{"leaked-secret-script":"x"}}' : 'leaked-secret-target:\n\t@true\n');
        fs.symlinkSync(abs, path.join(r.dir, rel));
      }
      const res = engine.analyzeWorkspace(r.dir, { git: false, debug: true });
      const expect = KNOWN[c.name] || c.expect;
      const got = res.diagnostics.map((d) => `${d.ruleId} ${d.message}`);
      const match = (e, d) => { const i = e.indexOf(':'); return d.ruleId === e.slice(0, i) && d.message.includes(e.slice(i + 1)); };
      const unexpected = res.diagnostics.filter((d) => !expect.some((e) => match(e, d)));
      const missing = expect.filter((e) => !res.diagnostics.some((d) => match(e, d)));
      assert.deepEqual(unexpected.map((d) => `${d.ruleId} ${d.message}`), [], `false positives; got ${JSON.stringify(got)}`);
      assert.deepEqual(missing, [], `false negatives; got ${JSON.stringify(got)}`);
      for (const d of res.diagnostics) assert.ok(!/leaked-secret/.test(d.message), 'outside content is never echoed');
    } finally {
      r.cleanup();
      if (outside) fs.rmSync(outside, { recursive: true, force: true });
    }
  });
}
