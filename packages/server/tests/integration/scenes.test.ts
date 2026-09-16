import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, request, sessionCookieFrom, type TestHarness } from './helpers.js';
import { createSession } from '../../src/identity/store.js';
import { SESSION_COOKIE } from '../../src/identity/cookies.js';
import type { GridState, Scene, SceneDetail, Token } from '@legendforge/contracts';

let harness: TestHarness;
let gmCookie = '';
let campaignId = '';

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
  const setup = await harness.app.handle(
    request('POST', '/api/setup', { body: { displayName: 'Simone', pin: 'forgia-2026' } }),
  );
  gmCookie = sessionCookieFrom(setup);
  const campaign = await harness.app.handle(
    request('POST', '/api/campaigns', { cookie: gmCookie, body: { name: 'Prova', playerSlots: 4 } }),
  );
  campaignId = (campaign.body as { id: string }).id;
});

/** Aggiunge un giocatore alla campagna e restituisce il suo cookie. */
async function addPlayer(): Promise<string> {
  const user = await harness.pool.query<{ id: string }>(
    `INSERT INTO users (display_name) VALUES ('Giocatore') RETURNING id`,
  );
  const userId = user.rows[0]?.id;
  if (!userId) throw new Error('utente non creato');
  await harness.pool.query(
    `INSERT INTO campaign_memberships (campaign_id, user_id, role) VALUES ($1, $2, 'player')`,
    [campaignId, userId],
  );
  const token = await createSession(harness.pool, userId, 'vitest');
  return `${SESSION_COOKIE}=${token}`;
}

async function createScene(name = 'Ingresso'): Promise<Scene> {
  const response = await harness.app.handle(
    request('POST', `/api/campaigns/${campaignId}/scenes`, { cookie: gmCookie, body: { name } }),
  );
  expect(response.status).toBe(201);
  return response.body as Scene;
}

async function addToken(sceneId: string, body: Record<string, unknown>): Promise<Token> {
  const response = await harness.app.handle(
    request('POST', `/api/scenes/${sceneId}/tokens`, { cookie: gmCookie, body }),
  );
  expect(response.status).toBe(201);
  return response.body as Token;
}

describe('scene', () => {
  it('nasce con una griglia non configurata e i default di prodotto', async () => {
    const scene = await createScene();
    expect(scene.grid.status).toBe('unconfigured');
    expect(scene.grid.metersPerCell).toBe(1.5);
    expect(scene.grid.snapEnabled).toBe(true);
    expect(scene.tokenCount).toBe(0);
  });

  it('compare nell elenco della campagna', async () => {
    await createScene('Cripta');
    const list = await harness.app.handle(
      request('GET', `/api/campaigns/${campaignId}/scenes`, { cookie: gmCookie }),
    );
    expect((list.body as Scene[]).map((s) => s.name)).toEqual(['Cripta']);
  });

  it('un giocatore può leggerla ma non crearne', async () => {
    const scene = await createScene();
    const player = await addPlayer();
    expect(
      (await harness.app.handle(request('GET', `/api/scenes/${scene.id}`, { cookie: player })))
        .status,
    ).toBe(200);
    expect(
      (
        await harness.app.handle(
          request('POST', `/api/campaigns/${campaignId}/scenes`, {
            cookie: player,
            body: { name: 'Abusiva' },
          }),
        )
      ).status,
    ).toBe(403);
  });

  it('a un estraneo risulta inesistente', async () => {
    const scene = await createScene();
    const stranger = await harness.pool.query<{ id: string }>(
      `INSERT INTO users (display_name) VALUES ('Estraneo') RETURNING id`,
    );
    const token = await createSession(harness.pool, stranger.rows[0]!.id, 'vitest');
    const response = await harness.app.handle(
      request('GET', `/api/scenes/${scene.id}`, { cookie: `${SESSION_COOKIE}=${token}` }),
    );
    expect(response.status).toBe(404);
  });
});

