import assert from 'node:assert/strict';
import test from 'node:test';
import { createFinanceRepository } from './finance.repository.mjs';
import { createImportService, parseMoneyCents } from './import.service.mjs';
import { loadModel } from './server.mjs';

function createImport(t) {
  const model = loadModel();
  const repository = createFinanceRepository({
    databasePath: ':memory:',
    model,
  });
  t.after(() => repository.close());
  return createImportService({ model, repository });
}

const validCsv = [
  'date,description,category,account,amount,currency',
  '2026-10-28,Market groceries,groceries,checking,-64.18,USD',
  '2026-10-29,Payroll deposit,income,checking,2400.00,USD',
].join('\n');

test('money parser converts decimal text to exact signed cents', () => {
  assert.equal(parseMoneyCents('-64.18'), -6418);
  assert.equal(parseMoneyCents('2400.00'), 240000);
  assert.equal(parseMoneyCents('1.234'), null);
  assert.equal(parseMoneyCents('0.00'), null);
  assert.equal(parseMoneyCents('90071992547409.92'), null);
});

test('rejects missing and oversized CSV input before parsing', (t) => {
  const imports = createImport(t);
  const model = loadModel();

  assert.equal(
    imports.preview(undefined).invalidRows[0].code,
    'payloadTooLarge',
  );
  assert.equal(
    imports.preview('x'.repeat(model.csv.maximumBytes + 1)).invalidRows[0].code,
    'payloadTooLarge',
  );
});

test('preview validates rows and calculates integer-cent totals without writes', (t) => {
  const imports = createImport(t);
  const preview = imports.preview(validCsv);

  assert.equal(preview.validCount, 2);
  assert.equal(preview.invalidCount, 0);
  assert.equal(preview.netAmountCents, 233582);
});

test('preview rejects a batch whose aggregate exceeds exact integer-cent range', (t) => {
  const imports = createImport(t);
  const csv = [
    'date,description,category,account,amount,currency',
    '2026-10-28,Large one,groceries,checking,-90071992547409.91,USD',
    '2026-10-29,Large two,groceries,checking,-90071992547409.91,USD',
  ].join('\n');
  const preview = imports.preview(csv);

  assert.equal(preview.validCount, 0);
  assert.equal(preview.netAmountCents, 0);
  assert.deepEqual(preview.invalidRows, [
    { rowNumber: 0, code: 'aggregateAmount' },
  ]);
});

test('rejects cumulative imports that would make ledger totals unsafe', (t) => {
  const model = loadModel();
  const repository = createFinanceRepository({
    databasePath: ':memory:',
    model,
  });
  t.after(() => repository.close());
  const imports = createImportService({ model, repository });
  const csv = [
    'date,description,category,account,amount,currency',
    '2026-10-28,Large entry,groceries,checking,-45035996273704.96,USD',
  ].join('\n');

  const firstImport = imports.commit(csv, 'large-import-one');
  const secondPreview = imports.preview(csv);
  const secondImport = imports.commit(csv, 'large-import-two');

  assert.equal(firstImport.rowsAdded, 1);
  assert.equal(secondPreview.validCount, 0);
  assert.deepEqual(secondPreview.invalidRows, [
    { rowNumber: 0, code: 'aggregateAmount' },
  ]);
  assert.deepEqual(secondImport.invalidRows, [
    { rowNumber: 0, code: 'aggregateAmount' },
  ]);
  assert.ok(
    Number.isSafeInteger(
      repository.getAccounts().find((account) => account.id === 'checking')
        .balanceCents,
    ),
  );
});

test('returns a safe import issue if ledger headroom changes before commit', () => {
  const model = loadModel();
  const imports = createImportService({
    model,
    repository: {
      getImportBatch: () => null,
      canImportTransactions: () => true,
      importTransactions: () => ({ rejected: true }),
    },
  });

  const result = imports.commit(validCsv, 'concurrent-ledger-update');

  assert.equal(result.validCount, 0);
  assert.equal(result.invalidCount, 1);
  assert.deepEqual(result.invalidRows, [
    { rowNumber: 0, code: 'aggregateAmount' },
  ]);
});

test('preview reports invalid account, category, currency, and amount sign', (t) => {
  const imports = createImport(t);
  const csv = [
    'date,description,category,account,amount,currency',
    '2026-10-28,Unknown,groceries,missing,-10.00,USD',
    '2026-10-28,Unknown,unknown,checking,-10.00,USD',
    '2026-02-30,Unknown,dining,checking,-10.00,USD',
    '28-10-2026,Unknown,dining,checking,-10.00,USD',
    '2026-10-28,,dining,checking,-10.00,USD',
    '2026-10-28,Unknown,dining,checking,-10.00,EUR',
    '2026-10-28,Unknown,income,checking,-10.00,USD',
    '2026-10-28,Unknown,dining,checking,10.00,USD',
    '2026-10-28,Unknown,dining,checking,-1.001,USD',
  ].join('\n');
  const preview = imports.preview(csv);

  assert.equal(preview.validCount, 0);
  assert.deepEqual(
    preview.invalidRows.map((row) => row.code),
    [
      'invalidAccount',
      'invalidCategory',
      'invalidDate',
      'invalidDate',
      'invalidRow',
      'invalidCurrency',
      'amountSign',
      'amountSign',
      'invalidAmount',
    ],
  );
});

