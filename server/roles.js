'use strict';

// Server roles. A server has:
//   roles:       [{ id, name, color, permissions }]  ordered LOWEST rank first
//   everyone:    permissions every member has (like Discord's @everyone)
//   memberRoles: { userId: [roleId, ...] }
// A member's rank is the position of their highest role (1-based); the owner outranks everyone.
// You can only manage roles/members ranked below you, and only hand out permissions you hold.

const PERMISSIONS = ['administrator', 'manageChannels', 'manageRoles', 'kickMembers', 'sendMessages', 'connectVoice'];
const DEFAULT_EVERYONE = { sendMessages: true, connectVoice: true };
const OWNER_RANK = 1_000_000;
const MAX_ROLES = 20;

const allPerms = () => Object.fromEntries(PERMISSIONS.map((k) => [k, true]));
const cleanPerms = (input) => Object.fromEntries(PERMISSIONS.map((k) => [k, !!(input && input[k])]));

// older servers have none of these fields
function ensureRoles(s) {
  s.roles ||= [];
  s.everyone ||= { ...DEFAULT_EVERYONE };
  s.memberRoles ||= {};
  return s;
}

function permsOf(s, uid) {
  ensureRoles(s);
  if (uid === s.ownerId) return allPerms();
  const p = cleanPerms(s.everyone);
  for (const rid of s.memberRoles[uid] || []) {
    const role = s.roles.find((r) => r.id === rid);
    if (role) for (const k of PERMISSIONS) if (role.permissions[k]) p[k] = true;
  }
  return p.administrator ? allPerms() : p;
}

function rankOf(s, uid) {
  ensureRoles(s);
  if (uid === s.ownerId) return OWNER_RANK;
  let best = 0;
  for (const rid of s.memberRoles[uid] || []) {
    const i = s.roles.findIndex((r) => r.id === rid);
    if (i + 1 > best) best = i + 1;
  }
  return best;
}

const roleRank = (s, role) => s.roles.indexOf(role) + 1;

// may `uid` edit / delete / hand out / reorder this role?
function canManageRole(s, uid, role) {
  return permsOf(s, uid).manageRoles && roleRank(s, role) < rankOf(s, uid);
}

// you can only switch on/off permission bits that you hold yourself
function canChangePerms(s, uid, before, after) {
  const mine = permsOf(s, uid);
  return PERMISSIONS.every((k) => !!before[k] === !!after[k] || mine[k]);
}

module.exports = { PERMISSIONS, DEFAULT_EVERYONE, OWNER_RANK, MAX_ROLES, allPerms, cleanPerms, ensureRoles, permsOf, rankOf, roleRank, canManageRole, canChangePerms };
