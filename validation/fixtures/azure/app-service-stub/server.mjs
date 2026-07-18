/* global process */
// Minimal App Service stub: serves the bundled OpenAPI fixture at /openapi.json
// and a matching /health endpoint. No dependencies.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const openapi = readFileSync(path.join(here, 'openapi.json'), 'utf8');
const port = Number(process.env.PORT ?? 8080);

createServer((request, response) => {
  if (request.url === '/openapi.json') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(openapi);
    return;
  }
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: 'not found' }));
}).listen(port);
