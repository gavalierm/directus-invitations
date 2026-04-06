import {
  roleSk, junctionCollection, junctionExists, getOwnerEmails,
  getBandTitle, buildEmailHtml, getAppUrl
} from './helpers.js';

export async function handleUserActivated({ keys, payload }, { services, database, getSchema, logger, env }) {
  if (payload?.status !== 'active') return;

  const schema = await getSchema();
  const invitationsService = new services.ItemsService('invitations', { schema, accountability: { admin: true } });
  const mailService = new services.MailService({ schema });

  for (const userId of (Array.isArray(keys) ? keys : [keys])) {
    const users = await database('directus_users')
      .where('id', userId)
      .select('id', 'email', 'first_name', 'last_name')
      .limit(1);

    const user = users[0];
    if (!user?.email) continue;

    const invitations = await database('invitations')
      .where({ email: user.email, status: 'pending' })
      .select('id', 'email', 'band', 'role_type');

    if (!invitations.length) continue;

    const userName = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email;
    const processedBands = [];

    for (const inv of invitations) {
      const collection = junctionCollection(inv.role_type);
      const bandTitle = await getBandTitle(database, inv.band);

      if (!bandTitle) {
        await invitationsService.updateOne(inv.id, { status: 'accepted' });
        continue;
      }

      if (collection && !(await junctionExists(database, collection, user.id, inv.band))) {
        await database(collection).insert({ user: user.id, band: inv.band });
        logger.info(`[invitation-handler] Activated: added ${user.email} to ${collection} for band ${inv.band}`);
      }

      await invitationsService.updateOne(inv.id, { status: 'accepted' });

      const ownerEmails = await getOwnerEmails(database, inv.band);
      if (ownerEmails.length) {
        const role = roleSk(inv.role_type);
        await mailService.send({
          to: ownerEmails,
          subject: `${userName} akceptoval pozvánku do kapely ${bandTitle}`,
          html: buildEmailHtml({
            heading: 'Nový používateľ akceptoval pozvánku a dokončil registráciu.',
            items: [
              `<strong>Používateľ:</strong> ${userName} (${user.email})`,
              `<strong>Kapela:</strong> ${bandTitle}`,
              `<strong>Rola:</strong> ${role}`,
            ],
          }),
        }).catch(err => logger.error(`[invitation-handler] Activated owner mail failed: ${err.message}`));
      }

      processedBands.push(`${bandTitle} (${roleSk(inv.role_type)})`);
    }

    if (processedBands.length) {
      await mailService.send({
        to: user.email,
        subject: 'Vitajte v Spevníku — boli ste priradení do kapiel',
        html: buildEmailHtml({
          heading: `Ahoj ${userName},`,
          items: processedBands,
          ctaText: 'Otvoriť Spevník',
          ctaUrl: getAppUrl(env),
          footer: 'Vaša registrácia bola dokončená a boli ste priradení do vyššie uvedených kapiel.',
        }),
      }).catch(err => logger.error(`[invitation-handler] Activated user mail failed: ${err.message}`));
    }
  }
}
