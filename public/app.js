(() => {
'use strict';

// ---------- tiny helpers ----------
const el = (tag, props, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : String(kid));
  return e;
};
const root = document.getElementById('app');
const initial = (s) => (s || '?').trim().charAt(0).toUpperCase();
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* ignore */ } },
};

let token = store.get('token');
let S = null;                       // state from /api/me
let socket = null;
let ui = { tab: 'online', serverId: null, chat: null, error: '' };
const msgs = {};                    // local chat key -> messages[]
const unread = {};                  // local chat key -> count

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) { signOut(false); throw new Error(data.error || 'Signed out'); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}
const act = (p) => p.catch((e) => { alert(e.message); });

// ---------- chat key helpers ----------
// server dm keys are "dm:<a>:<b>" (sorted); locally we use "dm:<otherId>"
function localKey(serverKey) {
  const p = serverKey.split(':');
  if (p[0] !== 'dm') return serverKey;
  return 'dm:' + (p[1] === S.me.id ? p[2] : p[1]);
}
function chatInfo(key) {
  if (!key || !S) return null;
  const [t, a, b] = key.split(':');
  if (t === 'dm') { const f = S.friends.find((x) => x.id === a); return f && { title: f.username, kind: 'dm' }; }
  if (t === 'group') { const g = S.groups.find((x) => x.id === a); return g && { title: g.name, kind: 'group', group: g }; }
  if (t === 'chan') {
    const s = S.servers.find((x) => x.id === a);
    const c = s && s.channels.find((x) => x.id === b);
    if (!c) return null;
    return c.type === 'voice'
      ? { title: '\u{1F50A} ' + c.name, kind: 'voice', server: s, channel: c }
      : { title: '# ' + c.name, kind: 'chan', server: s, channel: c };
  }
  return null;
}
const firstText = (s) => s.channels.find((c) => c.type !== 'voice') || s.channels[0];
const serverUnread = (s) => s.channels.reduce((n, c) => n + (unread['chan:' + s.id + ':' + c.id] || 0), 0);

// ---------- session ----------
function signOut(callServer = true) {
  leaveVoice();
  if (callServer && token) api('POST', '/api/logout').catch(() => {});
  token = null; store.set('token', null);
  if (socket) { socket.disconnect(); socket = null; }
  S = null; ui = { tab: 'online', serverId: null, chat: null, error: '' };
  renderAuth();
}

async function refresh() {
  S = await api('GET', '/api/me');
  if (ui.serverId && !S.servers.some((s) => s.id === ui.serverId)) { ui.serverId = null; ui.chat = null; }
  if (ui.chat && !chatInfo(ui.chat)) ui.chat = null;
  if (ui.serverId && !ui.chat) {
    const s = S.servers.find((x) => x.id === ui.serverId);
    ui.chat = 'chan:' + s.id + ':' + firstText(s).id;
    loadMessages(ui.chat);
  }
  // our voice channel was deleted / we left that server
  if (voice.channelId && !S.servers.some((s) => s.channels.some((c) => c.id === voice.channelId))) cleanupVoice();
  renderApp();
}

function connect() {
  socket = io({ auth: { token } });
  socket.on('state', () => refresh().catch(() => {}));
  socket.on('presence', ({ userId, online }) => {
    if (!S) return;
    for (const u of S.friends) if (u.id === userId) u.online = online;
    renderApp(true);
  });
  socket.on('message', (m) => {
    if (!S) return;
    const key = localKey(m.chat);
    const list = msgs[key];
    if (list && !list.some((x) => x.id === m.id)) list.push(m);
    const viewing = key === ui.chat && !document.hidden;
    if (viewing) appendMessage(m, list);
    else if (m.userId !== S.me.id) { unread[key] = (unread[key] || 0) + 1; updateTitle(); renderApp(true); }
  });
  socket.on('connect_error', (e) => { if (e.message === 'unauthorized') signOut(false); });
  socket.on('disconnect', () => cleanupVoice());   // the server drops us from voice too
  socket.on('voice:kicked', () => cleanupVoice());
  socket.on('voice:signal', onVoiceSignal);
  socket.on('voice:peer-left', ({ userId }) => closePeer(userId));
}

