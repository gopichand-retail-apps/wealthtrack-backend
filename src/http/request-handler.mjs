import { mapRequestError } from './errors.mjs';
import { APP_VERSION } from '../app-version.mjs';
import { sendOutcome } from './json.mjs';
import { routeApiRequest } from './api-router.mjs';
import {
  requestIds,
  routeTemplate,
  setSecurityHeaders,
} from './request-metadata.mjs';
import { writeLog } from '../observability/logging.mjs';

export async function handleApiRequest(context) {
  const startedAt = performance.now();
  const ids = requestIds(context.request);
  const pathname = new URL(context.request.url ?? '/', 'http://127.0.0.1')
    .pathname;
  setSecurityHeaders(context.response, ids);
  let outcome;
  try {
    outcome = await routeApiRequest({
      ...context,
      ...ids,
      origin: context.request.headers.origin,
      pathname,
    });
  } catch (error) {
    outcome = mapRequestError(error, context.model, ids.requestId);
  }
  sendOutcome(context.response, outcome);
  logRequest(context, outcome, ids, routeTemplate(pathname), startedAt);
}

function logRequest(context, outcome, ids, route, startedAt) {
  const failed = outcome.status >= 400;
  writeLog({
    level: outcome.status >= 500 ? 'ERROR' : failed ? 'WARN' : 'INFO',
    service: 'wealthtrack-api',
    environment: process.env.NODE_ENV ?? 'development',
    version: APP_VERSION,
    eventName: failed ? 'api.request.failed' : 'api.request.completed',
    requestId: ids.requestId,
    traceId: ids.traceId,
    spanId: ids.spanId,
    method: context.request.method,
    routeTemplate: route,
    status: outcome.status,
    durationMs: Math.round(performance.now() - startedAt),
    outcome: failed ? 'failure' : 'success',
    ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
  });
}
