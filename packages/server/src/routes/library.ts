import {
  addPackEntriesInputSchema,
  createEntryInputSchema,
  createFolderInputSchema,
  createPackInputSchema,
  libraryKindSchema,
  LIBRARY_PAGE_SIZE,
  parseLibraryData,
  updateEntryInputSchema,
  updateFolderInputSchema,
  type CampaignRole,
  type ContentPack,
  type ContentPackFile,
  type LibraryEntry,
  type LibraryFolder,
  type LibraryKind,
  type LibraryPage,
  type PackEntryFile,
} from '@legendforge/contracts';
import { z } from 'zod';
import { requireCampaignAccess, requireGameMaster } from '../access.js';
import { requireViewer, type ServerContext } from '../context.js';
import { HttpError, type Route } from '../http.js';
import { parseBody } from '../validate.js';

/**
 * Libreria dei contenuti.
 *
 * Il motore non sa che cosa sia una palla di fuoco: sa che esistono voci con
 * un tipo, un nome e una forma. Quello che ci finisce dentro arriva dai
 * pacchetti, e un pacchetto si toglie senza toccare il codice.
 *
 * Il bestiario resta del Game Master: un giocatore vede incantesimi, oggetti e
 * classi — cioè il materiale a cui il suo personaggio attinge — ma non i
 * mostri, per la stessa ragione per cui non vede le pedine nascoste.
 */

const GAME_MASTER_ONLY_KINDS = new Set<LibraryKind>(['monster']);

function visibleKinds(role: CampaignRole): LibraryKind[] {
  const all = libraryKindSchema.options;
  return role === 'game_master' ? [...all] : all.filter((k) => !GAME_MASTER_ONLY_KINDS.has(k));
}

function requireVisibleKind(role: CampaignRole, kind: LibraryKind): void {
  if (role !== 'game_master' && GAME_MASTER_ONLY_KINDS.has(kind)) {
    // Non 403: per chi non è Game Master il bestiario non esiste proprio.
    throw new HttpError(404, 'not_found', 'Voce non trovata');
  }
}

/* --------------------------------- righe --------------------------------- */

interface PackRow {
  id: string;
  campaign_id: string;
  slug: string;
  name: string;
  pack_version: string;
  license: string;
  attribution: string;
  source_url: string | null;
  locked: boolean;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
  entry_count: number | string;
}

interface FolderRow {
  id: string;
  campaign_id: string;
  kind: LibraryKind;
  parent_id: string | null;
  name: string;
  sort_order: number;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
}

interface EntryRow {
  id: string;
  campaign_id: string;
  pack_id: string | null;
  folder_id: string | null;
  kind: LibraryKind;
  name: string;
  original_name: string | null;
  slug: string;
  data: unknown;
  custom: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
  pack_locked: boolean | null;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toPack(row: PackRow): ContentPack {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    slug: row.slug,
    name: row.name,
    packVersion: row.pack_version,
    license: row.license,
    attribution: row.attribution,
    sourceUrl: row.source_url,
    locked: row.locked,
    entryCount: Number(row.entry_count ?? 0),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: row.version,
  };
}

function toFolder(row: FolderRow): LibraryFolder {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    kind: row.kind,
    parentId: row.parent_id,
    name: row.name,
    sortOrder: row.sort_order,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: row.version,
  };
}

function toEntry(row: EntryRow): LibraryEntry {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    packId: row.pack_id,
    folderId: row.folder_id,
    kind: row.kind,
    name: row.name,
    originalName: row.original_name,
    slug: row.slug,
    data: row.data,
    custom: (row.custom ?? {}) as LibraryEntry['custom'],
    // Una voce di un pacchetto ricevuto non si modifica sul posto: se ne fa
    // una copia propria. Così quello che si riesporta è quello che si è
    // ricevuto, e non una versione ritoccata che si spaccia per l'originale.
    readOnly: row.pack_locked === true,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: row.version,
  };
}

