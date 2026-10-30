import type { CSSProperties, ReactNode } from 'react'

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  format?: (value: number) => string
  disabled?: boolean
  onChange(value: number): void
  onGesture?(phase: 'start' | 'end'): void
}

export function Slider({ label, value, min, max, step, format, disabled, onChange, onGesture }: SliderProps) {
  const percent = max > min ? ((value - min) / (max - min)) * 100 : 0
  return (
    <label className={disabled ? 'field disabled' : 'field'}>
      <span className="field-head">
        <span>{label}</span>
        <output>{format ? format(value) : value}</output>
      </span>
      <input
        type="range"
        className="slider"
        style={{ '--v': `${percent}%` } as CSSProperties}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerDown={() => onGesture?.('start')}
        onPointerUp={() => onGesture?.('end')}
        onPointerCancel={() => onGesture?.('end')}
      />
    </label>
  )
}

export function Toggle({ label, on, disabled, onChange, badge }: {
  label: string
  on: boolean
  disabled?: boolean
  onChange(on: boolean): void
  badge?: ReactNode
}) {
  return (
    <div className={disabled ? 'row disabled' : 'row'}>
      <span className="row-label">{label} {badge}</span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        disabled={disabled}
        className={on ? 'toggle on' : 'toggle'}
        onClick={() => onChange(!on)}
      />
    </div>
  )
}

export function Seg<T extends string | number>({ value, options, onChange, label }: {
  value: T
  options: { value: T; label: ReactNode; disabled?: boolean }[]
  onChange(value: T): void
  label?: string
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          className={o.value === value ? 'on' : undefined}
          aria-pressed={o.value === value}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
