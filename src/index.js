import { handleInviteCreate } from './invite-create.js';
import { filterInviteUpdate, handleInviteAccepted } from './invite-accept.js';
import { preDeleteCapture, postDeleteProcess } from './invite-delete.js';
import { handleExpiryCleanup } from './expiry-cleanup.js';

export default ({ action, filter, schedule }, context) => {
  const { services, database, getSchema, logger, env } = context;

  const ctx = { services, database, getSchema, logger, env };

  // Pending deletes buffer — filter captures data, action processes it
  const _pendingDeletes = new Map();

  // ── CREATE ──

  action('invitations.items.create', async (meta) => {
    try {
      await handleInviteCreate(meta, ctx);
    } catch (err) {
      logger.error(`[invitations] create error: ${err.message}`);
    }
  });

  // ── UPDATE (accept) ──

  filter('invitations.items.update', (payload, meta) => {
    try {
      return filterInviteUpdate(payload, meta, ctx);
    } catch (err) {
      // Re-throw to block the update
      throw err;
    }
  });

  action('invitations.items.update', async (meta) => {
    try {
      await handleInviteAccepted(meta, ctx);
    } catch (err) {
      logger.error(`[invitations] accept error: ${err.message}`);
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
      logger.error(`[invitations] pre-delete error: ${err.message}`);
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
      logger.error(`[invitations] delete error: ${err.message}`);
    }
  });

  // ── CRON: expiry cleanup (daily at 2:00 AM) ──

  schedule('0 2 * * *', async () => {
    try {
      await handleExpiryCleanup(ctx);
    } catch (err) {
      logger.error(`[invitations] expiry-cleanup error: ${err.message}`);
    }
  });
};