const SELECT_PACKS = `
  SELECT p.id, p.campaign_id, p.slug, p.name, p.pack_version, p.license, p.attribution,
         p.source_url, p.locked, p.created_at, p.updated_at, p.version,
         (SELECT count(*) FROM library_entries e
           WHERE e.pack_id = p.id AND e.deleted_at IS NULL) AS entry_count
    FROM content_packs p`;

const SELECT_ENTRIES = `
  SELECT e.id, e.campaign_id, e.pack_id, e.folder_id, e.kind, e.name, e.original_name,
         e.slug, e.data, e.custom, e.created_at, e.updated_at, e.version,
         p.locked AS pack_locked
    FROM library_entries e
    LEFT JOIN content_packs p ON p.id = e.pack_id
   WHERE e.deleted_at IS NULL`;

const SELECT_FOLDERS = `
  SELECT id, campaign_id, kind, parent_id, name, sort_order, created_at, updated_at, version
    FROM library_folders`;

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 200);
  return slug || 'voce';
}

/* -------------------------------- cartelle ------------------------------- */

/**
 * Trova o crea le cartelle di un percorso come "Incantesimi/Livello 3".
 *
 * Le cartelle nascono dal caricamento invece di essere chieste a chi carica:
 * un pacchetto porta con sé la propria organizzazione.
 */