describe('calibrazione della griglia', () => {
  it('aggiorna i valori e incrementa la versione', async () => {
    const scene = await createScene();
    const response = await harness.app.handle(
      request('PATCH', `/api/scenes/${scene.id}/grid`, {
        cookie: gmCookie,
        body: { version: scene.grid.version, cellSizePx: 72, offsetX: 11, offsetY: 5 },
      }),
    );
    expect(response.status).toBe(200);
    const grid = response.body as GridState;
    expect(grid.cellSizePx).toBe(72);
    expect(grid.offsetX).toBe(11);
    expect(grid.version).toBe(scene.grid.version + 1);
  });

  it('richiede una conferma esplicita per passare a confermata', async () => {
    const scene = await createScene();
    const patched = await harness.app.handle(
      request('PATCH', `/api/scenes/${scene.id}/grid`, {
        cookie: gmCookie,
        body: { version: scene.grid.version, cellSizePx: 64 },
      }),
    );
    expect((patched.body as GridState).status).toBe('unconfigured');

    const confirmed = await harness.app.handle(
      request('PATCH', `/api/scenes/${scene.id}/grid`, {
        cookie: gmCookie,
        body: { version: (patched.body as GridState).version, confirmed: true },
      }),
    );
    expect((confirmed.body as GridState).status).toBe('confirmed');
  });

  it('rifiuta un aggiornamento basato su una versione superata', async () => {
    const scene = await createScene();
    await harness.app.handle(
      request('PATCH', `/api/scenes/${scene.id}/grid`, {
        cookie: gmCookie,
        body: { version: scene.grid.version, cellSizePx: 80 },
      }),
    );
    const stale = await harness.app.handle(
      request('PATCH', `/api/scenes/${scene.id}/grid`, {
        cookie: gmCookie,
        body: { version: scene.grid.version, cellSizePx: 40 },
      }),
    );
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: { code: 'version_conflict' } });
  });

  it('rifiuta valori fuori dagli intervalli ammessi', async () => {
    const scene = await createScene();
    for (const body of [
      { cellSizePx: 0 },
      { cellSizePx: 99999 },
      { rotationDeg: 45 },
      { metersPerCell: -1 },
    ]) {
      const response = await harness.app.handle(
        request('PATCH', `/api/scenes/${scene.id}/grid`, {
          cookie: gmCookie,
          body: { version: scene.grid.version, ...body },
        }),
      );
      expect(response.status).toBe(400);
    }
  });

  it('un giocatore non può calibrare', async () => {
    const scene = await createScene();
    const player = await addPlayer();
    const response = await harness.app.handle(
      request('PATCH', `/api/scenes/${scene.id}/grid`, {
        cookie: player,
        body: { version: scene.grid.version, cellSizePx: 50 },
      }),
    );
    expect(response.status).toBe(403);
  });
});

describe('pedine', () => {
  it('vengono agganciate alla griglia dal server', async () => {
    const scene = await createScene();
    await harness.app.handle(
      request('PATCH', `/api/scenes/${scene.id}/grid`, {
        cookie: gmCookie,
        body: { version: scene.grid.version, cellSizePx: 100, offsetX: 0, offsetY: 0 },
      }),
    );
    const token = await addToken(scene.id, { name: 'Aria', x: 233, y: 141 });
    // Centro della casella (2,1) con passo 100 e offset nullo.
    expect(token.x).toBe(250);
    expect(token.y).toBe(150);
  });

  it('rispettano la richiesta di non agganciare', async () => {
    const scene = await createScene();
    const token = await addToken(scene.id, { name: 'Libera', x: 233.5, y: 141.25, snapToGrid: false });
    expect(token.x).toBeCloseTo(233.5, 6);
    expect(token.y).toBeCloseTo(141.25, 6);
  });

  it('si spostano e la versione avanza', async () => {
    const scene = await createScene();
    const token = await addToken(scene.id, { name: 'Aria', x: 10, y: 10, snapToGrid: false });
    const moved = await harness.app.handle(
      request('PATCH', `/api/tokens/${token.id}`, {
        cookie: gmCookie,
        body: { version: token.version, x: 400, y: 300, snapToGrid: false },
      }),
    );
    expect(moved.status).toBe(200);
    const updated = moved.body as Token;
    expect(updated.x).toBe(400);
    expect(updated.version).toBe(token.version + 1);
  });

  it('rifiutano uno spostamento basato su una versione superata', async () => {
    const scene = await createScene();
    const token = await addToken(scene.id, { name: 'Aria', x: 10, y: 10, snapToGrid: false });
    await harness.app.handle(
      request('PATCH', `/api/tokens/${token.id}`, {
        cookie: gmCookie,
        body: { version: token.version, x: 100, y: 100, snapToGrid: false },
      }),
    );
    const stale = await harness.app.handle(
      request('PATCH', `/api/tokens/${token.id}`, {
        cookie: gmCookie,
        body: { version: token.version, x: 999, y: 999, snapToGrid: false },
      }),
    );
    expect(stale.status).toBe(409);

    // La posizione vincente resta la prima, non l'ultima arrivata.
    const detail = await harness.app.handle(
      request('GET', `/api/scenes/${scene.id}`, { cookie: gmCookie }),
    );
    expect((detail.body as SceneDetail).tokens[0]?.x).toBe(100);
  });

  it('restano dove sono state messe, anche rileggendo la scena', async () => {
    const scene = await createScene();
    await addToken(scene.id, { name: 'Aria', x: 128, y: 64, snapToGrid: false });
    const detail = await harness.app.handle(
      request('GET', `/api/scenes/${scene.id}`, { cookie: gmCookie }),
    );
    const tokens = (detail.body as SceneDetail).tokens;
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ name: 'Aria', x: 128, y: 64 });
  });

  it('si cancellano', async () => {
    const scene = await createScene();
    const token = await addToken(scene.id, { name: 'Usa e getta', x: 0, y: 0 });
    expect(
      (await harness.app.handle(request('DELETE', `/api/tokens/${token.id}`, { cookie: gmCookie })))
        .status,
    ).toBe(200);
    const detail = await harness.app.handle(
      request('GET', `/api/scenes/${scene.id}`, { cookie: gmCookie }),
    );
    expect((detail.body as SceneDetail).tokens).toHaveLength(0);
  });
});

