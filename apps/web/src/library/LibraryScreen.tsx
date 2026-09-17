import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  LIBRARY_KIND_LABELS,
  type Campaign,
  type ContentPack,
  type CustomFields,
  type LibraryEntry,
  type LibraryFolder,
  type LibraryKind,
} from '@legendforge/contracts';
import { ApiError, api } from '../api/client';
import { EntryDetail } from './EntryDetail';
import { PackPanel } from './PackPanel';

interface LibraryScreenProps {
  campaign: Campaign;
  onBack: () => void;
}

/** Ordine in cui compaiono i tipi: prima quello che si consulta di più. */
const KIND_ORDER: LibraryKind[] = [
  'spell',
  'monster',
  'item',
  'weapon',
  'armor',
  'class',
  'subclass',
  'species',
  'background',
  'feat',
];

export function LibraryScreen({ campaign, onBack }: LibraryScreenProps) {
  const isGameMaster = campaign.viewerRole === 'game_master';
  const [kind, setKind] = useState<LibraryKind>('spell');
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Partial<Record<LibraryKind, number>>>({});
  const [selected, setSelected] = useState<LibraryEntry | null>(null);
  const [packs, setPacks] = useState<ContentPack[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  /** Tipi che questa persona può vedere: al giocatore il bestiario non arriva. */
  const kinds = useMemo(
    () => KIND_ORDER.filter((k) => isGameMaster || k !== 'monster'),
    [isGameMaster],
  );

  const loadShelf = useCallback(async () => {
    try {
      const [allFolders, allPacks] = await Promise.all([
        api.listFolders(campaign.id),
        api.listPacks(campaign.id),
      ]);
      setFolders(allFolders);
      setPacks(allPacks);
      // Un conteggio per tipo, per le linguette in cima.
      const tallies = await Promise.all(
        kinds.map(async (k) => [k, (await api.library(campaign.id, { kind: k, limit: '1' })).total] as const),
      );
      setCounts(Object.fromEntries(tallies) as Partial<Record<LibraryKind, number>>);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Libreria non raggiungibile');
    }
  }, [campaign.id, kinds]);

  useEffect(() => {
    void loadShelf();
  }, [loadShelf]);

  const loadEntries = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query: Record<string, string> = { kind, limit: '100' };
      if (folderId) query.folderId = folderId;
      if (search.trim()) query.q = search.trim();
      const page = await api.library(campaign.id, query);
      setEntries(page.entries);
      setTotal(page.total);
      setSelected((current) =>
        current && page.entries.some((e) => e.id === current.id) ? current : page.entries[0] ?? null,
      );
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Elenco non caricato');
      setEntries([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [campaign.id, kind, folderId, search]);

  useEffect(() => {
    // Una pausa prima di cercare: si scrive più veloce di quanto risponda il server.
    const timer = setTimeout(() => void loadEntries(), search ? 250 : 0);
    return () => clearTimeout(timer);
  }, [loadEntries, search]);

  const kindFolders = useMemo(
    () => folders.filter((folder) => folder.kind === kind),
    [folders, kind],
  );

  /** Cartelle di primo livello, con i figli appesi sotto. */
  const tree = useMemo(() => {
    const roots = kindFolders.filter((folder) => folder.parentId === null);
    return roots.map((root) => ({
      root,
      children: kindFolders.filter((folder) => folder.parentId === root.id),
    }));
  }, [kindFolders]);

  const act = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      const message =
        caught instanceof ApiError
          ? Array.isArray(caught.details)
            ? `${caught.message}: ${(caught.details as string[]).join('; ')}`
            : caught.message
          : 'Operazione non riuscita';
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen library">
      <div className="screen__head">
        <div>
          <button type="button" className="gate__link screen__back" onClick={onBack}>
            ← Torna alla campagna
          </button>
          <h1>Libreria</h1>
          <p className="screen__lead">
            {isGameMaster
              ? 'Incantesimi, mostri, oggetti e classi di questa campagna.'
              : 'Il materiale a cui il tuo personaggio attinge.'}
          </p>
        </div>
      </div>

      {error && <p className="gate__error">{error}</p>}

      <nav className="library__kinds">
        {kinds.map((k) => (
          <button
            key={k}
            type="button"
            className={k === kind ? 'library__kind library__kind--on' : 'library__kind'}
            onClick={() => {
              setKind(k);
              setFolderId(null);
            }}
          >
            {LIBRARY_KIND_LABELS[k].many}
            <span className="library__count">{counts[k] ?? 0}</span>
          </button>
        ))}
      </nav>

      <div className="library__layout">
        <aside className="library__folders">
          <label className="field">
            <span className="field__label">Cerca</span>
            <input
              type="search"
              value={search}
              placeholder="nome italiano o originale"
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <button
            type="button"
            className={folderId === null ? 'folder folder--on' : 'folder'}
            onClick={() => setFolderId(null)}
          >
            Tutte
          </button>
          {tree.map(({ root, children }) => (
            <div key={root.id}>
              <button
                type="button"
                className={folderId === root.id ? 'folder folder--on' : 'folder'}
                onClick={() => setFolderId(root.id)}
              >
                {root.name}
              </button>
              {children.map((child) => (
                <button
                  key={child.id}
                  type="button"
                  className={
                    folderId === child.id ? 'folder folder--child folder--on' : 'folder folder--child'
                  }
                  onClick={() => setFolderId(child.id)}
                >
                  {child.name}
                </button>
              ))}
            </div>
          ))}
        </aside>

        <section className="library__list">
          <p className="panel__hint">
            {loading
              ? 'Caricamento…'
              : total === 0
                ? 'Niente qui.'
                : total > entries.length
                  ? `${entries.length} di ${total} — restringi con la ricerca o una cartella`
                  : `${total} ${total === 1 ? 'voce' : 'voci'}`}
          </p>
          <ul className="plain-list">
            {entries.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className={
                    selected?.id === entry.id ? 'token token--active' : 'token'
                  }
                  onClick={() => setSelected(entry)}
                >
                  <span className="token__name">{entry.name}</span>
                  {entry.originalName && entry.originalName !== entry.name && (
                    <span className="library__alias">{entry.originalName}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>

        <div className="library__detail">
          {selected ? (
            <EntryDetail
              entry={selected}
              canEdit={isGameMaster}
              busy={busy}
              onSave={(patch: { name?: string; data?: unknown; custom?: CustomFields }) =>
                void act(async () => {
                  const updated = await api.updateEntry(selected.id, {
                    version: selected.version,
                    ...patch,
                  });
                  setSelected(updated);
                  await loadEntries();
                })
              }
              onCopy={() =>
                void act(async () => {
                  const copy = await api.copyEntry(selected.id);
                  await loadEntries();
                  await loadShelf();
                  setSelected(copy);
                })
              }
              onDelete={() =>
                void act(async () => {
                  await api.deleteEntry(selected.id);
                  setSelected(null);
                  await loadEntries();
                  await loadShelf();
                })
              }
            />
          ) : (
            <section className="panel">
              <p className="panel__hint">Scegli una voce dall'elenco.</p>
            </section>
          )}

          {isGameMaster && (
            <PackPanel
              campaignId={campaign.id}
              packs={packs}
              onChanged={() => {
                void loadShelf();
                void loadEntries();
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
