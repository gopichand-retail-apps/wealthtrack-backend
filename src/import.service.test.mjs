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
