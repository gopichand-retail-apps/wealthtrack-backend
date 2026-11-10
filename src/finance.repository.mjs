import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const DAY_MS = 24 * 60 * 60 * 1000;
const maximumSafeCents = BigInt(Number.MAX_SAFE_INTEGER);
const schemaUrl = new URL('./schema.sql', import.meta.url);

function absoluteCents(value) {
  const cents = BigInt(value);
  return cents < 0n ? -cents : cents;
}

function transaction(database, work) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function dayStart(value) {
  const date = new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function dateKey(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function mapTransaction(row) {
  return {
    id: row.id,
    date: row.occurred_at,
    description: row.description,
    category: row.category_id,
    accountId: row.account_id,
    amountCents: Number(row.amount_cents),
    currency: row.currency,
    source: row.source,
  };
}

function sum(rows, predicate, project) {
  return rows.reduce(
    (total, row) => (predicate(row) ? total + project(row) : total),
    0,
  );
}

export function createFinanceRepository({
  databasePath,
  model,
  now = new Date(),
}) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(readFileSync(schemaUrl, 'utf8'));
    seedDatabase(database, model, now);
  } catch (error) {
    database.close();
    throw error;
  }
  return createRepository(database);
}

function createRepository(database) {
  return {
    close: () => database.close(),
    canImportTransactions: (rows) => canImportTransactions(database, rows),
    getAccounts: () => getAccounts(database),
    getBills: () => getBills(database),
    getBudgets: (now) => getBudgets(database, now),
    getGoals: () => getGoals(database),
    getImportBatch: (key) => getImportBatch(database, key),
    getSummary: (days, now) => getSummary(database, days, now),
    getTransactions: (filters) => getTransactions(database, filters),
    importTransactions: (key, rows) => importTransactions(database, key, rows),
  };
}

