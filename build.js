#!/usr/bin/env node
/**
 * Assembles index.html from src/.
 *
 * index.html stays the single deployable artifact - that portability is the
 * point of this app. What it no longer has to be is the only place the source
 * lives. Blocks that are cleanly separable move to src/js/ and are stitched
 * back in here.
 *
 *   node build.js          rebuild index.html from src/
 *   node build.js --check   verify index.html matches src/ (used by tests/CI)
 *
 * The build is byte-exact: rebuilding an unmodified tree must reproduce
 * index.html with no diff at all. That is what makes the extraction provably
 * safe rather than a hopeful refactor.
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const TEMPLATE = path.join(ROOT, 'src', 'index.template.html');
const OUT = path.join(ROOT, 'index.html');
const INCLUDE = /^([ \t]*)\/\/ @include ([\w./-]+)[ \t]*$/gm;

function build() {
  const tpl = fs.readFileSync(TEMPLATE, 'utf8');
  let missing = [];
  const out = tpl.replace(INCLUDE, (_m, indent, rel) => {
    const p = path.join(ROOT, 'src', rel);
    if (!fs.existsSync(p)) { missing.push(rel); return _m; }
    // Files are stored verbatim, including their own indentation, so the
    // rebuild is byte-exact rather than reformatted.
    return fs.readFileSync(p, 'utf8').replace(/\n$/, '');
  });
  if (missing.length) { console.error('Missing include(s):\n  ' + missing.join('\n  ')); process.exit(1); }
  return out;
}

const built = build();
const check = process.argv.includes('--check');
const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;

if (check) {
  if (current === built) { console.log('build: index.html is in sync with src/'); process.exit(0); }
  console.error('build: index.html does NOT match src/. Run `node build.js`.');
  if (current) {
    // Point at the first divergence so the mismatch is actionable.
    const a = current.split('\n'), b = built.split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) { console.error(`  first difference at line ${i + 1}`);
        console.error(`    index.html: ${JSON.stringify((a[i] || '').slice(0, 90))}`);
        console.error(`    from src/ : ${JSON.stringify((b[i] || '').slice(0, 90))}`); break; }
    }
  }
  process.exit(1);
}

fs.writeFileSync(OUT, built);
console.log(current === built ? 'build: index.html unchanged (byte-identical)' : 'build: index.html written');
