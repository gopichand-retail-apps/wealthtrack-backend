export function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}

export function sendOutcome(response, outcome) {
  if (outcome.status === 204) {
    response.writeHead(outcome.status);
    response.end();
    return;
  }
  if (outcome.contentType) {
    response.writeHead(outcome.status, {
      'Content-Type': outcome.contentType,
      ...outcome.headers,
    });
    response.end(outcome.body);
    return;
  }
  sendJson(response, outcome.status, outcome.body);
}

function requestError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export async function readJsonBody(request, maximumBytes) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw requestError('Payload too large', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw requestError('Invalid JSON', 400);
  }
}
