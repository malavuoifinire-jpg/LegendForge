import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, request, sessionCookieFrom, type TestHarness } from './helpers.js';
import { createSession } from '../../src/identity/store.js';
import { SESSION_COOKIE } from '../../src/identity/cookies.js';
import type {
  ContentPack,
  ContentPackFile,
  LibraryEntry,
  LibraryFolder,
  LibraryPage,
} from '@legendforge/contracts';

/**
 * Libreria dei contenuti.
 *
 * Le due domande di fondo: quello che carico lo ritrovo com'era, e quello che
 * non deve vedere un giocatore non gli arriva.
 */

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
  return `${SESSION_COOKIE}=${await createSession(harness.pool, userId, 'vitest')}`;
}

const PACK_HEADER = {
  format: 'legendforge-pack' as const,
  schemaVersion: 1 as const,
  slug: 'prova-pack',
  name: 'Pacchetto di prova',
  license: 'CC-BY-4.0',
  attribution: 'Materiale di prova, nessun manuale coinvolto.',
  sourceUrl: 'https://example.invalid/pack',
};

const ENTRIES = [
  {
    kind: 'spell' as const,
    name: 'Palla di Fuoco',
    originalName: 'Fireball',
    slug: 'fireball',
    folder: 'Incantesimi/Livello 3',
    data: { level: 3, school: 'Invocazione', rangeMeters: 45, damage: { dice: '8d6', type: 'fire' } },
  },
  {
    kind: 'spell' as const,
    name: 'Luce',
    slug: 'light',
    folder: 'Incantesimi/Trucchetti',
    data: { level: 0, school: 'Invocazione' },
  },
  {
    kind: 'monster' as const,
    name: 'Ghoul',
    slug: 'ghoul',
    folder: 'Mostri/Grado di sfida 1–4',
    data: { armorClass: 12, hitPoints: 22, challengeRating: 1 },
  },
];

async function importPack(
  entries: unknown[] = ENTRIES,
  options: Record<string, unknown> = {},
): Promise<ContentPack> {
  const created = await harness.app.handle(
    request('POST', `/api/campaigns/${campaignId}/packs`, {
      cookie: gmCookie,
      body: { ...PACK_HEADER, ...options },
    }),
  );
  expect([200, 201]).toContain(created.status);
  const pack = created.body as ContentPack;
  const added = await harness.app.handle(
    request('POST', `/api/packs/${pack.id}/entries`, { cookie: gmCookie, body: { entries } }),
  );
  expect(added.status).toBe(200);
  return (added.body as { pack: ContentPack }).pack;
}

async function library(cookie: string, query: Record<string, string> = {}): Promise<LibraryPage> {
  const response = await harness.app.handle(
    request('GET', `/api/campaigns/${campaignId}/library`, { cookie, query }),
  );
  expect(response.status).toBe(200);
  return response.body as LibraryPage;
}

