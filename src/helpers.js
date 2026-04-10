import jwt from 'jsonwebtoken';

// ── Role mapping ──

const ROLE_SK = { member: 'člen', manager: 'správca', owner: 'vlastník' };
const ACCESS_FIELD = { member: 'member', manager: 'manager', owner: 'owner' };
const ACCESS_VALUE = { member: 'public', manager: 'unlisted', owner: 'unlisted' };

export const INVITE_TTL_DAYS = 7;

export function roleSk(roleType) {
  return ROLE_SK[roleType] || roleType;
}

// ── App URL ──

export function getAppUrl(env) {
  const url = env.INVITATION_APP_URL || env.PUBLIC_URL;
  return url?.replace(/\/+$/, '');
}

// ── Default Directus role for new users ──

export async function getDefaultRole(env, database) {
  if (env.INVITATION_DEFAULT_ROLE) return env.INVITATION_DEFAULT_ROLE;
  try {
    const [row] = await database('directus_settings').select('public_registration_role').limit(1);
    if (row?.public_registration_role) return row.public_registration_role;
  } catch { /* fall through */ }
  return env.AUTH_DEFAULT_ROLE || null;
}

// ── JWT ──

export function createInviteToken(env, email, invitationId) {
  return jwt.sign(
    { email, invitation_id: invitationId, scope: 'invite' },
    env.SECRET,
    { expiresIn: env.USER_INVITE_TOKEN_TTL || '7d', issuer: 'directus' },
  );
}

export function verifyInviteToken(env, token) {
  const payload = jwt.verify(token, env.SECRET, { issuer: 'directus' });
  if (payload.scope !== 'invite') throw new Error('Invalid token scope');
  if (!payload.invitation_id) throw new Error('Missing invitation_id in token');
  return payload;
}

// ── DB queries ──

export async function getBandTitle(database, bandId) {
  const [row] = await database('bands').where('id', bandId).select('title').limit(1);
  return row?.title || null;
}

export async function getInviterName(database, userId) {
  if (!userId) return 'Spevník';
  const [row] = await database('directus_users').where('id', userId).select('first_name', 'last_name').limit(1);
  if (!row) return 'Spevník';
  return [row.first_name, row.last_name].filter(Boolean).join(' ') || 'Spevník';
}

export async function getUserByEmail(database, email) {
  const [row] = await database('directus_users')
    .where('email', email)
    .select('id', 'status', 'first_name', 'last_name')
    .limit(1);
  return row || null;
}

export async function getUserName(database, userId, fallbackEmail) {
  if (!userId) return fallbackEmail || null;
  const [row] = await database('directus_users').where('id', userId).select('first_name', 'last_name', 'email').limit(1);
  if (!row) return fallbackEmail || null;
  return [row.first_name, row.last_name].filter(Boolean).join(' ') || row.email;
}

export async function getOwnerEmails(database, bandId) {
  const rows = await database('access')
    .join('directus_users', 'access.user', 'directus_users.id')
    .where('access.band', bandId)
    .whereNotNull('access.owner')
    .whereNotNull('directus_users.email')
    .select('directus_users.email');
  return rows.map(r => r.email);
}

// ── Access upsert ──

export async function upsertAccess(database, roleType, userId, bandId) {
  const field = ACCESS_FIELD[roleType];
  const value = ACCESS_VALUE[roleType];
  if (!field || !value) throw new Error(`Unknown role_type: ${roleType}`);

  const [existing] = await database('access')
    .where({ user: userId, band: bandId })
    .select('id', field)
    .limit(1);

  if (existing) {
    if (existing[field] === value) return false;
    await database('access').where('id', existing.id).update({ [field]: value });
    return true;
  }

  await database('access').insert({ user: userId, band: bandId, [field]: value });
  return true;
}

// ── Deduplication ──

export async function isDuplicate(database, email, bandId, roleType, excludeId) {
  const [row] = await database('invitations')
    .where({ email, band: bandId, role_type: roleType })
    .whereNot('id', excludeId)
    .select('id')
    .limit(1);
  return !!row;
}

// ── Batch notification (shared by delete + expiry) ──

export async function sendBatchNotification(pendingInvitations, mailService, database, logger, {
  inviteeSubject, inviteeHeading, ownerSubject, ownerHeading, ttlNote = false,
}) {
  if (!pendingInvitations.length) return;

  const inviteeEmails = new Set();
  const inviteeLines = [];
  const ownerLines = [];
  const allOwnerEmails = new Set();

  for (const inv of pendingInvitations) {
    const bandTitle = await getBandTitle(database, inv.band);
    if (!bandTitle) continue;

    const role = roleSk(inv.role_type);
    inviteeEmails.add(inv.email);
    inviteeLines.push(`<strong>Kapela:</strong> ${bandTitle} — <strong>Rola:</strong> ${role}`);
    ownerLines.push(`<strong>${inv.email}</strong> — ${bandTitle} (${role})`);

    const ownerEmails = await getOwnerEmails(database, inv.band);
    ownerEmails.forEach(e => allOwnerEmails.add(e));
  }

  if (inviteeEmails.size) {
    await mailService.send({
      to: [...inviteeEmails],
      subject: typeof inviteeSubject === 'function' ? inviteeSubject(pendingInvitations.length) : inviteeSubject,
      html: buildEmailHtml({ heading: inviteeHeading, items: inviteeLines, ttlNote }),
    }).catch(err => logger.error(`[invitations] Batch mail to invitees failed: ${err.message}`));
  }

  if (allOwnerEmails.size) {
    await mailService.send({
      to: [...allOwnerEmails],
      subject: ownerSubject,
      html: buildEmailHtml({ heading: ownerHeading, items: ownerLines }),
    }).catch(err => logger.error(`[invitations] Batch mail to owners failed: ${err.message}`));
  }
}

// ── Orphan cleanup (shared by delete + expiry) ──

export async function cleanupOrphanedUsers(database, emails, logger) {
  for (const email of [...new Set(emails)]) {
    const [remaining] = await database('invitations').where('email', email).select('id').limit(1);
    if (remaining) continue;

    const [orphan] = await database('directus_users')
      .where({ email, status: 'invited' })
      .select('id')
      .limit(1);

    if (orphan) {
      await database('directus_users').where('id', orphan.id).delete();
      logger.info(`[invitations] Deleted orphan invited user ${email}`);
    }
  }
}

// ── Email HTML ──

export function buildEmailHtml({ heading, items, ctaText, ctaUrl, footer, ttlNote = false }) {
  const listHtml = items.map(i => `<li>${i}</li>`).join('');
  const ctaHtml = ctaUrl
    ? `<p style="margin:20px 0"><a href="${ctaUrl}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:bold">${ctaText}</a></p>`
    : '';
  const ttlHtml = ttlNote
    ? `<p style="color:#888;font-size:13px;margin-top:16px">Platnosť pozvánky: ${INVITE_TTL_DAYS} dní od odoslania.</p>`
    : '';
  const footerHtml = footer
    ? `<p style="color:#666;font-size:12px;margin-top:20px">${footer}</p>`
    : '';

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px">`
    + `<p>${heading}</p><ul>${listHtml}</ul>${ctaHtml}${ttlHtml}${footerHtml}</div>`;
}
