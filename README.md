# WealthTrack Backend

![CI](https://github.com/gopichand-retail-apps/wealthtrack-backend/actions/workflows/ci.yml/badge.svg)

[Architecture guide](docs/architecture.md) — source map, workflows, contracts, data, security, and checks.

## Repository layout and deployment boundary

This independent repository owns WealthTrack's Node.js ESM API and authoritative SQLite state. The UI is the separate [wealthtrack-frontend](https://github.com/gopichand-retail-apps/wealthtrack-frontend) repository. Keep the current directory names, Git histories, origins, and independent builds.

The Vercel configuration belongs to the frontend only. This API has no verified Vercel deployment adapter. The local file database is not shared durable storage for stateless function instances. Do not deploy the local simulator as a public API or point it at real records.

Use Node **24.15.0**, npm, and the committed package-lock.json. From the full Retail Apps workspace, `./scripts/Start-Apps.ps1 -App WealthTrack` uses the correct built/native entry after setup. With the required sibling frontend available, install with `npm.cmd ci` and start with `npm.cmd start`; no API build is needed.

Health: http://127.0.0.1:5902/api/v1/health. Direct startup stores data under `data/wealthtrack.sqlite`; the workspace launcher can select a separate app-owned path. The [API contract](openapi.yaml) and [canonical architecture](docs/architecture.md) describe the existing routes and trust boundaries. The architecture guide is inside this repository.

The API reads its seed/content contract from the adjacent frontend at `../wealthtrack-frontend/public/wealthtrack-model.json`. Clone both repositories as siblings before starting it; this existing file dependency is not a network integration. Backend configuration is read from process environment variables; creating a .env file alone does not load it.

Known release gaps: No sign-in, household ownership, or bank integration. Use synthetic CSVs only; formatting, bundle, identity, persistence, and import isolation work remain.

The Node.js API owns WealthTrack's SQLite database, validation, finance queries, and transactional CSV import. It loads synthetic fixtures and validation configuration from the sibling frontend's strict `public/wealthtrack-model.json` content model. It does not authenticate users or connect to financial institutions.

## Run

Use Node.js 22.13 or newer.

```sh
npm ci
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

The service binds to loopback and checks configured browser origins when an `Origin` header is present. CORS is not authentication or authorization: there is no user identity or row ownership enforcement. Use synthetic data only and do not expose this prototype outside the local machine. See the [security notes](docs/architecture.md#8-security-privacy-and-egress).
