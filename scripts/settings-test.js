// The port setting: what may be chosen, how it is kept, and that a typed port is never quietly changed.
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { DEFAULT_PORT, parsePort, loadSettings, saveSettings } = require('../electron/settings');
const { startServer } = require('../server');

(async () => {
  // what may be chosen
  for (const ok of [1024, 3100, 8080, 65535, '3100', ' 4000 ']) assert.ok(parsePort(ok).port, `${ok} should be allowed`);
  assert.strictEqual(parsePort('4000').port, 4000);
  for (const bad of [0, 80, 1023, 65536, -1, 3100.5, 'abc', '', '12ab', '99999', null, undefined, {}, '3443', 3443]) {
    assert.ok(parsePort(bad).error, `${JSON.stringify(bad)} should be refused`);
  }
  assert.match(parsePort(3443).error, /secure link/);

  // how it is kept
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-settings-'));
  assert.deepStrictEqual(loadSettings(dir), { port: DEFAULT_PORT }, 'no file means the default');
  saveSettings(dir, { port: 4321 });
  assert.deepStrictEqual(loadSettings(dir), { port: 4321 });
  assert.ok(!fs.existsSync(path.join(dir, 'settings.json.tmp')), 'no temporary file is left behind');
  fs.writeFileSync(path.join(dir, 'settings.json'), '{ not json');
  assert.strictEqual(loadSettings(dir).port, DEFAULT_PORT, 'a damaged file means the default');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ port: 80 }));
  assert.strictEqual(loadSettings(dir).port, DEFAULT_PORT, 'a port that is not allowed means the default');
  assert.strictEqual(DEFAULT_PORT, 3100);

  // a typed port is never quietly changed; the one picked at startup may move
  const data = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-data-'));
  const first = await startServer({ port: 3910, httpsPort: 3920, dataDir: data() });
  assert.strictEqual(first.port, 3910);
  await assert.rejects(startServer({ port: 3910, httpsPort: 3921, dataDir: data(), strictPort: true }), (e) => e.code === 'EADDRINUSE');
  const moved = await startServer({ port: 3910, httpsPort: 3922, dataDir: data() });
  assert.strictEqual(moved.port, 3911, 'without strictPort a busy port moves to the next one');
  await first.close();
  const again = await startServer({ port: 3910, httpsPort: 3923, dataDir: data(), strictPort: true });
  assert.strictEqual(again.port, 3910, 'once the port is free the strict start gets it');
  await moved.close();
  await again.close();

  console.log('settings tests passed');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
