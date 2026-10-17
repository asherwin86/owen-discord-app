'use strict';
const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { Store } = require('./store');
const { ensureCert } = require('./cert');

const newId = () => crypto.randomBytes(8).toString('hex');
const MAX_MSG = 2000;
const MAX_HISTORY = 2000;
const MAX_VOICE = 8; // peer-to-peer mesh: every extra person adds a connection for everyone

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  // Prefer typical home-network ranges first.
  return out.sort((a, b) => Number(b.startsWith('192.168.')) - Number(a.startsWith('192.168.')));
}

function listen(server, port, tries = 10) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      if (err.code === 'EADDRINUSE' && tries > 0) resolve(listen(server, port + 1, tries - 1));
      else reject(err);
    };
    const onListening = () => { server.removeListener('error', onError); resolve(server.address().port); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '0.0.0.0');
  });
}

async function startServer({ port = 3000, httpsPort = 3443, dataDir, publicDir = path.join(__dirname, '..', 'public') }) {
  const store = new Store(path.join(dataDir, 'data.json'));
  const db = store.db;

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 1e5 });
  app.disable('x-powered-by');
  app.use(express.json({ limit: '20kb' }));
  app.use(express.static(publicDir));

  // ---------- helpers ----------
  let securePort = null;
  app.get('/api/info', (req, res) => res.json({ httpsPort: securePort }));

  const online = new Map(); // userId -> socket count
  // voice: channelId -> Map(userId -> socketId); one voice connection per user
  const voiceRooms = new Map();
  const voiceOf = new Map(); // userId -> { serverId, channelId, socketId }
  const isOnline = (uid) => (online.get(uid) || 0) > 0;
  const pub = (uid) => {
    const u = db.users[uid];
    return u ? { id: u.id, username: u.username, online: isOnline(uid) } : { id: uid, username: 'deleted', online: false };
  };
  const findUser = (name) => Object.values(db.users).find((u) => u.username.toLowerCase() === String(name).trim().toLowerCase());
  const findFriendship = (a, b) => db.friendships.find((f) => (f.from === a && f.to === b) || (f.from === b && f.to === a));
  const areFriends = (a, b) => { const f = findFriendship(a, b); return !!f && f.status === 'accepted'; };
  const friendIds = (uid) => db.friendships
    .filter((f) => f.status === 'accepted' && (f.from === uid || f.to === uid))
    .map((f) => (f.from === uid ? f.to : f.from));

  function stateFor(uid) {
    const friends = [], incoming = [], outgoing = [];
    for (const f of db.friendships) {
      if (f.from !== uid && f.to !== uid) continue;
      const other = f.from === uid ? f.to : f.from;
      if (f.status === 'accepted') friends.push(pub(other));
      else if (f.to === uid) incoming.push({ id: f.id, user: pub(other) });
      else outgoing.push({ id: f.id, user: pub(other) });
    }
    friends.sort((a, b) => a.username.localeCompare(b.username));
    const groups = Object.values(db.groups)
      .filter((g) => g.members.includes(uid))
      .map((g) => ({ id: g.id, name: g.name, ownerId: g.ownerId, members: g.members.map(pub) }));
    const servers = Object.values(db.servers)
      .filter((s) => s.members.includes(uid))
      .map((s) => ({
        id: s.id, name: s.name, ownerId: s.ownerId, inviteCode: s.inviteCode,
        channels: s.channels.map((c) => ({ ...c, type: c.type || 'text' })),
        members: s.members.map(pub),
        voice: Object.fromEntries(s.channels
          .filter((c) => voiceRooms.has(c.id))
          .map((c) => [c.id, [...voiceRooms.get(c.id).keys()].map(pub)])),
      }));
    return { me: pub(uid), friends, incoming, outgoing, groups, servers };
  }

  const notify = (uids) => { for (const uid of new Set(uids)) io.to('u:' + uid).emit('state'); };

  // chat keys: dm:<otherUserId> | group:<groupId> | chan:<serverId>:<channelId>
  // returns { key (normalized), members } or null when invalid / not allowed
  function resolveChat(uid, key) {
    const [type, a, b] = String(key || '').split(':');
    if (type === 'dm') {
      if (!db.users[a] || !areFriends(uid, a)) return null;
      return { key: 'dm:' + [uid, a].sort().join(':'), members: [uid, a] };
    }
    if (type === 'group') {
      const g = db.groups[a];
      return g && g.members.includes(uid) ? { key: 'group:' + a, members: g.members } : null;
    }
    if (type === 'chan') {
      const s = db.servers[a];
      // voice channels have no text chat
      if (!s || !s.members.includes(uid) || !s.channels.some((c) => c.id === b && c.type !== 'voice')) return null;
      return { key: `chan:${a}:${b}`, members: s.members };
    }
    return null;
  }

  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  });
  const fail = (res, code, msg) => res.status(code).json({ error: msg });

  function auth(req, res, next) {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    const uid = db.sessions[token];
    if (!uid || !db.users[uid]) return fail(res, 401, 'Not signed in');
    req.uid = uid;
    next();
  }

  // ---------- auth ----------
  const attempts = new Map(); // ip -> { n, t }
  function throttled(req) {
    const now = Date.now();
    const a = attempts.get(req.ip);
    if (!a || now - a.t > 60_000) { attempts.set(req.ip, { n: 1, t: now }); return false; }
    return ++a.n > 20;
  }

  function newSession(uid) {
    const token = crypto.randomBytes(32).toString('hex');
    db.sessions[token] = uid;
    store.save();
    return token;
  }

  // Name-only sign in. The network itself is the access control: an existing
  // name logs you in as that user, a new name creates the account.
  app.post('/api/join', (req, res) => {
    if (throttled(req)) return fail(res, 429, 'Too many attempts, wait a minute');
    const username = String((req.body || {}).username || '').trim();
    if (!/^[A-Za-z0-9_.-]{2,24}$/.test(username)) return fail(res, 400, 'Name must be 2-24 letters, numbers, _ . -');
    let user = findUser(username);
    if (!user) {
      user = { id: newId(), username, created: Date.now() };
      db.users[user.id] = user;
    }
    res.json({ token: newSession(user.id) });
  });

  app.post('/api/logout', auth, (req, res) => {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    delete db.sessions[token];
    store.save();
    res.json({ ok: true });
  });

  app.get('/api/me', auth, (req, res) => res.json(stateFor(req.uid)));

  // ---------- friends ----------
  app.post('/api/friends/request', auth, (req, res) => {
    const target = findUser((req.body || {}).username || '');
    if (!target) return fail(res, 404, 'No user with that name');
    if (target.id === req.uid) return fail(res, 400, "You can't add yourself");
    const existing = findFriendship(req.uid, target.id);
    if (existing) {
      if (existing.status === 'accepted') return fail(res, 400, 'Already friends');
      if (existing.from === req.uid) return fail(res, 400, 'Request already sent');
      existing.status = 'accepted'; // they already asked us: accept
    } else {
      db.friendships.push({ id: newId(), from: req.uid, to: target.id, status: 'pending' });
    }
    store.save();
    notify([req.uid, target.id]);
    res.json({ ok: true });
  });

  app.post('/api/friends/accept', auth, (req, res) => {
    const f = db.friendships.find((x) => x.id === (req.body || {}).id && x.to === req.uid && x.status === 'pending');
    if (!f) return fail(res, 404, 'Request not found');
    f.status = 'accepted';
    store.save();
    notify([f.from, f.to]);
    res.json({ ok: true });
  });

  // decline an incoming request or cancel an outgoing one
  app.post('/api/friends/decline', auth, (req, res) => {
    const i = db.friendships.findIndex((x) => x.id === (req.body || {}).id && x.status === 'pending' && (x.to === req.uid || x.from === req.uid));
    if (i < 0) return fail(res, 404, 'Request not found');
    const [f] = db.friendships.splice(i, 1);
    store.save();
    notify([f.from, f.to]);
    res.json({ ok: true });
  });

  app.delete('/api/friends/:userId', auth, (req, res) => {
    const f = findFriendship(req.uid, req.params.userId);
    if (!f || f.status !== 'accepted') return fail(res, 404, 'Not friends');
    db.friendships.splice(db.friendships.indexOf(f), 1);
    store.save();
    notify([f.from, f.to]);
    res.json({ ok: true });
  });

  // ---------- groups ----------
  const cleanName = (s, max = 32) => String(s || '').trim().replace(/\s+/g, ' ').slice(0, max);

  app.post('/api/groups', auth, (req, res) => {
    const name = cleanName((req.body || {}).name);
    if (!name) return fail(res, 400, 'Group needs a name');
    const picked = [].concat((req.body || {}).members || []).filter((id) => areFriends(req.uid, id));
    const group = { id: newId(), name, ownerId: req.uid, members: [...new Set([req.uid, ...picked])] };
    db.groups[group.id] = group;
    store.save();
    notify(group.members);
    res.json({ id: group.id });
  });

  app.post('/api/groups/:id/members', auth, (req, res) => {
    const g = db.groups[req.params.id];
    if (!g || !g.members.includes(req.uid)) return fail(res, 404, 'Group not found');
    const add = [].concat((req.body || {}).members || []).filter((id) => areFriends(req.uid, id) && !g.members.includes(id));
    g.members.push(...add);
    store.save();
    notify(g.members);
    res.json({ ok: true });
  });

  app.post('/api/groups/:id/leave', auth, (req, res) => {
    const g = db.groups[req.params.id];
    if (!g || !g.members.includes(req.uid)) return fail(res, 404, 'Group not found');
    const before = [...g.members];
    g.members = g.members.filter((m) => m !== req.uid);
    if (!g.members.length) { delete db.groups[g.id]; delete db.messages['group:' + g.id]; }
    else if (g.ownerId === req.uid) g.ownerId = g.members[0];
    store.save();
    notify(before);
    res.json({ ok: true });
  });

  // ---------- servers ----------
  const newInvite = () => crypto.randomBytes(4).toString('hex');

  app.post('/api/servers', auth, (req, res) => {
    const name = cleanName((req.body || {}).name);
    if (!name) return fail(res, 400, 'Server needs a name');
    const s = {
      id: newId(), name, ownerId: req.uid, inviteCode: newInvite(), members: [req.uid],
      channels: [{ id: newId(), name: 'general', type: 'text' }, { id: newId(), name: 'Lounge', type: 'voice' }],
    };
    db.servers[s.id] = s;
    store.save();
    notify(s.members);
    res.json({ id: s.id });
  });

  app.post('/api/servers/join', auth, (req, res) => {
    const code = String((req.body || {}).code || '').trim().toLowerCase();
    const s = Object.values(db.servers).find((x) => x.inviteCode === code);
    if (!s) return fail(res, 404, 'Invalid invite code');
    if (!s.members.includes(req.uid)) s.members.push(req.uid);
    store.save();
    notify(s.members);
    res.json({ id: s.id });
  });

  app.post('/api/servers/:id/channels', auth, (req, res) => {
    const s = db.servers[req.params.id];
    if (!s || s.ownerId !== req.uid) return fail(res, 403, 'Only the server owner can add channels');
    const name = cleanName((req.body || {}).name, 24).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!name) return fail(res, 400, 'Channel needs a name');
    if (s.channels.length >= 30) return fail(res, 400, 'Too many channels');
    const channel = { id: newId(), name, type: (req.body || {}).type === 'voice' ? 'voice' : 'text' };
    s.channels.push(channel);
    store.save();
    notify(s.members);
    res.json(channel);
  });

  app.delete('/api/servers/:id/channels/:cid', auth, (req, res) => {
    const s = db.servers[req.params.id];
    if (!s || s.ownerId !== req.uid) return fail(res, 403, 'Only the server owner can delete channels');
    const target = s.channels.find((c) => c.id === req.params.cid);
    if (!target) return fail(res, 404, 'Channel not found');
    if (target.type !== 'voice' && s.channels.filter((c) => c.type !== 'voice').length <= 1) {
      return fail(res, 400, 'A server needs at least one text channel');
    }
    kickVoice((v) => v.channelId === target.id);
    s.channels = s.channels.filter((c) => c.id !== req.params.cid);
    delete db.messages[`chan:${s.id}:${req.params.cid}`];
    store.save();
    notify(s.members);
    res.json({ ok: true });
  });

  // owner deletes the server, everyone else leaves it
  app.post('/api/servers/:id/leave', auth, (req, res) => {
    const s = db.servers[req.params.id];
    if (!s || !s.members.includes(req.uid)) return fail(res, 404, 'Server not found');
    const before = [...s.members];
    if (s.ownerId === req.uid) {
      kickVoice((v) => v.serverId === s.id);
      for (const c of s.channels) delete db.messages[`chan:${s.id}:${c.id}`];
      delete db.servers[s.id];
    } else {
      kickVoice((v, uid) => v.serverId === s.id && uid === req.uid);
      s.members = s.members.filter((m) => m !== req.uid);
    }
    store.save();
    notify(before);
    res.json({ ok: true });
  });

  // ---------- messages ----------
  app.get('/api/messages', auth, (req, res) => {
    const chat = resolveChat(req.uid, req.query.chat);
    if (!chat) return fail(res, 404, 'Chat not found');
    let list = db.messages[chat.key] || [];
    const before = Number(req.query.before);
    if (before) list = list.filter((m) => m.ts < before);
    res.json(list.slice(-100));
  });

  app.post('/api/messages', auth, (req, res) => {
    const chat = resolveChat(req.uid, (req.body || {}).chat);
    if (!chat) return fail(res, 404, 'Chat not found');
    const text = String((req.body || {}).text || '').replace(/\r\n/g, '\n').trim().slice(0, MAX_MSG);
    if (!text) return fail(res, 400, 'Empty message');
    const msg = { id: newId(), chat: chat.key, userId: req.uid, username: db.users[req.uid].username, text, ts: Date.now() };
    const list = (db.messages[chat.key] ||= []);
    list.push(msg);
    if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY);
    store.save();
    io.to(chat.members.map((m) => 'u:' + m)).emit('message', msg);
    res.json(msg);
  });

  // ---------- realtime ----------
  io.use((socket, next) => {
    const uid = db.sessions[socket.handshake.auth && socket.handshake.auth.token];
    if (!uid || !db.users[uid]) return next(new Error('unauthorized'));
    socket.uid = uid;
    next();
  });

  const presence = (uid) => {
    io.to(friendIds(uid).map((f) => 'u:' + f)).emit('presence', { userId: uid, online: isOnline(uid) });
  };

  // ---------- voice ----------
  // Audio itself flows peer-to-peer (WebRTC); the server only relays the
  // signalling messages and tracks who is in which channel.
  function leaveVoice(uid) {
    const v = voiceOf.get(uid);
    if (!v) return;
    voiceOf.delete(uid);
    const room = voiceRooms.get(v.channelId);
    if (room) {
      room.delete(uid);
      for (const sid of room.values()) io.to(sid).emit('voice:peer-left', { userId: uid });
      if (!room.size) voiceRooms.delete(v.channelId);
    }
    const s = db.servers[v.serverId];
    if (s) notify(s.members);
  }

  // remove everyone matching pred(voiceEntry, userId), telling their client
  function kickVoice(pred) {
    for (const [uid, v] of [...voiceOf]) {
      if (!pred(v, uid)) continue;
      io.to(v.socketId).emit('voice:kicked');
      leaveVoice(uid);
    }
  }

  function joinVoice(socket, { serverId, channelId }, ack) {
    const uid = socket.uid;
    const s = db.servers[serverId];
    const ch = s && s.channels.find((c) => c.id === channelId);
    if (!s || !s.members.includes(uid) || !ch || ch.type !== 'voice') return ack({ error: 'Voice channel not found' });
    const cur = voiceOf.get(uid);
    if (cur && cur.channelId === channelId && cur.socketId === socket.id) return ack({ error: 'Already connected' });
    if (cur) { io.to(cur.socketId).emit('voice:kicked'); leaveVoice(uid); }
    const room = voiceRooms.get(channelId) || new Map();
    if (room.size >= MAX_VOICE) return ack({ error: `Voice channel is full (${MAX_VOICE} people)` });
    const peers = [...room.keys()].map(pub);
    room.set(uid, socket.id);
    voiceRooms.set(channelId, room);
    voiceOf.set(uid, { serverId, channelId, socketId: socket.id });
    notify(s.members);
    ack({ peers });
  }

  io.on('connection', (socket) => {
    const uid = socket.uid;
    socket.join('u:' + uid);
    online.set(uid, (online.get(uid) || 0) + 1);
    if (online.get(uid) === 1) presence(uid);

    socket.on('voice:join', (data, ack) => {
      if (typeof ack !== 'function') return;
      joinVoice(socket, data || {}, ack);
    });
    socket.on('voice:leave', () => {
      const v = voiceOf.get(uid);
      if (v && v.socketId === socket.id) leaveVoice(uid);
    });
    // relay SDP offers/answers and ICE candidates between two people in the same room
    socket.on('voice:signal', ({ to, data } = {}) => {
      const me = voiceOf.get(uid);
      const them = voiceOf.get(to);
      if (!me || !them || me.socketId !== socket.id || me.channelId !== them.channelId) return;
      io.to(them.socketId).emit('voice:signal', { from: uid, data });
    });

    socket.on('disconnect', () => {
      const v = voiceOf.get(uid);
      if (v && v.socketId === socket.id) leaveVoice(uid);
      online.set(uid, (online.get(uid) || 1) - 1);
      if (!isOnline(uid)) presence(uid);
    });
  });

  // ---------- go ----------
  const boundPort = await listen(server, port);

  // HTTPS (needed for microphone access from other devices). Failure is not fatal.
  let httpsServer = null;
  try {
    const ips = lanAddresses();
    httpsServer = https.createServer(ensureCert(dataDir, ips), app);
    io.attach(httpsServer, { maxHttpBufferSize: 1e5 });
    securePort = await listen(httpsServer, httpsPort);
  } catch (e) {
    console.error('HTTPS unavailable, voice will only work on localhost:', e.message);
    httpsServer = null;
    securePort = null;
  }

  return {
    port: boundPort,
    httpsPort: securePort,
    urls: () => lanAddresses().map((ip) => `http://${ip}:${boundPort}`),
    secureUrls: () => (securePort ? lanAddresses().map((ip) => `https://${ip}:${securePort}`) : []),
    localUrl: `http://localhost:${boundPort}`,
    stats: () => ({
      users: Object.keys(db.users).length,
      online: [...online.values()].filter((n) => n > 0).length,
    }),
    close: () => new Promise((resolve) => {
      store.flush();
      io.close(() => resolve());
      if (httpsServer) httpsServer.close();
    }),
  };
}

module.exports = { startServer, lanAddresses };
