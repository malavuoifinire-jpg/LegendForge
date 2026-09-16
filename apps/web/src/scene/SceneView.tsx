import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Actor,
  LightSource,
  SceneDetail,
  SceneEvent,
  SceneVisionSettings,
  SceneVisionState,
  Token,
  Wall,
  WallKind,
} from '@legendforge/contracts';
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
import { BLANK_SURFACE_HEIGHT, BLANK_SURFACE_WIDTH, createBlankSurface } from './blankSurface';
import type { CanvasMap } from './types';
import { CalibrationPanel } from './CalibrationPanel';
import { useSceneSync } from './useSceneSync';
import { VisionPanel, type VisionTool } from './VisionPanel';

interface SceneViewProps {
  sceneId: string;
  campaignId: string;
  onBack: () => void;
}

const TOKEN_COLORS = ['#4ade80', '#60a5fa', '#f87171', '#fbbf24', '#c084fc', '#f472b6'];

export function SceneView({ sceneId, campaignId, onBack }: SceneViewProps) {
  const [scene, setScene] = useState<SceneDetail | null>(null);
  const [map, setMap] = useState<CanvasMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [gridVisible, setGridVisible] = useState(true);
  const [selectedTokenId, setSelectedTokenId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ panX: 0, panY: 0, zoom: 1 });
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 600 });
  const [picking, setPicking] = useState(false);
  const [pickedPoints, setPickedPoints] = useState<ImagePoint[]>([]);
  /** Anteprima locale della griglia mentre si trascina un cursore. */
  const [gridPreview, setGridPreview] = useState<Partial<GridConfiguration>>({});
  const tokensRef = useRef<Token[]>([]);
  const draggingRef = useRef<string | null>(null);
  const [actors, setActors] = useState<Actor[]>([]);
  const [chosenActorId, setChosenActorId] = useState('');
  const [vision, setVision] = useState<SceneVisionState | null>(null);
  const [tool, setTool] = useState<VisionTool>('select');
  const [wallKind, setWallKind] = useState<WallKind>('opaque');
  const [snapWalls, setSnapWalls] = useState(true);
  const [draftWall, setDraftWall] = useState<ImagePoint[]>([]);
  const [selectedWallId, setSelectedWallId] = useState<string | null>(null);
  const [selectedLightId, setSelectedLightId] = useState<string | null>(null);
  const [previewTokenId, setPreviewTokenId] = useState<string | null>(null);

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
        // Nessuna mappa: si lavora comunque, su una superficie neutra.
        const blank = createBlankSurface();
        setMap({ source: blank, width: BLANK_SURFACE_WIDTH, height: BLANK_SURFACE_HEIGHT });
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Impossibile caricare la scena');
    }
  }, [sceneId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Rilegge il campo visivo.
   *
   * Si rilegge invece di ricevere i dati negli eventi: così il filtro di chi
   * può vedere che cosa resta un posto solo, sul server, e un aggiornamento non
   * può contenere per sbaglio un muro che chi lo riceve non deve conoscere.
   */
  const loadVision = useCallback(async () => {
    try {
      setVision(await api.sceneVision(sceneId, previewTokenId ?? undefined));
    } catch {
      // Il campo visivo è un sovrappiù: se non arriva, la scena resta usabile.
      setVision(null);
    }
  }, [sceneId, previewTokenId]);

  useEffect(() => {
    void loadVision();
  }, [loadVision]);

  useEffect(() => {
    api
      .listActors(campaignId)
      .then(setActors)
      .catch(() => undefined);
  }, [campaignId]);

  /**
   * Applica gli aggiornamenti che arrivano dal server.
   *
   * La pedina che si sta trascinando in questo momento viene lasciata stare:
   * sarebbe la propria eco a strapparla di mano.
   */
  const applyEvents = useCallback((events: SceneEvent[]) => {
    let revisit = false;
    let moved = false;
    setScene((current) => {
      if (!current) return current;
      let tokens = current.tokens;
      let grid = current.grid;
      for (const event of events) {
        if (event.kind === 'token.upserted') {
          const incoming = event.payload as Token;
          moved = true;
          if (draggingRef.current === incoming.id) continue;
          const index = tokens.findIndex((token) => token.id === incoming.id);
          tokens = index === -1
            ? [...tokens, incoming]
            : tokens.map((token) => (token.id === incoming.id ? incoming : token));
        } else if (event.kind === 'token.removed') {
          const { id } = event.payload as { id: string };
          moved = true;
          if (draggingRef.current === id) continue;
          tokens = tokens.filter((token) => token.id !== id);
        } else if (event.kind === 'grid.updated') {
          grid = event.payload as SceneDetail['grid'];
        } else if (
          event.kind === 'wall.changed' ||
          event.kind === 'light.changed' ||
          event.kind === 'vision.changed'
        ) {
          revisit = true;
        }
      }
      tokensRef.current = tokens;
      return { ...current, tokens, grid };
    });
    // Le pedine si sono mosse: quello che si vede da lì è cambiato.
    if (revisit || moved) void reloadVisionRef.current();
  }, []);

  const reloadVisionRef = useRef(loadVision);
  reloadVisionRef.current = loadVision;

  useSceneSync(scene ? scene.id : null, scene?.eventCursor ?? 0, applyEvents);

  const canEdit = scene?.viewerRole === 'game_master';

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
    draggingRef.current = id;
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
      if (!token) {
        draggingRef.current = null;
        return;
      }
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
      } finally {
        draggingRef.current = null;
      }
      // Muovendosi si vede altro: il campo visivo va rifatto subito, senza
      // aspettare che torni indietro l'eco del proprio movimento.
      void reloadVisionRef.current();
    },
    [load],
  );

  const addToken = useCallback(async () => {
    if (!scene || !grid) return;
    setSaving(true);
    try {
      // Al centro di ciò che si sta guardando, scostata di una casella per
      // ogni pedina già presente: non si accatastano tutte sullo stesso punto.
      const center = screenToImage(
        { x: canvasSize.width / 2, y: canvasSize.height / 2 },
        viewport,
      );
      const index = scene.tokens.length;
      const actor = actors.find((candidate) => candidate.id === chosenActorId) ?? null;
      const created = await api.createToken(scene.id, {
        name: actor ? actor.name : `Pedina ${index + 1}`,
        actorId: actor ? actor.id : null,
        x: center.x + (index % 4) * grid.cellSizePx,
        y: center.y + Math.floor(index / 4) * grid.cellSizePx,
        // Con un personaggio il colore lo decide lui; senza, si ruota la tavolozza.
        ...(actor ? {} : { color: TOKEN_COLORS[index % TOKEN_COLORS.length] ?? '#94a3b8' }),
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
  }, [scene, grid, viewport, canvasSize, actors, chosenActorId]);

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

  /* --------------------------------- visione -------------------------------- */

  const failed = useCallback((caught: unknown, fallback: string) => {
    setError(caught instanceof ApiError ? caught.message : fallback);
  }, []);

  const saveVisionSettings = useCallback(
    async (patch: Partial<SceneVisionSettings>) => {
      if (!scene) return;
      // Ottimistico soltanto per il cursore: il valore che vale torna dal server.
      setVision((current) => (current ? { ...current, ...patch } : current));
      setSaving(true);
      try {
        const updated = await api.updateSceneVision(scene.id, {
          ...patch,
          version: scene.version,
        });
        setScene((current) =>
          current ? { ...current, vision: updated, version: current.version + 1 } : current,
        );
        setVision((current) => (current ? { ...current, ...updated } : current));
      } catch (caught) {
        failed(caught, 'Impostazioni non salvate');
        await load();
        await loadVision();
      } finally {
        setSaving(false);
      }
    },
    [scene, load, loadVision, failed],
  );

  const addWallPoint = useCallback((point: ImagePoint) => {
    setDraftWall((current) => [...current, point]);
  }, []);

  const finishDraft = useCallback(async () => {
    if (!scene || draftWall.length < 2) return;
    setSaving(true);
    try {
      const segments = [];
      for (let i = 0; i + 1 < draftWall.length; i += 1) {
        const a = draftWall[i];
        const b = draftWall[i + 1];
        if (!a || !b) continue;
        if (a.x === b.x && a.y === b.y) continue;
        segments.push({
          ax: a.x,
          ay: a.y,
          bx: b.x,
          by: b.y,
          kind: wallKind,
          doorState: 'closed' as const,
        });
      }
      if (segments.length === 0) {
        setDraftWall([]);
        return;
      }
      await api.createWalls(scene.id, segments);
      setDraftWall([]);
      await loadVision();
    } catch (caught) {
      failed(caught, 'Muri non salvati');
    } finally {
      setSaving(false);
    }
  }, [scene, draftWall, wallKind, loadVision, failed]);

  const updateWall = useCallback(
    async (wall: Wall, patch: { kind?: WallKind; doorState?: Wall['doorState'] }) => {
      setSaving(true);
      try {
        // Lo stato della porta passa dalla rotta dedicata: è un gesto di gioco,
        // aperto anche ai giocatori che ci arrivano, non una modifica di mappa.
        if (patch.doorState && !patch.kind) await api.setDoorState(wall.id, patch.doorState);
        else await api.updateWall(wall.id, { ...patch, version: wall.version });
        await loadVision();
      } catch (caught) {
        failed(caught, 'Muro non aggiornato');
        await loadVision();
      } finally {
        setSaving(false);
      }
    },
    [loadVision, failed],
  );

  const deleteWall = useCallback(
    async (wall: Wall) => {
      setSaving(true);
      try {
        await api.deleteWall(wall.id);
        setSelectedWallId(null);
        await loadVision();
      } catch (caught) {
        failed(caught, 'Muro non eliminato');
      } finally {
        setSaving(false);
      }
    },
    [loadVision, failed],
  );

  const clearWalls = useCallback(async () => {
    if (!scene) return;
    if (!window.confirm('Cancellare tutti i muri di questa scena?')) return;
    setSaving(true);
    try {
      await api.clearWalls(scene.id);
      setSelectedWallId(null);
      await loadVision();
    } catch (caught) {
      failed(caught, 'Muri non cancellati');
    } finally {
      setSaving(false);
    }
  }, [scene, loadVision, failed]);

  const placeLight = useCallback(
    async (point: ImagePoint) => {
      if (!scene) return;
      setSaving(true);
      try {
        const created = await api.createLight(scene.id, {
          name: `Luce ${(vision?.lights?.length ?? 0) + 1}`,
          x: point.x,
          y: point.y,
        });
        setSelectedLightId(created.id);
        setTool('select');
        await loadVision();
      } catch (caught) {
        failed(caught, 'Luce non creata');
      } finally {
        setSaving(false);
      }
    },
    [scene, vision, loadVision, failed],
  );

  const updateLight = useCallback(
    async (light: LightSource, patch: Record<string, unknown>) => {
      setSaving(true);
      try {
        await api.updateLight(light.id, { ...patch, version: light.version });
        await loadVision();
      } catch (caught) {
        failed(caught, 'Luce non aggiornata');
        await loadVision();
      } finally {
        setSaving(false);
      }
    },
    [loadVision, failed],
  );

  const deleteLight = useCallback(
    async (light: LightSource) => {
      setSaving(true);
      try {
        await api.deleteLight(light.id);
        setSelectedLightId(null);
        await loadVision();
      } catch (caught) {
        failed(caught, 'Luce non eliminata');
      } finally {
        setSaving(false);
      }
    },
    [loadVision, failed],
  );

  const forgetExploration = useCallback(async () => {
    if (!scene) return;
    if (!window.confirm('Dimenticare quello che i giocatori hanno esplorato?')) return;
    setSaving(true);
    try {
      await api.forgetExploration(scene.id);
      await loadVision();
    } catch (caught) {
      failed(caught, 'Memoria non cancellata');
    } finally {
      setSaving(false);
    }
  }, [scene, loadVision, failed]);

  const selectedWall =
    vision?.walls?.find((wall) => wall.id === selectedWallId) ??
    vision?.visibleDoors.find((wall) => wall.id === selectedWallId) ??
    null;
  const selectedLight = vision?.lights?.find((light) => light.id === selectedLightId) ?? null;

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
        <span className="chip chip--confirmed">in ascolto</span>
        <span className="badge">
          {scene.map
            ? `${scene.map.name} · ${scene.map.widthPx}×${scene.map.heightPx} px`
            : 'senza mappa · superficie neutra'}
        </span>
      </div>

      {error && <p className="gate__error">{error}</p>}
      {notice && <p className="panel__hint">{notice}</p>}

      <div className="table">
        <section className="table__stage">
          <div className="table__toolbar">
            <span className="readout">Zoom {Math.round(viewport.zoom * 100)}%</span>
            {vision?.visionEnabled && (
              <span className="chip">
                {vision.perspective === 'game_master'
                  ? 'campo visivo attivo — tu vedi tutto'
                  : previewTokenId
                    ? 'anteprima dagli occhi di una pedina'
                    : 'vedi solo ciò che le tue pedine vedono'}
              </span>
            )}
          </div>
          {map && (
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
              onSizeChange={setCanvasSize}
              canMoveToken={(id) => scene.controllableTokenIds.includes(id)}
              picking={picking}
              onPickPoint={handlePickPoint}
              pickedPoints={pickedPoints}
              vision={vision}
              tool={tool}
              draftWall={draftWall}
              selectedWallId={selectedWallId}
              selectedLightId={selectedLightId}
              snapWalls={snapWalls}
              onWallPoint={addWallPoint}
              onSelectWall={setSelectedWallId}
              onSelectLight={setSelectedLightId}
              onPlaceLight={(point) => void placeLight(point)}
            />
          )}
          <p className="stage-note">
            {tool === 'wall'
              ? 'Clicca per posare i vertici del muro; poi salva la spezzata dal pannello.'
              : tool === 'light'
                ? 'Clicca dove vuoi mettere la sorgente di luce.'
                : 'Rotella per lo zoom, trascina per spostare la vista, doppio clic per inquadrare. Trascina una pedina tua per muoverla: la posizione la decide il server.'}
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

          {canEdit && vision && (
            <VisionPanel
              vision={vision}
              sceneVersion={scene.version}
              tool={tool}
              wallKind={wallKind}
              snapWalls={snapWalls}
              draftLength={draftWall.length}
              selectedWall={selectedWall}
              selectedLight={selectedLight}
              tokens={scene.tokens}
              previewTokenId={previewTokenId}
              busy={saving}
              onSettings={(patch) => void saveVisionSettings(patch)}
              onTool={(next) => {
                setTool(next);
                setDraftWall([]);
              }}
              onWallKind={setWallKind}
              onSnapWalls={setSnapWalls}
              onFinishDraft={() => void finishDraft()}
              onCancelDraft={() => setDraftWall([])}
              onUpdateWall={(wall, patch) => void updateWall(wall, patch)}
              onDeleteWall={(wall) => void deleteWall(wall)}
              onClearWalls={() => void clearWalls()}
              onUpdateLight={(light, patch) => void updateLight(light, patch)}
              onDeleteLight={(light) => void deleteLight(light)}
              onForgetExploration={() => void forgetExploration()}
              onPreview={(tokenId) => {
                setPreviewTokenId(tokenId);
                setTool('select');
              }}
            />
          )}

          {!canEdit && selectedWall && selectedWall.kind === 'door' && (
            <section className="panel">
              <h2>Porta</h2>
              <p className="panel__hint">
                {selectedWall.doorState === 'locked'
                  ? 'È bloccata: serve il Game Master.'
                  : selectedWall.doorState === 'open'
                    ? 'È aperta.'
                    : 'È chiusa.'}
              </p>
              {selectedWall.doorState !== 'locked' && (
                <button
                  type="button"
                  className="panel__action"
                  disabled={saving}
                  onClick={() =>
                    void updateWall(selectedWall, {
                      doorState: selectedWall.doorState === 'open' ? 'closed' : 'open',
                    })
                  }
                >
                  {selectedWall.doorState === 'open' ? 'Chiudi la porta' : 'Apri la porta'}
                </button>
              )}
            </section>
          )}

          {!canEdit && vision?.visionEnabled && vision.viewpoints.length === 0 && (
            <section className="panel">
              <h2>Al buio</h2>
              <p className="panel__hint">
                Non controlli nessuna pedina in questa scena, quindi non hai occhi qui. Chiedi al
                Game Master di assegnartene una.
              </p>
            </section>
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

            {canEdit && actors.length > 0 && (
              <label className="field">
                <span className="field__label">Personaggio della prossima pedina</span>
                <select value={chosenActorId} onChange={(e) => setChosenActorId(e.target.value)}>
                  <option value="">Nessuno — solo il Game Master la muove</option>
                  {actors.map((actor) => (
                    <option key={actor.id} value={actor.id}>
                      {actor.name}
                      {actor.ownerUserIds.length > 0 ? ' (assegnato)' : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}

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
