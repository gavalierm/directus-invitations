import {
  verifyInviteToken, roleSk, upsertAccess,
  getBandTitle, getUserName, getOwnerEmails, buildEmailHtml, getAppUrl,
} from './helpers.js';

/**
 * Filter hook: runs BEFORE the update is written to DB.
 * - Validates that the only allowed PATCH is { status: "accepted", token: "jwt" }
 * - Verifies JWT (signature, expiry, scope, invitation_id match)
 * - Strips `token` from payload (not a DB field)
 */
export function filterInviteUpdate(payload, meta, { env, database, logger }) {
  const keys = meta.keys || [];
  if (!keys.length) return payload;

  // Only allow { status: "accepted", token: "..." }
  const allowedKeys = new Set(['status', 'token']);
  const payloadKeys = Object.keys(payload);

  if (payloadKeys.some(k => !allowedKeys.has(k))) {
    throw new Error('Invitation je po vytvorení nemenná. Povolená je len akceptácia.');
  }

  if (payload.status !== 'accepted') {
    throw new Error('Invitation je po vytvorení nemenná. Povolená je len akceptácia.');
  }

  if (!payload.token) {
    throw new Error('Token je povinný pre akceptáciu pozvánky.');
  }

  // Verify JWT
  let tokenPayload;
  try {
    tokenPayload = verifyInviteToken(env, payload.token);
  } catch (err) {
    throw new Error(`Neplatný alebo expirovaný token: ${err.message}`);
  }

  // Verify invitation_id matches
  // Directus passes keys as strings; invitation_id in token is a number
  const targetId = String(tokenPayload.invitation_id);
  if (keys.length !== 1 || String(keys[0]) !== targetId) {
    throw new Error('Token nesúhlasí s pozvánkou.');
  }

  // Strip token from payload — not a DB field
  delete payload.token;

  // Attach verified data for the action hook
  payload._verified = {
    email: tokenPayload.email,
    invitationId: tokenPayload.invitation_id,
  };

  return payload;
}

/**
 * Action hook: runs AFTER the update is written to DB.
 * Creates/updates access record and sends confirmation emails.
 */
export async function handleInviteAccepted({ keys, payload }, { services, database, getSchema, logger, env }) {
  if (payload?.status !== 'accepted') return;

  const verified = payload._verified;
  if (!verified) return; // not from the accept flow

  const schema = await getSchema();
  const mailService = new services.MailService({ schema });

  const invitationId = verified.invitationId;

  const [invitation] = await database('invitations')
    .where('id', invitationId)
    .select('id', 'email', 'band', 'role_type')
    .limit(1);

  if (!invitation) {
    logger.warn(`[invitations] Accepted invitation ${invitationId} not found`);
    return;
  }

  const { email, band: bandId, role_type: roleType } = invitation;

  // Find user
  const [user] = await database('directus_users')
    .where('email', email)
    .select('id', 'first_name', 'last_name')
    .limit(1);

  if (!user) {
    logger.error(`[invitations] User ${email} not found for accepted invitation ${invitationId}`);
    return;
  }

  // Upsert access
  const changed = await upsertAccess(database, roleType, user.id, bandId);
  if (changed) {
    logger.info(`[invitations] Access upserted: ${email} → ${roleType} in band ${bandId}`);
  }

  // Send confirmation emails
  const bandTitle = await getBandTitle(database, bandId);
  const role = roleSk(roleType);
  const userName = [user.first_name, user.last_name].filter(Boolean).join(' ') || email;

  // Email to accepted user
  await mailService.send({
    to: email,
    subject: `Boli ste pridaný do kapely ${bandTitle}`,
    html: buildEmailHtml({
      heading: `Ahoj ${userName},`,
      items: [
        `<strong>Kapela:</strong> ${bandTitle}`,
        `<strong>Rola:</strong> ${role}`,
      ],
      ctaText: 'Otvoriť Spevník',
      ctaUrl: getAppUrl(env),
    }),
  }).catch(err => logger.error(`[invitations] Confirmation mail to ${email} failed: ${err.message}`));

  // Email to band owners
  const ownerEmails = await getOwnerEmails(database, bandId);
  if (ownerEmails.length) {
    await mailService.send({
      to: ownerEmails,
      subject: `${userName} akceptoval pozvánku do kapely ${bandTitle}`,
      html: buildEmailHtml({
        heading: 'Pozvánka bola akceptovaná.',
        items: [
          `<strong>Používateľ:</strong> ${userName} (${email})`,
          `<strong>Kapela:</strong> ${bandTitle}`,
          `<strong>Rola:</strong> ${role}`,
        ],
      }),
    }).catch(err => logger.error(`[invitations] Owner accept notification failed: ${err.message}`));
  }
}
