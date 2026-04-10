import {
  roleSk, getOwnerEmails, getBandTitle, buildEmailHtml, INVITE_TTL_DAYS,
} from './helpers.js';

export async function handleExpiryCleanup({ services, database, getSchema, logger }) {
  const schema = await getSchema();
  const mailService = new services.MailService({ schema });

  const cutoff = new Date(Date.now() - INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Find all invitations older than TTL (both statuses)
  const expired = await database('invitations')
    .where('date_created', '<', cutoff)
    .select('id', 'email', 'band', 'role_type', 'status');

  if (!expired.length) {
    logger.info('[invitations] No expired invitations');
    return;
  }

  // Separate pending (notify) from accepted (silent)
  const pending = expired.filter(inv => inv.status === 'pending');
  const expiredIds = expired.map(inv => inv.id);

  // Notify about expired pending invitations
  if (pending.length) {
    const inviteeEmails = new Set();
    const inviteeLines = [];
    const ownerLines = [];
    const allOwnerEmails = new Set();

    for (const inv of pending) {
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
        subject: 'Vaše pozvánky do kapiel expirovali',
        html: buildEmailHtml({
          heading: `Nasledujúce pozvánky expirovali po ${INVITE_TTL_DAYS} dňoch:`,
          items: inviteeLines,
          footer: 'Ak máte záujem, požiadajte o novú pozvánku.',
        }),
      }).catch(err => logger.error(`[invitations] Expiry mail to invitees failed: ${err.message}`));
    }

    if (allOwnerEmails.size) {
      await mailService.send({
        to: [...allOwnerEmails],
        subject: 'Pozvánky do vašej kapely expirovali',
        html: buildEmailHtml({
          heading: 'Nasledujúce pozvánky expirovali:',
          items: ownerLines,
        }),
      }).catch(err => logger.error(`[invitations] Expiry mail to owners failed: ${err.message}`));
    }
  }

  // Delete all expired invitations
  await database('invitations').whereIn('id', expiredIds).delete();
  logger.info(`[invitations] Deleted ${expiredIds.length} expired invitations (${pending.length} pending, ${expiredIds.length - pending.length} accepted)`);

  // Cleanup orphaned invited users
  const emails = [...new Set(expired.map(i => i.email))];
  for (const email of emails) {
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