describe('pedine nascoste', () => {
  it('non compaiono affatto nella risposta a un giocatore', async () => {
    const scene = await createScene();
    await addToken(scene.id, { name: 'Visibile', x: 0, y: 0 });
    const secret = await addToken(scene.id, { name: 'Agguato', x: 500, y: 500, hidden: true });

    const player = await addPlayer();
    const detail = await harness.app.handle(
      request('GET', `/api/scenes/${scene.id}`, { cookie: player }),
    );
    const body = detail.body as SceneDetail;
    expect(body.tokens.map((t) => t.name)).toEqual(['Visibile']);
    // Nemmeno il nome deve trapelare nel corpo della risposta.
    expect(JSON.stringify(body)).not.toContain('Agguato');
    expect(JSON.stringify(body)).not.toContain(secret.id);

    // Il Game Master invece le vede tutte.
    const gmView = await harness.app.handle(
      request('GET', `/api/scenes/${scene.id}`, { cookie: gmCookie }),
    );
    expect((gmView.body as SceneDetail).tokens).toHaveLength(2);
  });

  it('un giocatore non può modificare né cancellare pedine', async () => {
    const scene = await createScene();
    const token = await addToken(scene.id, { name: 'Aria', x: 0, y: 0 });
    const player = await addPlayer();

    expect(
      (
        await harness.app.handle(
          request('PATCH', `/api/tokens/${token.id}`, {
            cookie: player,
            body: { version: token.version, x: 900, y: 900 },
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await harness.app.handle(request('DELETE', `/api/tokens/${token.id}`, { cookie: player })))
        .status,
    ).toBe(403);

    const detail = await harness.app.handle(
      request('GET', `/api/scenes/${scene.id}`, { cookie: gmCookie }),
    );
    expect((detail.body as SceneDetail).tokens[0]?.x).toBe(token.x);
  });

  it('un estraneo non può nemmeno raggiungere la pedina', async () => {
    const scene = await createScene();
    const token = await addToken(scene.id, { name: 'Aria', x: 0, y: 0 });
    const stranger = await harness.pool.query<{ id: string }>(
      `INSERT INTO users (display_name) VALUES ('Estraneo') RETURNING id`,
    );
    const session = await createSession(harness.pool, stranger.rows[0]!.id, 'vitest');
    const response = await harness.app.handle(
      request('PATCH', `/api/tokens/${token.id}`, {
        cookie: `${SESSION_COOKIE}=${session}`,
        body: { version: token.version, x: 1, y: 1 },
      }),
    );
    expect(response.status).toBe(404);
  });
});
