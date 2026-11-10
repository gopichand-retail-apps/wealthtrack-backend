# WealthTrack Backend

The Node.js API owns WealthTrack's SQLite database, validation, finance queries, and transactional CSV import. It loads synthetic fixtures and validation configuration from the sibling frontend's strict `public/wealthtrack-model.json` content model. It does not authenticate users or connect to financial institutions.

## Run

Use Node.js 22.13 or newer.

```sh
npm install
npm start
```

The API binds to `127.0.0.1:5902`. By default it creates `data/wealthtrack.sqlite` under this package. Override the database location with `WEALTHTRACK_DB_PATH`; `:memory:` is intended for isolated tests. `PORT` overrides the listener port. `WEALTHTRACK_ALLOWED_ORIGINS` accepts a comma-separated list of explicit URL origins and replaces the model allowlist.

```sh
PORT=5902 WEALTHTRACK_DB_PATH=/tmp/wealthtrack-local.sqlite npm start
```

## API

The versioned base URL is `http://127.0.0.1:5902/api/v1`. See [`openapi.yaml`](openapi.yaml) for the HTTP contract.

- `GET /health`, `/accounts`, `/summary`, `/transactions`, `/budgets`, `/goals`, `/bills`
- `GET /imports/template`
- `POST /imports/preview` validates a CSV without writes.
- `POST /imports` requires `Idempotency-Key` and commits a valid batch atomically.

JSON success bodies use `{ "data": ... }`; errors use a stable code/message/requestId envelope. Request and trace IDs, safe route metadata, status, duration, and outcome are logged. CSV contents and transaction details are not logged.

## Data and checks

Money is stored as integer cents with an explicit currency. CSV amounts are parsed from decimal text, not binary floating point. The sum of absolute transaction and opening-balance cents across the existing ledger and incoming batch must stay within JavaScript's safe integer range; unsafe imports are rejected during preview and commit. The repository uses parameterized SQL and explicit transactions. Invalid rows prevent the batch from committing; repeated idempotency keys do not insert duplicate transactions.

```sh
npm run format:check
npm run lint
npm run check
npm test
npm run test:cov
npm audit
```

The coverage command enforces at least 90% statements, branches, functions,
and lines across backend source files. Tests use an isolated in-memory SQLite
database and exercise transaction rollback and import idempotency.

The frontend Playwright configuration starts this API with `WEALTHTRACK_DB_PATH=:memory:`. It leaves the local development database untouched.

## Security boundary

The service binds to loopback and checks configured browser origins when an `Origin` header is present. CORS is not authentication or authorization: there is no user identity or row ownership enforcement. Use synthetic data only and do not expose this prototype outside the local machine. See the [security notes](../docs/security/README.md).
