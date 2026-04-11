import { handleInviteCreate } from './invite-create.js';
import { preDeleteCapture, postDeleteProcess } from './invite-delete.js';
import { handleExpiryCleanup } from './expiry-cleanup.js';
import { notifyAdmins } from '../shared/notify-admin.js';

export default ({ action, filter, schedule }, context) => {
  const { services, database, getSchema, logger, env } = context;

  const ctx = { services, database, getSchema, logger, env };

  const _pendingDeletes = new Map();

  // ── CREATE ──

  action('invitations.items.create', async (meta) => {
    try {
      await handleInviteCreate(meta, ctx);
    } catch (err) {
      await notifyAdmins(ctx, 'invitations:create', err, {
        key: meta.key,
        collection: meta.collection,
        payload: meta.payload,
      });
    }
  });

  // ── DELETE ──
  // Note: accept flow is handled by the /invitations-accept endpoint (see
  // src/endpoint/accept-handler.js). No filter/action hooks on items.update —
  // any PATCH on invitations collection outside of admin accountability is
  // blocked by Directus permissions.

  filter('invitations.items.delete', async (keys) => {
    try {
      const captured = await preDeleteCapture(keys, ctx);
      const batchId = Date.now().toString();
      _pendingDeletes.set(batchId, captured);
      keys._invBatchId = batchId;
    } catch (err) {
      await notifyAdmins(ctx, 'invitations:delete-pre', err, { keys });
    }
    return keys;
  });

  action('invitations.items.delete', async (meta) => {
    try {
      const batchId = meta.keys?._invBatchId || [..._pendingDeletes.keys()].pop();
      const captured = _pendingDeletes.get(batchId) || [];
      _pendingDeletes.delete(batchId);
      await postDeleteProcess(captured, ctx);
    } catch (err) {
      await notifyAdmins(ctx, 'invitations:delete-post', err, { keys: meta.keys });
    }
  });

  // ── CRON: expiry cleanup (daily at 2:00 AM) ──

  schedule('0 2 * * *', async () => {
    try {
      await handleExpiryCleanup(ctx);
    } catch (err) {
      await notifyAdmins(ctx, 'invitations:expiry-cleanup', err, {});
    }
  });
};
