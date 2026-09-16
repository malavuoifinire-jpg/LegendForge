import net from 'node:net';
import tls from 'node:tls';

/**
 * Legge la catena di certificati presentata dal server PostgreSQL.
 *
 * PostgreSQL non parla TLS dal primo byte: il client invia un pacchetto
 * SSLRequest e solo dopo la risposta `S` inizia la negoziazione. Una
 * `tls.connect` diretta fallirebbe.
 *
 * Restituisce soltanto informazioni pubbliche — soggetto, emittente, validità,
 * impronta e PEM dei certificati di autorità — e la destinazione è sempre
 * l'host della nostra DATABASE_URL, mai un indirizzo scelto da chi chiama.
 */

const SSL_REQUEST_CODE = 80877103;

export interface CertificateSummary {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  fingerprint256: string;
  selfSigned: boolean;
  /** Presente solo per i certificati di autorità: sono documenti pubblici. */
  pem: string | null;
}

export interface TlsProbeResult {
  host: string;
  port: number;
  ok: boolean;
  error: string | null;
  chain: CertificateSummary[];
}

function sslRequestPacket(): Buffer {
  const packet = Buffer.alloc(8);
  packet.writeInt32BE(8, 0);
  packet.writeInt32BE(SSL_REQUEST_CODE, 4);
  return packet;
}

function asText(value: Record<string, unknown> | undefined): string {
  if (!value) return '';
  return Object.entries(value)
    .map(([key, entry]) => `${key}=${String(entry)}`)
    .join(', ');
}

function toPem(raw: Buffer): string {
  const body = raw.toString('base64').replace(/(.{64})/gu, '$1\n').trimEnd();
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
}

function summarize(certificate: tls.PeerCertificate, includePem: boolean): CertificateSummary {
  const subject = asText(certificate.subject as unknown as Record<string, unknown>);
  const issuer = asText(certificate.issuer as unknown as Record<string, unknown>);
  return {
    subject,
    issuer,
    validFrom: certificate.valid_from ?? '',
    validTo: certificate.valid_to ?? '',
    fingerprint256: certificate.fingerprint256 ?? '',
    selfSigned: subject === issuer,
    pem: includePem && certificate.raw ? toPem(certificate.raw) : null,
  };
}

export function probeDatabaseTls(
  connectionString: string,
  timeoutMs = 8000,
): Promise<TlsProbeResult> {
  let host = '';
  let port = 5432;
  try {
    const url = new URL(connectionString);
    host = url.hostname;
    port = Number(url.port || 5432);
  } catch {
    return Promise.resolve({
      host: '',
      port: 0,
      ok: false,
      error: 'DATABASE_URL non interpretabile',
      chain: [],
    });
  }

  return new Promise<TlsProbeResult>((resolve) => {
    const base: TlsProbeResult = { host, port, ok: false, error: null, chain: [] };
    let settled = false;
    const finish = (result: TlsProbeResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      finish({ ...base, error: 'timeout' });
    }, timeoutMs);

    const fail = (message: string): void => {
      clearTimeout(timer);
      socket.destroy();
      finish({ ...base, error: message });
    };

    socket.once('error', (error: Error) => fail(error.message));

    socket.once('connect', () => {
      socket.write(sslRequestPacket());
      socket.once('data', (answer: Buffer) => {
        if (answer.toString('utf8', 0, 1) !== 'S') {
          fail('il server non accetta TLS su questa porta');
          return;
        }

        const secure = tls.connect({ socket, servername: host, rejectUnauthorized: false }, () => {
          clearTimeout(timer);
          const chain: CertificateSummary[] = [];
          const seen = new Set<string>();
          let certificate: tls.DetailedPeerCertificate | undefined = secure.getPeerCertificate(true);
          while (certificate?.fingerprint256 && !seen.has(certificate.fingerprint256)) {
            seen.add(certificate.fingerprint256);
            // Il PEM serve solo per le autorità, cioè dal secondo in poi.
            chain.push(summarize(certificate, chain.length > 0));
            const parent: tls.DetailedPeerCertificate | undefined = certificate.issuerCertificate;
            if (!parent || parent === certificate) break;
            certificate = parent;
          }
          secure.end();
          finish({ ...base, ok: true, chain });
        });
        secure.once('error', (error: Error) => fail(error.message));
      });
    });
  });
}
