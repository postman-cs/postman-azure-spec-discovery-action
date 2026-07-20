import type { Server } from 'node:http';

export function eventGridValidationResponse(payload: unknown):
  | { validationResponse: string }
  | undefined;
export function startServer(): Server;
