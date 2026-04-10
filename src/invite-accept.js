import {
  verifyInviteToken, roleSk, upsertAccess,
  getBandTitle, getUserName, getOwnerEmails, buildEmailHtml, getAppUrl,
} from './helpers.js';

/**
 * Filter hook: runs BEFORE the update is written to DB.
 * Invitation is immutable after creation. Only allowed PATCH:
 *   { status: "accepted", token: "jwt" }
 *   { status: "accepted", token: "jwt", password: "xxx" }  (for invited users)
 *
 * - Verifies JWT (signature, expiry, scope, invitation_id match)
 * - If user is "invited" and password provided: activates user via UsersService
 * - Strips token + password from payload (not DB fields)
 * - Attaches _verified data for the action hook
 */
export async function filterInviteUpdate(payload, meta, { env, database, services, getSchema, logger }) {
  const keys = meta.keys || [];
  if (!keys.length) return payload;

  const allowedKeys = new Set(['status', 'token', 'password']);
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
  const targetId = String(tokenPayload.invitation_id);
  if (keys.length !== 1 || String(keys[0]) !== targetId) {
    throw new Error('Token nesúhlasí s pozvánkou.');
  }

  // Check invitation is still pending
  const [invitation] = await database('invitations')
    .where('id', tokenPayload.invitation_id)
    .select('status')
    .limit(1);

  if (!invitation) {
    throw new Error('Pozvánka neexistuje.');
  }

  if (invitation.status === 'accepted') {
    throw new Error('Pozvánka už bola akceptovaná.');
  }

  // Find user by email
  const [user] = await database('directus_users')
    .where('email', tokenPayload.email)
    .select('id', 'status')
    .limit(1);

  if (!user) {
    throw new Error('Používateľ neexistuje.');
  }

  // If user is "invited" — activate with password
  if (user.status === 'invited') {
    if (!payload.password) {
      throw new Error('Heslo je povinné pre aktiváciu účtu.');
    }

    const schema = await getSchema();
    const usersService = new services.UsersService({ schema, accountability: { admin: true } });
    await usersService.updateOne(user.id, { status: 'active', password: payload.password });
    logger.info(`[invitations] Activated user ${tokenPayload.email}`);
  }

  // Strip non-DB fields
  delete payload.token;
  delete payload.password;

  // Attach verified data for action hook
  payload._verified = {
    email: tokenPayload.email,
    invitationId: tokenPayload.invitation_id,
    userId: user.id,
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
  if (!verified) return;

  const schema = await getSchema();
  const mailService = new services.MailService({ schema });

  const [invitation] = await database('invitations')
    .where('id', verified.invitationId)
    .select('id', 'email', 'band', 'role_type')
    .limit(1);

  if (!invitation) {
    logger.warn(`[invitations] Accepted invitation ${verified.invitationId} not found`);
    return;
  }

  const { email, band: bandId, role_type: roleType } = invitation;

  // Upsert access
  const changed = await upsertAccess(database, roleType, verified.userId, bandId);
  if (changed) {
    logger.info(`[invitations] Access upserted: ${email} → ${roleType} in band ${bandId}`);
  }

  const bandTitle = await getBandTitle(database, bandId);
  const role = roleSk(roleType);
  const userName = await getUserName(database, verified.userId, email);

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
