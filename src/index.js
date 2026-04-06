import { handleInviteCreate } from './invite-create.js';
import { preDeleteCapture, postDeleteProcess } from './invite-delete.js';
import { handleUserActivated } from './user-activated.js';
import { handleExpiryCleanup } from './expiry-cleanup.js';

export default ({ action, filter, schedule }, context) => {
  const { services, database, getSchema, logger, env } = context;

  let _pendingDeletes = new Map();

  action('invitations.items.create', async (meta) => {
    try {
      await handleInviteCreate(meta, { services, database, getSchema, logger, env });
    } catch (err) {
      logger.error(`[invitation-handler] create error: ${err.message}`);
    }
  });

  filter('invitations.items.delete', async (keys) => {
    try {
      const captured = await preDeleteCapture(keys, { database, logger });
      const batchId = Date.now().toString();
      _pendingDeletes.set(batchId, captured);
      keys._invBatchId = batchId;
    } catch (err) {
      logger.error(`[invitation-handler] pre-delete error: ${err.message}`);
    }
    return keys;
  });

  action('invitations.items.delete', async (meta) => {
    try {
      const batchId = meta.keys?._invBatchId || [..._pendingDeletes.keys()].pop();
      const captured = _pendingDeletes.get(batchId) || [];
      _pendingDeletes.delete(batchId);
      await postDeleteProcess(captured, { services, database, getSchema, logger });
    } catch (err) {
      logger.error(`[invitation-handler] delete error: ${err.message}`);
    }
  });

  action('directus_users.items.update', async (meta) => {
    try {
      await handleUserActivated(meta, { services, database, getSchema, logger, env });
    } catch (err) {
      logger.error(`[invitation-handler] user-activated error: ${err.message}`);
    }
  });

  schedule('0 2 * * *', async () => {
    try {
      await handleExpiryCleanup({ services, database, getSchema, logger, env });
    } catch (err) {
      logger.error(`[invitation-handler] expiry-cleanup error: ${err.message}`);
    }
  });
};
