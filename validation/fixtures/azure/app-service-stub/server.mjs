/* global process */
// Minimal App Service stub: serves the bundled OpenAPI fixture, a health
// endpoint, and the synchronous Event Grid subscription-validation handshake.
import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const openapi = readFileSync(path.join(here, 'openapi.json'), 'utf8');
const port = Number(process.env.PORT ?? 8080);
const MAX_REQUEST_BYTES = 64 * 1024;

function writeJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

export function eventGridValidationResponse(payload) {
  if (!Array.isArray(payload)) return undefined;
  const event = payload.find(
    (candidate) =>
      candidate?.eventType === 'Microsoft.EventGrid.SubscriptionValidationEvent' &&
      typeof candidate?.data?.validationCode === 'string' &&
      candidate.data.validationCode.length > 0
  );
  return event ? { validationResponse: event.data.validationCode } : undefined;
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw new RangeError('request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function startServer() {
  return createServer(async (request, response) => {
    if (request.url === '/openapi.json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(openapi);
      return;
    }
    if (request.url === '/health') {
      if (request.method === 'POST') {
        try {
          const validation = eventGridValidationResponse(await readJson(request));
          if (validation) {
            writeJson(response, 200, validation);
            return;
          }
        } catch (error) {
          writeJson(response, error instanceof RangeError ? 413 : 400, { error: 'invalid request' });
          return;
        }
      }
      writeJson(response, 200, { status: 'ok' });
      return;
    }
    writeJson(response, 404, { error: 'not found' });
  }).listen(port);
}

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entrypoint === fileURLToPath(import.meta.url)) startServer();
