import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, request, sessionCookieFrom, type TestHarness } from './helpers.js';
import { createSession } from '../../src/identity/store.js';
import { SESSION_COOKIE } from '../../src/identity/cookies.js';
import type {
  LightSource,
  Scene,
  SceneDetail,
  SceneVisionSettings,
  SceneVisionState,
  Token,
  Wall,
} from '@legendforge/contracts';

/**
 * Campo visivo dal lato del server.
 *
 * La domanda di fondo di questi test è sempre la stessa: che cosa arriva
 * davvero nella risposta. Non basta che l'interfaccia non disegni una pedina —
 * il giocatore non deve proprio riceverla.
 */

let harness: TestHarness;
let gmCookie = '';
let campaignId = '';

/** Casella da 50 px che vale 1,5 m: un metro sono 100/3 pixel. */
const CELL_PX = 50;
const METERS_PER_CELL = 1.5;
const PX_PER_METER = CELL_PX / METERS_PER_CELL;

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

async function addPlayer(name = 'Giocatore'): Promise<{ cookie: string; userId: string }> {
  const user = await harness.pool.query<{ id: string }>(
    `INSERT INTO users (display_name) VALUES ($1) RETURNING id`,
    [name],
  );
  const userId = user.rows[0]?.id;
  if (!userId) throw new Error('utente non creato');
  await harness.pool.query(
    `INSERT INTO campaign_memberships (campaign_id, user_id, role) VALUES ($1, $2, 'player')`,
    [campaignId, userId],
  );
  const token = await createSession(harness.pool, userId, 'vitest');
  return { cookie: `${SESSION_COOKIE}=${token}`, userId };
}

/** Scena con griglia confermata e visione accesa al buio pesto. */
async function createDarkScene(): Promise<Scene> {
  const created = await harness.app.handle(
    request('POST', `/api/campaigns/${campaignId}/scenes`, {
      cookie: gmCookie,
      body: { name: 'Cripta' },
    }),
  );
  const scene = created.body as Scene;
  const grid = await harness.app.handle(
    request('PATCH', `/api/scenes/${scene.id}/grid`, {
      cookie: gmCookie,
      body: {
        version: scene.grid.version,
        cellSizePx: CELL_PX,
        offsetX: 0,
        offsetY: 0,
        rotationDeg: 0,
        metersPerCell: METERS_PER_CELL,
        confirmed: true,
      },
    }),
  );
  expect(grid.status).toBe(200);

  const current = (
    await harness.app.handle(request('GET', `/api/scenes/${scene.id}`, { cookie: gmCookie }))
  ).body as SceneDetail;
  const vision = await harness.app.handle(
    request('PATCH', `/api/scenes/${scene.id}/vision`, {
      cookie: gmCookie,
      body: {
        version: current.version,
        visionEnabled: true,
        ambientDarkness: 1,
        sceneReachMeters: 60,
      },
    }),
  );
  expect(vision.status).toBe(200);
  return scene;
}

/** Personaggio con scurovisione, assegnato a una persona, con la sua pedina. */
async function addCharacter(
  sceneId: string,
  ownerId: string,
  position: { x: number; y: number },
  darkvisionMeters = 18,
): Promise<Token> {
  const actor = await harness.app.handle(
    request('POST', `/api/campaigns/${campaignId}/actors`, {
      cookie: gmCookie,
      body: { kind: 'character', name: 'Eroe' },
    }),
  );
  const actorId = (actor.body as { id: string }).id;
  await harness.pool.query('UPDATE actors SET darkvision_meters = $2 WHERE id = $1', [
    actorId,
    darkvisionMeters,
  ]);
  await harness.app.handle(
    request('PUT', `/api/actors/${actorId}/owners`, {
      cookie: gmCookie,
      body: { userIds: [ownerId] },
    }),
  );
  const token = await harness.app.handle(
    request('POST', `/api/scenes/${sceneId}/tokens`, {
      cookie: gmCookie,
      body: { name: 'Eroe', actorId, x: position.x, y: position.y, snapToGrid: false },
    }),
  );
  expect(token.status).toBe(201);
  return token.body as Token;
}

async function addMonster(
  sceneId: string,
  position: { x: number; y: number },
  name = 'Ghoul',
): Promise<Token> {
  const response = await harness.app.handle(
    request('POST', `/api/scenes/${sceneId}/tokens`, {
      cookie: gmCookie,
      body: {
        name,
        x: position.x,
        y: position.y,
        disposition: 'hostile',
        snapToGrid: false,
      },
    }),
  );
  expect(response.status).toBe(201);
  return response.body as Token;
}

