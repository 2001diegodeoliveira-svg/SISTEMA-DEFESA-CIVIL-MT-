'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

const contextStorage = new AsyncLocalStorage();

function normalizeContext(context = {}) {
  return {
    userId: context.userId == null ? '' : String(context.userId),
    organizationIds: [...new Set((context.organizationIds || []).map(String))],
    directOrganizationIds: [...new Set((context.directOrganizationIds || []).map(String))],
    writableOrganizationIds: [...new Set((context.writableOrganizationIds || []).map(String))],
    operation: String(context.operation || 'public'),
    isPublic: context.isPublic === true,
  };
}

function runWithDbContext(context, callback) {
  return contextStorage.run(normalizeContext(context), callback);
}

function currentDbContext() {
  return contextStorage.getStore() || null;
}

async function setDbContext(client, context = currentDbContext()) {
  const normalized = normalizeContext(context || {});
  await client.query(
    `SELECT
       set_config('app.user_id', $1, true),
       set_config('app.organization_ids', $2, true),
       set_config('app.direct_organization_ids', $3, true),
       set_config('app.writable_organization_ids', $4, true),
       set_config('app.operation', $5, true),
       set_config('app.is_public', $6, true)`,
    [
      normalized.userId,
      normalized.organizationIds.join(','),
      normalized.directOrganizationIds.join(','),
      normalized.writableOrganizationIds.join(','),
      normalized.operation,
      String(normalized.isPublic),
    ]
  );
}

module.exports = { currentDbContext, normalizeContext, runWithDbContext, setDbContext };
