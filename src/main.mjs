import { fileURLToPath } from 'node:url';
import { writeLog } from './observability/logging.mjs';
import { loadModel, createApiServer } from './server.mjs';

function withE2ERateLimit(model) {
  const configuredRateLimit = process.env.WEALTHTRACK_E2E_RATE_LIMIT;
  if (!configuredRateLimit) return model;
  const rateLimit = Number(configuredRateLimit);
  if (!Number.isSafeInteger(rateLimit) || rateLimit < model.api.rateLimit) {
    throw new Error(
      'WEALTHTRACK_E2E_RATE_LIMIT must not be lower than the configured rate limit.',
    );
  }
  return { ...model, api: { ...model.api, rateLimit } };
}

const databasePath =
  process.env.WEALTHTRACK_DB_PATH ??
  fileURLToPath(new URL('../data/wealthtrack.sqlite', import.meta.url));
const port = Number(process.env.PORT ?? 5902);
const api = createApiServer({
  databasePath,
  model: withE2ERateLimit(loadModel()),
});
let shuttingDown = false;

api.server.listen(port, '127.0.0.1', () => {
  writeLog({
    level: 'INFO',
    service: 'wealthtrack-api',
    environment: process.env.NODE_ENV ?? 'development',
    eventName: 'service.started',
    port,
    storage: 'sqlite',
  });
});

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  void api
    .close()
    .then(() => {
      process.exitCode = 0;
    })
    .catch((error) => {
      writeLog({
        level: 'ERROR',
        service: 'wealthtrack-api',
        environment: process.env.NODE_ENV ?? 'development',
        eventName: 'service.shutdown.failed',
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      process.exitCode = 1;
    });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
