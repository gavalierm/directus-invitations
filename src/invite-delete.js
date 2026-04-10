import {
  roleSk, getOwnerEmails, getBandTitle, buildEmailHtml, INVITE_TTL_DAYS,
} from './helpers.js';

/**
 * Filter hook: captures invitation data BEFORE deletion.
 * Returns the data for use in the action hook.
 */
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

/**
 * Action hook: sends cancellation emails for PENDING invitations only.
 * Accepted invitations are deleted silently.
 * Also cleans up orphaned invited users.
 */
export async function postDeleteProcess(deletedInvitations, { services, database, getSchema, logger }) {
  if (!deletedInvitations.length) return;

  const pending = deletedInvitations.filter(inv => inv.status === 'pending');

  if (pending.length) {
    const schema = await getSchema();
    const mailService = new services.MailService({ schema });

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

    // Notify invited users
    if (inviteeEmails.size) {
      const subject = pending.length === 1
        ? 'Pozvánka do kapely bola zrušená'
        : 'Vaše pozvánky do kapiel boli zrušené';

      await mailService.send({
        to: [...inviteeEmails],
        subject,
        html: buildEmailHtml({
          heading: 'Nasledujúce pozvánky boli zrušené:',
          items: inviteeLines,
          ttlNote: true,
        }),
      }).catch(err => logger.error(`[invitations] Cancel mail to invitees failed: ${err.message}`));
    }

    // Notify owners
    if (allOwnerEmails.size) {
      await mailService.send({
        to: [...allOwnerEmails],
        subject: 'Pozvánky do vašej kapely boli zrušené',
        html: buildEmailHtml({
          heading: 'Nasledujúce pozvánky boli zrušené:',
          items: ownerLines,
        }),
      }).catch(err => logger.error(`[invitations] Cancel mail to owners failed: ${err.message}`));
    }
  }

  // Cleanup orphaned invited users
  const emails = [...new Set(deletedInvitations.map(i => i.email))];
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