async function addWalls(sceneId: string, walls: Record<string, unknown>[]): Promise<Wall[]> {
  const response = await harness.app.handle(
    request('POST', `/api/scenes/${sceneId}/walls`, { cookie: gmCookie, body: { walls } }),
  );
  expect(response.status).toBe(201);
  return response.body as Wall[];
}

async function sceneFor(sceneId: string, cookie: string): Promise<SceneDetail> {
  const response = await harness.app.handle(
    request('GET', `/api/scenes/${sceneId}`, { cookie }),
  );
  expect(response.status).toBe(200);
  return response.body as SceneDetail;
}

async function visionFor(sceneId: string, cookie: string): Promise<SceneVisionState> {
  const response = await harness.app.handle(
    request('GET', `/api/scenes/${sceneId}/vision`, { cookie }),
  );
  expect(response.status).toBe(200);
  return response.body as SceneVisionState;
}

describe('impostazioni di visione', () => {
  it('una scena nuova ha la visione spenta: si vede tutto', async () => {
    const created = await harness.app.handle(
      request('POST', `/api/campaigns/${campaignId}/scenes`, {
        cookie: gmCookie,
        body: { name: 'Piazza' },
      }),
    );
    const scene = created.body as Scene;
    const detail = await sceneFor(scene.id, gmCookie);
    expect(detail.vision).toEqual<SceneVisionSettings>({
      visionEnabled: false,
      fogEnabled: true,
      ambientDarkness: 0,
      sceneReachMeters: 60,
    });
  });

  it('solo il Game Master le cambia', async () => {
    const scene = await createDarkScene();
    const player = await addPlayer();
    const detail = await sceneFor(scene.id, gmCookie);
    const response = await harness.app.handle(
      request('PATCH', `/api/scenes/${scene.id}/vision`, {
        cookie: player.cookie,
        body: { version: detail.version, visionEnabled: false },
      }),
    );
    expect(response.status).toBe(403);
  });

  it('rifiuta una versione superata', async () => {
    const scene = await createDarkScene();
    const response = await harness.app.handle(
      request('PATCH', `/api/scenes/${scene.id}/vision`, {
        cookie: gmCookie,
        body: { version: 1, ambientDarkness: 0.5 },
      }),
    );
    expect(response.status).toBe(409);
  });
});

