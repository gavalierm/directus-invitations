import {
  roleSk, getAppUrl, getDefaultRole, createInviteToken,
  getBandTitle, getInviterName, getUserByEmail, getOwnerEmails,
  isDuplicate, buildEmailHtml,
} from './helpers.js';

export async function handleInviteCreate({ key, payload }, { services, database, getSchema, logger, env }) {
  const schema = await getSchema();
  const invitationsService = new services.ItemsService('invitations', { schema, accountability: { admin: true } });
  const mailService = new services.MailService({ schema });

  const invitation = await invitationsService.readOne(key, {
    fields: ['id', 'email', 'band', 'role_type', 'user_created'],
  });
  if (!invitation) return;

  const { email, band: bandId, role_type: roleType, user_created: inviterId } = invitation;

  const bandTitle = await getBandTitle(database, bandId);
  if (!bandTitle) {
    logger.warn(`[invitations] Band ${bandId} not found, deleting invitation ${key}`);
    await invitationsService.deleteOne(key);
    return;
  }

  if (await isDuplicate(database, email, bandId, roleType, key)) {
    logger.info(`[invitations] Duplicate invitation for ${email} band=${bandId} role=${roleType}, deleting ${key}`);
    await invitationsService.deleteOne(key);
    return;
  }

  const inviterName = await getInviterName(database, inviterId);
  const role = roleSk(roleType);
  const token = createInviteToken(env, email, key);
  const inviteUrl = `${getAppUrl(env)}/accept-invite?token=${encodeURIComponent(token)}`;

  let user = await getUserByEmail(database, email);
  const usersService = new services.ItemsService('directus_users', { schema, accountability: { admin: true } });

  if (!user) {
    // New user — create with invited status
    const roleId = await getDefaultRole(env, database);
    if (!roleId) {
      logger.error(`[invitations] No default role configured. Deleting invitation ${key}.`);
      await invitationsService.deleteOne(key);
      return;
    }
    const newUserId = await usersService.createOne({ email, role: roleId, status: 'invited' });
    logger.info(`[invitations] Created invited user ${newUserId} for ${email}`);
    user = { status: 'invited' };
  } else if (user.status !== 'invited' && user.status !== 'active') {
    // Any other status (suspended, archived, ...) — reset to invited
    await usersService.updateOne(user.id, { status: 'invited' });
    logger.info(`[invitations] Reset user ${email} from ${user.status} to invited`);
    user.status = 'invited';
  }

  const isActive = user.status === 'active';
  const userName = [user.first_name, user.last_name].filter(Boolean).join(' ');

  await mailService.send({
    to: email,
    subject: `Pozvánka do kapely ${bandTitle} — Spevník`,
    html: buildEmailHtml({
      heading: userName ? `Ahoj ${userName},` : 'Ahoj,',
      items: [
        `<strong>Kapela:</strong> ${bandTitle}`,
        `<strong>Rola:</strong> ${role}`,
        `<strong>Pozval/a:</strong> ${inviterName}`,
      ],
      ctaText: isActive ? 'Akceptovať pozvánku' : 'Aktivovať účet',
      ctaUrl: inviteUrl,
      footer: isActive ? null : 'Pre aktiváciu kliknite na tlačidlo a nastavte si heslo.',
      ttlNote: true,
    }),
  }).catch(err => logger.error(`[invitations] Invite mail to ${email} failed: ${err.message}`));

  // Notify band owners
  const ownerEmails = await getOwnerEmails(database, bandId);
  if (ownerEmails.length) {
    await mailService.send({
      to: ownerEmails,
      subject: `Nová pozvánka do kapely ${bandTitle}`,
      html: buildEmailHtml({
        heading: 'Bola vytvorená nová pozvánka do vašej kapely.',
        items: [
          `<strong>E-mail:</strong> ${email}`,
          `<strong>Kapela:</strong> ${bandTitle}`,
          `<strong>Rola:</strong> ${role}`,
          `<strong>Pozval/a:</strong> ${inviterName}`,
        ],
        ttlNote: true,
      }),
    }).catch(err => logger.error(`[invitations] Owner notification failed: ${err.message}`));
  }
}
