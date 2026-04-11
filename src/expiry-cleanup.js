import {
  INVITE_TTL_DAYS, sendBatchNotification, cleanupOrphanedUsers,
} from './helpers.js';

export async function handleExpiryCleanup({ services, database, getSchema, logger }) {
  const cutoff = new Date(Date.now() - INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const expired = await database('invitations')
    .where('date_created', '<', cutoff)
    .select('id', 'email', 'band', 'role_type', 'status');

  if (!expired.length) {
    logger.info('[invitations] No expired invitations');
    return;
  }

  const pending = expired.filter(inv => inv.status === 'pending');

  if (pending.length) {
    const schema = await getSchema();
    const mailService = new services.MailService({ schema });

    await sendBatchNotification(pending, mailService, database, logger, {
      inviteeSubject: 'Vaše pozvánky do kapiel expirovali',
      inviteeHeading: `Nasledujúce pozvánky expirovali po ${INVITE_TTL_DAYS} dňoch:`,
      ownerSubject: 'Pozvánky do vašej kapely expirovali',
      ownerHeading: 'Nasledujúce pozvánky expirovali:',
    });
  }

  const expiredIds = expired.map(inv => inv.id);
  await database('invitations').whereIn('id', expiredIds).delete();
  logger.info(`[invitations] Deleted ${expiredIds.length} expired invitations (${pending.length} pending, ${expiredIds.length - pending.length} accepted)`);

  await cleanupOrphanedUsers(database, expired.map(i => i.email), logger, services, getSchema);
}