function prepareSeedStatements(database) {
  return {
    account: database.prepare(`
      INSERT OR IGNORE INTO accounts
        (id, name, type, currency, opening_balance_cents, display_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    category: database.prepare(
      'INSERT OR IGNORE INTO categories (id, kind, display_order) VALUES (?, ?, ?)',
    ),
    transaction: database.prepare(`
      INSERT OR IGNORE INTO transactions
        (id, occurred_at, description, category_id, account_id, amount_cents, currency, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    budget: database.prepare(`
      INSERT OR IGNORE INTO budgets (id, category_id, limit_cents, display_order)
      VALUES (?, ?, ?, ?)
    `),
    goal: database.prepare(`
      INSERT OR IGNORE INTO goals
        (id, name, saved_cents, target_cents, target_date, display_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    bill: database.prepare(`
      INSERT OR IGNORE INTO recurring_bills
        (id, name, category_id, amount_cents, account_id, cadence, next_due, display_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
  };
}

function seedDatabase(database, model, now) {
  const statements = prepareSeedStatements(database);
  const today = dayStart(now);
  transaction(database, () => {
    seedAccounts(statements.account, model.seed.accounts);
    seedCategories(statements.category, model.categories);
    seedTransactions(statements.transaction, model.seed.transactions, today);
    seedBudgets(statements.budget, model.seed.budgets);
    seedGoals(statements.goal, model.seed.goals);
    seedBills(statements.bill, model.seed.bills, today);
  });
}

function seedAccounts(insert, accounts) {
  accounts.forEach((account, index) => {
    insert.run(
      account.id,
      account.name,
      account.type,
      account.currency,
      account.openingBalanceCents,
      index + 1,
    );
  });
}

function seedCategories(insert, categories) {
  categories.forEach((category, index) => {
    insert.run(category.id, category.kind, index + 1);
  });
}

function seedTransactions(insert, transactions, today) {
  transactions.forEach((item) => {
    const occurredAt = new Date(
      today.getTime() - item.daysAgo * DAY_MS,
    ).toISOString();
    insert.run(
      item.id,
      occurredAt,
      item.description,
      item.category,
      item.accountId,
      item.amountCents,
      item.currency,
      'seed',
    );
  });
}

function seedBudgets(insert, budgets) {
  budgets.forEach((budget) => {
    insert.run(
      budget.id,
      budget.categoryId,
      budget.limitCents,
      budget.displayOrder,
    );
  });
}

function seedGoals(insert, goals) {
  goals.forEach((goal) => {
    insert.run(
      goal.id,
      goal.name,
      goal.savedCents,
      goal.targetCents,
      goal.targetDate,
      goal.displayOrder,
    );
  });
}

function seedBills(insert, bills, today) {
  bills.forEach((bill) => {
    const nextDue = new Date(
      today.getTime() + bill.dueInDays * DAY_MS,
    ).toISOString();
    insert.run(
      bill.id,
      bill.name,
      bill.categoryId,
      bill.amountCents,
      bill.accountId,
      bill.cadence,
      nextDue,
      bill.displayOrder,
    );
  });
}

function getAccounts(database) {
  const rows = database
    .prepare(
      `
    SELECT a.id, a.name, a.type, a.currency, a.opening_balance_cents AS openingBalanceCents,
      a.display_order AS displayOrder, COALESCE(SUM(t.amount_cents), 0) AS activityCents
    FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id
    GROUP BY a.id ORDER BY a.display_order
  `,
    )
    .all();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    currency: row.currency,
    openingBalanceCents: Number(row.openingBalanceCents),
    balanceCents: Number(row.openingBalanceCents) + Number(row.activityCents),
  }));
}

function getTransactions(
  database,
  { from, to, category, accountId, search, limit = 100 } = {},
) {
  const { conditions, values } = buildTransactionFilters({
    from,
    to,
    category,
    accountId,
    search,
  });
  return database
    .prepare(
      `
    SELECT id, occurred_at, description, category_id, account_id, amount_cents, currency, source
    FROM transactions WHERE ${conditions.join(' AND ')}
    ORDER BY occurred_at DESC, id LIMIT ?
  `,
    )
    .all(...values, limit)
    .map(mapTransaction);
}

function buildTransactionFilters({ from, to, category, accountId, search }) {
  const conditions = ['occurred_at >= ?', 'occurred_at < ?'];
  const values = [from, to];
  if (category) {
    conditions.push('category_id = ?');
    values.push(category);
  }
  if (accountId) {
    conditions.push('account_id = ?');
    values.push(accountId);
  }
  if (search) {
    conditions.push('instr(lower(description), lower(?)) > 0');
    values.push(search);
  }
  return { conditions, values };
}

function getSummary(database, days, now = new Date()) {
  const today = dayStart(now);
  const from = new Date(today.getTime() - (days - 1) * DAY_MS).toISOString();
  const to = new Date(today.getTime() + DAY_MS).toISOString();
  const transactions = getTransactions(database, { from, to, limit: 5000 });
  const incomeCents = sum(
    transactions,
    (item) => item.amountCents > 0,
    (item) => item.amountCents,
  );
  const spendingCents = sum(
    transactions,
    (item) => item.amountCents < 0,
    (item) => -item.amountCents,
  );
  const netCashFlowCents = incomeCents - spendingCents;
  const accounts = getAccounts(database);
  const cashPositionCents = accounts.reduce(
    (total, account) => total + account.balanceCents,
    0,
  );
  return {
    periodDays: days,
    cashPositionCents,
    incomeCents,
    spendingCents,
    netCashFlowCents,
    savingsRatePct: calculateSavingsRate(netCashFlowCents, incomeCents),
    accounts,
    series: buildDailySeries(transactions, today, days),
    categories: buildCategorySpending(transactions),
    transactions: transactions.slice(0, 6),
  };
}

function calculateSavingsRate(netCashFlowCents, incomeCents) {
  return incomeCents > 0
    ? Math.round((netCashFlowCents / incomeCents) * 1000) / 10
    : 0;
}

function buildDailySeries(transactions, today, days) {
  const dailyTotals = new Map();
  for (const item of transactions) {
    const key = dateKey(item.date);
    dailyTotals.set(key, (dailyTotals.get(key) ?? 0) + item.amountCents);
  }
  return Array.from({ length: days }, (_, index) => {
    const day = new Date(today.getTime() - (days - index - 1) * DAY_MS);
    const key = dateKey(day);
    return { date: key, amountCents: dailyTotals.get(key) ?? 0 };
  });
}

function buildCategorySpending(transactions) {
  const totals = new Map();
  for (const item of transactions) {
    if (item.amountCents >= 0) continue;
    totals.set(
      item.category,
      (totals.get(item.category) ?? 0) - item.amountCents,
    );
  }
  return [...totals.entries()].map(([id, amountCents]) => ({
    id,
    amountCents,
  }));
}

function getBudgets(database, now = new Date()) {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  ).toISOString();
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  ).toISOString();
  const spending = database
    .prepare(
      `
    SELECT category_id AS categoryId, COALESCE(-SUM(amount_cents), 0) AS spentCents
    FROM transactions WHERE occurred_at >= ? AND occurred_at < ? AND amount_cents < 0
    GROUP BY category_id
  `,
    )
    .all(start, end);
  const spentByCategory = new Map(
    spending.map((row) => [row.categoryId, Number(row.spentCents)]),
  );
  return database
    .prepare(
      `
    SELECT id, category_id AS categoryId, limit_cents AS limitCents
    FROM budgets ORDER BY display_order
  `,
    )
    .all()
    .map((row) => budgetResult(row, spentByCategory));
}

