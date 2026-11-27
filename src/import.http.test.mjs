import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createApiServer, loadModel } from './server.mjs';

// Keep imported rows inside the 30-day reporting window on whatever day the suite runs.
const isoDaysAgo = (days) =>
  new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

async function startTestServer(t) {
  const api = createApiServer({ databasePath: ':memory:' });
  api.server.listen(0, '127.0.0.1');
  await once(api.server, 'listening');
  t.after(() => api.close());
  return `http://127.0.0.1:${api.server.address().port}`;
}

function commitWith(url, key) {
  return (csvText) =>
    fetch(`${url}/api/v1/imports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ csvText }),
    });
}

async function importedRows(url) {
  const response = await fetch(`${url}/api/v1/transactions?days=30`);
  const body = await response.json();
  return body.data.filter((row) => row.source === 'csv');
}

const header = 'date,description,category,account,amount,currency';
const firstCsv = `${header}\n${isoDaysAgo(2)},Market groceries,groceries,checking,-64.18,USD`;
const changedCsv = `${header}\n${isoDaysAgo(2)},Market groceries,groceries,checking,-65.18,USD`;

test('reusing an import key for different content returns 409 and keeps the first batch', async (t) => {
  const url = await startTestServer(t);
  const commit = commitWith(url, 'http-reused-key');

  const first = await commit(firstCsv);
  const conflict = await commit(changedCsv);
  const conflictBody = await conflict.json();
  const replay = await commit(firstCsv);
  const replayBody = await replay.json();
  const message = loadModel().copy.errors.idempotencyKeyReused;

  assert.equal(first.status, 201);
  assert.equal(conflict.status, 409);
  assert.equal(conflictBody.error.code, 'IDEMPOTENCY_KEY_REUSED');
  assert.ok(message.length > 0);
  assert.equal(conflictBody.error.message, message);
  assert.equal(replay.status, 200);
  assert.equal(replayBody.data.replayed, true);
  assert.equal(replayBody.data.rowsAdded, 1);
  assert.equal(Object.hasOwn(replayBody.data, 'payloadDigest'), false);
  assert.equal((await importedRows(url)).length, 1);
});

test('every import attempt receives its own server request ID', async (t) => {
  const url = await startTestServer(t);
  const commit = commitWith(url, 'http-request-ids');

  const first = await commit(firstCsv);
  const replay = await commit(firstCsv);
  const conflict = await commit(changedCsv);
  const ids = [first, replay, conflict].map((response) =>
    response.headers.get('x-request-id'),
  );

  assert.equal(new Set(ids).size, 3);
  assert.ok(ids.every((id) => id && id.length > 0));
});

test('an invalid preview or commit writes zero rows', async (t) => {
  const url = await startTestServer(t);
  const invalidCsv = [
    header,
    `${isoDaysAgo(2)},Bad amount,dining,checking,3.456,USD`,
    `${isoDaysAgo(1)},Fine row,groceries,checking,-1.00,USD`,
  ].join('\n');

  const preview = await fetch(`${url}/api/v1/imports/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ csvText: invalidCsv }),
  });
  const previewBody = await preview.json();
  const commit = await commitWith(url, 'http-invalid-commit')(invalidCsv);
  const commitBody = await commit.json();

  assert.equal(previewBody.data.validCount, 1);
  assert.deepEqual(previewBody.data.invalidRows, [
    { rowNumber: 2, code: 'invalidAmount' },
  ]);
  assert.equal(commit.status, 422);
  assert.deepEqual(commitBody.error.details, [
    { rowNumber: 2, code: 'invalidAmount' },
  ]);
  assert.equal((await importedRows(url)).length, 0);
});