function updateTitle() {
  const n = Object.values(unread).reduce((a, b) => a + b, 0);
  document.title = (n ? `(${n}) ` : '') + 'LanChat';
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && ui.chat && unread[ui.chat]) { delete unread[ui.chat]; updateTitle(); if (S) renderApp(true); }
});

// ---------- auth screen ----------
function renderAuth() {
  const err = el('div', { class: 'error' });
  const user = el('input', { type: 'text', autocomplete: 'username', autocapitalize: 'none', maxlength: 24, required: true, value: store.get('lastName') || '' });
  const form = el('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      try {
        const r = await api('POST', '/api/join', { username: user.value });
        token = r.token; store.set('token', token); store.set('lastName', user.value.trim());
        await start();
      } catch (ex) { err.textContent = ex.message; }
    },
  },
    el('h1', {}, 'Welcome to LanChat'),
    el('p', {}, 'Enter your name to join. New name = new account; an existing name signs you back in.'),
    el('div', {}, el('label', {}, 'Your name'), user),
    err,
    el('button', { class: 'btn', type: 'submit' }, 'Join'),
  );
  root.replaceChildren(el('div', { class: 'auth' }, form));
  user.focus();
}

// ---------- modals ----------
function modal(title, bodyNodes, buttons) {
  const close = () => ov.remove();
  const ov = el('div', { class: 'overlay', onmousedown: (e) => { if (e.target === ov) close(); } },
    el('div', { class: 'modal' }, el('h3', {}, title), ...bodyNodes,
      el('div', { class: 'actions' },
        el('button', { class: 'btn grey', type: 'button', onclick: close }, buttons ? 'Cancel' : 'Close'),
        ...(buttons || []).map((b) => el('button', { class: 'btn ' + (b.cls || ''), type: 'button', onclick: async () => {
          try { if ((await b.run()) !== false) close(); } catch (e) { alert(e.message); }
        } }, b.label)))));
  document.body.append(ov);
  const first = ov.querySelector('input[type=text]');
  if (first) first.focus();
  return close;
}

function friendPicker(exclude = []) {
  const boxes = S.friends.filter((f) => !exclude.includes(f.id)).map((f) => {
    const cb = el('input', { type: 'checkbox', value: f.id });
    return { f, cb, node: el('label', { class: 'check' }, cb, f.username) };
  });
  const node = boxes.length ? el('div', {}, ...boxes.map((b) => b.node)) : el('p', { class: 'sub' }, 'No friends to add yet.');
  return { node, values: () => boxes.filter((b) => b.cb.checked).map((b) => b.f.id) };
}

function newGroupModal() {
  const name = el('input', { type: 'text', maxlength: 32, placeholder: 'Weekend plans' });
  const picker = friendPicker();
  modal('Create a group chat', [el('label', {}, 'Group name'), name, el('label', {}, 'Add friends'), picker.node], [
    { label: 'Create', run: async () => {
      const r = await api('POST', '/api/groups', { name: name.value, members: picker.values() });
      await refresh(); openChat('group:' + r.id);
    } },
  ]);
}

function addToGroupModal(g) {
  const picker = friendPicker(g.members.map((m) => m.id));
  modal('Add friends to ' + g.name, [picker.node], [
    { label: 'Add', run: () => api('POST', `/api/groups/${g.id}/members`, { members: picker.values() }) },
  ]);
}

function serverModal() {
  const name = el('input', { type: 'text', maxlength: 32, placeholder: 'My server' });
  const code = el('input', { type: 'text', placeholder: 'e.g. 1a2b3c4d' });
  modal('Add a server', [
    el('label', {}, 'Create a server'), name,
    el('label', {}, 'Or join with an invite code'), code,
  ], [
    { label: 'Create / Join', run: async () => {
      if (!name.value.trim() && !code.value.trim()) return false;
      const r = code.value.trim()
        ? await api('POST', '/api/servers/join', { code: code.value })
        : await api('POST', '/api/servers', { name: name.value });
      ui.serverId = r.id; ui.chat = null; await refresh();
    } },
  ]);
}

