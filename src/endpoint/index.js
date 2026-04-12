import { handleAccept } from './accept-handler.js';
import { notifyAdmins } from '../shared/notify-admin.js';

export default {
  id: 'invitations-accept',
  handler: (router, context) => {
    const { services, database, getSchema, logger, env } = context;
    const ctx = { services, database, getSchema, logger, env };

    router.post('/', async (req, res) => {
      try {
        const notify = (source, err, context) => notifyAdmins(ctx, source, err, context);
        const result = await handleAccept(req.body || {}, ctx, notify);
        res.status(200).json({ data: result });
      } catch (err) {
        if (err?.isBusinessError) {
          res.status(err.status).json({
            errors: [{ message: err.message, extensions: { code: err.code } }],
          });
          return;
        }
        if (!err.adminsNotified) {
          await notifyAdmins(ctx, 'invitations:accept-endpoint', err, {
            body: req.body,
            ip: req.ip,
            ua: req.headers?.['user-agent'],
          });
        }
        res.status(500).json({
          errors: [{
            message: 'An unexpected error occurred.',
            extensions: { code: 'INTERNAL_SERVER_ERROR' },
          }],
        });
      }
    });
  },
};
