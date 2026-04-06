import jwt from 'jsonwebtoken';
import {
  roleSk, junctionCollection, getOwnerEmails, getInviterName, getBandTitle,
  junctionExists, buildEmailHtml, getAppUrl, getBandMemberRole
} from './helpers.js';

export async function handleInviteCreate({ key, payload }, { services, database, getSchema, logger, env }) {
  const schema = await getSchema();
  const invitationsService = new services.ItemsService('invitations', { schema, accountability: { admin: true } });
  const mailService = new services.MailService({ schema });

  const invitation = await invitationsService.readOne(key, {
    fields: ['id', 'email', 'band', 'role_type', 'user_created']
  });

  if (!invitation) return;

  const { email, band: bandId, role_type: roleType, user_created: inviterId } = invitation;

  const bandTitle = await getBandTitle(database, bandId);
  if (!bandTitle) {
    logger.warn(`[invitation-handler] Band ${bandId} not found, deleting invitation ${key}`);
    await invitationsService.deleteOne(key);
    return;
  }

  // Deduplicate: same email+band+role already exists
  const duplicates = await database('invitations')
    .where({ email, band: bandId, role_type: roleType })
    .whereNot('id', key)
    .select('id')
    .limit(1);

  if (duplicates.length) {
    logger.info(`[invitation-handler] Duplicate invitation for ${email}, deleting ${key}`);
    await invitationsService.deleteOne(key);
    return;
  }

  const inviterName = await getInviterName(database, inviterId);
  const ownerEmails = await getOwnerEmails(database, bandId);
  const role = roleSk(roleType);
  const collection = junctionCollection(roleType);

  const users = await database('directus_users')
    .where('email', email)
    .select('id', 'status', 'first_name', 'last_name')
    .limit(1);

  const user = users[0];

  if (user && user.status === 'active') {
    // ── Active user ──
    if (collection && !(await junctionExists(database, collection, user.id, bandId))) {
      await database(collection).insert({ user: user.id, band: bandId });
      logger.info(`[invitation-handler] Added ${email} to ${collection} for band ${bandId}`);
    }

    await invitationsService.updateOne(key, { status: 'accepted' });

    const userName = [user.first_name, user.last_name].filter(Boolean).join(' ') || email;

    await mailService.send({
      to: email,
      subject: `Boli ste priradení do kapely ${bandTitle}`,
      html: buildEmailHtml({
        heading: `Ahoj ${userName},`,
        items: [
          `<strong>Kapela:</strong> ${bandTitle}`,
          `<strong>Rola:</strong> ${role}`,
          `<strong>Pridal/a:</strong> ${inviterName}`,
        ],
        ctaText: 'Otvoriť Spevník',
        ctaUrl: getAppUrl(env),
      }),
    }).catch(err => logger.error(`[invitation-handler] Mail to ${email} failed: ${err.message}`));

    if (ownerEmails.length) {
      await mailService.send({
        to: ownerEmails,
        subject: `Nový ${role} v kapele ${bandTitle}`,
        html: buildEmailHtml({
          heading: `Do vašej kapely bol pridaný nový ${role}.`,
          items: [
            `<strong>Používateľ:</strong> ${userName} (${email})`,
            `<strong>Kapela:</strong> ${bandTitle}`,
            `<strong>Rola:</strong> ${role}`,
            `<strong>Pridal/a:</strong> ${inviterName}`,
          ],
        }),
      }).catch(err => logger.error(`[invitation-handler] Mail to owners failed: ${err.message}`));
    }

  } else if (user && user.status === 'invited') {
    // ── Already invited ──
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
            `<strong>Stav:</strong> Čaká na akceptáciu`,
          ],
        }),
      }).catch(err => logger.error(`[invitation-handler] Mail to owners failed: ${err.message}`));
    }

  } else {
    // ── New user ──
    const usersService = new services.ItemsService('directus_users', { schema, accountability: { admin: true } });
    const newUserId = await usersService.createOne({
      email,
      role: getBandMemberRole(env),
      status: 'invited',
    });

    logger.info(`[invitation-handler] Created invited user ${newUserId} for ${email}`);

    const token = jwt.sign(
      { email, scope: 'invite' },
      env.SECRET,
      { expiresIn: env.USER_INVITE_TOKEN_TTL || '7d', issuer: 'directus' }
    );

    const inviteUrl = `${getAppUrl(env)}/accept-invite?token=${encodeURIComponent(token)}`;

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
      }),
    }).catch(err => logger.error(`[invitation-handler] Invite mail to ${email} failed: ${err.message}`));

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
            `<strong>Stav:</strong> Čaká na akceptáciu`,
          ],
        }),
      }).catch(err => logger.error(`[invitation-handler] Mail to owners failed: ${err.message}`));
    }
  }
}
