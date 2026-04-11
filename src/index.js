import { handleInviteCreate } from './invite-create.js';
import { filterInviteUpdate, handleInviteAccepted } from './invite-accept.js';
import { preDeleteCapture, postDeleteProcess } from './invite-delete.js';
import { handleExpiryCleanup } from './expiry-cleanup.js';
import { notifyAdmins } from './notify-admin.js';

export default ({ action, filter, schedule }, context) => {
  const { services, database, getSchema, logger, env } = context;

  const ctx = { services, database, getSchema, logger, env };

  const _pendingDeletes = new Map();
  const _pendingAccepts = new Map();

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

  // ── UPDATE (accept) ──

  filter('invitations.items.update', async (payload, meta) => {
    return filterInviteUpdate(payload, meta, ctx, _pendingAccepts);
  });

  action('invitations.items.update', async (meta) => {
    try {
      await handleInviteAccepted(meta, ctx, _pendingAccepts);
    } catch (err) {
      await notifyAdmins(ctx, 'invitations:accept', err, {
        keys: meta.keys,
        collection: meta.collection,
        payload: meta.payload,
      });
    }
  });

  // ── DELETE ──

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