describe('caricamento di un pacchetto', () => {
  it('porta dentro le voci e conta quelle nuove', async () => {
    const pack = await importPack();
    expect(pack.entryCount).toBe(3);
    expect(pack.license).toBe('CC-BY-4.0');
    expect(pack.attribution).toContain('nessun manuale');
    expect(pack.locked).toBe(true);
  });

  it('crea le cartelle dal percorso dichiarato nel pacchetto', async () => {
    await importPack();
    const response = await harness.app.handle(
      request('GET', `/api/campaigns/${campaignId}/folders`, { cookie: gmCookie }),
    );
    const folders = response.body as LibraryFolder[];
    const names = folders.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['Incantesimi', 'Livello 3', 'Trucchetti', 'Mostri']));
    const livello3 = folders.find((f) => f.name === 'Livello 3');
    const incantesimi = folders.find((f) => f.name === 'Incantesimi');
    // La gerarchia è vera, non un nome con una barra dentro.
    expect(livello3?.parentId).toBe(incantesimi?.id);
  });

  it('una voce storta non ferma le altre', async () => {
    const created = await harness.app.handle(
      request('POST', `/api/campaigns/${campaignId}/packs`, { cookie: gmCookie, body: PACK_HEADER }),
    );
    const pack = created.body as ContentPack;
    const added = await harness.app.handle(
      request('POST', `/api/packs/${pack.id}/entries`, {
        cookie: gmCookie,
        body: {
          entries: [
            ENTRIES[0],
            { kind: 'spell', name: 'Rotto', slug: 'rotto', data: { level: 99 } },
            ENTRIES[1],
          ],
        },
      }),
    );
    const result = added.body as { created: number; skipped: { slug: string; reason: string }[] };
    expect(result.created).toBe(2);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.slug).toBe('rotto');
    expect(result.skipped[0]?.reason).toContain('level');
  });

  it('caricare a mazzetti somma invece di ricominciare', async () => {
    const created = await harness.app.handle(
      request('POST', `/api/campaigns/${campaignId}/packs`, { cookie: gmCookie, body: PACK_HEADER }),
    );
    const pack = created.body as ContentPack;
    for (const entry of ENTRIES) {
      await harness.app.handle(
        request('POST', `/api/packs/${pack.id}/entries`, {
          cookie: gmCookie,
          body: { entries: [entry] },
        }),
      );
    }
    const packs = await harness.app.handle(
      request('GET', `/api/campaigns/${campaignId}/packs`, { cookie: gmCookie }),
    );
    expect((packs.body as ContentPack[])[0]?.entryCount).toBe(3);
  });

  it('ricaricare lo stesso pacchetto va chiesto esplicitamente', async () => {
    await importPack();
    const again = await harness.app.handle(
      request('POST', `/api/campaigns/${campaignId}/packs`, { cookie: gmCookie, body: PACK_HEADER }),
    );
    expect(again.status).toBe(409);
    expect((again.body as { error: { code: string } }).error.code).toBe('pack_exists');
  });

  it('sostituendolo, le voci vecchie se ne vanno con lui', async () => {
    await importPack();
    const pack = await importPack([ENTRIES[1]], { replaceExisting: true });
    expect(pack.entryCount).toBe(1);
    const page = await library(gmCookie, { kind: 'spell' });
    expect(page.entries.map((e) => e.slug)).toEqual(['light']);
  });

  it('togliendo il pacchetto se ne vanno anche le voci', async () => {
    const pack = await importPack();
    const removed = await harness.app.handle(
      request('DELETE', `/api/packs/${pack.id}`, { cookie: gmCookie }),
    );
    expect(removed.status).toBe(200);
    expect((await library(gmCookie)).total).toBe(0);
  });

  it('uno schema di versione sconosciuta viene rifiutato', async () => {
    const response = await harness.app.handle(
      request('POST', `/api/campaigns/${campaignId}/packs`, {
        cookie: gmCookie,
        body: { ...PACK_HEADER, slug: 'dal-futuro', schemaVersion: 2 },
      }),
    );
    expect(response.status).toBe(422);
  });

  it('un file che non dichiara di essere un pacchetto viene rifiutato', async () => {
    const response = await harness.app.handle(
      request('POST', `/api/campaigns/${campaignId}/packs`, {
        cookie: gmCookie,
        body: { ...PACK_HEADER, format: 'qualcos-altro' },
      }),
    );
    expect(response.status).toBe(422);
  });

  it('solo il Game Master carica', async () => {
    const player = await addPlayer();
    expect(
      (
        await harness.app.handle(
          request('POST', `/api/campaigns/${campaignId}/packs`, { cookie: player, body: PACK_HEADER }),
        )
      ).status,
    ).toBe(403);
  });
});

