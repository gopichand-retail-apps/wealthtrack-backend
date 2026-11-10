import { z } from 'zod';
import { APP_VERSION } from '../app-version.mjs';
import { errorEnvelope } from './errors.mjs';
import { readJsonBody } from './json.mjs';
import { setCorsHeaders } from './request-metadata.mjs';

const previewSchema = z.object({ csvText: z.string().min(1) }).strict();
const limitSchema = z.coerce.number().int().min(1).max(500).default(100);

const handlers = new Map([
  ['GET /api/v1/health', handleHealth],
  ['GET /api/v1/version', handleVersion],
  ['GET /api/v1/summary', handleSummary],
  ['GET /api/v1/accounts', handleAccounts],
  ['GET /api/v1/transactions', handleTransactions],
  ['GET /api/v1/budgets', handleBudgets],
  ['GET /api/v1/goals', handleGoals],
  ['GET /api/v1/bills', handleBills],
  ['GET /api/v1/imports/template', handleImportTemplate],
  ['POST /api/v1/imports/preview', handleImportPreview],
  ['POST /api/v1/imports', handleImportCommit],
]);

export async function routeApiRequest(context) {
  const {
    request,
    response,
    origin,
    allowedOrigins,
    model,
    isRateLimited,
    requestId,
    pathname,
  } = context;
  if (origin && !allowedOrigins.includes(origin)) {
    return errorEnvelope(
      403,
      'ORIGIN_NOT_ALLOWED',
      model.copy.errors.originNotAllowed,
      requestId,
    );
  }
  if (origin) setCorsHeaders(response, origin);
  if (request.method === 'OPTIONS') return { status: 204 };
  if (isRateLimited(request.socket.remoteAddress ?? 'local')) {
    response.setHeader('Retry-After', '60');
    return errorEnvelope(
      429,
      'RATE_LIMITED',
      model.copy.errors.rateLimited,
      requestId,
    );
  }

  const handler = handlers.get(`${request.method} ${pathname}`);
  if (!handler)
    return errorEnvelope(
      404,
      'NOT_FOUND',
      model.copy.errors.notFound,
      requestId,
    );
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  return handler({ ...context, url });
}

function handleHealth() {
  return {
    status: 200,
    body: {
      data: { status: 'ok', service: 'wealthtrack-api', storage: 'sqlite' },
    },
  };
}

function handleVersion() {
  return {
    status: 200,
    body: { data: { service: 'wealthtrack-api', version: APP_VERSION } },
  };
}

function resolveDays(url, model) {
  const defaultDays = model.periods.find(
    (period) => period.id === model.filters.defaultPeriodId,
  )?.days;
  const days = Number(url.searchParams.get('days') ?? defaultDays);
  return model.periods.some((period) => period.days === days) ? days : null;
}

function handleSummary({ model, repository, url, requestId }) {
  const days = resolveDays(url, model);
  if (days === null) {
    return errorEnvelope(
      400,
      'INVALID_PERIOD',
      model.copy.errors.invalidRequest,
      requestId,
    );
  }
  return { status: 200, body: { data: repository.getSummary(days) } };
}

function handleAccounts({ repository }) {
  return { status: 200, body: { data: repository.getAccounts() } };
}

function handleTransactions({ model, repository, url, requestId }) {
  const filters = validateTransactionFilters(model, url, requestId);
  if (filters.error) return filters.error;
  const { from, to } = transactionRange(filters.days);
  return {
    status: 200,
    body: { data: repository.getTransactions({ ...filters, from, to }) },
  };
}

function validateTransactionFilters(model, url, requestId) {
  const days = resolveDays(url, model);
  if (days === null) {
    return {
      error: errorEnvelope(
        400,
        'INVALID_PERIOD',
        model.copy.errors.invalidRequest,
        requestId,
      ),
    };
  }
  const category = url.searchParams.get('category');
  const accountId = url.searchParams.get('accountId');
  const search = (url.searchParams.get('search') ?? '').trim();
  const limit = limitSchema.safeParse(
    url.searchParams.get('limit') ?? undefined,
  );
  if (!limit.success || search.length > 80) {
    return {
      error: errorEnvelope(
        400,
        'INVALID_FILTER',
        model.copy.errors.invalidRequest,
        requestId,
      ),
    };
  }
  if (category && !model.categories.some((item) => item.id === category)) {
    return {
      error: errorEnvelope(
        400,
        'INVALID_CATEGORY',
        model.copy.errors.invalidRequest,
        requestId,
      ),
    };
  }
  if (accountId && !model.seed.accounts.some((item) => item.id === accountId)) {
    return {
      error: errorEnvelope(
        404,
        'ACCOUNT_NOT_FOUND',
        model.copy.errors.notFound,
        requestId,
      ),
    };
  }
  return { days, category, accountId, search, limit: limit.data };
}

function transactionRange(days) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const from = new Date(
    today.getTime() - (days - 1) * 86_400_000,
  ).toISOString();
  const to = new Date(today.getTime() + 86_400_000).toISOString();
  return { from, to };
}

function handleBudgets({ repository }) {
  return { status: 200, body: { data: repository.getBudgets() } };
}

function handleGoals({ repository }) {
  return { status: 200, body: { data: repository.getGoals() } };
}

function handleBills({ repository }) {
  return { status: 200, body: { data: repository.getBills() } };
}

function escapeCsvCell(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function handleImportTemplate({ model }) {
  const rows = [model.csv.headers, ...model.csv.templateRows];
  const body = rows.map((row) => row.map(escapeCsvCell).join(',')).join('\r\n');
  return {
    status: 200,
    contentType: 'text/csv; charset=utf-8',
    headers: {
      'Content-Disposition': `attachment; filename="${model.csv.sampleFileName}"`,
    },
    body,
  };
}

async function handleImportPreview({ model, imports, request, requestId }) {
  const body = await readJsonBody(request, model.csv.maximumBytes + 1024);
  const parsed = previewSchema.safeParse(body);
  if (!parsed.success) {
    return errorEnvelope(
      400,
      'INVALID_IMPORT_REQUEST',
      model.copy.errors.invalidRequest,
      requestId,
    );
  }
  return { status: 200, body: { data: imports.preview(parsed.data.csvText) } };
}

async function handleImportCommit({ model, imports, request, requestId }) {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(key)) {
    return errorEnvelope(
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
      model.copy.errors.invalidRequest,
      requestId,
    );
  }
  const body = await readJsonBody(request, model.csv.maximumBytes + 1024);
  const parsed = previewSchema.safeParse(body);
  if (!parsed.success) {
    return errorEnvelope(
      400,
      'INVALID_IMPORT_REQUEST',
      model.copy.errors.invalidRequest,
      requestId,
    );
  }
  const result = imports.commit(parsed.data.csvText, key);
  if (result.invalidCount > 0) {
    return errorEnvelope(
      422,
      'INVALID_CSV',
      model.copy.errors.invalidCsv,
      requestId,
      result.invalidRows,
    );
  }
  return { status: result.replayed ? 200 : 201, body: { data: result } };
}
