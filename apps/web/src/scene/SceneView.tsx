import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SceneDetail, Token } from '@legendforge/contracts';
import {
  formatDistance,
  screenToImage,
  type GridConfiguration,
  type ImagePoint,
  type Viewport,
} from '@legendforge/core';
import { ApiError, api } from '../api/client';
import { SceneCanvas } from './SceneCanvas';
import { loadImageFromUrl } from './imageAnalysis';
import type { CanvasMap } from './types';
import { CalibrationPanel } from './CalibrationPanel';

interface SceneViewProps {
  sceneId: string;
  canEdit: boolean;
  onBack: () => void;
}

const TOKEN_COLORS = ['#4ade80', '#60a5fa', '#f87171', '#fbbf24', '#c084fc', '#f472b6'];

export function SceneView({ sceneId, canEdit, onBack }: SceneViewProps) {
  const [scene, setScene] = useState<SceneDetail | null>(null);
  const [map, setMap] = useState<CanvasMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [gridVisible, setGridVisible] = useState(true);
  const [selectedTokenId, setSelectedTokenId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ panX: 0, panY: 0, zoom: 1 });
  const [picking, setPicking] = useState(false);
  const [pickedPoints, setPickedPoints] = useState<ImagePoint[]>([]);
  /** Anteprima locale della griglia mentre si trascina un cursore. */
  const [gridPreview, setGridPreview] = useState<Partial<GridConfiguration>>({});
  const tokensRef = useRef<Token[]>([]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const detail = await api.getScene(sceneId);
      setScene(detail);
      tokensRef.current = detail.tokens;
      setGridPreview({});
      if (detail.mapSource) {
        const image = await loadImageFromUrl(detail.mapSource.url);
        setMap({
          source: image,
          width: detail.map?.widthPx ?? image.naturalWidth,
          height: detail.map?.heightPx ?? image.naturalHeight,
        });
      } else {
        setMap(null);
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Impossibile caricare la scena');
    }
  }, [sceneId]);

  useEffect(() => {
    void load();
  }, [load]);

  const grid = useMemo(() => {
    if (!scene) return null;
    return { ...scene.grid, ...gridPreview };
  }, [scene, gridPreview]);

  /* --------------------------------- griglia -------------------------------- */

  const saveGrid = useCallback(
    async (patch: Partial<GridConfiguration>, confirm?: boolean) => {
      if (!scene) return;
      setSaving(true);
      setError(null);
      try {
        const updated = await api.updateGrid(scene.id, {
          ...patch,
          version: scene.grid.version,
          ...(confirm ? { confirmed: true } : {}),
        });
        setScene((current) => (current ? { ...current, grid: updated } : current));
        setGridPreview({});
        if (confirm) setNotice('Griglia confermata.');
      } catch (caught) {
        if (caught instanceof ApiError && caught.code === 'version_conflict') {
          setError('La griglia era già stata modificata: ho ricaricato lo stato aggiornato.');
          await load();
        } else {
          setError(caught instanceof ApiError ? caught.message : 'Salvataggio non riuscito');
          setGridPreview({});
        }
      } finally {
        setSaving(false);
      }
    },
    [scene, load],
  );

  const handlePickPoint = useCallback((point: ImagePoint) => {
    setPickedPoints((current) => (current.length >= 2 ? [point] : [...current, point]));
  }, []);

  /* --------------------------------- pedine --------------------------------- */

  const moveTokenLocally = useCallback((id: string, position: ImagePoint) => {
    setScene((current) => {
      if (!current) return current;
      const tokens = current.tokens.map((token) =>
        token.id === id ? { ...token, x: position.x, y: position.y } : token,
      );
      tokensRef.current = tokens;
      return { ...current, tokens };
    });
  }, []);

  const commitToken = useCallback(
    async (id: string) => {
      const token = tokensRef.current.find((candidate) => candidate.id === id);
      if (!token) return;
      try {
        // La posizione che vale è quella che torna dal server: è lui ad
        // applicare l'aggancio, non il browser.
        const updated = await api.updateToken(token.id, {
          version: token.version,
          x: token.x,
          y: token.y,
        });
        setScene((current) => {
          if (!current) return current;
          const tokens = current.tokens.map((candidate) =>
            candidate.id === updated.id ? updated : candidate,
          );
          tokensRef.current = tokens;
          return { ...current, tokens };
        });
      } catch (caught) {
        if (caught instanceof ApiError && caught.code === 'version_conflict') {
          setError('Quella pedina era già stata spostata: ho ricaricato la scena.');
        } else {
          setError(caught instanceof ApiError ? caught.message : 'Spostamento non salvato');
        }
        await load();
      }
    },
    [load],
  );

  const addToken = useCallback(async () => {
    if (!scene || !grid) return;
    setSaving(true);
    try {
      // Nuova pedina al centro di ciò che si sta guardando.
      const center = screenToImage({ x: 420, y: 300 }, viewport);
      const created = await api.createToken(scene.id, {
        name: `Pedina ${scene.tokens.length + 1}`,
        x: center.x,
        y: center.y,
        color: TOKEN_COLORS[scene.tokens.length % TOKEN_COLORS.length] ?? '#60a5fa',
      });
      setScene((current) => {
        if (!current) return current;
        const tokens = [...current.tokens, created];
        tokensRef.current = tokens;
        return { ...current, tokens };
      });
      setSelectedTokenId(created.id);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Creazione non riuscita');
    } finally {
      setSaving(false);
    }
  }, [scene, grid, viewport]);

  const removeToken = useCallback(async (id: string) => {
    try {
      await api.deleteToken(id);
      setScene((current) => {
        if (!current) return current;
        const tokens = current.tokens.filter((token) => token.id !== id);
        tokensRef.current = tokens;
        return { ...current, tokens };
      });
      setSelectedTokenId(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Cancellazione non riuscita');
    }
  }, []);

  const toggleHidden = useCallback(async (token: Token) => {
    try {
      const updated = await api.updateToken(token.id, {
        version: token.version,
        hidden: !token.hidden,
      });
      setScene((current) => {
        if (!current) return current;
        const tokens = current.tokens.map((candidate) =>
          candidate.id === updated.id ? updated : candidate,
        );
        tokensRef.current = tokens;
        return { ...current, tokens };
      });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Modifica non riuscita');
    }
  }, []);

  const selected = scene?.tokens.find((token) => token.id === selectedTokenId) ?? null;

  const distanceLabel = useMemo(() => {
    if (!selected || !grid) return null;
    const other = scene?.tokens.find((token) => token.id !== selected.id);
    if (!other) return null;
    const pixels = Math.hypot(other.x - selected.x, other.y - selected.y);
    const meters = (pixels / grid.cellSizePx) * grid.metersPerCell;
    return { name: other.name, ...formatDistance(meters, grid) };
  }, [selected, scene, grid]);

  if (error && !scene) {
    return (
      <div className="screen">
        <button type="button" className="gate__link" onClick={onBack}>
          ← Torna alla campagna
        </button>
        <p className="gate__error">{error}</p>
      </div>
    );
  }

  if (!scene || !grid) return <p className="panel__hint screen">Caricamento della scena…</p>;

  return (
    <div className="campaign-screen">
      <div className="campaign-screen__head">
        <button type="button" className="gate__link" onClick={onBack}>
          ← Torna alla campagna
        </button>
        <h1>{scene.name}</h1>
        {scene.map && (
          <span className="badge">
            {scene.map.name} · {scene.map.widthPx}×{scene.map.heightPx} px
          </span>
        )}
      </div>

      {error && <p className="gate__error">{error}</p>}
      {notice && <p className="panel__hint">{notice}</p>}

      <div className="table">
        <section className="table__stage">
          <div className="table__toolbar">
            <span className="readout">Zoom {Math.round(viewport.zoom * 100)}%</span>
          </div>
          {map ? (
            <SceneCanvas
              map={map}
              grid={grid}
              gridVisible={gridVisible}
              tokens={scene.tokens}
              selectedTokenId={selectedTokenId}
              onSelectToken={setSelectedTokenId}
              onMoveToken={moveTokenLocally}
              onCommitToken={commitToken}
              onViewportChange={setViewport}
              picking={picking}
              onPickPoint={handlePickPoint}
              pickedPoints={pickedPoints}
            />
          ) : (
            <div className="empty">
              <p>Questa scena non ha una mappa.</p>
            </div>
          )}
          <p className="stage-note">
            Rotella per lo zoom, trascina per spostare la vista, doppio clic per inquadrare.
            {canEdit ? ' Trascina una pedina per muoverla: la posizione la decide il server.' : ''}
          </p>
        </section>

        <aside className="table__side">
          {canEdit && (
            <CalibrationPanel
              grid={{ ...scene.grid, ...gridPreview }}
              gridVisible={gridVisible}
              detectionConfidence={scene.map?.detection?.confidence ?? null}
              saving={saving}
              picking={picking}
              pickedPoints={pickedPoints}
              onToggleVisible={setGridVisible}
              onPreview={(patch) => setGridPreview((current) => ({ ...current, ...patch }))}
              onSave={(patch, confirm) => void saveGrid(patch, confirm)}
              onStartPicking={() => {
                setPicking(true);
                setPickedPoints([]);
              }}
              onCancelPicking={() => {
                setPicking(false);
                setPickedPoints([]);
              }}
            />
          )}

          <section className="panel">
            <header className="panel__header">
              <h2>Pedine</h2>
              {canEdit && (
                <button type="button" className="panel__action" disabled={saving} onClick={() => void addToken()}>
                  Aggiungi
                </button>
              )}
            </header>

            {scene.tokens.length === 0 && <p className="panel__hint">Nessuna pedina sulla scena.</p>}

            <ul className="token-list">
              {scene.tokens.map((token) => (
                <li key={token.id}>
                  <button
                    type="button"
                    className={token.id === selectedTokenId ? 'token token--active' : 'token'}
                    onClick={() => setSelectedTokenId(token.id)}
                  >
                    <span className="token__dot" style={{ background: token.color }} />
                    <span className="token__name">
                      {token.name}
                      {token.hidden && <span className="token__flag">nascosta</span>}
                    </span>
                    <span className="token__size">
                      {token.sizeInCells}×{token.sizeInCells}
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            {selected && (
              <>
                <dl className="kv kv--compact">
                  <dt>Posizione</dt>
                  <dd className="kv__value">
                    {Math.round(selected.x)}, {Math.round(selected.y)} px
                  </dd>
                  {distanceLabel && (
                    <>
                      <dt>Distanza da {distanceLabel.name}</dt>
                      <dd className="kv__value">{distanceLabel.label}</dd>
                    </>
                  )}
                </dl>
                {canEdit && (
                  <div className="wizard__actions">
                    <button
                      type="button"
                      className="panel__action"
                      onClick={() => void toggleHidden(selected)}
                    >
                      {selected.hidden ? 'Mostra ai giocatori' : 'Nascondi ai giocatori'}
                    </button>
                    <button
                      type="button"
                      className="panel__action panel__action--danger"
                      onClick={() => {
                        if (window.confirm(`Eliminare "${selected.name}"?`)) {
                          void removeToken(selected.id);
                        }
                      }}
                    >
                      Elimina
                    </button>
                  </div>
                )}
              </>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
