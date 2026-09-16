import type { ServerEnv } from '../env.js';
import type { Route } from '../http.js';
import { probeDatabaseTls } from '../tls-probe.js';

/**
 * Diagnostica della connessione al database.
 *
 * Non richiede una sessione perché serve proprio quando il database non è
 * raggiungibile e quindi nessuna sessione può essere verificata. Espone solo
 * dati pubblici — la catena di certificati del server — e non accetta
 * indirizzi dal chiamante: la destinazione è sempre la nostra DATABASE_URL.
 */
export function diagnosticsRoutes(env: ServerEnv): Route[] {
  return [
    {
      method: 'GET',
      pattern: '/api/diagnostics/database-tls',
      async handle() {
        if (!env.databaseUrl) {
          return {
            status: 200,
            headers: { 'Cache-Control': 'no-store' },
            body: { configured: false },
          };
        }
        const result = await probeDatabaseTls(env.databaseUrl);
        return { status: 200, headers: { 'Cache-Control': 'no-store' }, body: result };
      },
    },
  ];
}
