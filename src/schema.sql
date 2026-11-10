PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  currency TEXT NOT NULL,
  opening_balance_cents INTEGER NOT NULL,
  display_order INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('income', 'expense', 'transfer')),
  display_order INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  description TEXT NOT NULL,
  category_id TEXT NOT NULL REFERENCES categories(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents != 0),
  currency TEXT NOT NULL,
  source TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS transactions_date_idx ON transactions(occurred_at);
CREATE INDEX IF NOT EXISTS transactions_category_date_idx ON transactions(category_id, occurred_at);
CREATE INDEX IF NOT EXISTS transactions_account_date_idx ON transactions(account_id, occurred_at);

CREATE TABLE IF NOT EXISTS budgets (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES categories(id),
  limit_cents INTEGER NOT NULL CHECK (limit_cents >= 0),
  display_order INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  saved_cents INTEGER NOT NULL CHECK (saved_cents >= 0),
  target_cents INTEGER NOT NULL CHECK (target_cents > 0),
  target_date TEXT NOT NULL,
  display_order INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS recurring_bills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category_id TEXT NOT NULL REFERENCES categories(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  cadence TEXT NOT NULL,
  next_due TEXT NOT NULL,
  display_order INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS import_batches (
  idempotency_key TEXT PRIMARY KEY,
  imported_at TEXT NOT NULL,
  rows_added INTEGER NOT NULL,
  total_net_cents INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_events (
  id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
