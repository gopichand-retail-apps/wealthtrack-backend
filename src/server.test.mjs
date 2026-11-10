import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createApiServer, loadModel } from './server.mjs';

async function startTestServer(t, model = loadModel()) {
  const api = createApiServer({ databasePath: ':memory:', model });
  api.server.listen(0, '127.0.0.1');
  await once(api.server, 'listening');
  t.after(() => api.close());
  return { api, url: `http://127.0.0.1:${api.server.address().port}` };
}

test('health and summary expose service status and synthetic finance aggregates', async (t) => {
  const { url } = await startTestServer(t);
  const traceparent = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';
  const [healthResponse, summaryResponse] = await Promise.all([
    fetch(`${url}/api/v1/health`, { headers: { traceparent } }),
    fetch(`${url}/api/v1/summary?days=30`),
  ]);
  const health = await healthResponse.json();
  const summary = await summaryResponse.json();

  assert.equal(healthResponse.status, 200);
  assert.equal(health.data.storage, 'sqlite');
  assert.ok(healthResponse.headers.get('x-request-id'));
  assert.equal(
    healthResponse.headers.get('x-trace-id'),
    '0123456789abcdef0123456789abcdef',
  );
  assert.equal(summaryResponse.status, 200);
  assert.equal(summary.data.series.length, 30);
});

test('version reports the backend package release', async (t) => {
  const { url } = await startTestServer(t);
  const response = await fetch(`${url}/api/v1/version`);
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(result.data, { service: 'wealthtrack-api', version: '1.0.0' });
});

test('summary and transaction routes reject unsupported reporting periods', async (t) => {
  const { url } = await startTestServer(t);
  const summaryResponse = await fetch(`${url}/api/v1/summary?days=invalid`);
  const transactionResponse = await fetch(
    `${url}/api/v1/transactions?days=invalid`,
  );
  const summary = await summaryResponse.json();
  const transactions = await transactionResponse.json();

  assert.equal(summaryResponse.status, 400);
  assert.equal(summary.error.code, 'INVALID_PERIOD');
  assert.equal(transactionResponse.status, 400);
  assert.equal(transactions.error.code, 'INVALID_PERIOD');
});

test('origin allowlist permits configured UI and rejects other origins', async (t) => {
  const { url } = await startTestServer(t);
  const model = loadModel();
  const allowed = await fetch(`${url}/api/v1/accounts`, {
    headers: { Origin: model.app.allowedOrigins[0] },
  });
  const denied = await fetch(`${url}/api/v1/accounts`, {
    headers: { Origin: 'https://unapproved.example' },
  });
  const deniedBody = await denied.json();

  assert.equal(allowed.status, 200);
  assert.equal(denied.status, 403);
  assert.equal(deniedBody.error.code, 'ORIGIN_NOT_ALLOWED');
});

test('uses a validated environment origin allowlist override', async (t) => {
  const originalOrigins = process.env.WEALTHTRACK_ALLOWED_ORIGINS;
  process.env.WEALTHTRACK_ALLOWED_ORIGINS = 'http://127.0.0.1:5903';
  let url;
  try {
    ({ url } = await startTestServer(t));
  } finally {
    if (originalOrigins === undefined)
      delete process.env.WEALTHTRACK_ALLOWED_ORIGINS;
    else process.env.WEALTHTRACK_ALLOWED_ORIGINS = originalOrigins;
  }
  const allowed = await fetch(`${url}/api/v1/accounts`, {
    headers: { Origin: 'http://127.0.0.1:5903' },
  });
  const denied = await fetch(`${url}/api/v1/accounts`, {
    headers: { Origin: 'http://localhost:5901' },
  });

  assert.equal(allowed.status, 200);
  assert.equal(denied.status, 403);
});

