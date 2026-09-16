import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_RULE_SET,
  formatDistance,
  snapImagePointToFootprint,
  type CellCoord,
  type GridConfiguration,
  type ImagePoint,
  type Viewport,
} from '@legendforge/core';
import { SceneCanvas } from './SceneCanvas';
import type { CanvasMap, CanvasToken } from './types';
import {
  createDemoMap,
  DEMO_MAP_CELL_PX,
  DEMO_MAP_HEIGHT,
  DEMO_MAP_OFFSET,
  DEMO_MAP_WIDTH,
} from './demoMap';
import { GridPanel } from '../panels/GridPanel';

const INITIAL_GRID: GridConfiguration = {
  cellSizePx: DEMO_MAP_CELL_PX,
  offsetX: DEMO_MAP_OFFSET.x,
  offsetY: DEMO_MAP_OFFSET.y,
  rotationDeg: 0,
  metersPerCell: DEFAULT_RULE_SET.grid.defaultMetersPerCell,
  snapEnabled: DEFAULT_RULE_SET.grid.defaultSnapEnabled,
};

const INITIAL_TOKENS: CanvasToken[] = [
  { id: 'a', name: 'Aria', x: 32 + 4.5 * 64, y: 18 + 4.5 * 64, sizeInCells: 1, color: '#4ade80' },
  { id: 'b', name: 'Bork', x: 32 + 6.5 * 64, y: 18 + 3.5 * 64, sizeInCells: 1, color: '#60a5fa' },
  { id: 'o', name: 'Ogre', x: 32 + 17 * 64, y: 18 + 12 * 64, sizeInCells: 2, color: '#f87171' },
];

/**
 * Anteprima del renderer.
 *
 * La mappa è generata dal browser e nulla viene salvato: serve a verificare
 * canvas, trasformazioni di vista e matematica della griglia mentre il flusso
 * con mappe reali e persistenza viene costruito.
 */
export function TablePreview() {
  const [map, setMap] = useState<CanvasMap | null>(null);
  const [grid, setGrid] = useState<GridConfiguration>(INITIAL_GRID);
  const [gridVisible, setGridVisible] = useState(true);
  const [tokens, setTokens] = useState<CanvasToken[]>(INITIAL_TOKENS);
  const [selectedTokenId, setSelectedTokenId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ panX: 0, panY: 0, zoom: 1 });
  const [hoverCell, setHoverCell] = useState<CellCoord | null>(null);

  useEffect(() => {
    const canvas = createDemoMap();
    setMap({ source: canvas, width: canvas.width, height: canvas.height });
  }, []);

  const updateGrid = useCallback((patch: Partial<GridConfiguration>) => {
    setGrid((current) => ({ ...current, ...patch }));
  }, []);

  const moveToken = useCallback((id: string, position: ImagePoint) => {
    setTokens((current) =>
      current.map((token) => (token.id === id ? { ...token, x: position.x, y: position.y } : token)),
    );
  }, []);

  const snapAll = useCallback(() => {
    setTokens((current) =>
      current.map((token) => {
        const snapped = snapImagePointToFootprint({ x: token.x, y: token.y }, grid, token.sizeInCells);
        return { ...token, x: snapped.x, y: snapped.y };
      }),
    );
  }, [grid]);

  const selected = useMemo(
    () => tokens.find((token) => token.id === selectedTokenId) ?? null,
    [tokens, selectedTokenId],
  );

  const tokenDistance = useMemo(() => {
    if (!selected) return null;
    const other = tokens.find((token) => token.id !== selected.id);
    if (!other) return null;
    const pixels = Math.hypot(other.x - selected.x, other.y - selected.y);
    const meters = (pixels / grid.cellSizePx) * grid.metersPerCell;
    return { name: other.name, ...formatDistance(meters, grid) };
  }, [selected, tokens, grid]);

  return (
    <div className="table">
      <section className="table__stage">
        <div className="table__toolbar">
          <span className="readout">
            Zoom {Math.round(viewport.zoom * 100)}%
            {hoverCell ? ` · casella ${hoverCell.col}, ${hoverCell.row}` : ''}
          </span>
        </div>
        <SceneCanvas
          map={map}
          grid={grid}
          gridVisible={gridVisible}
          tokens={tokens}
          selectedTokenId={selectedTokenId}
          onSelectToken={setSelectedTokenId}
          onMoveToken={moveToken}
          onViewportChange={setViewport}
          onHoverCell={setHoverCell}
        />
        <p className="stage-note">
          Rotella per lo zoom, trascina per spostare la vista, doppio clic per inquadrare. Trascina
          una pedina per muoverla.
        </p>
      </section>

      <aside className="table__side">
        <section className="panel panel--notice">
          <h2>Anteprima tecnica</h2>
          <p>
            Questa mappa è generata dal browser e <strong>nulla viene salvato</strong>: serve a
            verificare il renderer e la matematica della griglia. Il caricamento di mappe reali, il
            rilevamento automatico e la persistenza sono il prossimo passo.
          </p>
        </section>

        <GridPanel
          grid={grid}
          gridVisible={gridVisible}
          onChange={updateGrid}
          onToggleVisible={setGridVisible}
          onReset={() => setGrid(INITIAL_GRID)}
        />

        <section className="panel">
          <header className="panel__header">
            <h2>Pedine</h2>
            <button type="button" className="panel__action" onClick={snapAll}>
              Aggancia tutte
            </button>
          </header>
          <ul className="token-list">
            {tokens.map((token) => (
              <li key={token.id}>
                <button
                  type="button"
                  className={token.id === selectedTokenId ? 'token token--active' : 'token'}
                  onClick={() => setSelectedTokenId(token.id)}
                >
                  <span className="token__dot" style={{ background: token.color }} />
                  <span className="token__name">{token.name}</span>
                  <span className="token__size">
                    {token.sizeInCells}×{token.sizeInCells}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {selected && (
            <dl className="kv kv--compact">
              <dt>Posizione</dt>
              <dd className="kv__value">
                {Math.round(selected.x)}, {Math.round(selected.y)} px
              </dd>
              {tokenDistance && (
                <>
                  <dt>Distanza da {tokenDistance.name}</dt>
                  <dd className="kv__value">{tokenDistance.label}</dd>
                </>
              )}
            </dl>
          )}
        </section>

        <section className="panel panel--muted">
          <h2>Mappa di prova</h2>
          <p>
            {DEMO_MAP_WIDTH} × {DEMO_MAP_HEIGHT} px, reticolo con passo {DEMO_MAP_CELL_PX} px e
            offset {DEMO_MAP_OFFSET.x}, {DEMO_MAP_OFFSET.y}. Sono i valori che il rilevamento
            automatico dovrà ritrovare da solo.
          </p>
        </section>
      </aside>
    </div>
  );
}