describe('quello che carico lo ritrovo com era', () => {
  it('l esportazione restituisce licenza, attribuzione e voci', async () => {
    const pack = await importPack();
    const response = await harness.app.handle(
      request('GET', `/api/packs/${pack.id}/export`, { cookie: gmCookie }),
    );
    expect(response.status).toBe(200);
    const file = response.body as ContentPackFile;
    expect(file.format).toBe('legendforge-pack');
    expect(file.license).toBe('CC-BY-4.0');
    expect(file.attribution).toBe(PACK_HEADER.attribution);
    expect(file.sourceUrl).toBe(PACK_HEADER.sourceUrl);
    expect(file.entries).toHaveLength(3);
    const fireball = file.entries.find((e) => e.slug === 'fireball');
    expect(fireball?.name).toBe('Palla di Fuoco');
    expect(fireball?.originalName).toBe('Fireball');
    expect((fireball?.data as { rangeMeters: number }).rangeMeters).toBe(45);
  });

  it('un giocatore non esporta', async () => {
    const pack = await importPack();
    const player = await addPlayer();
    expect(
      (await harness.app.handle(request('GET', `/api/packs/${pack.id}/export`, { cookie: player })))
        .status,
    ).toBe(403);
  });
});

describe('il bestiario resta del Game Master', () => {
  it('il giocatore vede gli incantesimi e non i mostri', async () => {
    await importPack();
    const player = await addPlayer();

    const page = await library(player);
    const kinds = new Set(page.entries.map((e) => e.kind));
    expect(kinds.has('spell')).toBe(true);
    expect(kinds.has('monster')).toBe(false);
    expect(JSON.stringify(page)).not.toContain('Ghoul');
  });

  it('chiedere i mostri per nome non serve a niente', async () => {
    await importPack();
    const player = await addPlayer();
    const response = await harness.app.handle(
      request('GET', `/api/campaigns/${campaignId}/library`, {
        cookie: player,
        query: { kind: 'monster' },
      }),
    );
    // Non 403: per lui il bestiario non esiste.
    expect(response.status).toBe(404);
  });

  it('nemmeno l indirizzo diretto di un mostro', async () => {
    await importPack();
    const gmPage = await library(gmCookie, { kind: 'monster' });
    const ghoul = gmPage.entries[0];
    expect(ghoul).toBeDefined();
    const player = await addPlayer();
    expect(
      (await harness.app.handle(request('GET', `/api/library/${ghoul!.id}`, { cookie: player })))
        .status,
    ).toBe(404);
  });

  it('chi non e della campagna non trova niente', async () => {
    await importPack();
    const outsider = await harness.app.handle(
      request('POST', '/api/register', { body: { displayName: 'Estraneo', pin: 'estraneo-2026' } }),
    );
    const cookie = sessionCookieFrom(outsider);
    expect(
      (await harness.app.handle(request('GET', `/api/campaigns/${campaignId}/library`, { cookie })))
        .status,
    ).toBe(404);
  });
});

