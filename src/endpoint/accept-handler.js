import {
  verifyInviteToken,
  getBandTitle,
  getOwnerEmails,
  roleSk,
  upsertAccess,
  buildEmailHtml,
  getAppUrl,
} from '../shared/helpers.js';
import { BusinessError } from '../shared/errors.js';

const MIN_PASSWORD_LENGTH = 8;

export async function handleAccept(body, { services, database, getSchema, env, logger }, _notifyAdmins) {
  const invitationId = body?.invitation_id;
  const token = body?.token;

  if (invitationId == null || typeof token !== 'string' || !token) {
    throw new BusinessError('INVALID_PAYLOAD', 400, 'invitation_id a token sú povinné.');
  }

  const firstName = typeof body.first_name === 'string' ? body.first_name.trim() : null;
  const lastName = typeof body.last_name === 'string' ? body.last_name.trim() : null;
  const password = typeof body.password === 'string' ? body.password : null;

  let tokenPayload;
  try {
    tokenPayload = verifyInviteToken(env, token);
  } catch {
    throw new BusinessError('INVALID_TOKEN', 403, 'Neplatný alebo expirovaný aktivačný odkaz.');
  }

  if (String(tokenPayload.invitation_id) !== String(invitationId)) {
    throw new BusinessError('INVALID_TOKEN', 403, 'Token nesúhlasí s pozvánkou.');
  }

  const [invitation] = await database('invitations')
    .where('id', invitationId)
    .select('id', 'email', 'band', 'role_type', 'status')
    .limit(1);

  if (!invitation) {
    throw new BusinessError('INVITATION_NOT_FOUND', 404, 'Pozvánka neexistuje.');
  }
  if (invitation.status !== 'pending') {
    throw new BusinessError('INVITATION_ALREADY_ACCEPTED', 409, 'Táto pozvánka už bola akceptovaná.');
  }
  if (invitation.email !== tokenPayload.email) {
    throw new BusinessError('INVALID_TOKEN', 403, 'Token nesúhlasí s pozvánkou.');
  }

  const [user] = await database('directus_users')
    .where('email', invitation.email)
    .select('id', 'status', 'first_name', 'last_name')
    .limit(1);

  if (!user) {
    throw new BusinessError('USER_NOT_FOUND', 404, 'Používateľ k pozvánke neexistuje.');
  }

  const wasInvited = user.status === 'invited';
  if (wasInvited) {
    if (!password) {
      throw new BusinessError('PASSWORD_REQUIRED', 400, 'Heslo je povinné pre aktiváciu účtu.');
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new BusinessError('PASSWORD_TOO_SHORT', 400, `Heslo musí mať aspoň ${MIN_PASSWORD_LENGTH} znakov.`);
    }
  }

  const schema = await getSchema();
  const usersService = new services.UsersService({ schema, accountability: { admin: true } });

  const userUpdates = {};
  if (wasInvited) {
    userUpdates.status = 'active';
    userUpdates.password = password;
  }
  if (firstName) userUpdates.first_name = firstName;
  if (lastName) userUpdates.last_name = lastName;
  if (Object.keys(userUpdates).length) {
    await usersService.updateOne(user.id, userUpdates);
  }

  // Verify password was actually persisted — UsersService.updateOne() can
  // silently drop the password (e.g. if argon2 hashing fails internally).
  // This is a critical integrity check: an active user without a password
  // is locked out permanently.
  if (wasInvited) {
    const [check] = await database('directus_users')
      .where('id', user.id)
      .select('password')
      .limit(1);
    if (!check?.password) {
      const err = new Error(
        `Password not persisted for user ${user.id} (${invitation.email}) after UsersService.updateOne(). ` +
        `User is now status=active with no password — manual intervention required.`,
      );
      err.adminsNotified = true;
      if (_notifyAdmins) {
        await _notifyAdmins('invitations:accept-password-lost', err, {
          user_id: user.id,
          email: invitation.email,
          invitation_id: invitation.id,
          band: invitation.band,
        });
      }
      throw err;
    }
  }

  const invitationsService = new services.ItemsService('invitations', {
    schema,
    accountability: { admin: true },
  });
  await invitationsService.updateOne(invitationId, { status: 'accepted' }, { emitEvents: false });

  await upsertAccess(services, schema, invitation.role_type, user.id, invitation.band);

  const mailService = new services.MailService({ schema });
  const bandTitle = await getBandTitle(database, invitation.band);
  const role = roleSk(invitation.role_type);
  const fullName = [firstName || user.first_name, lastName || user.last_name].filter(Boolean).join(' ') || invitation.email;

  mailService.send({
    to: invitation.email,
    subject: `Boli ste pridaný do kapely ${bandTitle}`,
    html: buildEmailHtml({
      heading: `Ahoj ${fullName},`,
      items: [
        `<strong>Kapela:</strong> ${bandTitle}`,
        `<strong>Rola:</strong> ${role}`,
      ],
      ctaText: 'Otvoriť Spevník',
      ctaUrl: getAppUrl(env),
    }),
  }).catch(err => logger.error(`[invitations] Confirmation mail to ${invitation.email} failed: ${err.message}`));

  const ownerEmails = await getOwnerEmails(database, invitation.band);
  if (ownerEmails.length) {
    mailService.send({
      to: ownerEmails,
      subject: `${fullName} akceptoval pozvánku do kapely ${bandTitle}`,
      html: buildEmailHtml({
        heading: 'Pozvánka bola akceptovaná.',
        items: [
          `<strong>Používateľ:</strong> ${fullName} (${invitation.email})`,
          `<strong>Kapela:</strong> ${bandTitle}`,
          `<strong>Rola:</strong> ${role}`,
        ],
      }),
    }).catch(err => logger.error(`[invitations] Owner accept notification failed: ${err.message}`));
  }

  return {
    invitation_id: invitation.id,
    band: { id: invitation.band, title: bandTitle },
    role_type: invitation.role_type,
    was_invited: wasInvited,
    user_id: user.id,
  };
}
