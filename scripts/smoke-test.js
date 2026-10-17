// End-to-end smoke test: starts a server on a temp dir and exercises the API + sockets.
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { io } = require('socket.io-client');
const { startServer } = require('../server');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-test-'));
  const srv = await startServer({ port: 3900, dataDir: dir });
  const base = srv.localUrl;
  const call = async (method, url, token, body) => {
    const r = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json() };
  };
  const ok = (r, s = 200) => assert.strictEqual(r.status, s, JSON.stringify(r.body));

  const join = async (n) => (await call('POST', '/api/join', null, { username: n })).body.token;
  const a = await join('alice'), b = await join('bob'), c = await join('carol');
  // same name (any case) signs into the same account; bad names are rejected
  const a2 = await join('ALICE');
  assert.strictEqual((await call('GET', '/api/me', a2)).body.me.id, (await call('GET', '/api/me', a)).body.me.id);
  ok(await call('POST', '/api/join', null, { username: 'x' }), 400);

  const meA = (await call('GET', '/api/me', a)).body, meB = (await call('GET', '/api/me', b)).body, meC = (await call('GET', '/api/me', c)).body;

  // can't DM before being friends
  ok(await call('POST', '/api/messages', a, { chat: 'dm:' + meB.me.id, text: 'hi' }), 404);

  // friend flow
  ok(await call('POST', '/api/friends/request', a, { username: 'bob' }));
  const reqs = (await call('GET', '/api/me', b)).body.incoming;
  assert.strictEqual(reqs.length, 1);
  ok(await call('POST', '/api/friends/accept', b, { id: reqs[0].id }));
  ok(await call('POST', '/api/friends/request', a, { username: 'carol' }));
  ok(await call('POST', '/api/friends/request', c, { username: 'alice' })); // auto-accepts
  assert.strictEqual((await call('GET', '/api/me', a)).body.friends.length, 2);

  // realtime DM
  const sockB = io(base, { auth: { token: b } });
  const sockC = io(base, { auth: { token: c } });
  await Promise.all([new Promise((r) => sockB.on('connect', r)), new Promise((r) => sockC.on('connect', r))]);
  const got = new Promise((r) => sockB.on('message', r));
  ok(await call('POST', '/api/messages', a, { chat: 'dm:' + meB.me.id, text: 'hello bob' }));
  const m = await got;
  assert.strictEqual(m.text, 'hello bob');
  let leaked = false; sockC.on('message', (msg) => { if (msg.chat.startsWith('dm:') && msg.userId !== meC.me.id) leaked = true; });

  // history, both directions of the dm key
  assert.strictEqual((await call('GET', '/api/messages?chat=dm:' + meA.me.id, b)).body.length, 1);

  // group
  const g = (await call('POST', '/api/groups', a, { name: 'crew', members: [meB.me.id] })).body.id;
  ok(await call('POST', '/api/messages', b, { chat: 'group:' + g, text: 'in group' }));
  ok(await call('POST', '/api/messages', c, { chat: 'group:' + g, text: 'sneak' }), 404);
  ok(await call('POST', `/api/groups/${g}/members`, a, { members: [meC.me.id] }));
  ok(await call('POST', '/api/messages', c, { chat: 'group:' + g, text: 'now ok' }));

  // server + invite + channels
  const s = (await call('POST', '/api/servers', a, { name: 'Hangout' })).body.id;
  const sv = (await call('GET', '/api/me', a)).body.servers[0];
  assert.strictEqual(sv.channels[0].name, 'general');
  ok(await call('POST', '/api/servers/join', b, { code: sv.inviteCode }));
  ok(await call('POST', `/api/servers/${s}/channels`, b, { name: 'nope' }), 403);
  const ch = (await call('POST', `/api/servers/${s}/channels`, a, { name: 'Game Night!' })).body;
  assert.strictEqual(ch.name, 'game-night');
  ok(await call('POST', '/api/messages', b, { chat: `chan:${s}:${ch.id}`, text: 'gg' }));
  ok(await call('POST', '/api/messages', c, { chat: `chan:${s}:${ch.id}`, text: 'not a member' }), 404);
  // voice channels: no text, membership enforced, signalling relayed, occupancy tracked
  const lounge = (await call('GET', '/api/me', a)).body.servers[0].channels.find((c) => c.type === 'voice');
  assert(lounge, 'new servers get a voice channel');
  // voice channels have a text chat too (members only)
  ok(await call('POST', '/api/messages', b, { chat: `chan:${s}:${lounge.id}`, text: 'chat in voice' }));
  ok(await call('POST', '/api/messages', c, { chat: `chan:${s}:${lounge.id}`, text: 'x' }), 404);
  assert.strictEqual((await call('GET', `/api/messages?chat=chan:${s}:${lounge.id}`, a)).body.length, 1);
  // QR endpoint only encodes http(s) links
  const qr = await fetch(base + '/api/qr?text=' + encodeURIComponent('https://192.168.0.2:3443/#voice=abc:def'));
  assert.strictEqual(qr.status, 200);
  assert((await qr.text()).startsWith('<svg'));
  assert.strictEqual((await fetch(base + '/api/qr?text=javascript:alert(1)')).status, 400);
  const sockA = io(base, { auth: { token: a } });
  await new Promise((r) => sockA.on('connect', r));
  const ack = (sock, ev, data) => new Promise((r) => sock.emit(ev, data, r));
  assert.deepStrictEqual((await ack(sockA, 'voice:join', { serverId: s, channelId: lounge.id })).peers, []);
  assert.strictEqual((await ack(sockB, 'voice:join', { serverId: s, channelId: lounge.id })).peers.length, 1);
  assert((await ack(sockC, 'voice:join', { serverId: s, channelId: lounge.id })).error, 'non-member joined voice');
  const sig = new Promise((r) => sockA.once('voice:signal', r));
  sockC.emit('voice:signal', { to: meA.me.id, data: { sdp: 'evil' } });   // carol is not in the room: dropped
  sockB.emit('voice:signal', { to: meA.me.id, data: { sdp: { type: 'offer', sdp: 'x' } } });
  const relayed = await sig;
  assert.strictEqual(relayed.from, meB.me.id);
  assert.strictEqual(relayed.data.sdp.type, 'offer');
  assert.strictEqual((await call('GET', '/api/me', a)).body.servers[0].voice[lounge.id].length, 2);
  const left = new Promise((r) => sockA.once('voice:peer-left', r));
  sockB.disconnect();   // dropping the socket must remove them from the room
  assert.strictEqual((await left).userId, meB.me.id);
  assert.strictEqual((await call('GET', '/api/me', a)).body.servers[0].voice[lounge.id].length, 1);
  sockA.close();
  ok(await call('POST', `/api/servers/${s}/leave`, b));

  // bad input
  ok(await call('POST', '/api/messages', a, { chat: 'dm:' + meB.me.id, text: '   ' }), 400);
  ok(await call('GET', '/api/me', 'bogus'), 401);

  // persistence
  srv.stats(); await srv.close();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8'));
  assert.strictEqual(Object.keys(saved.users).length, 3);

  sockB.close(); sockC.close();
  assert(!leaked, 'carol received a DM she was not part of');
  console.log('All smoke tests passed.');
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
