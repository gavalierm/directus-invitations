import { sendBatchNotification, cleanupOrphanedUsers } from './helpers.js';

export async function preDeleteCapture(keys, { database, logger }) {
  try {
    const ids = Array.isArray(keys) ? keys : [keys];
    return await database('invitations')
      .whereIn('id', ids)
      .select('id', 'email', 'band', 'role_type', 'status');
  } catch (err) {
    logger.error(`[invitations] preDeleteCapture error: ${err.message}`);
    return [];
  }
}

export async function postDeleteProcess(deletedInvitations, { services, database, getSchema, logger }) {
  if (!deletedInvitations.length) return;

  const pending = deletedInvitations.filter(inv => inv.status === 'pending');

  if (pending.length) {
    const schema = await getSchema();
    const mailService = new services.MailService({ schema });

    await sendBatchNotification(pending, mailService, database, logger, {
      inviteeSubject: (count) => count === 1
        ? 'Pozvánka do kapely bola zrušená'
        : 'Vaše pozvánky do kapiel boli zrušené',
      inviteeHeading: 'Nasledujúce pozvánky boli zrušené:',
      ownerSubject: 'Pozvánky do vašej kapely boli zrušené',
      ownerHeading: 'Nasledujúce pozvánky boli zrušené:',
      ttlNote: true,
    });
  }

  await cleanupOrphanedUsers(database, deletedInvitations.map(i => i.email), logger);
}