test('accepts a transfer category without applying income or expense sign rules', (t) => {
  const imports = createImport(t);
  const csv = [
    'date,description,category,account,amount,currency',
    '2026-10-28,Savings contribution,savings,checking,10.00,USD',
  ].join('\n');
  const preview = imports.preview(csv);

  assert.equal(preview.validCount, 1);
  assert.equal(preview.invalidCount, 0);
  assert.equal(preview.netAmountCents, 1000);
});

test('invalid headers and empty input are rejected without partial rows', (t) => {
  const imports = createImport(t);

  assert.equal(
    imports.preview('date,description\n2026-10-28,Example').invalidRows[0].code,
    'invalidHeaders',
  );
  assert.equal(
    imports.preview('date,description,category,account,amount,currency')
      .invalidRows[0].code,
    'emptyFile',
  );
});

function createImportWithRepository(t) {
  const model = loadModel();
  const repository = createFinanceRepository({
    databasePath: ':memory:',
    model,
  });
  t.after(() => repository.close());
  return { imports: createImportService({ model, repository }), repository };
}

function importedRowCount(repository) {
  return repository
    .getTransactions({
      from: '2000-01-01T00:00:00.000Z',
      to: '2100-01-01T00:00:00.000Z',
      limit: 500,
    })
    .filter((row) => row.source === 'csv').length;
}

const changedCsv = [
  'date,description,category,account,amount,currency',
  '2026-10-30,Different purchase,dining,checking,-12.00,USD',
].join('\n');

test('a reused key with different content is a conflict and writes nothing', (t) => {
  const { imports, repository } = createImportWithRepository(t);

  const first = imports.commit(validCsv, 'reused-key');
  const second = imports.commit(changedCsv, 'reused-key');

  assert.equal(first.rowsAdded, 2);
  assert.equal(second.conflict, true);
  assert.equal(second.replayed, undefined);
  assert.equal(importedRowCount(repository), 2);
});

test('the same content under the same key replays the one earlier batch', (t) => {
  const { imports, repository } = createImportWithRepository(t);

  const first = imports.commit(validCsv, 'same-key');
  const replay = imports.commit(validCsv, 'same-key');

  assert.equal(replay.replayed, true);
  assert.equal(replay.importedAt, first.importedAt);
  assert.equal(replay.rowsAdded, 2);
  assert.equal(replay.totalNetCents, first.totalNetCents);
  assert.equal(Object.hasOwn(replay, 'payloadDigest'), false);
  assert.equal(importedRowCount(repository), 2);
});

test('spacing and line endings do not change the content under a key', (t) => {
  const { imports, repository } = createImportWithRepository(t);
  const respaced = [
    'date,description,category,account,amount,currency',
    '2026-10-28, Market groceries ,groceries,checking, -64.18 ,USD',
    '2026-10-29,Payroll deposit,income,checking,2400.00,USD',
  ].join('\r\n');

  imports.commit(validCsv, 'respaced-key');
  const replay = imports.commit(respaced, 'respaced-key');

  assert.equal(replay.replayed, true);
  assert.equal(importedRowCount(repository), 2);
});

test('a reused key with an invalid file is a conflict, not a replay', (t) => {
  const { imports, repository } = createImportWithRepository(t);

  imports.commit(validCsv, 'invalid-reuse-key');
  const result = imports.commit('date,description\n1,2', 'invalid-reuse-key');

  assert.equal(result.conflict, true);
  assert.equal(importedRowCount(repository), 2);
});

test('a replay still answers after later imports used the ledger headroom', (t) => {
  const { imports } = createImportWithRepository(t);
  const csv = [
    'date,description,category,account,amount,currency',
    '2026-10-28,Large entry,groceries,checking,-45035996273704.96,USD',
  ].join('\n');

  imports.commit(csv, 'headroom-one');
  const rejected = imports.commit(csv, 'headroom-two');
  const replay = imports.commit(csv, 'headroom-one');

  assert.equal(rejected.invalidCount, 1);
  assert.equal(replay.replayed, true);
  assert.equal(replay.rowsAdded, 1);
});

test('a batch stored before digests existed replays without a comparison', (t) => {
  const { imports, repository } = createImportWithRepository(t);
  repository.importTransactions('legacy-key', [
    {
      date: '2026-10-28',
      description: 'Earlier import',
      category: 'groceries',
      accountId: 'checking',
      amountCents: -500,
      currency: 'USD',
    },
  ]);

  const result = imports.commit(validCsv, 'legacy-key');

  assert.equal(result.replayed, true);
  assert.equal(result.rowsAdded, 1);
  assert.equal(importedRowCount(repository), 1);
});

test('reports malformed CSV syntax and row-limit violations', (t) => {
  const imports = createImport(t);
  const model = loadModel();
  const malformed = `${model.csv.headers.join(',')}\n"unterminated`;
  const validRow = '2026-10-28,Market groceries,groceries,checking,-1.00,USD';
  const tooManyRows = [
    model.csv.headers.join(','),
    ...Array.from({ length: model.csv.maximumRows + 1 }, () => validRow),
  ].join('\n');

  assert.equal(imports.preview(malformed).invalidRows[0].code, 'invalidCsv');
  assert.equal(imports.preview(tooManyRows).invalidRows[0].code, 'tooManyRows');
});
