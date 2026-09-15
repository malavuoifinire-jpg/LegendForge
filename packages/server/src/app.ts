import { readEnv, type ServerEnv } from './env.js';
import { createRouter, type AppRequest, type AppResponse, type Router } from './http.js';
import { healthRoutes } from './routes/health.js';

export function createApp(env: ServerEnv = readEnv()): Router {
  return createRouter([...healthRoutes(env)]);
}

let cachedApp: Router | null = null;

/**
 * Punto di ingresso unico usato dall'adattatore del runtime.
 * Il router viene costruito una volta sola per processo.
 */
export async function handleRequest(request: AppRequest): Promise<AppResponse> {
  if (!cachedApp) cachedApp = createApp();
  return cachedApp.handle(request);
}
