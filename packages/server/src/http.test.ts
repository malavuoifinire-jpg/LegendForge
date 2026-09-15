import { describe, expect, it } from 'vitest';
import { createRouter, HttpError, type AppRequest } from './http.js';

function request(method: string, path: string): AppRequest {
  return { method, path, query: {}, headers: {}, body: undefined };
}

const router = createRouter([
  { method: 'GET', pattern: '/api/ping', handle: () => ({ status: 200, body: { pong: true } }) },
  {
    method: 'GET',
    pattern: '/api/scenes/:sceneId/tokens/:tokenId',
    handle: ({ params }) => ({ status: 200, body: params }),
  },
  {
    method: 'POST',
    pattern: '/api/boom',
    handle: () => {
      throw new HttpError(409, 'version_conflict', 'La risorsa è cambiata');
    },
  },
  {
    method: 'POST',
    pattern: '/api/crash',
    handle: () => {
      throw new Error('dettaglio interno che non deve uscire');
    },
  },
]);

describe('router', () => {
  it('instrada una rotta statica', async () => {
    const response = await router.handle(request('GET', '/api/ping'));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ pong: true });
  });

  it('estrae i parametri dinamici', async () => {
    const response = await router.handle(request('GET', '/api/scenes/abc/tokens/xyz'));
    expect(response.body).toEqual({ sceneId: 'abc', tokenId: 'xyz' });
  });

  it('distingue 404 da 405', async () => {
    expect((await router.handle(request('GET', '/api/ignoto'))).status).toBe(404);
    expect((await router.handle(request('DELETE', '/api/ping'))).status).toBe(405);
  });

  it('traduce HttpError in risposta con codice', async () => {
    const response = await router.handle(request('POST', '/api/boom'));
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: { code: 'version_conflict' } });
  });

  it('non fa trapelare i dettagli di un errore imprevisto', async () => {
    const response = await router.handle(request('POST', '/api/crash'));
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('dettaglio interno');
    expect(response.body).toMatchObject({ error: { code: 'internal_error' } });
  });

  it('non confonde percorsi di lunghezza diversa', async () => {
    expect((await router.handle(request('GET', '/api/ping/extra'))).status).toBe(404);
  });
});