function serverInfoModal(s) {
  const mine = s.ownerId === S.me.id;
  modal(s.name, [
    el('label', {}, 'Invite code - share it with friends'), el('div', { class: 'code' }, s.inviteCode),
    el('label', {}, `Members (${s.members.length})`),
    ...s.members.map((m) => el('div', { class: 'frow' }, el('div', { class: 'avatar sm' }, initial(m.username)),
      el('div', { class: 'grow' }, m.username + (m.id === s.ownerId ? ' (owner)' : '')))),
  ], [{
    label: mine ? 'Delete server' : 'Leave server', cls: 'red',
    run: async () => {
      if (!confirm(mine ? `Delete "${s.name}" for everyone?` : `Leave "${s.name}"?`)) return false;
      await api('POST', `/api/servers/${s.id}/leave`);
    },
  }]);
}

function membersModal(info) {
  const members = info.group ? info.group.members : info.server.members;
  const nodes = [...members.map((m) => el('div', { class: 'frow' }, el('div', { class: 'avatar sm' }, initial(m.username)),
    el('div', { class: 'grow' }, m.username)))];
  if (info.group) {
    modal(info.group.name + ' - members', nodes, [
      { label: 'Add friends', run: () => { setTimeout(() => addToGroupModal(info.group)); } },
      { label: 'Leave group', cls: 'red', run: async () => {
        if (!confirm('Leave this group?')) return false;
        await api('POST', `/api/groups/${info.group.id}/leave`);
      } },
    ]);
  } else modal('Members', nodes);
}

// ---------- navigation ----------
function openChat(key) {
  ui.chat = key;
  delete unread[key]; updateTitle();
  document.body.classList.remove('show-nav');
  const info = chatInfo(key);
  if (!msgs[key]) loadMessages(key);
  renderApp();
  const input = document.getElementById('composer');
  if (input && matchMedia('(min-width: 761px)').matches) input.focus();
}
function openHome() { ui.serverId = null; ui.chat = null; document.body.classList.add('show-nav'); renderApp(); }
function openServer(s) {
  ui.serverId = s.id;
  const key = 'chan:' + s.id + ':' + firstText(s).id;
  openChat(key);
  document.body.classList.add('show-nav');
}

async function loadMessages(key) {
  try {
    msgs[key] = await api('GET', '/api/messages?chat=' + encodeURIComponent(key));
    if (key === ui.chat) renderMain();
  } catch { /* chat may have vanished */ }
}

// ---------- main app render ----------
function renderApp(soft) {
  if (!S) return;
  let layout = root.querySelector('.layout');
  if (!layout) {
    layout = el('div', { class: 'layout' }, el('div', { class: 'nav' }, el('div', { class: 'rail' }), el('div', { class: 'side' })), el('div', { class: 'main' }));
    root.replaceChildren(layout);
    document.body.classList.add('show-nav');
  }
  renderRail(); renderSide();
  if (!soft) renderMain();
  else if (!ui.chat) renderMain(); // friends list updates with presence
}

function renderRail() {
  const rail = root.querySelector('.rail');
  const dmUnread = Object.entries(unread).filter(([k]) => !k.startsWith('chan:')).reduce((n, [, v]) => n + v, 0) + S.incoming.length;
  rail.replaceChildren(
    el('button', { class: 'item' + (!ui.serverId ? ' on' : ''), title: 'Home', onclick: openHome }, '\u{1F3E0}',
      dmUnread ? el('span', { class: 'badge' }, dmUnread) : null),
    el('div', { class: 'sep' }),
    ...S.servers.map((s) => {
      const n = serverUnread(s);
      return el('button', { class: 'item' + (ui.serverId === s.id ? ' on' : ''), title: s.name, onclick: () => openServer(s) },
        initial(s.name), n ? el('span', { class: 'badge' }, n) : null);
    }),
    el('button', { class: 'item add', title: 'Add a server', onclick: serverModal }, '+'),
  );
}

