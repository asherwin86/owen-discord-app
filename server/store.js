'use strict';
const fs = require('fs');
const path = require('path');

// Tiny JSON-file database: everything lives in memory and is written to disk
// (atomically, debounced) whenever save() is called.
class Store {
  constructor(file) {
    this.file = file;
    this.timer = null;
    this.db = { users: {}, sessions: {}, friendships: [], groups: {}, servers: {}, messages: {} };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      Object.assign(this.db, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (e) {
      if (e.code !== 'ENOENT') {
        try { fs.copyFileSync(file, file + '.corrupt-' + Date.now()); } catch { /* ignore */ }
        console.error('Could not read database, starting fresh:', e.message);
      }
    }
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 300);
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.db));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store };