describe('i muri non arrivano al giocatore', () => {
  it('il Game Master li riceve, il giocatore no', async () => {
    const scene = await createDarkScene();
    const player = await addPlayer();
    await addCharacter(scene.id, player.userId, { x: 100, y: 100 });
    await addWalls(scene.id, [{ ax: 300, ay: 0, bx: 300, by: 600 }]);

    const gmVision = await visionFor(scene.id, gmCookie);
    expect(gmVision.perspective).toBe('game_master');
    expect(gmVision.walls).toHaveLength(1);
    expect(gmVision.lights).toEqual([]);

    const playerVision = await visionFor(scene.id, player.cookie);
    expect(playerVision.perspective).toBe('tokens');
    expect(playerVision.walls).toBeNull();
    expect(playerVision.lights).toBeNull();
    expect(playerVision.viewpoints).toHaveLength(1);
    // Nella risposta non compare nessuna coordinata di muro: il poligono
    // racconta solo fin dove si vede.
    expect(JSON.stringify(playerVision)).not.toContain('"ax"');
  });

  it('un giocatore non può disegnarli né leggerne l elenco', async () => {
    const scene = await createDarkScene();
    const player = await addPlayer();
    expect(
      (
        await harness.app.handle(
          request('GET', `/api/scenes/${scene.id}/walls`, { cookie: player.cookie }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await harness.app.handle(
          request('POST', `/api/scenes/${scene.id}/walls`, {
            cookie: player.cookie,
            body: { walls: [{ ax: 0, ay: 0, bx: 10, by: 0 }] },
          }),
        )
      ).status,
    ).toBe(403);
  });

  it('chi non è della campagna non trova nemmeno la scena', async () => {
    const scene = await createDarkScene();
    const outsider = await harness.app.handle(
      request('POST', '/api/register', {
        body: { displayName: 'Estraneo', pin: 'estraneo-2026' },
      }),
    );
    const cookie = sessionCookieFrom(outsider);
    expect(
      (await harness.app.handle(request('GET', `/api/scenes/${scene.id}/vision`, { cookie })))
        .status,
    ).toBe(404);
  });

  it('un muro lungo zero viene rifiutato', async () => {
    const scene = await createDarkScene();
    const response = await harness.app.handle(
      request('POST', `/api/scenes/${scene.id}/walls`, {
        cookie: gmCookie,
        body: { walls: [{ ax: 10, ay: 10, bx: 10, by: 10 }] },
      }),
    );
    expect(response.status).toBe(422);
  });
});

describe('le pedine fuori dal campo visivo non vengono spedite', () => {
  it('il mostro dietro al muro non compare nella scena del giocatore', async () => {
    const scene = await createDarkScene();
    const player = await addPlayer();
    await addCharacter(scene.id, player.userId, { x: 100, y: 300 });
    await addWalls(scene.id, [{ ax: 300, ay: 0, bx: 300, by: 600 }]);
    const nascosto = await addMonster(scene.id, { x: 400, y: 300 }, 'Ghoul nascosto');
    const inVista = await addMonster(scene.id, { x: 200, y: 300 }, 'Ratto in vista');

    const player0 = await sceneFor(scene.id, player.cookie);
    const ids = player0.tokens.map((token) => token.id);
    expect(ids).toContain(inVista.id);
    expect(ids).not.toContain(nascosto.id);
    // Nemmeno il nome trapela.
    expect(JSON.stringify(player0.tokens)).not.toContain(nascosto.name);

    // Il Game Master li vede entrambi.
    const gm = await sceneFor(scene.id, gmCookie);
    expect(gm.tokens.map((token) => token.id)).toEqual(
      expect.arrayContaining([nascosto.id, inVista.id]),
    );
  });

  it('oltre la portata della scurovisione non si vede', async () => {
    const scene = await createDarkScene();
    const player = await addPlayer();
    // Scurovisione 18 m = 12 caselle = 600 px con caselle da 50 px.
    await addCharacter(scene.id, player.userId, { x: 100, y: 100 }, 18);
    const vicino = await addMonster(scene.id, { x: 100 + 10 * CELL_PX, y: 100 });
    const lontano = await addMonster(scene.id, { x: 100 + 16 * CELL_PX, y: 100 });

    const detail = await sceneFor(scene.id, player.cookie);
    const ids = detail.tokens.map((token) => token.id);
    expect(ids).toContain(vicino.id);
    expect(ids).not.toContain(lontano.id);

    const vision = await visionFor(scene.id, player.cookie);
    expect(vision.viewpoints[0]?.radiusMeters).toBeCloseTo(18, 6);
    expect(vision.viewpoints[0]?.radiusPx).toBeCloseTo(18 * PX_PER_METER, 6);
    expect(vision.viewpoints[0]?.source).toBe('scurovisione');
  });

  it('la scurovisione lunga arriva a 36 metri', async () => {
    const scene = await createDarkScene();
    const player = await addPlayer();
    await addCharacter(scene.id, player.userId, { x: 100, y: 100 }, 36);
    const lontano = await addMonster(scene.id, { x: 100 + 20 * CELL_PX, y: 100 });

    const vision = await visionFor(scene.id, player.cookie);
    expect(vision.viewpoints[0]?.radiusMeters).toBeCloseTo(36, 6);
    expect(vision.viewpoints[0]?.radiusPx).toBeCloseTo(36 * PX_PER_METER, 6);
    const detail = await sceneFor(scene.id, player.cookie);
    expect(detail.tokens.map((token) => token.id)).toContain(lontano.id);
  });

  it('la propria pedina si vede sempre, anche senza sensi', async () => {
    const scene = await createDarkScene();
    const player = await addPlayer();
    const mia = await addCharacter(scene.id, player.userId, { x: 100, y: 100 }, 0);
    const detail = await sceneFor(scene.id, player.cookie);
    expect(detail.tokens.map((token) => token.id)).toEqual([mia.id]);
  });

  it('senza pedine assegnate un giocatore non riceve nessuna pedina', async () => {
    const scene = await createDarkScene();
    const player = await addPlayer();
    await addMonster(scene.id, { x: 100, y: 100 });
    const detail = await sceneFor(scene.id, player.cookie);
    expect(detail.tokens).toEqual([]);
    expect((await visionFor(scene.id, player.cookie)).viewpoints).toEqual([]);
  });

  it('con la visione spenta si torna a vedere tutto il non nascosto', async () => {
    const scene = await createDarkScene();
    const player = await addPlayer();
    await addCharacter(scene.id, player.userId, { x: 100, y: 300 });
    await addWalls(scene.id, [{ ax: 300, ay: 0, bx: 300, by: 600 }]);
    const dietro = await addMonster(scene.id, { x: 400, y: 300 });

    const before = await sceneFor(scene.id, gmCookie);
    await harness.app.handle(
      request('PATCH', `/api/scenes/${scene.id}/vision`, {
        cookie: gmCookie,
        body: { version: before.version, visionEnabled: false },
      }),
    );
    const detail = await sceneFor(scene.id, player.cookie);
    expect(detail.tokens.map((token) => token.id)).toContain(dietro.id);
  });

  it('una pedina nascosta resta nascosta anche se in piena vista', async () => {
    const scene = await createDarkScene();
    const player = await addPlayer();
    await addCharacter(scene.id, player.userId, { x: 100, y: 100 });
    const invisibile = await harness.app.handle(
      request('POST', `/api/scenes/${scene.id}/tokens`, {
        cookie: gmCookie,
        body: { name: 'Spettro', x: 150, y: 100, hidden: true, snapToGrid: false },
      }),
    );
    const id = (invisibile.body as Token).id;
    const detail = await sceneFor(scene.id, player.cookie);
    expect(detail.tokens.map((token) => token.id)).not.toContain(id);
  });
});

describe('porte', () => {
  async function scenaConPorta() {
    const scene = await createDarkScene();
    const player = await addPlayer();
    await addCharacter(scene.id, player.userId, { x: 250, y: 300 });
    const [, porta] = await addWalls(scene.id, [
      { ax: 300, ay: 0, bx: 300, by: 250 },
      { ax: 300, ay: 250, bx: 300, by: 350, kind: 'door', doorState: 'closed' },
      { ax: 300, ay: 350, bx: 300, by: 600 },
    ]);
    const oltre = await addMonster(scene.id, { x: 400, y: 300 });
    if (!porta) throw new Error('porta non creata');
    return { scene, player, porta, oltre };
  }

  it('chiusa nasconde, aperta rivela', async () => {
    const { scene, player, porta, oltre } = await scenaConPorta();

    const chiusa = await sceneFor(scene.id, player.cookie);
    expect(chiusa.tokens.map((token) => token.id)).not.toContain(oltre.id);

    const apri = await harness.app.handle(
      request('POST', `/api/walls/${porta.id}/door`, {
        cookie: gmCookie,
        body: { state: 'open' },
      }),
    );
    expect(apri.status).toBe(200);
    expect((apri.body as Wall).doorState).toBe('open');

    const aperta = await sceneFor(scene.id, player.cookie);
    expect(aperta.tokens.map((token) => token.id)).toContain(oltre.id);
  });

  it('bloccata si comporta come chiusa', async () => {
    const { scene, player, porta, oltre } = await scenaConPorta();
    await harness.app.handle(
      request('POST', `/api/walls/${porta.id}/door`, {
        cookie: gmCookie,
        body: { state: 'locked' },
      }),
    );
    const detail = await sceneFor(scene.id, player.cookie);
    expect(detail.tokens.map((token) => token.id)).not.toContain(oltre.id);
  });

  it('un giocatore la apre se ci arriva', async () => {
    const { player, porta } = await scenaConPorta();
    const response = await harness.app.handle(
      request('POST', `/api/walls/${porta.id}/door`, {
        cookie: player.cookie,
        body: { state: 'open' },
      }),
    );
    expect(response.status).toBe(200);
  });

  it('un giocatore non apre una porta lontana', async () => {
    const scene = await createDarkScene();
    const player = await addPlayer();
    await addCharacter(scene.id, player.userId, { x: 100, y: 100 });
    const [porta] = await addWalls(scene.id, [
      { ax: 2000, ay: 0, bx: 2000, by: 100, kind: 'door', doorState: 'closed' },
    ]);
    if (!porta) throw new Error('porta non creata');
    const response = await harness.app.handle(
      request('POST', `/api/walls/${porta.id}/door`, {
        cookie: player.cookie,
        body: { state: 'open' },
      }),
    );
    expect(response.status).toBe(403);
  });

  it('un giocatore non sblocca una porta bloccata', async () => {
    const { player, porta } = await scenaConPorta();
    await harness.app.handle(
      request('POST', `/api/walls/${porta.id}/door`, {
        cookie: gmCookie,
        body: { state: 'locked' },
      }),
    );
    const response = await harness.app.handle(
      request('POST', `/api/walls/${porta.id}/door`, {
        cookie: player.cookie,
        body: { state: 'open' },
      }),
    );
    expect(response.status).toBe(403);
  });

  it('un muro normale non è una porta', async () => {
    const scene = await createDarkScene();
    const [muro] = await addWalls(scene.id, [{ ax: 0, ay: 0, bx: 100, by: 0 }]);
    if (!muro) throw new Error('muro non creato');
    const response = await harness.app.handle(
      request('POST', `/api/walls/${muro.id}/door`, {
        cookie: gmCookie,
        body: { state: 'open' },
      }),
    );
    expect(response.status).toBe(422);
  });
});

describe('i muri fermano il movimento', () => {
  it('un giocatore non attraversa un muro, il Game Master sì', async () => {
    const scene = await createDarkScene();
    const player = await addPlayer();
    const eroe = await addCharacter(scene.id, player.userId, { x: 100, y: 300 });
    await addWalls(scene.id, [{ ax: 300, ay: 0, bx: 300, by: 600 }]);

    const bloccato = await harness.app.handle(
      request('PATCH', `/api/tokens/${eroe.id}`, {
        cookie: player.cookie,
        body: { version: eroe.version, x: 400, y: 300, snapToGrid: false },
      }),
    );
    expect(bloccato.status).toBe(422);
    expect((bloccato.body as { error: { code: string } }).error.code).toBe('movement_blocked');

    const lecito = await harness.app.handle(
      request('PATCH', `/api/tokens/${eroe.id}`, {
        cookie: player.cookie,
        body: { version: eroe.version, x: 250, y: 300, snapToGrid: false },
      }),
    );
    expect(lecito.status).toBe(200);

    // Il Game Master resta l'autorità finale: può ignorare il calcolo.
    const forzato = await harness.app.handle(
      request('PATCH', `/api/tokens/${eroe.id}`, {
        cookie: gmCookie,
        body: { version: (lecito.body as Token).version, x: 400, y: 300, snapToGrid: false },
      }),
    );
    expect(forzato.status).toBe(200);
  });

  it('una porta aperta si attraversa, una chiusa no', async () => {
    const scene = await createDarkScene();
    const player = await addPlayer();
    const eroe = await addCharacter(scene.id, player.userId, { x: 250, y: 300 });
    const [porta] = await addWalls(scene.id, [
      { ax: 300, ay: 250, bx: 300, by: 350, kind: 'door', doorState: 'closed' },
    ]);
    if (!porta) throw new Error('porta non creata');

    const chiusa = await harness.app.handle(
      request('PATCH', `/api/tokens/${eroe.id}`, {
        cookie: player.cookie,
        body: { version: eroe.version, x: 350, y: 300, snapToGrid: false },
      }),
    );
    expect(chiusa.status).toBe(422);

    await harness.app.handle(
      request('POST', `/api/walls/${porta.id}/door`, {
        cookie: gmCookie,
        body: { state: 'open' },
      }),
    );
    const aperta = await harness.app.handle(
      request('PATCH', `/api/tokens/${eroe.id}`, {
        cookie: player.cookie,
        body: { version: eroe.version, x: 350, y: 300, snapToGrid: false },
      }),
    );
    expect(aperta.status).toBe(200);
  });

  it('una finestra ferma il passo ma non lo sguardo', async () => {
    const scene = await createDarkScene();
    const player = await addPlayer();
    const eroe = await addCharacter(scene.id, player.userId, { x: 250, y: 300 });
    await addWalls(scene.id, [{ ax: 300, ay: 0, bx: 300, by: 600, kind: 'window' }]);
    const oltre = await addMonster(scene.id, { x: 400, y: 300 });

    const detail = await sceneFor(scene.id, player.cookie);
    expect(detail.tokens.map((token) => token.id)).toContain(oltre.id);

    const passaggio = await harness.app.handle(
      request('PATCH', `/api/tokens/${eroe.id}`, {
        cookie: player.cookie,
        body: { version: eroe.version, x: 400, y: 300, snapToGrid: false },
      }),
    );
    expect(passaggio.status).toBe(422);
  });
});

describe('luci', () => {
  it('una torcia fa vedere chi non ha scurovisione', async () => {
    const scene = await createDarkScene();
    const player = await addPlayer();
    await addCharacter(scene.id, player.userId, { x: 100, y: 100 }, 0);
    const invisibile = await addMonster(scene.id, { x: 100 + 4 * CELL_PX, y: 100 });

    const buio = await sceneFor(scene.id, player.cookie);
    expect(buio.tokens.map((token) => token.id)).not.toContain(invisibile.id);

    const luce = await harness.app.handle(
      request('POST', `/api/scenes/${scene.id}/lights`, {
        cookie: gmCookie,
        body: { name: 'Braciere', x: 100, y: 100, brightRadiusMeters: 6, dimRadiusMeters: 12 },
      }),
    );
    expect(luce.status).toBe(201);

    const illuminato = await sceneFor(scene.id, player.cookie);
    expect(illuminato.tokens.map((token) => token.id)).toContain(invisibile.id);
    const vision = await visionFor(scene.id, player.cookie);
    expect(vision.viewpoints[0]?.source).toBe('luce');
    expect(vision.viewpoints[0]?.radiusMeters).toBeCloseTo(12, 6);
  });

  it('una torcia spenta non illumina', async () => {
    const scene = await createDarkScene();
    const player = await addPlayer();
    await addCharacter(scene.id, player.userId, { x: 100, y: 100 }, 0);
    const lontano = await addMonster(scene.id, { x: 100 + 4 * CELL_PX, y: 100 });
    await harness.app.handle(
      request('POST', `/api/scenes/${scene.id}/lights`, {
        cookie: gmCookie,
        body: { name: 'Braciere spento', x: 100, y: 100, enabled: false },
      }),
    );
    const detail = await sceneFor(scene.id, player.cookie);
    expect(detail.tokens.map((token) => token.id)).not.toContain(lontano.id);
  });

  it('una torcia agganciata a una pedina la segue', async () => {
    const scene = await createDarkScene();
    const player = await addPlayer();
    const eroe = await addCharacter(scene.id, player.userId, { x: 100, y: 100 }, 0);
    await harness.app.handle(
      request('POST', `/api/scenes/${scene.id}/lights`, {
        cookie: gmCookie,
        body: {
          name: 'Torcia',
          tokenId: eroe.id,
          x: 0,
          y: 0,
          brightRadiusMeters: 6,
          dimRadiusMeters: 12,
        },
      }),
    );
    // La riga della luce è ferma nell'origine, ma vale la posizione della pedina.
    const vision = await visionFor(scene.id, player.cookie);
    expect(vision.viewpoints[0]?.radiusMeters).toBeCloseTo(12, 6);
  });

  it('solo il Game Master le gestisce', async () => {
    const scene = await createDarkScene();
    const player = await addPlayer();
    expect(
      (
        await harness.app.handle(
          request('POST', `/api/scenes/${scene.id}/lights`, {
            cookie: player.cookie,
            body: { name: 'Abuso', x: 0, y: 0 },
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await harness.app.handle(
          request('GET', `/api/scenes/${scene.id}/lights`, { cookie: player.cookie }),
        )
      ).status,
    ).toBe(403);
  });

  it('una luce può essere spostata, spenta ed eliminata', async () => {
    const scene = await createDarkScene();
    const created = await harness.app.handle(
      request('POST', `/api/scenes/${scene.id}/lights`, {
        cookie: gmCookie,
        body: { name: 'Lanterna', x: 10, y: 10 },
      }),
    );
    const light = created.body as LightSource;
    const moved = await harness.app.handle(
      request('PATCH', `/api/lights/${light.id}`, {
        cookie: gmCookie,
        body: { version: light.version, x: 99, enabled: false },
      }),
    );
    expect(moved.status).toBe(200);
    expect((moved.body as LightSource).x).toBe(99);
    expect((moved.body as LightSource).enabled).toBe(false);

    const stale = await harness.app.handle(
      request('PATCH', `/api/lights/${light.id}`, {
        cookie: gmCookie,
        body: { version: light.version, x: 1 },
      }),
    );
    expect(stale.status).toBe(409);

    expect(
      (
        await harness.app.handle(
          request('DELETE', `/api/lights/${light.id}`, { cookie: gmCookie }),
        )
      ).status,
    ).toBe(200);
    expect((await visionFor(scene.id, gmCookie)).lights).toEqual([]);
  });
});

describe('anteprima del Game Master', () => {
  it('guarda la scena con gli occhi di una pedina', async () => {
    const scene = await createDarkScene();
    const player = await addPlayer();
    const eroe = await addCharacter(scene.id, player.userId, { x: 100, y: 300 });
    await addWalls(scene.id, [{ ax: 300, ay: 0, bx: 300, by: 600 }]);

    const preview = await harness.app.handle(
      request('GET', `/api/scenes/${scene.id}/vision`, {
        cookie: gmCookie,
        query: { asToken: eroe.id },
      }),
    );
    expect(preview.status).toBe(200);
    const body = preview.body as SceneVisionState;
    expect(body.perspective).toBe('tokens');
    expect(body.viewpoints).toHaveLength(1);
    expect(body.viewpoints[0]?.tokenId).toBe(eroe.id);
    // In anteprima nemmeno il Game Master riceve i muri: sta guardando da lì.
    expect(body.walls).toBeNull();
  });

  it('un giocatore non può usarla', async () => {
    const scene = await createDarkScene();
    const player = await addPlayer();
    const eroe = await addCharacter(scene.id, player.userId, { x: 100, y: 100 });
    const response = await harness.app.handle(
      request('GET', `/api/scenes/${scene.id}/vision`, {
        cookie: player.cookie,
        query: { asToken: eroe.id },
      }),
    );
    expect(response.status).toBe(403);
  });
});

describe('sincronizzazione', () => {
  it('un muro nuovo genera un evento senza coordinate', async () => {
    const scene = await createDarkScene();
    const player = await addPlayer();
    const before = await sceneFor(scene.id, player.cookie);
    await addWalls(scene.id, [{ ax: 300, ay: 0, bx: 300, by: 600 }]);

    const events = await harness.app.handle(
      request('GET', `/api/scenes/${scene.id}/events`, {
        cookie: player.cookie,
        query: { since: String(before.eventCursor), wait: '0' },
      }),
    );
    expect(events.status).toBe(200);
    const body = events.body as { events: { kind: string; payload: unknown }[] };
    expect(body.events.map((event) => event.kind)).toContain('wall.changed');
    expect(JSON.stringify(body)).not.toContain('"ax"');
  });
});

describe('porte in vista', () => {
  it('il giocatore riceve le porte che vede e non le altre', async () => {
    const scene = await createDarkScene();
    const player = await addPlayer();
    await addCharacter(scene.id, player.userId, { x: 250, y: 300 });
    const [vicina, lontana] = await addWalls(scene.id, [
      { ax: 300, ay: 250, bx: 300, by: 350, kind: 'door', doorState: 'closed' },
      { ax: 2000, ay: 250, bx: 2000, by: 350, kind: 'door', doorState: 'closed' },
    ]);

    const vision = await visionFor(scene.id, player.cookie);
    const ids = vision.visibleDoors.map((door) => door.id);
    expect(ids).toContain(vicina?.id);
    expect(ids).not.toContain(lontana?.id);
    // I muri restano comunque fuori dalla risposta.
    expect(vision.walls).toBeNull();
  });

  it('una porta dietro a un muro non si vede', async () => {
    const scene = await createDarkScene();
    const player = await addPlayer();
    await addCharacter(scene.id, player.userId, { x: 100, y: 300 });
    const [, dietro] = await addWalls(scene.id, [
      { ax: 300, ay: 0, bx: 300, by: 600 },
      { ax: 500, ay: 250, bx: 500, by: 350, kind: 'door', doorState: 'closed' },
    ]);

    const vision = await visionFor(scene.id, player.cookie);
    expect(vision.visibleDoors.map((door) => door.id)).not.toContain(dietro?.id);
  });

  it('per il Game Master l elenco resta quello completo dei muri', async () => {
    const scene = await createDarkScene();
    await addWalls(scene.id, [
      { ax: 300, ay: 250, bx: 300, by: 350, kind: 'door', doorState: 'closed' },
    ]);
    const vision = await visionFor(scene.id, gmCookie);
    expect(vision.walls).toHaveLength(1);
    // Senza punti di vista non ci sono porte "in vista": lui le vede tutte.
    expect(vision.visibleDoors).toEqual([]);
  });
});

describe('sensi del personaggio', () => {
  it('si creano e si modificano dal Game Master', async () => {
    const created = await harness.app.handle(
      request('POST', `/api/campaigns/${campaignId}/actors`, {
        cookie: gmCookie,
        body: { kind: 'character', name: 'Nano', vision: { darkvisionMeters: 18 } },
      }),
    );
    expect(created.status).toBe(201);
    const actor = created.body as { id: string; version: number; vision: unknown };
    expect(actor.vision).toEqual({
      normalRangeMeters: null,
      darkvisionMeters: 18,
      specialSenses: [],
    });

    const updated = await harness.app.handle(
      request('PATCH', `/api/actors/${actor.id}`, {
        cookie: gmCookie,
        body: {
          version: actor.version,
          vision: {
            darkvisionMeters: 36,
            specialSenses: [{ name: 'percezione tellurica', rangeMeters: 9 }],
          },
        },
      }),
    );
    expect(updated.status).toBe(200);
    expect((updated.body as { vision: { darkvisionMeters: number } }).vision.darkvisionMeters).toBe(
      36,
    );

    const stale = await harness.app.handle(
      request('PATCH', `/api/actors/${actor.id}`, {
        cookie: gmCookie,
        body: { version: actor.version, name: 'Altro' },
      }),
    );
    expect(stale.status).toBe(409);
  });

  it('un giocatore non li tocca', async () => {
    const player = await addPlayer();
    const created = await harness.app.handle(
      request('POST', `/api/campaigns/${campaignId}/actors`, {
        cookie: gmCookie,
        body: { kind: 'character', name: 'Elfo' },
      }),
    );
    const actor = created.body as { id: string; version: number };
    const response = await harness.app.handle(
      request('PATCH', `/api/actors/${actor.id}`, {
        cookie: player.cookie,
        body: { version: actor.version, vision: { darkvisionMeters: 999 } },
      }),
    );
    expect(response.status).toBe(403);
  });

  it('i sensi arrivano davvero al calcolo del campo visivo', async () => {
    const scene = await createDarkScene();
    const player = await addPlayer();
    const eroe = await addCharacter(scene.id, player.userId, { x: 100, y: 100 }, 18);
    void eroe;
    expect((await visionFor(scene.id, player.cookie)).viewpoints[0]?.radiusMeters).toBeCloseTo(
      18,
      6,
    );
  });
});

describe('memoria dell esplorato', () => {
  /** Quante caselle risultano esplorate nella mappa di bit ricevuta. */
  function exploredCount(cells: string): number {
    const bytes = Buffer.from(cells, 'base64');
    let count = 0;
    for (const byte of bytes) {
      for (let bit = 0; bit < 8; bit += 1) if ((byte & (1 << bit)) !== 0) count += 1;
    }
    return count;
  }

  it('cresce camminando e non torna indietro', async () => {
    const scene = await createDarkScene();
    const player = await addPlayer();
    const eroe = await addCharacter(scene.id, player.userId, { x: 100, y: 100 }, 9);

    const first = await visionFor(scene.id, player.cookie);
    expect(first.exploration).not.toBeNull();
    const before = exploredCount(first.exploration!.cells);
    expect(before).toBeGreaterThan(0);

    await harness.app.handle(
      request('PATCH', `/api/tokens/${eroe.id}`, {
        cookie: player.cookie,
        body: { version: eroe.version, x: 1000, y: 1000, snapToGrid: false },
      }),
    );

    const second = await visionFor(scene.id, player.cookie);
    const after = exploredCount(second.exploration!.cells);
    // Si è visto un posto nuovo senza dimenticare il precedente.
    expect(after).toBeGreaterThan(before);
  });

  it('è di chi ha esplorato, non della campagna', async () => {
    const scene = await createDarkScene();
    const uno = await addPlayer('Uno');
    const due = await addPlayer('Due');
    await addCharacter(scene.id, uno.userId, { x: 100, y: 100 }, 9);
    await addCharacter(scene.id, due.userId, { x: 2000, y: 2000 }, 9);

    const visioneUno = await visionFor(scene.id, uno.cookie);
    const visioneDue = await visionFor(scene.id, due.cookie);
    expect(visioneUno.exploration!.cells).not.toEqual(visioneDue.exploration!.cells);
  });

  it('il Game Master non ne ha bisogno', async () => {
    const scene = await createDarkScene();
    expect((await visionFor(scene.id, gmCookie)).exploration).toBeNull();
  });

  it('si può dimenticare, e solo il Game Master lo fa', async () => {
    const scene = await createDarkScene();
    const player = await addPlayer();
    await addCharacter(scene.id, player.userId, { x: 100, y: 100 }, 9);
    const before = await visionFor(scene.id, player.cookie);
    expect(exploredCount(before.exploration!.cells)).toBeGreaterThan(0);

    expect(
      (
        await harness.app.handle(
          request('DELETE', `/api/scenes/${scene.id}/exploration`, { cookie: player.cookie }),
        )
      ).status,
    ).toBe(403);

    const cancellato = await harness.app.handle(
      request('DELETE', `/api/scenes/${scene.id}/exploration`, { cookie: gmCookie }),
    );
    expect(cancellato.status).toBe(200);

    // Rileggendo si riparte da quello che si vede adesso, non da prima.
    const dopo = await visionFor(scene.id, player.cookie);
    expect(exploredCount(dopo.exploration!.cells)).toBeLessThanOrEqual(
      exploredCount(before.exploration!.cells),
    );
  });

  it('con la nebbia spenta non si tiene niente', async () => {
    const scene = await createDarkScene();
    const player = await addPlayer();
    await addCharacter(scene.id, player.userId, { x: 100, y: 100 }, 9);
    const detail = await sceneFor(scene.id, gmCookie);
    await harness.app.handle(
      request('PATCH', `/api/scenes/${scene.id}/vision`, {
        cookie: gmCookie,
        body: { version: detail.version, fogEnabled: false },
      }),
    );
    expect((await visionFor(scene.id, player.cookie)).exploration).toBeNull();
  });

  it('cambiare la griglia azzera la memoria', async () => {
    const scene = await createDarkScene();
    const player = await addPlayer();
    await addCharacter(scene.id, player.userId, { x: 400, y: 400 }, 18);
    const before = await visionFor(scene.id, player.cookie);
    const wide = exploredCount(before.exploration!.cells);
    expect(wide).toBeGreaterThan(0);

    const detail = await sceneFor(scene.id, gmCookie);
    await harness.app.handle(
      request('PATCH', `/api/scenes/${scene.id}/grid`, {
        cookie: gmCookie,
        body: { version: detail.grid.version, offsetX: 17 },
      }),
    );

    // Gli stessi bit indicherebbero caselle diverse: si ricomincia.
    const after = await visionFor(scene.id, player.cookie);
    expect(after.exploration).not.toBeNull();
    expect(after.exploration!.cells).not.toEqual(before.exploration!.cells);
  });
});