function renderSide() {
  const side = root.querySelector('.side');
  const me = el('div', { class: 'me' },
    el('div', { class: 'avatar sm' }, initial(S.me.username)),
    el('div', { class: 'who' }, S.me.username),
    el('button', { class: 'btn grey small', onclick: () => signOut() }, 'Log out'));
  const unreadBadge = (k) => (unread[k] ? el('span', { class: 'count' }, unread[k]) : null);

  if (ui.serverId) {
    const s = S.servers.find((x) => x.id === ui.serverId);
    const mine = s.ownerId === S.me.id;
    side.replaceChildren(
      el('div', { class: 'side-head click', onclick: () => serverInfoModal(s), title: 'Server info & invite code' },
        el('span', {}, s.name), el('span', {}, '⌄')),
      el('div', { class: 'side-body' },
        el('h4', {}, 'Text channels', mine ? el('button', { class: 'icon-btn', title: 'Add channel', onclick: () => channelModal(s) }, '+') : null),
        ...s.channels.filter((c) => c.type !== 'voice').map((c) => {
          const key = `chan:${s.id}:${c.id}`;
          return el('button', { class: 'row' + (ui.chat === key ? ' on' : '') + (unread[key] ? ' unread' : ''), onclick: () => openChat(key) },
            el('span', { class: 'name' }, '# ' + c.name), unreadBadge(key));
        }),
        el('h4', {}, 'Voice channels', mine ? el('button', { class: 'icon-btn', title: 'Add channel', onclick: () => channelModal(s, 'voice') }, '+') : null),
        ...s.channels.filter((c) => c.type === 'voice').flatMap((c) => {
          const key = `chan:${s.id}:${c.id}`;
          return [
            el('button', { class: 'row' + (ui.chat === key ? ' on' : '') + (unread[key] ? ' unread' : ''), onclick: () => { openChat(key); joinVoice(s, c); } },
              el('span', { class: 'name' }, '\u{1F50A} ' + c.name), unreadBadge(key)),
            ...(s.voice[c.id] || []).map((u) => el('div', { class: 'vuser', 'data-uid': u.id }, el('div', { class: 'avatar sm' }, initial(u.username)), u.username)),
          ];
        })),
      voiceBar(),
      me);
    return;
  }

  side.replaceChildren(
    el('div', { class: 'side-head' }, 'LanChat'),
    el('div', { class: 'side-body' },
      el('button', { class: 'row' + (!ui.chat ? ' on' : ''), onclick: () => { ui.chat = null; document.body.classList.remove('show-nav'); renderApp(); } },
        el('span', { class: 'name' }, '\u{1F465} Friends'), S.incoming.length ? el('span', { class: 'count' }, S.incoming.length) : null),
      el('h4', {}, 'Direct messages'),
      ...S.friends.map((f) => {
        const key = 'dm:' + f.id;
        return el('button', { class: 'row' + (ui.chat === key ? ' on' : '') + (unread[key] ? ' unread' : ''), onclick: () => openChat(key) },
          el('div', { class: 'avatar sm' }, initial(f.username), el('span', { class: 'dot' + (f.online ? ' on' : '') })),
          el('span', { class: 'name' }, f.username), unreadBadge(key));
      }),
      el('h4', {}, 'Groups', el('button', { class: 'icon-btn', title: 'Create group', onclick: newGroupModal }, '+')),
      ...S.groups.map((g) => {
        const key = 'group:' + g.id;
        return el('button', { class: 'row' + (ui.chat === key ? ' on' : '') + (unread[key] ? ' unread' : ''), onclick: () => openChat(key) },
          el('div', { class: 'avatar sm' }, initial(g.name)), el('span', { class: 'name' }, g.name), unreadBadge(key));
      })),
    voiceBar(),
    me);
}

function channelModal(s, kind = 'text') {
  const name = el('input', { type: 'text', maxlength: 24, placeholder: 'new-channel' });
  const radio = (value, label) => el('label', { class: 'check' }, el('input', { type: 'radio', name: 'ctype', value, checked: value === kind }), label);
  const box = el('div', {}, radio('text', '# Text channel'), radio('voice', '\u{1F50A} Voice channel'));
  modal('Create channel', [box, el('label', {}, 'Channel name'), name], [
    { label: 'Create', run: () => api('POST', `/api/servers/${s.id}/channels`, {
      name: name.value, type: box.querySelector('input:checked').value,
    }) },
  ]);
}

