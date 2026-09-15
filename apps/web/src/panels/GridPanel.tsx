import type { GridConfiguration } from '@legendforge/core';
import { cellsToMeters, metersToCells } from '@legendforge/core';

interface GridPanelProps {
  grid: GridConfiguration;
  gridVisible: boolean;
  onChange: (patch: Partial<GridConfiguration>) => void;
  onToggleVisible: (visible: boolean) => void;
  onReset: () => void;
}

export function GridPanel({ grid, gridVisible, onChange, onToggleVisible, onReset }: GridPanelProps) {
  return (
    <section className="panel">
      <header className="panel__header">
        <h2>Griglia</h2>
        <button type="button" className="panel__action" onClick={onReset}>
          Ripristina
        </button>
      </header>

      <label className="toggle">
        <input
          type="checkbox"
          checked={gridVisible}
          onChange={(event) => onToggleVisible(event.target.checked)}
        />
        <span>Mostra la griglia</span>
      </label>

      <Slider
        label="Lato della casella"
        unit="px"
        min={16}
        max={200}
        step={0.5}
        value={grid.cellSizePx}
        onChange={(cellSizePx) => onChange({ cellSizePx })}
      />
      <Slider
        label="Offset orizzontale"
        unit="px"
        min={-200}
        max={200}
        step={0.5}
        value={grid.offsetX}
        onChange={(offsetX) => onChange({ offsetX })}
      />
      <Slider
        label="Offset verticale"
        unit="px"
        min={-200}
        max={200}
        step={0.5}
        value={grid.offsetY}
        onChange={(offsetY) => onChange({ offsetY })}
      />
      <Slider
        label="Rotazione"
        unit="°"
        min={-5}
        max={5}
        step={0.05}
        value={grid.rotationDeg}
        onChange={(rotationDeg) => onChange({ rotationDeg })}
      />
      <Slider
        label="Metri per casella"
        unit="m"
        min={0.5}
        max={6}
        step={0.1}
        value={grid.metersPerCell}
        onChange={(metersPerCell) => onChange({ metersPerCell })}
      />

      <label className="toggle">
        <input
          type="checkbox"
          checked={grid.snapEnabled}
          onChange={(event) => onChange({ snapEnabled: event.target.checked })}
        />
        <span>Aggancia le pedine alla griglia</span>
      </label>

      <dl className="kv kv--compact">
        <dt>Scurovisione</dt>
        <dd className="kv__value">
          18 m = {round(metersToCells(18, grid))} caselle · 36 m = {round(metersToCells(36, grid))}{' '}
          caselle
        </dd>
        <dt>Una casella</dt>
        <dd className="kv__value">{round(cellsToMeters(1, grid))} m</dd>
      </dl>
    </section>
  );
}

function round(value: number): number {
  return Number(value.toFixed(1));
}

interface SliderProps {
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
}

function Slider({ label, unit, min, max, step, value, onChange }: SliderProps) {
  return (
    <label className="slider">
      <span className="slider__label">
        {label}
        <output>
          {Number(value.toFixed(2))} {unit}
        </output>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}
