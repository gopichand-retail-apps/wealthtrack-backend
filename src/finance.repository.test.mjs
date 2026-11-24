import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import * as repositoryModule from './finance.repository.mjs';
import { createFinanceRepository } from './finance.repository.mjs';
import { loadModel } from './server.mjs';

const fixtureDate = new Date('2026-10-31T12:00:00.000Z');

function createRepository(t) {
  const repository = createFinanceRepository({
    databasePath: ':memory:',
    model: loadModel(),
    now: fixtureDate,
  });
  t.after(() => repository.close());
  return repository;
}

test('summary uses integer cents and produces one point per requested day', (t) => {
  const repository = createRepository(t);
  const summary = repository.getSummary(30);

  assert.equal(summary.series.length, 30);
  assert.ok(Number.isInteger(summary.cashPositionCents));
  assert.ok(Number.isInteger(summary.incomeCents));
  assert.ok(Number.isInteger(summary.spendingCents));
  assert.ok(summary.accounts.length >= 2);
});

test('budget aggregates expenses by category without mutating transaction rows', (t) => {
  const repository = createRepository(t);
  const before = repository.getTransactions({
    from: '2026-10-01T00:00:00.000Z',
    to: '2026-11-01T00:00:00.000Z',
    limit: 500,
  });
  const budgets = repository.getBudgets(fixtureDate);
  const groceries = budgets.find((budget) => budget.categoryId === 'groceries');

  assert.ok(groceries);
  assert.ok(groceries.spentCents > 0);
  assert.equal(
    repository.getTransactions({
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-11-01T00:00:00.000Z',
      limit: 500,
    }).length,
    before.length,
  );
});

test('idempotent imports do not add duplicate rows', (t) => {
  const repository = createRepository(t);
  const rows = [
    {
      date: '2026-10-28',
      description: 'Imported market',
      category: 'groceries',
      accountId: 'checking',
      amountCents: -1234,
      currency: 'USD',
    },
  ];
  const first = repository.importTransactions('wealthtrack-batch-1', rows);
  const replay = repository.importTransactions('wealthtrack-batch-1', rows);

  assert.equal(first.rowsAdded, 1);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.rowsAdded, 1);
});

test('a reused key with another digest conflicts and writes nothing', (t) => {
  const repository = createRepository(t);
  const rows = [
    {
      date: '2026-10-28',
      description: 'Imported market',
      category: 'groceries',
      accountId: 'checking',
      amountCents: -1234,
      currency: 'USD',
    },
  ];
  const changedRows = [{ ...rows[0], amountCents: -999 }];

  const first = repository.importTransactions('digest-batch', rows, 'digest-a');
  const same = repository.importTransactions('digest-batch', rows, 'digest-a');
  const other = repository.importTransactions(
    'digest-batch',
    changedRows,
    'digest-b',
  );

  assert.equal(first.replayed, false);
  assert.equal(same.replayed, true);
  assert.equal(other.conflict, true);
  assert.equal(other.replayed, undefined);
  assert.equal(repository.getImportBatch('digest-batch').rowsAdded, 1);
  assert.equal(
    repository
      .getTransactions({
        from: '2026-10-28T00:00:00.000Z',
        to: '2026-10-30T00:00:00.000Z',
        limit: 500,
      })
      .filter((transaction) => transaction.source === 'csv').length,
    1,
  );
});

test('adds the digest column to a database created before it existed', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE import_batches (
      idempotency_key TEXT PRIMARY KEY,
      imported_at TEXT NOT NULL,
      rows_added INTEGER NOT NULL,
      total_net_cents INTEGER NOT NULL
    )
  `);
  database
    .prepare('INSERT INTO import_batches VALUES (?, ?, ?, ?)')
    .run('legacy-batch', '2026-10-01T00:00:00.000Z', 2, 100);

  repositoryModule.upgradeSchema(database);
  repositoryModule.upgradeSchema(database);

  const columns = database
    .prepare('PRAGMA table_info(import_batches)')
    .all()
    .map((column) => column.name);
  const legacy = database.prepare('SELECT * FROM import_batches').get();
  database.close();
  assert.equal(columns.filter((name) => name === 'payload_digest').length, 1);
  assert.equal(legacy.payload_digest, null);
  assert.equal(legacy.rows_added, 2);
});

test('import transaction rolls back earlier rows after a constraint failure', (t) => {
  const repository = createRepository(t);
  const rows = [
    {
      date: '2026-10-28',
      description: 'Imported market',
      category: 'groceries',
      accountId: 'checking',
      amountCents: -1234,
      currency: 'USD',
    },
    {
      date: '2026-10-28',
      description: 'Invalid category',
      category: 'not-a-category',
      accountId: 'checking',
      amountCents: -100,
      currency: 'USD',
    },
  ];

  assert.throws(() =>
    repository.importTransactions('wealthtrack-rollback', rows),
  );
  assert.equal(repository.getImportBatch('wealthtrack-rollback'), null);
  const transactions = repository.getTransactions({
    from: '2026-10-28T00:00:00.000Z',
    to: '2026-10-30T00:00:00.000Z',
    limit: 500,
  });
  assert.equal(
    transactions.filter((transaction) => transaction.source === 'csv').length,
    0,
  );
});