// "voice connected" strip shown above the user panel while in a call
function voiceBar() {
  if (!voice.channelId) return document.createDocumentFragment();   // nothing (null would render as the text "null")
  const s = S.servers.find((x) => x.id === voice.serverId);
  const c = s && s.channels.find((x) => x.id === voice.channelId);
  return el('div', { class: 'voice-bar' },
    el('div', { class: 'grow' }, el('div', { class: 'vb-title' }, '\u{1F7E2} Voice connected'), el('div', { class: 'sub' }, c ? `${c.name} / ${s.name}` : '')),
    el('button', { class: 'btn grey small', title: voice.muted ? 'Unmute' : 'Mute', onclick: toggleMute }, voice.muted ? '\u{1F507}' : '\u{1F3A4}'),
    el('button', { class: 'btn red small', onclick: leaveVoice }, 'Leave'));
}

// ---------- main pane ----------
function renderMain() {
  const main = root.querySelector('.main');
  const menu = el('button', { class: 'icon-btn menu-btn', onclick: () => document.body.classList.add('show-nav') }, '☰');
  const info = chatInfo(ui.chat);
  if (!info) { renderFriends(main, menu); return; }

  // keep a half-typed message when a background refresh re-renders the pane
  const old = document.getElementById('composer');
  const draft = old && old.dataset.chat === ui.chat ? old.value : '';
  const hadFocus = old && document.activeElement === old;
  const list = el('div', { class: 'messages', id: 'messages' });
  const input = el('textarea', { id: 'composer', rows: 1, maxlength: 2000, placeholder: 'Message ' + info.title, 'data-chat': ui.chat });
  input.value = draft;
  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = ''; input.style.height = 'auto';
    try { await api('POST', '/api/messages', { chat: ui.chat, text }); }
    catch (e) { input.value = text; alert(e.message); }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; });

  const canMembers = info.kind !== 'dm';
  const isVoice = info.kind === 'voice';
  main.replaceChildren(
    el('div', { class: 'main-head' }, menu, el('div', { class: 'grow' }, info.title),
      isVoice ? el('button', { class: 'btn grey small', title: 'Show a QR code to join from a phone', onclick: () => qrModal(info.server, info.channel) }, '\u{1F4F1} QR') : null,
      canMembers ? el('button', { class: 'btn grey small', onclick: () => membersModal(info) }, 'Members') : null),
    isVoice ? voiceSection(info) : document.createDocumentFragment(),
    list,
    el('div', { class: 'composer' }, input));
  paintMessages(list, msgs[ui.chat]);
  if (hadFocus) input.focus();
}

function paintMessages(list, items) {
  if (!items) { list.replaceChildren(el('div', { class: 'empty' }, 'Loading...')); return; }
  if (!items.length) { list.replaceChildren(el('div', { class: 'empty' }, 'No messages yet. Say hi!')); return; }
  list.replaceChildren();
  items.forEach((m, i) => list.append(messageNode(m, items[i - 1])));
  list.scrollTop = list.scrollHeight;
}

