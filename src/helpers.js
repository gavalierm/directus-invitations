export const ROLE_MAP = { member: 'člen', admin: 'správca', owner: 'vlastník' };
export const COLLECTION_MAP = { member: 'members', admin: 'admins', owner: 'owners' };
export const INVITE_TTL_DAYS = 7;

export function getAppUrl(env) {
  const url = env.INVITATION_APP_URL || env.PUBLIC_URL;
  return url?.replace(/\/+$/, '');
}

export async function getBandMemberRole(env, database) {
  // 1. Explicit override for this extension
  if (env.INVITATION_DEFAULT_ROLE) return env.INVITATION_DEFAULT_ROLE;

  // 2. Runtime-configurable Directus setting (Settings → Project Settings → Public Registration → Default Role)
  try {
    const rows = await database('directus_settings')
      .select('public_registration_role')
      .limit(1);
    if (rows[0]?.public_registration_role) return rows[0].public_registration_role;
  } catch {
    // fall through to env fallback
  }

  // 3. Legacy SSO default
  return env.AUTH_DEFAULT_ROLE || null;
}

export function roleSk(roleType) {
  return ROLE_MAP[roleType] || roleType;
}

export function junctionCollection(roleType) {
  return COLLECTION_MAP[roleType] || null;
}

export async function getOwnerEmails(database, bandId) {
  const owners = await database('owners')
    .join('directus_users', 'owners.user', 'directus_users.id')
    .where('owners.band', bandId)
    .whereNotNull('directus_users.email')
    .select('directus_users.email');
  return owners.map(o => o.email);
}

export async function getInviterName(database, userId) {
  if (!userId) return 'Spevník';
  const rows = await database('directus_users')
    .where('id', userId)
    .select('first_name', 'last_name')
    .limit(1);
  if (!rows.length) return 'Spevník';
  return [rows[0].first_name, rows[0].last_name].filter(Boolean).join(' ') || 'Spevník';
}

export async function getBandTitle(database, bandId) {
  const rows = await database('bands').where('id', bandId).select('title').limit(1);
  return rows.length ? rows[0].title : null;
}

export async function junctionExists(database, collection, userId, bandId) {
  const rows = await database(collection)
    .where({ user: userId, band: bandId })
    .select('id')
    .limit(1);
  return rows.length > 0;
}

export function buildEmailHtml({ heading, items, ctaText, ctaUrl, footer }) {
  const listHtml = items.map(i => `<li>${i}</li>`).join('');
  const ctaHtml = ctaUrl
    ? `<p style="margin:20px 0"><a href="${ctaUrl}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:bold">${ctaText}</a></p>`
    : '';
  const footerHtml = footer ? `<p style="color:#666;font-size:12px;margin-top:20px">${footer}</p>` : '';
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px">`
    + `<p>${heading}</p><ul>${listHtml}</ul>${ctaHtml}${footerHtml}</div>`;
}