function budgetResult(row, spentByCategory) {
  const limitCents = Number(row.limitCents);
  const spentCents = spentByCategory.get(row.categoryId) ?? 0;
  return {
    id: row.id,
    categoryId: row.categoryId,
    limitCents,
    spentCents,
    remainingCents: limitCents - spentCents,
  };
}

function getGoals(database) {
  return database
    .prepare(
      `
    SELECT id, name, saved_cents AS savedCents, target_cents AS targetCents,
      target_date AS targetDate FROM goals ORDER BY display_order
  `,
    )
    .all()
    .map((row) => ({
      ...row,
      savedCents: Number(row.savedCents),
      targetCents: Number(row.targetCents),
    }));
}

function getBills(database) {
  return database
    .prepare(
      `
    SELECT id, name, category_id AS categoryId, amount_cents AS amountCents,
      account_id AS accountId, cadence, next_due AS nextDue
    FROM recurring_bills ORDER BY next_due, display_order
  `,
    )
    .all()
    .map((row) => ({ ...row, amountCents: Number(row.amountCents) }));
}

function getImportBatch(database, idempotencyKey) {
  const row = database
    .prepare(
      `
    SELECT idempotency_key AS idempotencyKey, imported_at AS importedAt,
      rows_added AS rowsAdded, total_net_cents AS totalNetCents
    FROM import_batches WHERE idempotency_key = ?
  `,
    )
    .get(idempotencyKey);
  return row ? normalizeImportBatch(row) : null;
}

function normalizeImportBatch(row) {
  return {
    ...row,
    rowsAdded: Number(row.rowsAdded),
    totalNetCents: Number(row.totalNetCents),
  };
}

function canImportTransactions(database, rows) {
  const currentTransactions = database
    .prepare('SELECT amount_cents FROM transactions')
    .all();
  const openingBalances = database
    .prepare('SELECT opening_balance_cents FROM accounts')
    .all();
  const existingCents = currentTransactions.reduce(
    (total, row) => total + absoluteCents(row.amount_cents),
    0n,
  );
  const openingCents = openingBalances.reduce(
    (total, row) => total + absoluteCents(row.opening_balance_cents),
    0n,
  );
  const incomingCents = rows.reduce(
    (total, row) => total + absoluteCents(row.amountCents),
    0n,
  );
  return existingCents + openingCents + incomingCents <= maximumSafeCents;
}

function importTransactions(database, idempotencyKey, rows) {
  return transaction(database, () => {
    const existing = getImportBatch(database, idempotencyKey);
    if (existing) return { ...existing, replayed: true };
    if (!canImportTransactions(database, rows)) return { rejected: true };
    return commitImportBatch(database, idempotencyKey, rows);
  });
}

function commitImportBatch(database, idempotencyKey, rows) {
  const importedAt = new Date().toISOString();
  const totalNetCents = rows.reduce((total, row) => total + row.amountCents, 0);
  insertImportedTransactions(database, rows);
  insertImportBatch(
    database,
    idempotencyKey,
    importedAt,
    rows.length,
    totalNetCents,
  );
  insertActivityEvent(database, 'transactions.imported', importedAt);
  return {
    idempotencyKey,
    importedAt,
    rowsAdded: rows.length,
    totalNetCents,
    replayed: false,
  };
}

function insertImportedTransactions(database, rows) {
  const insert = database.prepare(`
    INSERT INTO transactions
      (id, occurred_at, description, category_id, account_id, amount_cents, currency, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'csv')
  `);
  rows.forEach((row) => {
    insert.run(
      randomUUID(),
      new Date(`${row.date}T12:00:00.000Z`).toISOString(),
      row.description,
      row.category,
      row.accountId,
      row.amountCents,
      row.currency,
    );
  });
}

function insertImportBatch(
  database,
  key,
  importedAt,
  rowsAdded,
  totalNetCents,
) {
  database
    .prepare(
      `
    INSERT INTO import_batches (idempotency_key, imported_at, rows_added, total_net_cents)
    VALUES (?, ?, ?, ?)
  `,
    )
    .run(key, importedAt, rowsAdded, totalNetCents);
}

function insertActivityEvent(database, eventName, occurredAt) {
  database
    .prepare(
      `
    INSERT INTO activity_events (id, event_name, occurred_at) VALUES (?, ?, ?)
  `,
    )
    .run(randomUUID(), eventName, occurredAt);
}
