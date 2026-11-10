import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseWealthTrackModel } from './model.schema.mjs';

const envelope = JSON.parse(
  await readFile(
    new URL(
      '../../wealthtrack-frontend/public/wealthtrack-model.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

test('normalizes the strict versioned WealthTrack content envelope', () => {
  const model = parseWealthTrackModel(envelope);

  assert.equal(model.modelVersion, envelope.version);
  assert.equal(model.app.locale, envelope.locale);
  assert.equal(model.copy.overview, envelope.messages.overview);
  assert.equal(model.navigation.length, 6);
  assert.equal(Object.hasOwn(model, 'architecture'), false);
});

test('rejects a wrong app ID, missing data, and an architecture payload', () => {
  assert.throws(() =>
    parseWealthTrackModel({ ...envelope, appId: 'other-app' }),
  );

  const missingData = structuredClone(envelope);
  Reflect.deleteProperty(missingData, 'data');
  assert.throws(() => parseWealthTrackModel(missingData));

  const architecturePayload = structuredClone(envelope);
  architecturePayload.data.architecture = { diagram: 'not product data' };
  assert.throws(() => parseWealthTrackModel(architecturePayload));
});

test('rejects invalid nested money and configuration values', () => {
  const invalidSeed = structuredClone(envelope);
  invalidSeed.data.seed.transactions[0].amountCents = 1.5;
  assert.throws(() => parseWealthTrackModel(invalidSeed));

  const invalidOrigin = structuredClone(envelope);
  invalidOrigin.data.app.allowedOrigins = ['not-an-origin'];
  assert.throws(() => parseWealthTrackModel(invalidOrigin));
});
