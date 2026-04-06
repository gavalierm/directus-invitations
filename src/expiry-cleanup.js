import {
  roleSk, getOwnerEmails, getBandTitle, buildEmailHtml, INVITE_TTL_DAYS
} from './helpers.js';

export async function handleExpiryCleanup({ services, database, getSchema, logger }) {
  const schema = await getSchema();
  const mailService = new services.MailService({ schema });

  // 1. Delete accepted invitations silently
  const acceptedCount = await database('invitations')
    .where('status', 'accepted')
    .delete();

  if (acceptedCount) {
    logger.info(`[invitation-handler] Cleaned up ${acceptedCount} accepted invitations`);
  }

  // 2. Find expired pending invitations
  const cutoff = new Date(Date.now() - INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const expired = await database('invitations')
    .where('status', 'pending')
    .where('date_created', '<', cutoff)
    .select('id', 'email', 'band', 'role_type');

  if (!expired.length) {
    logger.info('[invitation-handler] No expired invitations');
    return;
  }

  const invitedEmails = new Set();
  const invitedLines = [];
  const ownerLines = [];
  const allOwnerEmails = new Set();
  const expiredIds = [];

  for (const inv of expired) {
    expiredIds.push(inv.id);
    const bandTitle = await getBandTitle(database, inv.band);
    if (!bandTitle) continue;

    const role = roleSk(inv.role_type);
    invitedEmails.add(inv.email);
    invitedLines.push(`<strong>Kapela:</strong> ${bandTitle} — <strong>Rola:</strong> ${role}`);
    ownerLines.push(`<strong>${inv.email}</strong> — ${bandTitle} (${role})`);

    const ownerEmails = await getOwnerEmails(database, inv.band);
    ownerEmails.forEach(e => allOwnerEmails.add(e));
  }

  // Email invited users
  if (invitedEmails.size) {
    await mailService.send({
      to: [...invitedEmails],
      subject: 'Vaše pozvánky do kapiel expirovali',
      html: buildEmailHtml({
        heading: `Nasledujúce pozvánky expirovali po ${INVITE_TTL_DAYS} dňoch:`,
        items: invitedLines,
        footer: 'Ak máte záujem, požiadajte o novú pozvánku.',
      }),
    }).catch(err => logger.error(`[invitation-handler] Expiry mail to users failed: ${err.message}`));
  }

  // Email owners
  if (allOwnerEmails.size) {
    await mailService.send({
      to: [...allOwnerEmails],
      subject: 'Pozvánky do vašej kapely expirovali',
      html: buildEmailHtml({
        heading: 'Nasledujúce pozvánky expirovali:',
        items: ownerLines,
      }),
    }).catch(err => logger.error(`[invitation-handler] Expiry mail to owners failed: ${err.message}`));
  }

  // Delete expired invitations
  await database('invitations').whereIn('id', expiredIds).delete();
  logger.info(`[invitation-handler] Deleted ${expiredIds.length} expired invitations`);

  // Cleanup orphan invited users
  const emails = [...new Set(expired.map(i => i.email))];
  for (const email of emails) {
    const remaining = await database('invitations').where('email', email).select('id').limit(1);
    if (remaining.length) continue;

    const orphans = await database('directus_users')
      .where({ email, status: 'invited' })
      .select('id')
      .limit(1);

    if (orphans.length) {
      await database('directus_users').where('id', orphans[0].id).delete();
      logger.info(`[invitation-handler] Deleted orphan invited user ${email}`);
    }
  }
}
