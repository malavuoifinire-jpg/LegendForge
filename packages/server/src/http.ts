import type { ErrorBody } from '@legendforge/contracts';

/**
 * Tipi di trasporto indipendenti dal runtime.
 *
 * Il dominio non conosce Vercel, Express o Node: riceve una richiesta
 * normalizzata e restituisce una risposta normalizzata. L'adattatore che sta
 * fuori si occupa di tradurre.
 */
export interface AppRequest {
  method: string;
  /** Percorso senza query string, sempre con lo slash iniziale. */
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | undefined>;
  body: unknown;
}

export interface AppResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

export type RouteParams = Record<string, string>;

export interface RouteContext {
  request: AppRequest;
  params: RouteParams;
}

export interface Route {
  method: string;
  /** Schema del percorso, con segmenti dinamici del tipo `:id`. */
  pattern: string;
  handle: (context: RouteContext) => Promise<AppResponse> | AppResponse;
}

/** Errore applicativo con codice e stato HTTP espliciti. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function errorBody(code: string, message: string, details?: unknown): ErrorBody {
  return details === undefined ? { error: { code, message } } : { error: { code, message, details } };
}

function matchPattern(pattern: string, path: string): RouteParams | null {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = path.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;

  const params: RouteParams = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const expected = patternParts[i];
    const actual = pathParts[i];
    if (expected === undefined || actual === undefined) return null;
    if (expected.startsWith(':')) {
      params[expected.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (expected !== actual) return null;
  }
  return params;
}

export interface Router {
  handle: (request: AppRequest) => Promise<AppResponse>;
}

export function createRouter(routes: Route[]): Router {
  return {
    async handle(request: AppRequest): Promise<AppResponse> {
      let pathExists = false;

      for (const route of routes) {
        const params = matchPattern(route.pattern, request.path);
        if (params === null) continue;
        pathExists = true;
        if (route.method !== request.method) continue;
        try {
          return await route.handle({ request, params });
        } catch (error) {
          if (error instanceof HttpError) {
            return {
              status: error.status,
              body: errorBody(error.code, error.message, error.details),
            };
          }
          // Il dettaglio interno non esce mai verso il client.
          return {
            status: 500,
            body: errorBody('internal_error', 'Errore interno del server'),
          };
        }
      }

      if (pathExists) {
        return { status: 405, body: errorBody('method_not_allowed', 'Metodo non consentito') };
      }
      return { status: 404, body: errorBody('not_found', 'Risorsa non trovata') };
    },
  };
}
