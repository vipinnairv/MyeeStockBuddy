// Pulls pure functions out of the single-file app so they can be unit tested.
// index.html is the deployable artifact and must stay one file; rather than
// fight that, the tests slice the functions they need out of it. If a slice
// stops matching, the test fails loudly instead of silently testing nothing.
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').replace(/\r\n/g, '\n');

function slice(startMarker, endMarker, label) {
  const a = SRC.indexOf(startMarker);
  if (a < 0) throw new Error(`extract: start marker not found for ${label}: ${startMarker.slice(0, 60)}`);
  const b = SRC.indexOf(endMarker, a + startMarker.length);
  if (b < 0) throw new Error(`extract: end marker not found for ${label}: ${endMarker.slice(0, 60)}`);
  return SRC.slice(a, b);
}

// Evaluate extracted source in a sandbox and return the named globals.
function load(code, names, globals = {}) {
  const keys = Object.keys(globals);
  const body = `${code}\n;return {${names.join(',')}};`;
  return new Function(...keys, body)(...keys.map(k => globals[k]));
}

module.exports = { SRC, slice, load };