test('serves finance read endpoints', async (t) => {
  const { url } = await startTestServer(t);
  const [
    accountsResponse,
    transactionsResponse,
    budgetsResponse,
    goalsResponse,
    billsResponse,
  ] = await Promise.all([
    fetch(`${url}/api/v1/accounts`),
    fetch(`${url}/api/v1/transactions?days=30`),
    fetch(`${url}/api/v1/budgets`),
    fetch(`${url}/api/v1/goals`),
    fetch(`${url}/api/v1/bills`),
  ]);
  const [accounts, transactions, budgets, goals, bills] = await Promise.all([
    accountsResponse.json(),
    transactionsResponse.json(),
    budgetsResponse.json(),
    goalsResponse.json(),
    billsResponse.json(),
  ]);
  for (const response of [
    accountsResponse,
    transactionsResponse,
    budgetsResponse,
    goalsResponse,
    billsResponse,
  ]) {
    assert.equal(response.status, 200);
  }
  assert.ok(accounts.data.length > 0);
  assert.ok(transactions.data.length > 0);
  assert.ok(budgets.data.length > 0);
  assert.ok(goals.data.length > 0);
  assert.ok(bills.data.length > 0);
});

test('validates transaction category, account, search, period, and limit filters', async (t) => {
  const { url } = await startTestServer(t);
  const filteredResponse = await fetch(
    `${url}/api/v1/transactions?days=30&category=groceries&accountId=checking&search=no-match&limit=1`,
  );
  const filtered = await filteredResponse.json();
  const invalidFilter = await fetch(
    `${url}/api/v1/transactions?days=30&limit=0`,
  );
  const longSearch = await fetch(
    `${url}/api/v1/transactions?days=30&search=${'x'.repeat(81)}`,
  );
  const invalidCategory = await fetch(
    `${url}/api/v1/transactions?days=30&category=unknown`,
  );
  const missingAccount = await fetch(
    `${url}/api/v1/transactions?days=30&accountId=unknown`,
  );

  assert.equal(filteredResponse.status, 200);
  assert.deepEqual(filtered.data, []);
  assert.equal(invalidFilter.status, 400);
  assert.equal(longSearch.status, 400);
  assert.equal(invalidCategory.status, 400);
  assert.equal(missingAccount.status, 404);
});

test('downloads the synthetic CSV template', async (t) => {
  const { url } = await startTestServer(t);
  const response = await fetch(`${url}/api/v1/imports/template`);
  const csv = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/csv/);
  assert.ok(
    csv.startsWith(
      '"date","description","category","account","amount","currency"\r\n',
    ),
  );
});

test('CSV preview and commit are validated and idempotent', async (t) => {
  const { url } = await startTestServer(t);
  const csvText = [
    'date,description,category,account,amount,currency',
    '2026-10-28,Market groceries,groceries,checking,-64.18,USD',
  ].join('\n');
  const previewResponse = await fetch(`${url}/api/v1/imports/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ csvText }),
  });
  const preview = await previewResponse.json();
  assert.equal(previewResponse.status, 200);
  assert.equal(preview.data.validCount, 1);

  const commit = () =>
    fetch(`${url}/api/v1/imports`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'wealthtrack-test-import',
      },
      body: JSON.stringify({ csvText }),
    });
  const firstResponse = await commit();
  const first = await firstResponse.json();
  const replayResponse = await commit();
  const replay = await replayResponse.json();

  assert.equal(firstResponse.status, 201);
  assert.equal(first.data.rowsAdded, 1);
  assert.equal(replayResponse.status, 200);
  assert.equal(replay.data.replayed, true);
});

test('import routes return safe errors for missing keys, invalid JSON, and oversized bodies', async (t) => {
  const { url } = await startTestServer(t);
  const missingKey = await fetch(`${url}/api/v1/imports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      csvText: 'date,description,category,account,amount,currency',
    }),
  });
  const invalidJson = await fetch(`${url}/api/v1/imports/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  const oversized = await fetch(`${url}/api/v1/imports/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      csvText: 'x'.repeat(loadModel().csv.maximumBytes + 1200),
    }),
  });
  const missingKeyBody = await missingKey.json();
  const invalidJsonBody = await invalidJson.json();
  const oversizedBody = await oversized.json();

  assert.equal(missingKey.status, 400);
  assert.equal(missingKeyBody.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
  assert.equal(invalidJson.status, 400);
  assert.equal(invalidJsonBody.error.code, 'INVALID_JSON');
  assert.equal(oversized.status, 413);
  assert.equal(oversizedBody.error.code, 'PAYLOAD_TOO_LARGE');
});

