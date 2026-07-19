import { weekdays, type Weekday } from '../../domain/types.js'
import {
  DAY_SHORT,
  PRESENTATION_LABELS,
  TIME_PRESET_LABELS,
  WEEKDAYS,
  WEEKENDS,
  summarizeFilters,
  type DashboardFilters,
  type NamedTimePreset,
  type PresentationFilter,
  type SortOrder,
} from '../model.js'

interface FiltersPanelProps {
  filters: DashboardFilters
  onChange: (next: DashboardFilters) => void
  onReset: () => void
}

const PRESENTATIONS: PresentationFilter[] = ['all', 'laser', '70mm']
const TIME_PRESETS: Array<NamedTimePreset | 'all'> = ['all', 'morning', 'afternoon', 'afterwork', 'late']
const SORTS: Array<{ value: SortOrder; label: string }> = [
  { value: 'soonest', label: 'Soonest' },
  { value: 'seats', label: 'Most seats' },
]

export function FiltersPanel({ filters, onChange, onReset }: FiltersPanelProps) {
  const summary = summarizeFilters(filters)
  const customTime = filters.time.preset === 'custom' ? filters.time : null

  function toggleDay(day: Weekday): void {
    onChange({
      ...filters,
      days: filters.days.includes(day)
        ? filters.days.filter((candidate) => candidate !== day)
        : [...filters.days, day],
    })
  }

  function setTimePreset(preset: NamedTimePreset | 'all' | 'custom'): void {
    if (preset === 'custom') {
      onChange({ ...filters, time: { preset: 'custom', from: '17:00', to: '21:00' } })
    } else {
      onChange({ ...filters, time: { preset } })
    }
  }

  return (
    <details className="filters">
      <summary className="filters-summary">
        <span>Filters</span>
        {summary.length > 0 ? <span className="filters-count">{summary.length} active</span> : null}
      </summary>
      <div className="filters-body">
        <fieldset className="filter-group">
          <legend>Presentation</legend>
          <div className="chips" role="radiogroup" aria-label="Presentation">
            {PRESENTATIONS.map((value) => (
              <label className="chip" key={value}>
                <input
                  type="radio"
                  name="presentation"
                  value={value}
                  checked={filters.presentation === value}
                  onChange={() => onChange({ ...filters, presentation: value })}
                />
                <span>{PRESENTATION_LABELS[value]}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="filter-group filter-days">
          <legend>Days</legend>
          <div className="chips">
            {weekdays.map((day) => (
              <label className="chip chip-day" key={day}>
                <input
                  type="checkbox"
                  checked={filters.days.includes(day)}
                  onChange={() => toggleDay(day)}
                  aria-label={day}
                />
                <span aria-hidden="true">{DAY_SHORT[day]}</span>
              </label>
            ))}
          </div>
          <div className="day-presets">
            <button type="button" className="text-button" onClick={() => onChange({ ...filters, days: [...WEEKDAYS] })}>
              Weekdays
            </button>
            <button type="button" className="text-button" onClick={() => onChange({ ...filters, days: [...WEEKENDS] })}>
              Weekends
            </button>
            <button type="button" className="text-button" onClick={() => onChange({ ...filters, days: [...weekdays] })}>
              Every day
            </button>
          </div>
        </fieldset>

        <fieldset className="filter-group">
          <legend>Session time</legend>
          <div className="chips" role="radiogroup" aria-label="Session time">
            {TIME_PRESETS.map((preset) => (
              <label className="chip" key={preset}>
                <input
                  type="radio"
                  name="time-preset"
                  value={preset}
                  checked={filters.time.preset === preset}
                  onChange={() => setTimePreset(preset)}
                />
                <span>{preset === 'all' ? 'All day' : TIME_PRESET_LABELS[preset]}</span>
              </label>
            ))}
            <label className="chip">
              <input
                type="radio"
                name="time-preset"
                value="custom"
                checked={filters.time.preset === 'custom'}
                onChange={() => setTimePreset('custom')}
              />
              <span>Custom</span>
            </label>
          </div>
          {customTime
            ? (
              <div className="custom-time">
                <label>
                  From
                  <input
                    type="time"
                    value={customTime.from}
                    onChange={(event) => onChange({
                      ...filters,
                      time: { preset: 'custom', from: event.target.value, to: customTime.to },
                    })}
                  />
                </label>
                <label>
                  To
                  <input
                    type="time"
                    value={customTime.to}
                    onChange={(event) => onChange({
                      ...filters,
                      time: { preset: 'custom', from: customTime.from, to: event.target.value },
                    })}
                  />
                </label>
              </div>
            )
            : null}
        </fieldset>

        <fieldset className="filter-group">
          <legend>Sort</legend>
          <div className="chips" role="radiogroup" aria-label="Sort order">
            {SORTS.map(({ value, label }) => (
              <label className="chip" key={value}>
                <input
                  type="radio"
                  name="sort"
                  value={value}
                  checked={filters.sort === value}
                  onChange={() => onChange({ ...filters, sort: value })}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="filter-foot">
          {summary.length > 0
            ? (
              <>
                <ul className="active-filters" aria-label="Active filters">
                  {summary.map((item) => <li key={item}>{item}</li>)}
                </ul>
                <button type="button" className="text-button" onClick={onReset}>Reset filters</button>
              </>
            )
            : <p className="filter-hint">Showing every captured session. Narrow by presentation, day, or time.</p>}
        </div>
      </div>
    </details>
  )
}
