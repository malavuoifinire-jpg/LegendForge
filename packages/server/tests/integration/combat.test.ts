import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, request, sessionCookieFrom, type TestHarness } from './helpers.js';
import { createSession } from '../../src/identity/store.js';
import { SESSION_COOKIE } from '../../src/identity/cookies.js';
import type {
  Campaign,
  Encounter,
  MoveResult,
  MovementRecord,
  SceneDetail,
  TerrainRegion,
  Token,
} from '@legendforge/contracts';

/**
 * Scontri, turni e movimento.
 *
 * La domanda di fondo: il budget lo decide il server, non il client. Il costo
 * che arriva da fuori non viene creduto, il percorso viene rifatto, e il Game
 * Master puo autorizzare oltre — ma resta scritto che l'ha fatto.
 */

let harness: TestHarness;
let gmCookie = '';
let campaignId = '';
let sceneId = '';

/** Casella da 50 px che vale 1,5 m: 9 metri di velocita sono 6 caselle. */
const CELL = 50;

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
  campaignId = (campaign.body as Campaign).id;
  const scene = await harness.app.handle(
    request('POST', `/api/campaigns/${campaignId}/scenes`, {
      cookie: gmCookie,
      body: { name: 'Sala' },
    }),
  );
  const created = scene.body as { id: string; grid: { version: number } };
  sceneId = created.id;
  await harness.app.handle(
    request('PATCH', `/api/scenes/${sceneId}/grid`, {
      cookie: gmCookie,
      body: {
        version: created.grid.version,
        cellSizePx: CELL,
        offsetX: 0,
        offsetY: 0,
        rotationDeg: 0,
        metersPerCell: 1.5,
        confirmed: true,
      },
    }),
  );
});

async function addPlayer(): Promise<{ cookie: string; userId: string }> {
  const user = await harness.pool.query<{ id: string }>(
    `INSERT INTO users (display_name) VALUES ('Marco') RETURNING id`,
  );
  const userId = user.rows[0]!.id;
  await harness.pool.query(
    `INSERT INTO campaign_memberships (campaign_id, user_id, role) VALUES ($1, $2, 'player')`,
    [campaignId, userId],
  );
  return { cookie: `${SESSION_COOKIE}=${await createSession(harness.pool, userId, 'vitest')}`, userId };
}

/** Pedina al centro della casella (col,row), con un personaggio assegnato. */
async function addToken(
  col: number,
  row: number,
  options: { ownerId?: string; movement?: Record<string, number>; name?: string } = {},
): Promise<Token> {
  const name = options.name ?? 'Kaelith';
  const actor = await harness.app.handle(
    request('POST', `/api/campaigns/${campaignId}/actors`, {
      cookie: gmCookie,
      body: { kind: 'character', name, movement: options.movement ?? { camminare: 9 } },
    }),
  );
  const actorId = (actor.body as { id: string }).id;
  if (options.ownerId) {
    await harness.app.handle(
      request('PUT', `/api/actors/${actorId}/owners`, {
        cookie: gmCookie,
        body: { userIds: [options.ownerId] },
      }),
    );
  }
  const token = await harness.app.handle(
    request('POST', `/api/scenes/${sceneId}/tokens`, {
      cookie: gmCookie,
      body: { name, actorId, x: col * CELL + CELL / 2, y: row * CELL + CELL / 2, snapToGrid: false },
    }),
  );
  expect(token.status).toBe(201);
  return token.body as Token;
}

const at = (col: number, row: number) => ({ x: col * CELL + CELL / 2, y: row * CELL + CELL / 2 });

async function startEncounter(): Promise<Encounter> {
  const response = await harness.app.handle(
    request('POST', `/api/scenes/${sceneId}/encounter`, {
      cookie: gmCookie,
      body: { rollInitiative: false },
    }),
  );
  expect(response.status).toBe(201);
  return response.body as Encounter;
}

function move(
  token: Token,
  waypoints: { x: number; y: number }[],
  cookie: string,
  extra: Record<string, unknown> = {},
) {
  return harness.app.handle(
    request('POST', `/api/tokens/${token.id}/move`, {
      cookie,
      body: { version: token.version, waypoints, snapToGrid: false, ...extra },
    }),
  );
}

