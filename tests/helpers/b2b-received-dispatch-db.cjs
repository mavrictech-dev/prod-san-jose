'use strict';
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');
const {withReceivedAutomationDatabase} = require('./b2b-received-automation-db.cjs');

// The inherited helper creates and verifies a NEW labelled PostgreSQL container:
// network none, no published ports, tmpfs storage and ownership-checked cleanup.
// No caller URL, existing database, compose service or runtime installer is used.
exports.withReceivedAutomationDatabase = async work => {
  assert.equal(process.env.FACTUEZ_B2B_RECEIVED_OWNED_DB,
    'NEW_NETWORK_NONE_TMPFS_ONLY', 'EXPLICIT_NEW_DATABASE_RUNNER_REQUIRED');
  return withReceivedAutomationDatabase(async context => {
    await context.pool.query(readFileSync(resolve(__dirname,
      '../../services/received-documents-service/b2b-received-dispatch.candidate.sql'), 'utf8'));
    return work(context);
  });
};