const fmt = (ts) => new Date(ts).toLocaleString([], { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' });
function messageNode(m, prev) {
  const grouped = prev && prev.userId === m.userId && m.ts - prev.ts < 5 * 60_000;
  return el('div', { class: 'msg' + (grouped ? '' : ' first') },
    grouped
      ? el('div', { class: 'gutter' }, new Date(m.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))
      : el('div', { class: 'avatar' }, initial(m.username)),
    el('div', {},
      grouped ? null : el('div', { class: 'meta' }, el('b', {}, m.username), el('span', {}, fmt(m.ts))),
      el('div', { class: 'text' }, m.text)));
}

function appendMessage(m, items) {
  const list = document.getElementById('messages');
  if (!list || !items) return;
  if (!items.length || items.length === 1) { paintMessages(list, items); return; }
  const near = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
  list.append(messageNode(m, items[items.length - 2]));
  if (near || m.userId === S.me.id) list.scrollTop = list.scrollHeight;
}

// ---------- friends page ----------
function renderFriends(main, menu) {
  const tabs = [['online', 'Online'], ['all', 'All'], ['pending', 'Pending' + (S.incoming.length ? ` (${S.incoming.length})` : '')], ['add', 'Add friend']];
  let body;
  if (ui.tab === 'add') {
    const name = el('input', { type: 'text', placeholder: 'Enter a username', autocapitalize: 'none' });
    const msg = el('div', { class: 'error' });
    body = el('div', { class: 'panel' },
      el('h3', {}, 'Add friend'),
      el('form', { class: 'addform', onsubmit: async (e) => {
        e.preventDefault();
        msg.style.color = ''; msg.textContent = '';
        try {
          await api('POST', '/api/friends/request', { username: name.value });
          msg.style.color = '#57f287'; msg.textContent = `Friend request sent to ${name.value}.`; name.value = '';
        } catch (ex) { msg.textContent = ex.message; }
      } }, name, el('button', { class: 'btn', type: 'submit' }, 'Send request')),
      msg);
  } else if (ui.tab === 'pending') {
    const rows = [
      ...S.incoming.map((r) => frow(r.user, 'Incoming request',
        el('button', { class: 'btn small', onclick: () => act(api('POST', '/api/friends/accept', { id: r.id })) }, 'Accept'),
        el('button', { class: 'btn grey small', onclick: () => act(api('POST', '/api/friends/decline', { id: r.id })) }, 'Ignore'))),
      ...S.outgoing.map((r) => frow(r.user, 'Outgoing request',
        el('button', { class: 'btn grey small', onclick: () => act(api('POST', '/api/friends/decline', { id: r.id })) }, 'Cancel'))),
    ];
    body = el('div', { class: 'panel' }, el('div', { class: 'list' }, rows.length ? rows : el('div', { class: 'empty' }, 'No pending requests.')));
  } else {
    const friends = ui.tab === 'online' ? S.friends.filter((f) => f.online) : S.friends;
    const rows = friends.map((f) => frow(f, f.online ? 'Online' : 'Offline',
      el('button', { class: 'btn small', onclick: () => openChat('dm:' + f.id) }, 'Message'),
      el('button', { class: 'btn grey small', onclick: () => { if (confirm(`Remove ${f.username} as a friend?`)) act(api('DELETE', '/api/friends/' + f.id)); } }, 'Remove')));
    body = el('div', { class: 'panel' }, el('div', { class: 'list' }, rows.length ? rows
      : el('div', { class: 'empty' }, S.friends.length ? 'Nobody is online right now.' : 'No friends yet - use "Add friend" and enter their username.')));
  }
  main.replaceChildren(
    el('div', { class: 'main-head' }, menu, el('span', {}, 'Friends'),
      el('div', { class: 'tabs' }, ...tabs.map(([k, label]) => el('button', { class: 'tab' + (ui.tab === k ? ' on' : ''), onclick: () => { ui.tab = k; renderMain(); } }, label)))),
    body);
}

function frow(user, sub, ...actions) {
  return el('div', { class: 'frow' },
    el('div', { class: 'avatar' }, initial(user.username), el('span', { class: 'dot' + (user.online ? ' on' : '') })),
    el('div', { class: 'grow' }, el('div', {}, user.username), el('div', { class: 'sub' }, sub)),
    ...actions);
}

// ---------- voice (WebRTC mesh; the server only relays signalling) ----------
const voice = {
  serverId: null, channelId: null, stream: null, muted: false,
  peers: new Map(),       // userId -> { pc, audio, queued: [] }
  analysers: new Map(),   // userId -> { analyser, buf }
  ctx: null, timer: null, httpsPort: null, hosts: [], error: '',
};
fetch('/api/info').then((r) => r.json()).then((i) => { voice.httpsPort = i.httpsPort; voice.hosts = i.hosts || []; }).catch(() => {});

const canUseMic = () => window.isSecureContext && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

async function joinVoice(s, c) {
  if (voice.channelId === c.id) return;
  if (!canUseMic()) { renderMain(); return; }   // the panel explains how to get HTTPS
  voice.error = '';
  if (voice.channelId) leaveVoice();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) {
    voice.error = 'Could not use the microphone (' + (e.name === 'NotAllowedError' ? 'permission denied' : e.message) + '). Allow it in the browser and try again.';
    renderMain(); return;
  }
  const r = await new Promise((res) => socket.emit('voice:join', { serverId: s.id, channelId: c.id }, res));
  if (r.error) {
    stream.getTracks().forEach((t) => t.stop());
    voice.error = r.error; renderMain(); return;
  }
  voice.serverId = s.id; voice.channelId = c.id; voice.stream = stream; voice.muted = false;
  startLevels();
  watchLevel(S.me.id, stream);
  for (const p of r.peers) await callPeer(p.id);   // the newcomer makes the offers
  renderApp(true); if (ui.chat) renderMain();
}

function leaveVoice() {
  if (!voice.channelId) return;
  if (socket) socket.emit('voice:leave');
  cleanupVoice();
}

function cleanupVoice() {
  const was = voice.channelId;
  for (const uid of [...voice.peers.keys()]) closePeer(uid);
  if (voice.stream) voice.stream.getTracks().forEach((t) => t.stop());
  clearInterval(voice.timer); voice.timer = null;
  if (voice.ctx) { voice.ctx.close().catch(() => {}); voice.ctx = null; }
  voice.analysers.clear();
  voice.serverId = voice.channelId = voice.stream = null;
  if (was && S) { renderApp(true); if (ui.chat) renderMain(); }
}

function toggleMute() {
  voice.muted = !voice.muted;
  if (voice.stream) voice.stream.getAudioTracks().forEach((t) => { t.enabled = !voice.muted; });
  renderApp(true); if (ui.chat) renderMain();
}

function makePeer(uid) {
  const pc = new RTCPeerConnection({ iceServers: [] });   // LAN only: host candidates are enough
  const peer = { pc, audio: null, queued: [] };
  voice.peers.set(uid, peer);
  voice.stream.getTracks().forEach((t) => pc.addTrack(t, voice.stream));
  pc.onicecandidate = (e) => { if (e.candidate) socket.emit('voice:signal', { to: uid, data: { candidate: e.candidate } }); };
  pc.ontrack = (e) => {
    if (peer.audio) return;
    peer.audio = el('audio', { autoplay: true });
    peer.audio.srcObject = e.streams[0];
    document.body.append(peer.audio);
    peer.audio.play().catch(() => {});
    watchLevel(uid, e.streams[0]);
  };
  pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') closePeer(uid); };
  return peer;
}

async function callPeer(uid) {
  const { pc } = makePeer(uid);
  await pc.setLocalDescription(await pc.createOffer());
  socket.emit('voice:signal', { to: uid, data: { sdp: pc.localDescription } });
}

async function onVoiceSignal({ from, data }) {
  if (!voice.channelId || !voice.stream) return;
  const peer = voice.peers.get(from) || makePeer(from);
  const { pc } = peer;
  try {
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      for (const c of peer.queued.splice(0)) await pc.addIceCandidate(c);
      if (data.sdp.type === 'offer') {
        await pc.setLocalDescription(await pc.createAnswer());
        socket.emit('voice:signal', { to: from, data: { sdp: pc.localDescription } });
      }
    } else if (data.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
      else peer.queued.push(data.candidate);   // candidate beat the offer
    }
  } catch (e) { console.warn('voice signal failed', e); }
}