async function folderForPath(
  context: ServerContext,
  campaignId: string,
  kind: LibraryKind,
  path: string | undefined,
  cache: Map<string, string>,
): Promise<string | null> {
  if (!path) return null;
  const parts = path.split('/').map((p) => p.trim()).filter(Boolean).slice(0, 4);
  if (parts.length === 0) return null;

  let parent: string | null = null;
  let walked = '';
  for (const part of parts) {
    walked = walked ? `${walked}/${part}` : part;
    const key = `${kind}::${walked}`;
    const known = cache.get(key);
    if (known) {
      parent = known;
      continue;
    }
    const existing: { rows: { id: string }[] } = await context.pool.query<{ id: string }>(
      `SELECT id FROM library_folders
        WHERE campaign_id = $1 AND kind = $2 AND name = $3
          AND parent_id IS NOT DISTINCT FROM $4
        LIMIT 1`,
      [campaignId, kind, part, parent],
    );
    // Annotato di proposito: senza, l'inferenza gira in tondo fra `parent` e
    // il risultato della query che lo usa come parametro.
    let id: string | undefined = existing.rows[0]?.id;
    if (!id) {
      const created: { rows: { id: string }[] } = await context.pool.query<{ id: string }>(
        `INSERT INTO library_folders (campaign_id, kind, parent_id, name)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [campaignId, kind, parent, part],
      );
      id = created.rows[0]?.id;
    }
    if (!id) throw new Error('cartella non creata');
    cache.set(key, id);
    parent = id;
  }
  return parent;
}

/* ------------------------------ autorizzazioni --------------------------- */

async function requirePackAccess(
  context: ServerContext,
  viewer: { id: string },
  packId: string,
): Promise<{ pack: ContentPack; role: CampaignRole }> {
  // Il ruolo va chiesto esplicitamente: SELECT_PACKS elenca solo le colonne
  // del pacchetto, e una `m.role` dimenticata qui diventa un Game Master che
  // riceve 403 a casa propria.
  const { rows } = await context.pool.query<PackRow & { role: CampaignRole }>(
    `SELECT p.id, p.campaign_id, p.slug, p.name, p.pack_version, p.license, p.attribution,
            p.source_url, p.locked, p.created_at, p.updated_at, p.version, m.role,
            (SELECT count(*) FROM library_entries e
              WHERE e.pack_id = p.id AND e.deleted_at IS NULL) AS entry_count
       FROM content_packs p
       JOIN campaigns c ON c.id = p.campaign_id AND c.deleted_at IS NULL
       JOIN campaign_memberships m
         ON m.campaign_id = p.campaign_id AND m.user_id = $2 AND m.status = 'active'
      WHERE p.id = $1`,
    [packId, viewer.id],
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, 'not_found', 'Pacchetto non trovato');
  return { pack: toPack(row), role: row.role };
}

async function requireEntryAccess(
  context: ServerContext,
  viewer: { id: string },
  entryId: string,
): Promise<{ entry: LibraryEntry; role: CampaignRole }> {
  const { rows } = await context.pool.query<EntryRow & { role: CampaignRole }>(
    `${SELECT_ENTRIES}
       AND e.id = $1
       AND EXISTS (SELECT 1 FROM campaign_memberships m
                    WHERE m.campaign_id = e.campaign_id AND m.user_id = $2
                      AND m.status = 'active')`,
    [entryId, viewer.id],
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, 'not_found', 'Voce non trovata');
  const membership = await context.pool.query<{ role: CampaignRole }>(
    `SELECT role FROM campaign_memberships
      WHERE campaign_id = $1 AND user_id = $2 AND status = 'active'`,
    [row.campaign_id, viewer.id],
  );
  const role = membership.rows[0]?.role;
  if (!role) throw new HttpError(404, 'not_found', 'Voce non trovata');
  requireVisibleKind(role, row.kind);
  return { entry: toEntry(row), role };
}

/* --------------------------------- rotte --------------------------------- */

const listQuerySchema = z.object({
  kind: libraryKindSchema.optional(),
  folderId: z.string().uuid().optional(),
  q: z.string().trim().max(120).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
  limit: z.coerce.number().int().min(1).max(LIBRARY_PAGE_SIZE).optional(),
});

export function libraryRoutes(context: ServerContext): Route[] {
  return [
    {
      method: 'GET',
      pattern: '/api/campaigns/:campaignId/library',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = await requireCampaignAccess(context, viewer, params.campaignId ?? '');
        const parsed = listQuerySchema.safeParse(request.query);
        if (!parsed.success) throw new HttpError(422, 'invalid_input', 'Filtro non valido');
        const query = parsed.data;
        if (query.kind) requireVisibleKind(access.role, query.kind);

        const kinds = query.kind ? [query.kind] : visibleKinds(access.role);
        const values: unknown[] = [access.campaignId, kinds];
        let where = ' AND e.campaign_id = $1 AND e.kind = ANY($2::text[])';
        if (query.folderId) {
          values.push(query.folderId);
          where += ` AND e.folder_id = $${values.length}`;
        }
        if (query.q) {
          values.push(`%${query.q}%`);
          where += ` AND (e.name ILIKE $${values.length} OR e.original_name ILIKE $${values.length})`;
        }

        const total = await context.pool.query<{ count: string }>(
          `SELECT count(*) AS count FROM library_entries e WHERE e.deleted_at IS NULL${where}`,
          values,
        );
        const limit = query.limit ?? LIBRARY_PAGE_SIZE;
        const offset = query.offset ?? 0;
        const { rows } = await context.pool.query<EntryRow>(
          `${SELECT_ENTRIES}${where} ORDER BY e.kind, e.name
            LIMIT ${limit} OFFSET ${offset}`,
          values,
        );
        const body: LibraryPage = {
          entries: rows.map(toEntry),
          total: Number(total.rows[0]?.count ?? 0),
        };
        return { status: 200, headers: { 'Cache-Control': 'no-store' }, body };
      },
    },

    {
      method: 'GET',
      pattern: '/api/library/:entryId',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const { entry } = await requireEntryAccess(context, viewer, params.entryId ?? '');
        return { status: 200, headers: { 'Cache-Control': 'no-store' }, body: entry };
      },
    },

    {
      method: 'POST',
      pattern: '/api/campaigns/:campaignId/library',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = requireGameMaster(
          await requireCampaignAccess(context, viewer, params.campaignId ?? ''),
        );
        const input = parseBody(createEntryInputSchema, request.body);
        const shape = parseLibraryData(input.kind, input.data ?? {});
        if (!shape.ok) {
          throw new HttpError(422, 'invalid_input', 'Dati non validi per questo tipo', shape.issues);
        }
        const { rows } = await context.pool.query<EntryRow>(
          `INSERT INTO library_entries
             (campaign_id, folder_id, kind, name, original_name, slug, data, custom)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
           RETURNING id, campaign_id, pack_id, folder_id, kind, name, original_name, slug,
                     data, custom, created_at, updated_at, version, NULL::boolean AS pack_locked`,
          [
            access.campaignId,
            input.folderId ?? null,
            input.kind,
            input.name,
            input.originalName ?? null,
            input.slug ?? slugify(input.name),
            JSON.stringify(shape.data),
            JSON.stringify(input.custom ?? {}),
          ],
        );
        const row = rows[0];
        if (!row) throw new Error('voce non creata');
        return { status: 201, body: toEntry(row) };
      },
    },

    {
      method: 'PATCH',
      pattern: '/api/library/:entryId',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const { entry, role } = await requireEntryAccess(context, viewer, params.entryId ?? '');
        if (role !== 'game_master') {
          throw new HttpError(403, 'forbidden', 'Solo il Game Master modifica la libreria');
        }
        if (entry.readOnly) {
          throw new HttpError(
            409,
            'entry_locked',
            'Questa voce arriva da un pacchetto: falne una copia per modificarla',
            entry,
          );
        }
        const input = parseBody(updateEntryInputSchema, request.body);
        let data = entry.data;
        if (input.data !== undefined) {
          const shape = parseLibraryData(entry.kind, input.data);
          if (!shape.ok) {
            throw new HttpError(422, 'invalid_input', 'Dati non validi per questo tipo', shape.issues);
          }
          data = shape.data;
        }
        const { rows } = await context.pool.query<EntryRow>(
          `UPDATE library_entries
              SET name          = COALESCE($3, name),
                  original_name = CASE WHEN $4::boolean THEN $5::text ELSE original_name END,
                  folder_id     = CASE WHEN $6::boolean THEN $7::uuid ELSE folder_id END,
                  data          = $8::jsonb,
                  custom        = COALESCE($9::jsonb, custom),
                  updated_at = now(), version = version + 1
            WHERE id = $1 AND version = $2 AND deleted_at IS NULL
        RETURNING id, campaign_id, pack_id, folder_id, kind, name, original_name, slug,
                  data, custom, created_at, updated_at, version, NULL::boolean AS pack_locked`,
          [
            entry.id,
            input.version,
            input.name ?? null,
            'originalName' in input,
            input.originalName ?? null,
            'folderId' in input,
            input.folderId ?? null,
            JSON.stringify(data),
            input.custom ? JSON.stringify(input.custom) : null,
          ],
        );
        const row = rows[0];
        if (!row) {
          throw new HttpError(409, 'version_conflict', 'La voce è stata modificata altrove', entry);
        }
        return { status: 200, body: toEntry(row) };
      },
    },

    {
      /**
       * Copia una voce in una modificabile.
       *
       * È la via d'uscita dal blocco dei pacchetti: il Game Master che vuole
       * una palla di fuoco diversa non tocca quella ricevuta, se ne tiene una
       * sua accanto.
       */
      method: 'POST',
      pattern: '/api/library/:entryId/copy',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const { entry, role } = await requireEntryAccess(context, viewer, params.entryId ?? '');
        if (role !== 'game_master') {
          throw new HttpError(403, 'forbidden', 'Solo il Game Master modifica la libreria');
        }
        const { rows } = await context.pool.query<EntryRow>(
          `INSERT INTO library_entries
             (campaign_id, folder_id, kind, name, original_name, slug, data, custom)
           SELECT campaign_id, folder_id, kind, $2, original_name, $3, data, custom
             FROM library_entries WHERE id = $1
           RETURNING id, campaign_id, pack_id, folder_id, kind, name, original_name, slug,
                     data, custom, created_at, updated_at, version, NULL::boolean AS pack_locked`,
          [entry.id, `${entry.name} (copia)`, `${entry.slug}-copia-${Date.now().toString(36)}`],
        );
        const row = rows[0];
        if (!row) throw new Error('copia non creata');
        return { status: 201, body: toEntry(row) };
      },
    },

    {
      method: 'DELETE',
      pattern: '/api/library/:entryId',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const { entry, role } = await requireEntryAccess(context, viewer, params.entryId ?? '');
        if (role !== 'game_master') {
          throw new HttpError(403, 'forbidden', 'Solo il Game Master modifica la libreria');
        }
        if (entry.readOnly) {
          throw new HttpError(
            409,
            'entry_locked',
            'Questa voce arriva da un pacchetto: si toglie togliendo il pacchetto',
          );
        }
        await context.pool.query(
          'UPDATE library_entries SET deleted_at = now() WHERE id = $1',
          [entry.id],
        );
        return { status: 200, body: { ok: true } };
      },
    },

    /* -------------------------------- cartelle ------------------------------ */

    {
      method: 'GET',
      pattern: '/api/campaigns/:campaignId/folders',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = await requireCampaignAccess(context, viewer, params.campaignId ?? '');
        const kinds = visibleKinds(access.role);
        const { rows } = await context.pool.query<FolderRow>(
          `${SELECT_FOLDERS} WHERE campaign_id = $1 AND kind = ANY($2::text[])
            ORDER BY kind, sort_order, name`,
          [access.campaignId, kinds],
        );
        return { status: 200, headers: { 'Cache-Control': 'no-store' }, body: rows.map(toFolder) };
      },
    },

    {
      method: 'POST',
      pattern: '/api/campaigns/:campaignId/folders',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = requireGameMaster(
          await requireCampaignAccess(context, viewer, params.campaignId ?? ''),
        );
        const input = parseBody(createFolderInputSchema, request.body);
        const { rows } = await context.pool.query<FolderRow>(
          `INSERT INTO library_folders (campaign_id, kind, parent_id, name, sort_order)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, campaign_id, kind, parent_id, name, sort_order,
                     created_at, updated_at, version`,
          [access.campaignId, input.kind, input.parentId ?? null, input.name, input.sortOrder ?? 0],
        );
        const row = rows[0];
        if (!row) throw new Error('cartella non creata');
        return { status: 201, body: toFolder(row) };
      },
    },

    {
      method: 'PATCH',
      pattern: '/api/folders/:folderId',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const folderId = params.folderId ?? '';
        const owner = await context.pool.query<{ campaign_id: string }>(
          'SELECT campaign_id FROM library_folders WHERE id = $1',
          [folderId],
        );
        const campaignId = owner.rows[0]?.campaign_id;
        if (!campaignId) throw new HttpError(404, 'not_found', 'Cartella non trovata');
        requireGameMaster(await requireCampaignAccess(context, viewer, campaignId));
        const input = parseBody(updateFolderInputSchema, request.body);
        if (input.parentId === folderId) {
          throw new HttpError(422, 'invalid_input', 'Una cartella non può contenere se stessa');
        }
        const { rows } = await context.pool.query<FolderRow>(
          `UPDATE library_folders
              SET name       = COALESCE($3, name),
                  parent_id  = CASE WHEN $4::boolean THEN $5::uuid ELSE parent_id END,
                  sort_order = COALESCE($6, sort_order),
                  updated_at = now(), version = version + 1
            WHERE id = $1 AND version = $2
        RETURNING id, campaign_id, kind, parent_id, name, sort_order,
                  created_at, updated_at, version`,
          [
            folderId,
            input.version,
            input.name ?? null,
            'parentId' in input,
            input.parentId ?? null,
            input.sortOrder ?? null,
          ],
        );
        const row = rows[0];
        if (!row) throw new HttpError(409, 'version_conflict', 'La cartella è cambiata altrove');
        return { status: 200, body: toFolder(row) };
      },
    },

    {
      method: 'DELETE',
      pattern: '/api/folders/:folderId',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const folderId = params.folderId ?? '';
        const owner = await context.pool.query<{ campaign_id: string }>(
          'SELECT campaign_id FROM library_folders WHERE id = $1',
          [folderId],
        );
        const campaignId = owner.rows[0]?.campaign_id;
        if (!campaignId) throw new HttpError(404, 'not_found', 'Cartella non trovata');
        requireGameMaster(await requireCampaignAccess(context, viewer, campaignId));
        // Le voci non spariscono con la cartella: tornano senza cartella.
        await context.pool.query('DELETE FROM library_folders WHERE id = $1', [folderId]);
        return { status: 200, body: { ok: true } };
      },
    },

    /* ------------------------------- pacchetti ------------------------------ */

    {
      method: 'GET',
      pattern: '/api/campaigns/:campaignId/packs',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = await requireCampaignAccess(context, viewer, params.campaignId ?? '');
        const { rows } = await context.pool.query<PackRow>(
          `${SELECT_PACKS} WHERE p.campaign_id = $1 ORDER BY p.name`,
          [access.campaignId],
        );
        return { status: 200, headers: { 'Cache-Control': 'no-store' }, body: rows.map(toPack) };
      },
    },

    {
      method: 'POST',
      pattern: '/api/campaigns/:campaignId/packs',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = requireGameMaster(
          await requireCampaignAccess(context, viewer, params.campaignId ?? ''),
        );
        const input = parseBody(createPackInputSchema, request.body);

        const existing = await context.pool.query<{ id: string }>(
          'SELECT id FROM content_packs WHERE campaign_id = $1 AND slug = $2',
          [access.campaignId, input.slug],
        );
        const already = existing.rows[0]?.id;
        if (already && !input.replaceExisting) {
          throw new HttpError(409, 'pack_exists', 'Questo pacchetto è già caricato');
        }
        if (already) {
          // Ricaricare un pacchetto lo sostituisce: le voci vecchie se ne vanno
          // con lui, altrimenti resterebbero in giro voci di una versione che
          // nessuno ha più.
          await context.pool.query('DELETE FROM library_entries WHERE pack_id = $1', [already]);
        }

        const { rows } = await context.pool.query<PackRow>(
          `INSERT INTO content_packs
             (campaign_id, slug, name, pack_version, license, attribution, source_url, locked)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (campaign_id, slug) DO UPDATE
              SET name = EXCLUDED.name, pack_version = EXCLUDED.pack_version,
                  license = EXCLUDED.license, attribution = EXCLUDED.attribution,
                  source_url = EXCLUDED.source_url, locked = EXCLUDED.locked,
                  updated_at = now(), version = content_packs.version + 1
           RETURNING id, campaign_id, slug, name, pack_version, license, attribution,
                     source_url, locked, created_at, updated_at, version, 0 AS entry_count`,
          [
            access.campaignId,
            input.slug,
            input.name,
            input.packVersion,
            input.license,
            input.attribution,
            input.sourceUrl ?? null,
            input.locked,
          ],
        );
        const row = rows[0];
        if (!row) throw new Error('pacchetto non creato');
        return { status: already ? 200 : 201, body: toPack(row) };
      },
    },

    {
      /**
       * Aggiunge un mazzetto di voci a un pacchetto.
       *
       * Una voce storta non ferma le altre: si dice quale è stata scartata e
       * perché. Rifiutare mille voci per una virgola non aiuterebbe nessuno.
       */
      method: 'POST',
      pattern: '/api/packs/:packId/entries',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const { pack, role } = await requirePackAccess(context, viewer, params.packId ?? '');
        if (role !== 'game_master') {
          throw new HttpError(403, 'forbidden', 'Solo il Game Master carica i pacchetti');
        }
        const input = parseBody(addPackEntriesInputSchema, request.body);

        const folders = new Map<string, string>();
        const skipped: { slug: string; kind: string; reason: string }[] = [];
        let created = 0;
        let updated = 0;

        for (const entry of input.entries as PackEntryFile[]) {
          const shape = parseLibraryData(entry.kind, entry.data ?? {});
          if (!shape.ok) {
            skipped.push({ slug: entry.slug, kind: entry.kind, reason: shape.issues[0] ?? 'dati non validi' });
            continue;
          }
          const folderId = await folderForPath(
            context, pack.campaignId, entry.kind, entry.folder, folders,
          );
          const { rows } = await context.pool.query<{ inserted: boolean }>(
            `INSERT INTO library_entries
               (campaign_id, pack_id, folder_id, kind, name, original_name, slug, data, custom)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
             ON CONFLICT (pack_id, kind, slug) WHERE pack_id IS NOT NULL
             DO UPDATE SET name = EXCLUDED.name, original_name = EXCLUDED.original_name,
                           folder_id = EXCLUDED.folder_id, data = EXCLUDED.data,
                           custom = EXCLUDED.custom, deleted_at = NULL,
                           updated_at = now(), version = library_entries.version + 1
             RETURNING (xmax = 0) AS inserted`,
            [
              pack.campaignId, pack.id, folderId, entry.kind, entry.name,
              entry.originalName ?? null, entry.slug,
              JSON.stringify(shape.data), JSON.stringify(entry.custom ?? {}),
            ],
          );
          if (rows[0]?.inserted) created += 1;
          else updated += 1;
        }

        const fresh = await context.pool.query<PackRow>(`${SELECT_PACKS} WHERE p.id = $1`, [pack.id]);
        const row = fresh.rows[0];
        if (!row) throw new Error('pacchetto non leggibile');
        return { status: 200, body: { pack: toPack(row), created, updated, skipped } };
      },
    },

    {
      method: 'DELETE',
      pattern: '/api/packs/:packId',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const { pack, role } = await requirePackAccess(context, viewer, params.packId ?? '');
        if (role !== 'game_master') {
          throw new HttpError(403, 'forbidden', 'Solo il Game Master toglie i pacchetti');
        }
        await context.pool.query('DELETE FROM content_packs WHERE id = $1', [pack.id]);
        return { status: 200, body: { ok: true } };
      },
    },

    {
      /** Riesporta un pacchetto come è arrivato, licenza e attribuzione comprese. */
      method: 'GET',
      pattern: '/api/packs/:packId/export',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const { pack, role } = await requirePackAccess(context, viewer, params.packId ?? '');
        if (role !== 'game_master') {
          throw new HttpError(403, 'forbidden', 'Solo il Game Master esporta i pacchetti');
        }
        const { rows } = await context.pool.query<EntryRow & { folder_path: string | null }>(
          `${SELECT_ENTRIES} AND e.pack_id = $1 ORDER BY e.kind, e.slug`,
          [pack.id],
        );
        const body: ContentPackFile = {
          format: 'legendforge-pack',
          schemaVersion: 1,
          slug: pack.slug,
          name: pack.name,
          packVersion: pack.packVersion,
          license: pack.license,
          attribution: pack.attribution,
          sourceUrl: pack.sourceUrl,
          entries: rows.map((row) => ({
            kind: row.kind,
            name: row.name,
            originalName: row.original_name,
            slug: row.slug,
            data: row.data,
            custom: (row.custom ?? {}) as PackEntryFile['custom'],
          })),
        };
        return { status: 200, headers: { 'Cache-Control': 'no-store' }, body };
      },
    },
  ];
}
