import type { ServerEnv } from '../env.js';

/**
 * Accesso allo storage di Supabase.
 *
 * Il file non passa mai dalla nostra API: il browser lo carica direttamente
 * con un URL firmato a scadenza breve, perché il corpo di una funzione
 * serverless è limitato a pochi megabyte e una mappa ne pesa molti di più.
 * Il percorso dentro il bucket lo decide sempre il server: il client non
 * sceglie dove scrivere.
 */

export interface StorageConfig {
  url: string;
  serviceRoleKey: string;
  bucket: string;
}

export interface SignedUpload {
  /** URL completo a cui il browser deve inviare il file. */
  uploadUrl: string;
  /** Percorso dell'oggetto dentro il bucket. */
  path: string;
  token: string;
}

export interface ObjectInfo {
  path: string;
  byteSize: number;
  mimeType: string | null;
  lastModified: string | null;
}

export class StorageError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'StorageError';
    this.status = status;
  }
}

export function readStorageConfig(env: ServerEnv): StorageConfig | null {
  if (!env.supabaseUrl || !env.supabaseServiceRoleKey) return null;
  return {
    url: env.supabaseUrl.replace(/\/+$/u, ''),
    serviceRoleKey: env.supabaseServiceRoleKey,
    bucket: env.storageBucket,
  };
}

async function call(
  config: StorageConfig,
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 10_000);
  try {
    return await fetch(`${config.url}/storage/v1${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.serviceRoleKey}`,
        apikey: config.serviceRoleKey,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const text = await response.text();
    if (!text) return fallback;
    try {
      const parsed = JSON.parse(text) as { message?: string; error?: string };
      return parsed.message ?? parsed.error ?? text.slice(0, 200);
    } catch {
      return text.slice(0, 200);
    }
  } catch {
    return fallback;
  }
}

export interface BucketState {
  exists: boolean;
  created: boolean;
  public: boolean | null;
  error: string | null;
}

/**
 * Garantisce che il bucket esista, privato e con i soli tipi ammessi.
 *
 * Un bucket pubblico renderebbe ogni mappa raggiungibile da chiunque ne
 * indovini l'URL: se lo trovassimo pubblico lo segnaliamo invece di far finta
 * di niente.
 */
export async function ensureBucket(
  config: StorageConfig,
  maxUploadBytes: number,
  allowedMimeTypes: readonly string[],
): Promise<BucketState> {
  try {
    const existing = await call(config, `/bucket/${encodeURIComponent(config.bucket)}`);
    if (existing.ok) {
      const body = (await existing.json()) as { public?: boolean };
      return { exists: true, created: false, public: body.public ?? null, error: null };
    }
    if (existing.status !== 404) {
      return {
        exists: false,
        created: false,
        public: null,
        error: await readError(existing, `HTTP ${existing.status}`),
      };
    }

    const created = await call(config, '/bucket', {
      method: 'POST',
      body: JSON.stringify({
        id: config.bucket,
        name: config.bucket,
        public: false,
        file_size_limit: maxUploadBytes,
        allowed_mime_types: [...allowedMimeTypes],
      }),
    });
    if (!created.ok) {
      return {
        exists: false,
        created: false,
        public: null,
        error: await readError(created, `HTTP ${created.status}`),
      };
    }
    return { exists: true, created: true, public: false, error: null };
  } catch (error) {
    return {
      exists: false,
      created: false,
      public: null,
      error: error instanceof Error ? error.message : 'errore sconosciuto',
    };
  }
}

/** URL firmato per il caricamento diretto dal browser. */
export async function createSignedUpload(
  config: StorageConfig,
  objectPath: string,
): Promise<SignedUpload> {
  const response = await call(
    config,
    `/object/upload/sign/${encodeURIComponent(config.bucket)}/${objectPath}`,
    { method: 'POST' },
  );
  if (!response.ok) {
    throw new StorageError(response.status, await readError(response, 'firma non riuscita'));
  }
  const body = (await response.json()) as { url?: string; token?: string };
  if (!body.url || !body.token) {
    throw new StorageError(502, 'risposta dello storage incompleta');
  }
  return { uploadUrl: `${config.url}/storage/v1${body.url}`, path: objectPath, token: body.token };
}

/** URL firmato per la lettura, a scadenza breve. */
export async function createSignedDownload(
  config: StorageConfig,
  objectPath: string,
  expiresInSeconds: number,
): Promise<{ url: string; expiresAt: string }> {
  const response = await call(
    config,
    `/object/sign/${encodeURIComponent(config.bucket)}/${objectPath}`,
    { method: 'POST', body: JSON.stringify({ expiresIn: expiresInSeconds }) },
  );
  if (!response.ok) {
    throw new StorageError(response.status, await readError(response, 'firma non riuscita'));
  }
  const body = (await response.json()) as { signedURL?: string; signedUrl?: string };
  const signed = body.signedURL ?? body.signedUrl;
  if (!signed) throw new StorageError(502, 'risposta dello storage incompleta');
  return {
    url: `${config.url}/storage/v1${signed}`,
    expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
  };
}

/**
 * Legge i metadati reali dell'oggetto caricato.
 *
 * È il passo che rende affidabile il caricamento diretto: dimensione e tipo
 * non sono quelli dichiarati dal client ma quelli effettivi sullo storage.
 */
export async function getObjectInfo(
  config: StorageConfig,
  objectPath: string,
): Promise<ObjectInfo | null> {
  const lastSlash = objectPath.lastIndexOf('/');
  const prefix = lastSlash === -1 ? '' : objectPath.slice(0, lastSlash);
  const name = lastSlash === -1 ? objectPath : objectPath.slice(lastSlash + 1);

  const response = await call(config, `/object/list/${encodeURIComponent(config.bucket)}`, {
    method: 'POST',
    body: JSON.stringify({ prefix, limit: 100, offset: 0, search: name }),
  });
  if (!response.ok) {
    throw new StorageError(response.status, await readError(response, 'elenco non riuscito'));
  }
  const entries = (await response.json()) as {
    name: string;
    updated_at?: string;
    metadata?: { size?: number; mimetype?: string } | null;
  }[];
  const match = entries.find((entry) => entry.name === name);
  if (!match) return null;
  return {
    path: objectPath,
    byteSize: match.metadata?.size ?? 0,
    mimeType: match.metadata?.mimetype ?? null,
    lastModified: match.updated_at ?? null,
  };
}

export async function deleteObject(config: StorageConfig, objectPath: string): Promise<void> {
  await call(config, `/object/${encodeURIComponent(config.bucket)}/${objectPath}`, {
    method: 'DELETE',
  }).catch(() => undefined);
}