test('invalid CSV does not commit any rows', async (t) => {
  const { url } = await startTestServer(t);
  const csvText = [
    'date,description,category,account,amount,currency',
    '2026-10-28,Invalid amount,dining,checking,3.456,USD',
  ].join('\n');
  const response = await fetch(`${url}/api/v1/imports`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'wealthtrack-invalid-import',
    },
    body: JSON.stringify({ csvText }),
  });
  const result = await response.json();
  const transactions = await fetch(`${url}/api/v1/transactions?days=30`).then(
    (item) => item.json(),
  );

  assert.equal(response.status, 422);
  assert.equal(result.error.code, 'INVALID_CSV');
  assert.equal(
    transactions.data.filter((row) => row.source === 'csv').length,
    0,
  );
});

test('unsafe aggregate totals are rejected without committing rows', async (t) => {
  const { url } = await startTestServer(t);
  const csvText = [
    'date,description,category,account,amount,currency',
    '2026-10-28,Large one,groceries,checking,-90071992547409.91,USD',
    '2026-10-29,Large two,groceries,checking,-90071992547409.91,USD',
  ].join('\n');
  const response = await fetch(`${url}/api/v1/imports`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'wealthtrack-overflow-import',
    },
    body: JSON.stringify({ csvText }),
  });
  const result = await response.json();
  const transactions = await fetch(`${url}/api/v1/transactions?days=30`).then(
    (item) => item.json(),
  );

  assert.equal(response.status, 422);
  assert.equal(result.error.code, 'INVALID_CSV');
  assert.deepEqual(result.error.details, [
    { rowNumber: 0, code: 'aggregateAmount' },
  ]);
  assert.equal(
    transactions.data.filter((row) => row.source === 'csv').length,
    0,
  );
});

test('cumulative import totals remain within the safe integer range', async (t) => {
  const { url } = await startTestServer(t);
  const csvText = [
    'date,description,category,account,amount,currency',
    '2026-10-28,Large entry,groceries,checking,-45035996273704.96,USD',
  ].join('\n');
  const commit = (idempotencyKey) =>
    fetch(`${url}/api/v1/imports`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({ csvText }),
    });
  const firstResponse = await commit('wealthtrack-large-one');
  const rejectedResponse = await commit('wealthtrack-large-two');
  const rejected = await rejectedResponse.json();
  const transactions = await fetch(`${url}/api/v1/transactions?days=30`).then(
    (item) => item.json(),
  );

  assert.equal(firstResponse.status, 201);
  assert.equal(rejectedResponse.status, 422);
  assert.deepEqual(rejected.error.details, [
    { rowNumber: 0, code: 'aggregateAmount' },
  ]);
  assert.equal(
    transactions.data.filter((row) => row.source === 'csv').length,
    1,
  );
});

test('unknown routes return a safe not-found envelope', async (t) => {
  const { url } = await startTestServer(t);
  const response = await fetch(`${url}/not-a-route`);
  const result = await response.json();

  assert.equal(response.status, 404);
  assert.equal(result.error.code, 'NOT_FOUND');
});

test('rate limiting returns a bounded retry response', async (t) => {
  const model = loadModel();
  model.api.rateLimit = 1;
  const { url } = await startTestServer(t, model);
  const first = await fetch(`${url}/api/v1/health`);
  const limited = await fetch(`${url}/api/v1/accounts`);
  const result = await limited.json();

  assert.equal(first.status, 200);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal(result.error.code, 'RATE_LIMITED');
});