function closePeer(uid) {
  const p = voice.peers.get(uid);
  if (!p) return;
  voice.peers.delete(uid);
  voice.analysers.delete(uid);
  p.pc.close();
  if (p.audio) { p.audio.srcObject = null; p.audio.remove(); }
}

// speaking indicator: poll each stream's loudness and toggle a CSS class
function startLevels() {
  if (voice.ctx) return;
  voice.ctx = new (window.AudioContext || window.webkitAudioContext)();
  voice.timer = setInterval(() => {
    const speaking = new Set();
    for (const [uid, a] of voice.analysers) {
      a.analyser.getByteTimeDomainData(a.buf);
      let peak = 0;
      for (const v of a.buf) peak = Math.max(peak, Math.abs(v - 128));
      if (peak > 6 && !(uid === S.me.id && voice.muted)) speaking.add(uid);
    }
    for (const n of document.querySelectorAll('[data-uid]')) n.classList.toggle('speaking', speaking.has(n.dataset.uid));
  }, 120);
}
function watchLevel(uid, stream) {
  if (!voice.ctx) return;
  const analyser = voice.ctx.createAnalyser();
  analyser.fftSize = 512;
  voice.ctx.createMediaStreamSource(stream).connect(analyser);
  voice.analysers.set(uid, { analyser, buf: new Uint8Array(analyser.fftSize) });
}