describe('voci proprie e voci ricevute', () => {
  it('una voce di un pacchetto non si modifica sul posto', async () => {
    await importPack();
    const page = await library(gmCookie, { kind: 'spell' });
    const fireball = page.entries.find((e) => e.slug === 'fireball');
    expect(fireball?.readOnly).toBe(true);

    const response = await harness.app.handle(
      request('PATCH', `/api/library/${fireball!.id}`, {
        cookie: gmCookie,
        body: { version: fireball!.version, name: 'Palla di Fuoco Potenziata' },
      }),
    );
    expect(response.status).toBe(409);
    expect((response.body as { error: { code: string } }).error.code).toBe('entry_locked');
  });

  it('se ne fa una copia, e quella si modifica', async () => {
    await importPack();
    const page = await library(gmCookie, { kind: 'spell' });
    const fireball = page.entries.find((e) => e.slug === 'fireball');

    const copied = await harness.app.handle(
      request('POST', `/api/library/${fireball!.id}/copy`, { cookie: gmCookie }),
    );
    expect(copied.status).toBe(201);
    const copy = copied.body as LibraryEntry;
    expect(copy.readOnly).toBe(false);
    expect(copy.packId).toBeNull();
    expect(copy.name).toContain('copia');

    const edited = await harness.app.handle(
      request('PATCH', `/api/library/${copy.id}`, {
        cookie: gmCookie,
        body: { version: copy.version, name: 'Palla di Fuoco di Simone' },
      }),
    );
    expect(edited.status).toBe(200);
    expect((edited.body as LibraryEntry).name).toBe('Palla di Fuoco di Simone');
  });

  it('una voce propria si crea, si modifica e si cancella', async () => {
    const created = await harness.app.handle(
      request('POST', `/api/campaigns/${campaignId}/library`, {
        cookie: gmCookie,
        body: {
          kind: 'monster',
          name: 'Bestia di Simone',
          data: { armorClass: 14, hitPoints: 40, challengeRating: 2 },
          custom: { note: 'inventata al volo', pericolosa: true },
        },
      }),
    );
    expect(created.status).toBe(201);
    const entry = created.body as LibraryEntry;
    expect(entry.slug).toBe('bestia-di-simone');
    expect(entry.custom).toEqual({ note: 'inventata al volo', pericolosa: true });

    const updated = await harness.app.handle(
      request('PATCH', `/api/library/${entry.id}`, {
        cookie: gmCookie,
        body: { version: entry.version, data: { armorClass: 16, hitPoints: 55 } },
      }),
    );
    expect(updated.status).toBe(200);
    expect((updated.body as LibraryEntry).data).toMatchObject({ armorClass: 16 });

    const stale = await harness.app.handle(
      request('PATCH', `/api/library/${entry.id}`, {
        cookie: gmCookie,
        body: { version: entry.version, name: 'Altro' },
      }),
    );
    expect(stale.status).toBe(409);

    expect(
      (await harness.app.handle(request('DELETE', `/api/library/${entry.id}`, { cookie: gmCookie })))
        .status,
    ).toBe(200);
    expect((await library(gmCookie, { kind: 'monster' })).total).toBe(0);
  });

  it('dati che non rispettano la forma del tipo vengono rifiutati', async () => {
    const response = await harness.app.handle(
      request('POST', `/api/campaigns/${campaignId}/library`, {
        cookie: gmCookie,
        body: { kind: 'spell', name: 'Impossibile', data: { level: 42 } },
      }),
    );
    expect(response.status).toBe(422);
  });

  it('un giocatore non scrive nella libreria', async () => {
    const player = await addPlayer();
    expect(
      (
        await harness.app.handle(
          request('POST', `/api/campaigns/${campaignId}/library`, {
            cookie: player,
            body: { kind: 'spell', name: 'Abuso', data: { level: 1 } },
          }),
        )
      ).status,
    ).toBe(403);
  });
});

describe('sfogliare', () => {
  it('filtra per tipo e cerca per nome, anche originale', async () => {
    await importPack();
    expect((await library(gmCookie, { kind: 'spell' })).total).toBe(2);
    expect((await library(gmCookie, { q: 'palla' })).total).toBe(1);
    // Il nome inglese e cercabile quanto quello italiano.
    expect((await library(gmCookie, { q: 'fireball' })).total).toBe(1);
    expect((await library(gmCookie, { q: 'nulla di nulla' })).total).toBe(0);
  });

  it('filtra per cartella', async () => {
    await importPack();
    const folders = (await harness.app.handle(
      request('GET', `/api/campaigns/${campaignId}/folders`, { cookie: gmCookie }),
    )).body as LibraryFolder[];
    const trucchetti = folders.find((f) => f.name === 'Trucchetti');
    const page = await library(gmCookie, { folderId: trucchetti!.id });
    expect(page.entries.map((e) => e.slug)).toEqual(['light']);
  });

  it('una pagina dichiara quante voci ci sono in tutto', async () => {
    await importPack();
    const page = await library(gmCookie, { limit: '1' });
    expect(page.entries).toHaveLength(1);
    expect(page.total).toBe(3);
  });

  it('togliendo una cartella le voci restano, senza cartella', async () => {
    await importPack();
    const folders = (await harness.app.handle(
      request('GET', `/api/campaigns/${campaignId}/folders`, { cookie: gmCookie }),
    )).body as LibraryFolder[];
    const trucchetti = folders.find((f) => f.name === 'Trucchetti');
    await harness.app.handle(
      request('DELETE', `/api/folders/${trucchetti!.id}`, { cookie: gmCookie }),
    );
    const page = await library(gmCookie, { kind: 'spell' });
    const light = page.entries.find((e) => e.slug === 'light');
    expect(light).toBeDefined();
    expect(light?.folderId).toBeNull();
  });
});
