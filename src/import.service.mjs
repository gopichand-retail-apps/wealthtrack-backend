import { parse } from 'csv-parse/sync';
import { z } from 'zod';

const csvRowSchema = z
  .object({
    date: z.string().min(1).max(10),
    description: z.string().trim().min(1).max(160),
    category: z.string().min(1).max(40),
    account: z.string().min(1).max(40),
    amount: z.string().min(1).max(32),
    currency: z.string().length(3),
  })
  .strict();
const maximumSafeCents = BigInt(Number.MAX_SAFE_INTEGER);

function parseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

export function parseMoneyCents(value) {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const sign = match[1] === '-' ? -1 : 1;
  const whole = BigInt(match[2]);
  const fraction = BigInt((match[3] ?? '').padEnd(2, '0'));
  const cents = whole * 100n + fraction;
  if (cents === 0n || cents > maximumSafeCents) return null;
  return Number(cents) * sign;
}

function rowIssue(record, model, accounts, rowNumber) {
  const parsed = csvRowSchema.safeParse(record);
  if (!parsed.success) return { rowNumber, code: 'invalidRow' };
  const row = parsed.data;
  if (!parseDate(row.date)) return { rowNumber, code: 'invalidDate' };
  const amountCents = parseMoneyCents(row.amount);
  if (amountCents === null) return { rowNumber, code: 'invalidAmount' };
  const category = model.categories.find((item) => item.id === row.category);
  if (!category) return { rowNumber, code: 'invalidCategory' };
  if (!accounts.has(row.account)) return { rowNumber, code: 'invalidAccount' };
  if (row.currency.toUpperCase() !== model.app.currency)
    return { rowNumber, code: 'invalidCurrency' };
  if (category.kind === 'income' && amountCents < 0)
    return { rowNumber, code: 'amountSign' };
  if (category.kind === 'expense' && amountCents > 0)
    return { rowNumber, code: 'amountSign' };
  return null;
}

function readCsvRecords(csvText, model) {
  if (
    typeof csvText !== 'string' ||
    Buffer.byteLength(csvText, 'utf8') > model.csv.maximumBytes
  ) {
    return { issue: { rowNumber: 0, code: 'payloadTooLarge' } };
  }
  let records;
  try {
    records = parse(csvText, {
      columns: false,
      bom: true,
      skip_empty_lines: true,
      trim: true,
      max_record_size: 2048,
      relax_column_count: false,
    });
  } catch {
    return { issue: { rowNumber: 0, code: 'invalidCsv' } };
  }
  const headers = records[0];
  if (
    !Array.isArray(headers) ||
    headers.join(',') !== model.csv.headers.join(',')
  )
    return { issue: { rowNumber: 1, code: 'invalidHeaders' } };
  const rows = records.slice(1);
  if (rows.length === 0) return { issue: { rowNumber: 0, code: 'emptyFile' } };
  if (rows.length > model.csv.maximumRows)
    return { issue: { rowNumber: 0, code: 'tooManyRows' } };
  return { headers, rows };
}

function validateCsvRows(headers, rows, model, accountIds) {
  const validRows = [];
  const invalidRows = [];
  for (const [index, values] of rows.entries()) {
    const record = Object.fromEntries(
      headers.map((header, columnIndex) => [header, values[columnIndex]]),
    );
    const issue = rowIssue(record, model, accountIds, index + 2);
    if (issue) {
      invalidRows.push(issue);
      continue;
    }
    validRows.push({
      date: record.date,
      description: record.description.trim(),
      category: record.category,
      accountId: record.account,
      amountCents: parseMoneyCents(record.amount),
      currency: record.currency.toUpperCase(),
    });
  }
  return { validRows, invalidRows };
}

function aggregateIsSafe(validRows, repository) {
  const absoluteTotalCents = validRows.reduce(
    (total, row) => total + BigInt(Math.abs(row.amountCents)),
    0n,
  );
  return (
    absoluteTotalCents <= maximumSafeCents &&
    (validRows.length === 0 || repository.canImportTransactions(validRows))
  );
}

function parseCsv(csvText, model, repository, accountIds) {
  const parsedFile = readCsvRecords(csvText, model);
  if (parsedFile.issue) {
    return { validRows: [], invalidRows: [parsedFile.issue] };
  }
  const result = validateCsvRows(
    parsedFile.headers,
    parsedFile.rows,
    model,
    accountIds,
  );
  if (!aggregateIsSafe(result.validRows, repository)) {
    return {
      validRows: [],
      invalidRows: [
        ...result.invalidRows,
        { rowNumber: 0, code: 'aggregateAmount' },
      ],
    };
  }
  return result;
}

export function createImportService({ model, repository }) {
  const accountIds = new Set(model.seed.accounts.map((account) => account.id));
  return {
    preview(csvText) {
      return createPreview(csvText, model, repository, accountIds);
    },
    commit(csvText, idempotencyKey) {
      return commitCsv(csvText, idempotencyKey, model, repository, accountIds);
    },
  };
}

function createPreview(csvText, model, repository, accountIds) {
  const result = parseCsv(csvText, model, repository, accountIds);
  const netAmountCents = result.validRows.reduce(
    (total, row) => total + row.amountCents,
    0,
  );
  return {
    validRows: result.validRows,
    invalidRows: result.invalidRows,
    validCount: result.validRows.length,
    invalidCount: result.invalidRows.length,
    netAmountCents,
  };
}

function commitCsv(csvText, idempotencyKey, model, repository, accountIds) {
  const existing = repository.getImportBatch(idempotencyKey);
  if (existing) return { ...existing, replayed: true };
  const result = parseCsv(csvText, model, repository, accountIds);
  if (result.invalidRows.length > 0) {
    return {
      invalidRows: result.invalidRows,
      validCount: result.validRows.length,
      invalidCount: result.invalidRows.length,
    };
  }
  const imported = repository.importTransactions(
    idempotencyKey,
    result.validRows,
  );
  if (imported.rejected) {
    return {
      invalidRows: [{ rowNumber: 0, code: 'aggregateAmount' }],
      validCount: 0,
      invalidCount: 1,
    };
  }
  return imported;
}