// the call controls shown above a voice channel's text chat
function voiceSection(info) {
  const { server: s, channel: c } = info;
  const here = voice.channelId === c.id;
  const users = s.voice[c.id] || [];
  if (!canUseMic()) {
    const secure = voice.httpsPort ? `https://${location.hostname}:${voice.httpsPort}` : null;
    return el('div', { class: 'vsection' },
      el('div', {}, 'Browsers only allow the microphone on secure pages, and this address is plain http.'),
      secure ? el('div', {}, 'Open ', el('a', { href: secure, style: 'color:#00a8fc' }, secure),
        ' instead. Your browser will warn about the certificate once: choose Advanced, then Continue.')
        : el('div', {}, 'HTTPS is not available on this host.'));
  }
  return el('div', { class: 'vsection' },
    voice.error ? el('div', { class: 'error' }, voice.error) : null,
    el('div', { class: 'vgrid' },
      ...users.map((u) => el('div', { class: 'vtile', 'data-uid': u.id }, el('div', { class: 'avatar' }, initial(u.username)), el('div', { class: 'vname' }, u.username))),
      !users.length ? el('div', { class: 'sub' }, 'Nobody is in this voice channel yet.') : null),
    el('div', { class: 'vactions' },
      here
        ? [el('button', { class: 'btn grey small', onclick: toggleMute }, voice.muted ? '\u{1F507} Unmute' : '\u{1F3A4} Mute'),
           el('button', { class: 'btn red small', onclick: leaveVoice }, 'Leave voice')]
        : el('button', { class: 'btn small', onclick: () => joinVoice(s, c) }, 'Join voice')));
}

// ---------- QR code: scan with a phone to land on this voice channel ----------
function connectUrl(s, c, host) {
  const port = location.protocol === 'https:' ? location.port : voice.httpsPort;
  return `https://${host}${port ? ':' + port : ''}/#voice=${s.inviteCode}:${c.id}`;
}

function qrModal(s, c) {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const hosts = local || !voice.hosts.includes(location.hostname) ? voice.hosts : [location.hostname, ...voice.hosts.filter((h) => h !== location.hostname)];
  if (!hosts.length) hosts.push(location.hostname);
  const img = el('img', { alt: 'QR code', width: 240, height: 240, style: 'background:#fff;border-radius:8px;align-self:center' });
  const link = el('div', { class: 'code' });
  const pick = el('select', { onchange: () => paint(pick.value) }, ...hosts.map((h) => el('option', { value: h }, h)));
  function paint(host) {
    const url = connectUrl(s, c, host);
    img.src = '/api/qr?text=' + encodeURIComponent(url);
    link.textContent = url;
  }
  paint(hosts[0]);
  modal('Join ' + c.name + ' from a phone', [
    el('div', { class: 'sub', style: 'white-space:normal' }, 'Scan with your phone camera (on the same Wi-Fi). It opens this voice channel; accept the certificate warning once, enter a name, then tap Join voice.'),
    img,
    hosts.length > 1 ? el('div', {}, el('label', {}, 'Host address (pick the one on your Wi-Fi)'), pick) : null,
    link,
    el('div', { class: 'sub', style: 'white-space:normal' }, 'The code includes the server invite, so anyone who scans it can join the server.'),
  ]);
}

// "#voice=<inviteCode>:<channelId>" from a scanned QR code
let pendingVoice = null;
{
  const m = /^#voice=([0-9a-f]+):([0-9a-f]+)$/.exec(location.hash);
  if (m) { pendingVoice = { code: m[1], channelId: m[2] }; history.replaceState(null, '', location.pathname); }
}
async function openPendingVoice() {
  if (!pendingVoice) return;
  const { code, channelId } = pendingVoice;
  pendingVoice = null;
  try {
    const r = await api('POST', '/api/servers/join', { code });
    ui.serverId = r.id;
    await refresh();
    const s = S.servers.find((x) => x.id === r.id);
    if (s && s.channels.some((c) => c.id === channelId)) openChat(`chan:${s.id}:${channelId}`);
  } catch (e) { alert('Could not open that voice channel: ' + e.message); }
}

// ---------- boot ----------
async function start() {
  try {
    await refresh();
    if (!socket) connect();
    openPendingVoice();
  } catch { renderAuth(); }
}

if (token) start(); else renderAuth();
})();
