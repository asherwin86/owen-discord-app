'use strict';
// The host's own settings, kept apart from the chat data: settings.json in the app's data folder
// (the one location.json can move to another drive).
const fs = require('fs');
const path = require('path');

const DEFAULT_PORT = 3100;
// The secure link and its certificate live here, so the plain port may not take it.
const HTTPS_PORT = 3443;

// A port a person may choose: a whole number from 1024 up (lower ones need administrator rights).
// Returns { port } or { error } so the message can go straight to the window.
function parsePort(value) {
  const n = typeof value === 'string' && /^\s*\d{1,5}\s*$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(n) || n < 1024 || n > 65535) return { error: 'Use a whole number from 1024 to 65535.' };
  if (n === HTTPS_PORT) return { error: `${HTTPS_PORT} is used for the secure link. Pick another port.` };
  return { port: n };
}

const fileOf = (dir) => path.join(dir, 'settings.json');

// A missing or damaged file means the defaults: the port is the only setting, and a host that will not
// start because of it would be worse than one on the usual port.
function loadSettings(dir) {
  try {
    const parsed = parsePort(JSON.parse(fs.readFileSync(fileOf(dir), 'utf8')).port);
    return { port: parsed.port || DEFAULT_PORT };
  } catch {
    return { port: DEFAULT_PORT };
  }
}

// Written through a temporary name so a crash never leaves half a file.
function saveSettings(dir, settings) {
  const target = fileOf(dir);
  const temp = `${target}.tmp`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(temp, JSON.stringify({ port: settings.port }, null, 2));
  fs.renameSync(temp, target);
}

module.exports = { DEFAULT_PORT, HTTPS_PORT, parsePort, loadSettings, saveSettings };
