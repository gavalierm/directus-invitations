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

  // Validate band exists
  const bandTitle = await getBandTitle(database, bandId);
  if (!bandTitle) {
    logger.warn(`[invitations] Band ${bandId} not found, deleting invitation ${key}`);
    await invitationsService.deleteOne(key);
    return;
  }

  // Deduplicate
  if (await isDuplicate(database, email, bandId, roleType, key)) {
    logger.info(`[invitations] Duplicate invitation for ${email} band=${bandId} role=${roleType}, deleting ${key}`);
    await invitationsService.deleteOne(key);
    return;
  }

  const inviterName = await getInviterName(database, inviterId);
  const ownerEmails = await getOwnerEmails(database, bandId);
  const role = roleSk(roleType);
  const token = createInviteToken(env, email, key);
  const inviteUrl = `${getAppUrl(env)}/accept-invite?token=${encodeURIComponent(token)}`;

  const user = await getUserByEmail(database, email);

  if (!user) {
    // ── New user: create with invited status ──
    const roleId = await getDefaultRole(env, database);
    if (!roleId) {
      logger.error(`[invitations] No default role configured. Deleting invitation ${key}.`);
      await invitationsService.deleteOne(key);
      return;
    }

    const usersService = new services.ItemsService('directus_users', { schema, accountability: { admin: true } });
    const newUserId = await usersService.createOne({ email, role: roleId, status: 'invited' });
    logger.info(`[invitations] Created invited user ${newUserId} for ${email}`);

    await mailService.send({
      to: email,
      subject: `Pozvánka do kapely ${bandTitle} — Spevník`,
      html: buildEmailHtml({
        heading: 'Ahoj,',
        items: [
          `<strong>Kapela:</strong> ${bandTitle}`,
          `<strong>Rola:</strong> ${role}`,
          `<strong>Pozval/a:</strong> ${inviterName}`,
        ],
        ctaText: 'Aktivovať účet',
        ctaUrl: inviteUrl,
        footer: 'Pre aktiváciu kliknite na tlačidlo a nastavte si heslo.',
        ttlNote: true,
      }),
    }).catch(err => logger.error(`[invitations] Invite mail to ${email} failed: ${err.message}`));

  } else if (user.status === 'invited') {
    // ── Existing invited user: send invite email with new token ──
    await mailService.send({
      to: email,
      subject: `Pozvánka do kapely ${bandTitle} — Spevník`,
      html: buildEmailHtml({
        heading: 'Ahoj,',
        items: [
          `<strong>Kapela:</strong> ${bandTitle}`,
          `<strong>Rola:</strong> ${role}`,
          `<strong>Pozval/a:</strong> ${inviterName}`,
        ],
        ctaText: 'Aktivovať účet',
        ctaUrl: inviteUrl,
        footer: 'Pre aktiváciu kliknite na tlačidlo a nastavte si heslo.',
        ttlNote: true,
      }),
    }).catch(err => logger.error(`[invitations] Invite mail to ${email} failed: ${err.message}`));

  } else {
    // ── Active user: send accept email ──
    const userName = [user.first_name, user.last_name].filter(Boolean).join(' ') || email;

    await mailService.send({
      to: email,
      subject: `Pozvánka do kapely ${bandTitle} — Spevník`,
      html: buildEmailHtml({
        heading: `Ahoj ${userName},`,
        items: [
          `<strong>Kapela:</strong> ${bandTitle}`,
          `<strong>Rola:</strong> ${role}`,
          `<strong>Pozval/a:</strong> ${inviterName}`,
        ],
        ctaText: 'Akceptovať pozvánku',
        ctaUrl: inviteUrl,
        ttlNote: true,
      }),
    }).catch(err => logger.error(`[invitations] Accept mail to ${email} failed: ${err.message}`));
  }

  // Notify band owners
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
