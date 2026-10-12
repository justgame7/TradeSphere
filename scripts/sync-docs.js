// Mirrors www/ (source of truth) into docs/ (GitHub Pages).
// Copies every file and removes anything in docs/ that no longer exists in www/.
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'www');
const dst = path.join(__dirname, '..', 'docs');

fs.mkdirSync(dst, { recursive: true });
const keep = new Set(fs.readdirSync(src));

for (const name of fs.readdirSync(dst)) {
  if (!keep.has(name)) {
    fs.rmSync(path.join(dst, name), { recursive: true, force: true });
    console.log('removed docs/' + name);
  }
}
fs.cpSync(src, dst, { recursive: true, force: true });
console.log('synced ' + keep.size + ' entries www/ -> docs/');
