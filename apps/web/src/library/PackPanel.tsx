import { useRef, useState } from 'react';
import {
  contentPackFileSchema,
  MAX_ENTRIES_PER_REQUEST,
  type ContentPack,
} from '@legendforge/contracts';
import { ApiError, api } from '../api/client';

interface PackPanelProps {
  campaignId: string;
  packs: ContentPack[];
  onChanged: () => void;
}

interface Progress {
  done: number;
  total: number;
  name: string;
}

/**
 * Pacchetti di contenuti: caricarli, toglierli, riesportarli.
 *
 * Il caricamento va a mazzetti perché un pacchetto grosso non entra nel corpo
 * di una richiesta sola. Il fatto che si veda avanzare è un effetto collaterale
 * gradito: un megabyte e mezzo di roba merita una barra, non un'attesa muta.
 */
export function PackPanel({ campaignId, packs, onChanged }: PackPanelProps) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async (file: File): Promise<void> => {
    setError(null);
    setNotice(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text()) as unknown;
    } catch {
      setError('Il file non è JSON leggibile.');
      return;
    }
    const shape = contentPackFileSchema.safeParse(parsed);
    if (!shape.success) {
      const first = shape.error.issues[0];
      setError(
        `Non è un pacchetto di LegendForge: ${first?.path.join('.') ?? ''} ${first?.message ?? ''}`.trim(),
      );
      return;
    }
    const pack = shape.data;
    const { entries, ...header } = pack;

    setProgress({ done: 0, total: entries.length, name: pack.name });
    try {
      const existing = packs.some((candidate) => candidate.slug === pack.slug);
      if (existing) {
        const replace = window.confirm(
          `"${pack.name}" è già caricato. Sostituirlo? Le voci vecchie vengono tolte.`,
        );
        if (!replace) {
          setProgress(null);
          return;
        }
      }
      const created = await api.createPack(campaignId, {
        ...header,
        replaceExisting: existing,
        locked: true,
      });

      let done = 0;
      const skipped: { slug: string; reason: string }[] = [];
      for (let i = 0; i < entries.length; i += MAX_ENTRIES_PER_REQUEST) {
        const batch = entries.slice(i, i + MAX_ENTRIES_PER_REQUEST);
        const result = await api.addPackEntries(created.id, batch);
        skipped.push(...result.skipped);
        done += batch.length;
        setProgress({ done, total: entries.length, name: pack.name });
      }
      setNotice(
        skipped.length === 0
          ? `Caricate ${entries.length} voci.`
          : `Caricate ${entries.length - skipped.length} voci; ${skipped.length} scartate ` +
            `(la prima: ${skipped[0]?.slug} — ${skipped[0]?.reason}).`,
      );
      onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Caricamento non riuscito');
    } finally {
      setProgress(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const remove = async (pack: ContentPack): Promise<void> => {
    if (!window.confirm(`Togliere "${pack.name}" e le sue ${pack.entryCount} voci?`)) return;
    try {
      await api.deletePack(pack.id);
      onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Rimozione non riuscita');
    }
  };

  const save = async (pack: ContentPack): Promise<void> => {
    try {
      const file = await api.exportPack(pack.id);
      const blob = new Blob([JSON.stringify(file, null, 1)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${pack.slug}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Esportazione non riuscita');
    }
  };

  return (
    <section className="panel">
      <header className="panel__header">
        <h2>Pacchetti</h2>
        <button
          type="button"
          className="panel__action"
          disabled={progress !== null}
          onClick={() => fileRef.current?.click()}
        >
          Carica un pacchetto
        </button>
      </header>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void load(file);
        }}
      />

      {progress && (
        <div className="progress">
          <div
            className="progress__bar"
            style={{ width: `${Math.round((progress.done / Math.max(progress.total, 1)) * 100)}%` }}
          />
          <span className="progress__label">
            {progress.name}: {progress.done} di {progress.total}
          </span>
        </div>
      )}
      {error && <p className="gate__error">{error}</p>}
      {notice && <p className="panel__hint">{notice}</p>}

      {packs.length === 0 && !progress && (
        <p className="panel__hint">
          Nessun pacchetto. Nel repository ne trovi uno pronto in <code>packs/</code>.
        </p>
      )}

      <ul className="plain-list">
        {packs.map((pack) => (
          <li key={pack.id} className="row row--column">
            <span className="row__main">
              {pack.name} <span className="badge">{pack.entryCount} voci</span>
            </span>
            {/* La licenza non è una decorazione: viaggia col contenuto e si vede. */}
            <span className="panel__hint">
              {pack.license}
              {pack.sourceUrl && (
                <>
                  {' · '}
                  <a href={pack.sourceUrl} target="_blank" rel="noreferrer noopener">
                    fonte
                  </a>
                </>
              )}
            </span>
            {pack.attribution && <p className="pack__attribution">{pack.attribution}</p>}
            <div className="wizard__actions">
              <button type="button" className="panel__action" onClick={() => void save(pack)}>
                Esporta
              </button>
              <button
                type="button"
                className="panel__action panel__action--danger"
                onClick={() => void remove(pack)}
              >
                Togli
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
