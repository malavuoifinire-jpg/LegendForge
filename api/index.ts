import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleRequest, type AppRequest } from '@legendforge/server';

/**
 * Adattatore fra il runtime serverless e il router applicativo.
 *
 * È volutamente sottile: non contiene logica di dominio, solo la traduzione
 * della richiesta e della risposta. Sostituirlo con un adattatore per un
 * server sempre attivo non richiederebbe di toccare il dominio.
 */

const MAX_BODY_BYTES = 1_000_000;

type VercelRequest = IncomingMessage & { body?: unknown; query?: Record<string, string | string[]> };

async function readJsonBody(req: VercelRequest): Promise<unknown> {
  if (req.body !== undefined) return req.body;
  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return undefined;

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('payload_too_large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('invalid_json');
  }
}

function normalizeHeaders(req: VercelRequest): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}

export default async function handler(req: VercelRequest, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) query[key] = value;

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'invalid_json';
    const status = reason === 'payload_too_large' ? 413 : 400;
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        error: {
          code: reason,
          message:
            reason === 'payload_too_large'
              ? 'Corpo della richiesta troppo grande'
              : 'Corpo della richiesta non è JSON valido',
        },
      }),
    );
    return;
  }

  const request: AppRequest = {
    method: (req.method ?? 'GET').toUpperCase(),
    path: url.pathname.replace(/\/+$/u, '') || '/',
    query,
    headers: normalizeHeaders(req),
    body,
  };

  const response = await handleRequest(request);

  res.statusCode = response.status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  for (const [key, value] of Object.entries(response.headers ?? {})) res.setHeader(key, value);
  res.end(JSON.stringify(response.body));
}
