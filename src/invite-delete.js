import {
  roleSk, getOwnerEmails, getBandTitle, buildEmailHtml
} from './helpers.js';

export async function preDeleteCapture(keys, { database, logger }) {
  try {
    const ids = Array.isArray(keys) ? keys : [keys];
    const invitations = await database('invitations')
      .whereIn('id', ids)
      .select('id', 'email', 'band', 'role_type', 'status');
    return invitations;
  } catch (err) {
    logger.error(`[invitation-handler] preDeleteCapture error: ${err.message}`);
    return [];
  }
}

export async function postDeleteProcess(deletedInvitations, { services, database, getSchema, logger }) {
  if (!deletedInvitations.length) return;

  const schema = await getSchema();
  const mailService = new services.MailService({ schema });

  const pendingInvitations = deletedInvitations.filter(inv => inv.status !== 'accepted');

  if (pendingInvitations.length) {
    const notifyEmails = new Set();
    const lines = [];
    const ownerLines = [];
    const allOwnerEmails = new Set();

    for (const inv of pendingInvitations) {
      const bandTitle = await getBandTitle(database, inv.band);
      if (!bandTitle) continue;

      const role = roleSk(inv.role_type);
      notifyEmails.add(inv.email);
      lines.push(`<strong>Kapela:</strong> ${bandTitle} — <strong>Rola:</strong> ${role}`);
      ownerLines.push(`<strong>${inv.email}</strong> — ${bandTitle} (${role})`);

      const ownerEmails = await getOwnerEmails(database, inv.band);
      ownerEmails.forEach(e => allOwnerEmails.add(e));
    }

    if (notifyEmails.size) {
      const subject = pendingInvitations.length === 1
        ? 'Pozvánka do kapely bola zrušená'
        : 'Vaše pozvánky do kapiel boli zrušené';

      await mailService.send({
        to: [...notifyEmails],
        subject,
        html: buildEmailHtml({
          heading: 'Nasledujúce pozvánky boli zrušené:',
          items: lines,
        }),
      }).catch(err => logger.error(`[invitation-handler] Cancel mail failed: ${err.message}`));
    }

    if (allOwnerEmails.size) {
      await mailService.send({
        to: [...allOwnerEmails],
        subject: 'Pozvánky do vašej kapely boli zrušené',
        html: buildEmailHtml({
          heading: 'Nasledujúce pozvánky boli zrušené:',
          items: ownerLines,
        }),
      }).catch(err => logger.error(`[invitation-handler] Cancel owner mail failed: ${err.message}`));
    }
  }

  // Cleanup orphan invited users
  const emails = [...new Set(deletedInvitations.map(i => i.email))];
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
