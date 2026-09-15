import { z } from 'zod';

/**
 * Configurazione letta dall'ambiente.
 *
 * Nessun segreto ha un valore predefinito: se manca, il servizio lo dichiara
 * invece di funzionare a metà in silenzio.
 */
const schema = z.object({
  databaseUrl: z.string().min(1).optional(),
  /**
   * Modalità TLS verso il database.
   *  - `require`  : TLS con verifica del certificato. È il default.
   *  - `insecure` : TLS senza verifica. Solo per diagnosi temporanee.
   *  - `disable`  : nessun TLS. Solo per un PostgreSQL locale in sviluppo.
   */
  databaseSsl: z.enum(['require', 'insecure', 'disable']).default('require'),
  build: z.string().nullable().default(null),
  region: z.string().nullable().default(null),
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
});

export type ServerEnv = z.infer<typeof schema>;

export function readEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  return schema.parse({
    databaseUrl: source.DATABASE_URL ?? source.SUPABASE_DB_POOLED_URL ?? undefined,
    databaseSsl: source.DATABASE_SSL ?? undefined,
    build: source.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    region: source.VERCEL_REGION ?? null,
    nodeEnv: (source.NODE_ENV as ServerEnv['nodeEnv']) ?? 'development',
  });
}
