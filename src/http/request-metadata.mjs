import { randomUUID } from 'node:crypto';

const knownRoutes = new Set([
  '/api/v1/health',
  '/api/v1/version',
  '/api/v1/summary',
  '/api/v1/accounts',
  '/api/v1/transactions',
  '/api/v1/budgets',
  '/api/v1/goals',
  '/api/v1/bills',
  '/api/v1/imports/template',
  '/api/v1/imports/preview',
  '/api/v1/imports',
]);

export function requestIds(request) {
  const traceParent = request.headers.traceparent ?? '';
  const match = /^\w{2}-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$/i.exec(
    traceParent,
  );
  return {
    requestId: randomUUID(),
    traceId: match?.[1] ?? randomUUID().replaceAll('-', ''),
    spanId: match?.[2] ?? randomUUID().replaceAll('-', '').slice(0, 16),
  };
}

export function routeTemplate(pathname) {
  return knownRoutes.has(pathname) ? pathname : '/unmatched';
}

export function setSecurityHeaders(response, { requestId, traceId }) {
  response.setHeader('X-Request-ID', requestId);
  response.setHeader('X-Trace-ID', traceId);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Vary', 'Origin');
}

export function setCorsHeaders(response, origin) {
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Idempotency-Key, Traceparent',
  );
  response.setHeader(
    'Access-Control-Expose-Headers',
    'X-Request-ID, X-Trace-ID',
  );
}