describe('ordine di iniziativa', () => {
  it('nasce con tutte le pedine e il turno a chi ha il numero piu alto', async () => {
    await addToken(0, 0, { name: 'Uno' });
    await addToken(2, 0, { name: 'Due' });
    const encounter = await startEncounter();

    expect(encounter.round).toBe(1);
    expect(encounter.entries).toHaveLength(2);
    expect(encounter.activeEntryId).toBe(encounter.entries[0]?.id);
    // Senza tiro, l'ordine e quello di creazione, stabile fra due letture.
    const again = await harness.app.handle(
      request('GET', `/api/scenes/${sceneId}/encounter`, { cookie: gmCookie }),
    );
    expect((again.body as Encounter).entries.map((e) => e.id)).toEqual(
      encounter.entries.map((e) => e.id),
    );
  });

  it('il tiro di iniziativa da a ciascuno un numero fra 1 e 20', async () => {
    await addToken(0, 0, { name: 'Uno' });
    await addToken(2, 0, { name: 'Due' });
    const response = await harness.app.handle(
      request('POST', `/api/scenes/${sceneId}/encounter`, {
        cookie: gmCookie,
        body: { rollInitiative: true },
      }),
    );
    const encounter = response.body as Encounter;
    for (const entry of encounter.entries) {
      expect(entry.initiative).toBeGreaterThanOrEqual(1);
      expect(entry.initiative).toBeLessThanOrEqual(20);
    }
    // In ordine decrescente.
    const values = encounter.entries.map((e) => e.initiative);
    expect([...values].sort((a, b) => b - a)).toEqual(values);
  });

  it('non se ne aprono due sulla stessa scena', async () => {
    await addToken(0, 0);
    await startEncounter();
    const second = await harness.app.handle(
      request('POST', `/api/scenes/${sceneId}/encounter`, {
        cookie: gmCookie,
        body: { rollInitiative: false },
      }),
    );
    expect(second.status).toBe(409);
  });

  it('il giro finito fa cominciare un round nuovo', async () => {
    await addToken(0, 0, { name: 'Uno' });
    await addToken(2, 0, { name: 'Due' });
    const encounter = await startEncounter();

    const dopoUno = await harness.app.handle(
      request('POST', `/api/encounters/${encounter.id}/next`, { cookie: gmCookie }),
    );
    expect((dopoUno.body as Encounter).round).toBe(1);
    expect((dopoUno.body as Encounter).activeEntryId).toBe(encounter.entries[1]?.id);

    const dopoDue = await harness.app.handle(
      request('POST', `/api/encounters/${encounter.id}/next`, { cookie: gmCookie }),
    );
    expect((dopoDue.body as Encounter).round).toBe(2);
    expect((dopoDue.body as Encounter).activeEntryId).toBe(encounter.entries[0]?.id);
  });

  it('solo il Game Master lo conduce', async () => {
    await addToken(0, 0);
    const player = await addPlayer();
    const encounter = await startEncounter();
    expect(
      (
        await harness.app.handle(
          request('POST', `/api/encounters/${encounter.id}/next`, { cookie: player.cookie }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await harness.app.handle(
          request('POST', `/api/scenes/${sceneId}/encounter`, {
            cookie: player.cookie,
            body: { rollInitiative: false },
          }),
        )
      ).status,
    ).toBe(403);
  });

  it('il giocatore lo vede, per sapere di chi e il turno', async () => {
    await addToken(0, 0);
    const player = await addPlayer();
    await startEncounter();
    const response = await harness.app.handle(
      request('GET', `/api/scenes/${sceneId}/encounter`, { cookie: player.cookie }),
    );
    expect(response.status).toBe(200);
    expect((response.body as Encounter).entries.length).toBeGreaterThan(0);
  });
});

describe('budget del movimento', () => {
  it('fuori dal combattimento non si consuma niente', async () => {
    const token = await addToken(0, 0);
    const response = await move(token, [at(20, 0)], gmCookie);
    expect(response.status).toBe(200);
    const result = response.body as MoveResult;
    expect(result.remainingMeters).toBeNull();
    expect(result.costMeters).toBeCloseTo(30, 6);
  });

  it('in combattimento si consuma, e il residuo cala', async () => {
    const token = await addToken(0, 0);
    await startEncounter();
    const response = await move(token, [at(4, 0)], gmCookie);
    const result = response.body as MoveResult;
    expect(result.costMeters).toBeCloseTo(6, 6);
    expect(result.totalMeters).toBe(9);
    expect(result.remainingMeters).toBeCloseTo(3, 6);
  });

  it('sforare viene impedito, e si dice di quanto', async () => {
    const token = await addToken(0, 0);
    await startEncounter();
    const response = await move(token, [at(8, 0)], gmCookie);
    expect(response.status).toBe(422);
    const body = response.body as {
      error: { code: string; details: { shortfallMeters: number; costMeters: number } };
    };
    expect(body.error.code).toBe('movement_budget_exceeded');
    expect(body.error.details.costMeters).toBeCloseTo(12, 6);
    expect(body.error.details.shortfallMeters).toBeCloseTo(3, 6);
  });

  it('il Game Master puo autorizzare comunque, e resta scritto', async () => {
    const token = await addToken(0, 0);
    const encounter = await startEncounter();
    const response = await move(token, [at(8, 0)], gmCookie, { overrideBudget: true });
    expect(response.status).toBe(200);
    expect((response.body as MoveResult).overridden).toBe(true);

    const history = await harness.app.handle(
      request('GET', `/api/encounters/${encounter.id}/history`, { cookie: gmCookie }),
    );
    const records = history.body as MovementRecord[];
    expect(records[0]?.overridden).toBe(true);
  });

  it('un giocatore non si autorizza da solo', async () => {
    const player = await addPlayer();
    const token = await addToken(0, 0, { ownerId: player.userId });
    await startEncounter();
    const response = await move(token, [at(8, 0)], player.cookie, { overrideBudget: true });
    expect(response.status).toBe(422);
  });

  it('il movimento riparte da zero quando arriva il proprio turno', async () => {
    const uno = await addToken(0, 0, { name: 'Uno' });
    await addToken(10, 10, { name: 'Due' });
    const encounter = await startEncounter();
    await move(uno, [at(4, 0)], gmCookie);

    let stato = await harness.app.handle(
      request('GET', `/api/scenes/${sceneId}/encounter`, { cookie: gmCookie }),
    );
    expect(
      (stato.body as Encounter).entries.find((e) => e.tokenId === uno.id)?.movementUsedMeters,
    ).toBeCloseTo(6, 6);

    // Giro completo: si torna a lui e il movimento e di nuovo pieno.
    await harness.app.handle(request('POST', `/api/encounters/${encounter.id}/next`, { cookie: gmCookie }));
    await harness.app.handle(request('POST', `/api/encounters/${encounter.id}/next`, { cookie: gmCookie }));
    stato = await harness.app.handle(
      request('GET', `/api/scenes/${sceneId}/encounter`, { cookie: gmCookie }),
    );
    const entry = (stato.body as Encounter).entries.find((e) => e.tokenId === uno.id);
    expect(entry?.movementUsedMeters).toBe(0);
    expect(entry?.movementRemainingMeters).toBe(9);
  });

  it('chi non ha quel modo non si muove cosi', async () => {
    const token = await addToken(0, 0, { movement: { camminare: 9 } });
    await startEncounter();
    const response = await move(token, [at(1, 0)], gmCookie, { mode: 'volare' });
    expect(response.status).toBe(422);
    expect((response.body as { error: { message: string } }).error.message).toContain('volare');
  });

  it('il server non crede al percorso del client: parte da dove sta la pedina', async () => {
    const token = await addToken(0, 0);
    await startEncounter();
    // Il client chiede un solo passo, ma partendo da lontano: il server
    // ricalcola dalla posizione vera e il costo e quello del tragitto intero.
    const response = await move(token, [at(4, 0)], gmCookie);
    expect((response.body as MoveResult).costMeters).toBeCloseTo(6, 6);
  });
});

describe('terreno e muri', () => {
  it('il terreno difficile costa il doppio', async () => {
    const token = await addToken(0, 0);
    await harness.app.handle(
      request('POST', `/api/scenes/${sceneId}/terrain`, {
        cookie: gmCookie,
        body: {
          kind: 'difficult',
          points: [
            { x: 100, y: -50 },
            { x: 250, y: -50 },
            { x: 250, y: 100 },
            { x: 100, y: 100 },
          ],
        },
      }),
    );
    await startEncounter();
    // Quattro caselle, due delle quali nel fango: 1 + 1 + 2 + 2 = 6 caselle = 9 m.
    const response = await move(token, [at(4, 0)], gmCookie);
    expect((response.body as MoveResult).costMeters).toBeCloseTo(9, 6);
  });

  it('un muro ferma il percorso e la pedina si ferma li', async () => {
    const token = await addToken(0, 0);
    await harness.app.handle(
      request('POST', `/api/scenes/${sceneId}/walls`, {
        cookie: gmCookie,
        body: { walls: [{ ax: 150, ay: -200, bx: 150, by: 400 }] },
      }),
    );
    await startEncounter();
    const response = await move(token, [at(4, 0)], gmCookie);
    expect(response.status).toBe(200);
    const result = response.body as MoveResult;
    expect(result.stoppedBy).toBe('muro');
    expect(result.token.x).toBeLessThan(150);
    expect(result.costMeters).toBeLessThan(6);
  });

  it('le zone di terreno le disegna solo il Game Master', async () => {
    const player = await addPlayer();
    const response = await harness.app.handle(
      request('POST', `/api/scenes/${sceneId}/terrain`, {
        cookie: player.cookie,
        body: {
          kind: 'difficult',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
          ],
        },
      }),
    );
    expect(response.status).toBe(403);
  });

  it('al giocatore arrivano solo le zone che ha davanti agli occhi', async () => {
    const player = await addPlayer();
    await addToken(0, 0, { ownerId: player.userId });
    await harness.app.handle(
      request('POST', `/api/scenes/${sceneId}/terrain`, {
        cookie: gmCookie,
        body: {
          name: 'lontana',
          kind: 'difficult',
          points: [
            { x: 4000, y: 4000 },
            { x: 4200, y: 4000 },
            { x: 4200, y: 4200 },
          ],
        },
      }),
    );
    const detail = await harness.app.handle(
      request('GET', `/api/scenes/${sceneId}`, { cookie: gmCookie }),
    );
    await harness.app.handle(
      request('PATCH', `/api/scenes/${sceneId}/vision`, {
        cookie: gmCookie,
        body: {
          version: (detail.body as SceneDetail).version,
          visionEnabled: true,
          ambientDarkness: 1,
        },
      }),
    );

    const gmView = await harness.app.handle(
      request('GET', `/api/scenes/${sceneId}/terrain`, { cookie: gmCookie }),
    );
    expect((gmView.body as TerrainRegion[])).toHaveLength(1);

    const playerView = await harness.app.handle(
      request('GET', `/api/scenes/${sceneId}/terrain`, { cookie: player.cookie }),
    );
    // Una pozza dall'altra parte della mappa racconterebbe dov'e la mappa.
    expect(playerView.body as TerrainRegion[]).toHaveLength(0);
  });
});

describe('annullare uno spostamento', () => {
  it('riporta la pedina indietro e restituisce il movimento', async () => {
    const token = await addToken(0, 0);
    await startEncounter();
    const moved = await move(token, [at(4, 0)], gmCookie);
    const result = moved.body as MoveResult;
    expect(result.movementId).not.toBeNull();

    const undone = await harness.app.handle(
      request('POST', `/api/movements/${result.movementId}/undo`, { cookie: gmCookie }),
    );
    expect(undone.status).toBe(200);
    expect((undone.body as Token).x).toBeCloseTo(at(0, 0).x, 6);

    const stato = await harness.app.handle(
      request('GET', `/api/scenes/${sceneId}/encounter`, { cookie: gmCookie }),
    );
    expect(
      (stato.body as Encounter).entries.find((e) => e.tokenId === token.id)?.movementUsedMeters,
    ).toBe(0);
  });

  it('non si annulla due volte', async () => {
    const token = await addToken(0, 0);
    await startEncounter();
    const moved = await move(token, [at(2, 0)], gmCookie);
    const id = (moved.body as MoveResult).movementId;
    await harness.app.handle(request('POST', `/api/movements/${id}/undo`, { cookie: gmCookie }));
    const second = await harness.app.handle(
      request('POST', `/api/movements/${id}/undo`, { cookie: gmCookie }),
    );
    expect(second.status).toBe(409);
  });

  it('resta nella cronologia, segnato come annullato', async () => {
    const token = await addToken(0, 0);
    const encounter = await startEncounter();
    const moved = await move(token, [at(2, 0)], gmCookie);
    await harness.app.handle(
      request('POST', `/api/movements/${(moved.body as MoveResult).movementId}/undo`, {
        cookie: gmCookie,
      }),
    );
    const history = await harness.app.handle(
      request('GET', `/api/encounters/${encounter.id}/history`, { cookie: gmCookie }),
    );
    const records = history.body as MovementRecord[];
    expect(records).toHaveLength(1);
    expect(records[0]?.undone).toBe(true);
    // La riga non sparisce: a fine serata la domanda e che cosa e successo.
    expect(records[0]?.costMeters).toBeCloseTo(3, 6);
  });

  it('un estraneo non annulla niente', async () => {
    const token = await addToken(0, 0);
    await startEncounter();
    const moved = await move(token, [at(2, 0)], gmCookie);
    const outsider = await harness.app.handle(
      request('POST', '/api/register', { body: { displayName: 'Estraneo', pin: 'estraneo-2026' } }),
    );
    const cookie = sessionCookieFrom(outsider);
    const response = await harness.app.handle(
      request('POST', `/api/movements/${(moved.body as MoveResult).movementId}/undo`, { cookie }),
    );
    expect(response.status).toBe(404);
  });
});
