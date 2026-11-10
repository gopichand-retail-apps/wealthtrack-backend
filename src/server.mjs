import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createFinanceRepository } from './finance.repository.mjs';
import { handleApiRequest } from './http/request-handler.mjs';
import { createImportService } from './import.service.mjs';
import { parseWealthTrackModel } from './model.schema.mjs';
import { createRateLimiter } from './services/rate-limiter.mjs';

const modelPath = fileURLToPath(
  new URL(
    '../../wealthtrack-frontend/public/wealthtrack-model.json',
    import.meta.url,
  ),
);
const allowedOriginsSchema = z.array(z.string().url()).min(1);

export function loadModel() {
  const envelope = JSON.parse(readFileSync(modelPath, 'utf8'));
  return parseWealthTrackModel(envelope);
}

function resolveAllowedOrigins(model) {
  const configuredOrigins = process.env.WEALTHTRACK_ALLOWED_ORIGINS;
  if (configuredOrigins === undefined) return model.app.allowedOrigins;
  return allowedOriginsSchema.parse(
    configuredOrigins.split(',').map((origin) => origin.trim()),
  );
}

export function createApiServer({
  databasePath = 'data/wealthtrack.sqlite',
  model = loadModel(),
} = {}) {
  if (databasePath !== ':memory:')
    mkdirSync(dirname(resolve(databasePath)), { recursive: true });
  const allowedOrigins = resolveAllowedOrigins(model);
  const isRateLimited = createRateLimiter(
    model.api.rateLimit,
    model.api.rateWindowMs,
  );
  const repository = createFinanceRepository({ databasePath, model });
  const imports = createImportService({ model, repository });
  const server = createServer((request, response) => {
    void handleApiRequest({
      request,
      response,
      model,
      repository,
      imports,
      allowedOrigins,
      isRateLimited,
    });
  });

  return {
    server,
    close: () => closeApiServer(server, repository),
  };
}

function closeApiServer(server, repository) {
  return new Promise((resolveClose, reject) => {
    server.close((error) => {
      repository.close();
      if (error) reject(error);
      else resolveClose();
    });
    server.closeAllConnections();
  });
}
