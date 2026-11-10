export function errorEnvelope(status, code, message, requestId, details) {
  return {
    status,
    errorCode: code,
    body: {
      error: { code, message, requestId, ...(details ? { details } : {}) },
    },
  };
}

export function mapRequestError(error, model, requestId) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const code =
    status === 413
      ? 'PAYLOAD_TOO_LARGE'
      : status === 400
        ? 'INVALID_JSON'
        : 'INTERNAL_ERROR';
  const message =
    status === 413
      ? model.copy.errors.payloadTooLarge
      : status === 400
        ? model.copy.errors.invalidRequest
        : model.copy.errors.server;
  return errorEnvelope(status, code, message, requestId);
}
