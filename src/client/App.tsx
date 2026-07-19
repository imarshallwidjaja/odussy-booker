import { useEffect, useRef, useState } from 'react'

import type { AppStatus } from '../domain/types.js'
import type { SessionSnapshot } from '../domain/types.js'
import { AlertDialog } from './components/AlertDialog.js'
import { FiltersPanel } from './components/FiltersPanel.js'
import { SessionCard } from './components/SessionCard.js'
import { SessionDetail } from './components/SessionDetail.js'
import {
  DEFAULT_FILTERS,
  applyFilters,
  buildSearch,
  parseFilters,
  parseSelectedSession,
  relativeFreshness,
} from './model.js'

type StatusResponse = Omit<AppStatus, 'sessionDiscovery'> & {
  degraded: boolean
  sessionDiscovery: AppStatus['sessionDiscovery'] & {
    freshness: {
      state: 'fresh' | 'stale' | 'missing'
      lastUpdate: string | null
      ageMs: number | null
      staleAfterMs: number
    }
  }
  note: string
}

const MOBILE_DETAIL_QUERY = '(max-width: 900px)'

export function App() {
  const [sessions, setSessions] = useState<SessionSnapshot[]>([])
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [emailConfigured, setEmailConfigured] = useState(false)
  const [timezone, setTimezone] = useState('Australia/Melbourne')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [filters, setFilters] = useState(() => parseFilters(location.search))
  const [selectedId, setSelectedId] = useState<string | null>(() => parseSelectedSession(location.search))
  const [detailOpen, setDetailOpen] = useState(false)
  const [alertOpen, setAlertOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const navigatedRef = useRef(false)
  const detailDialogRef = useRef<HTMLDialogElement>(null)
  const alertTriggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      try {
        const [sessionsResponse, statusResponse, healthResponse] = await Promise.all([
          fetch('/api/sessions'),
          fetch('/api/status'),
          fetch('/health'),
        ])
        if (!sessionsResponse.ok || !statusResponse.ok || !healthResponse.ok) {
          throw new Error('Dashboard data is unavailable right now.')
        }
        const [sessionData, statusData, healthData] = await Promise.all([
          sessionsResponse.json(),
          statusResponse.json(),
          healthResponse.json(),
        ])
        if (cancelled) return
        setSessions(sessionData.sessions ?? [])
        setTimezone(sessionData.timezone ?? 'Australia/Melbourne')
        setStatus(statusData)
        setEmailConfigured(Boolean(healthData.email?.configured))
        setLoadError('')
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : 'Dashboard data is unavailable right now.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    const interval = setInterval(load, 120_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    function onPopstate(): void {
      navigatedRef.current = true
      setFilters(parseFilters(location.search))
      setSelectedId(parseSelectedSession(location.search))
    }
    addEventListener('popstate', onPopstate)
    return () => removeEventListener('popstate', onPopstate)
  }, [])

  useEffect(() => {
    const search = buildSearch(filters, selectedId)
    if (navigatedRef.current) {
      navigatedRef.current = false
      if (location.search !== search) history.replaceState(null, '', `${location.pathname}${search}`)
      return
    }
    if (location.search !== search) history.pushState(null, '', `${location.pathname}${search}`)
  }, [filters, selectedId])

  useEffect(() => {
    if (loading || loadError || !selectedId) return
    const selectionIsVisible = applyFilters(sessions, filters).some(({ id }) => id === selectedId)
    if (!selectionIsVisible) {
      navigatedRef.current = true
      setSelectedId(null)
    }
  }, [filters, loadError, loading, selectedId, sessions])

  useEffect(() => {
    const dialog = detailDialogRef.current
    if (!dialog) return
    if (detailOpen) {
      if (!dialog.open) dialog.showModal()
    } else if (dialog.open) {
      dialog.close()
    }
  }, [detailOpen])

  const filtered = applyFilters(sessions, filters)
  const explicitSelected = filtered.find((session) => session.id === selectedId) ?? null
  const detailSession = explicitSelected ?? filtered[0] ?? null
  const freshnessText = relativeFreshness(now, status?.sessionDiscovery.freshness.lastUpdate ?? null)
  const listingFreshnessText = status?.sampleData
    ? 'Sample fixture'
    : freshnessText.startsWith('Updated')
      ? `Sessions ${freshnessText.toLowerCase()}`
      : freshnessText
  const discoveryState = status?.sessionDiscovery.state ?? 'blocked'
  const freshnessState = status?.sessionDiscovery.freshness.state ?? 'missing'
  const uncapturedSessions = status?.seatCapture.uncapturedSessionCount ?? 0
  const seatCaptureState = status?.seatCapture.state ?? 'pending'
  const lumosBootstrapState = status?.lumosBootstrap.state ?? 'pending'

  function selectSession(session: SessionSnapshot): void {
    setSelectedId(session.id)
    if (window.matchMedia(MOBILE_DETAIL_QUERY).matches) setDetailOpen(true)
  }

  return (
    <>
      <a className="skip-link" href="#sessions">Skip to sessions</a>
      <header className="site-header">
        <a className="wordmark" href="/">HOUSE&nbsp;<span>LIGHTS</span></a>
        <button ref={alertTriggerRef} type="button" className="outline-button" onClick={() => setAlertOpen(true)}>
          Create alert
        </button>
      </header>

      <main id="sessions" tabIndex={-1}>
        <section className="data-strip" aria-label="Data status">
          <div className="badges">
            {status?.sampleData ? <span className="badge badge-sample">SAMPLE DATA</span> : null}
            {!status?.sampleData && discoveryState === 'blocked'
              ? <span className="badge badge-blocked">LISTING PENDING</span>
              : null}
            {!status?.sampleData && discoveryState === 'error'
              ? <span className="badge badge-blocked">LISTING ERROR</span>
              : null}
            {!status?.sampleData && freshnessState === 'stale'
              ? <span className="badge badge-blocked">STALE</span>
              : null}
            {!status?.sampleData && freshnessState === 'missing' && !loading
              ? <span className="badge badge-dim">NO SESSION DATA</span>
              : null}
            {!status?.sampleData && discoveryState === 'ok' && freshnessState === 'fresh'
              ? <span className="badge badge-live">LIVE SESSIONS</span>
              : null}
            {!status?.sampleData && seatCaptureState === 'fresh'
              ? <span className="badge badge-live">J-M FRESH</span>
              : null}
            {!status?.sampleData && seatCaptureState === 'partial'
              ? <span className="badge badge-blocked">J-M PARTIAL</span>
              : null}
            {!status?.sampleData && (seatCaptureState === 'blocked' || lumosBootstrapState === 'blocked')
              ? <span className="badge badge-blocked">J-M BLOCKED</span>
              : null}
            {!status?.sampleData && seatCaptureState === 'error'
              ? <span className="badge badge-blocked">J-M ERROR</span>
              : null}
            {!status?.sampleData && seatCaptureState === 'pending' && uncapturedSessions > 0
              ? <span className="badge badge-dim">J-M PENDING</span>
              : null}
          </div>
          <p className="data-meta">{listingFreshnessText} · All times {timezone}</p>
        </section>

        {status?.sampleData
          ? (
            <div className="notice notice-sample" role="note">
              <strong>SAMPLE DATA.</strong> Local review fixture only — nothing shown is live cinema availability.
            </div>
          )
          : null}
        {!status?.sampleData && discoveryState !== 'ok'
          ? (
            <div className="notice notice-blocked" role="note">
              <strong>Live session discovery is unavailable.</strong> {status?.sessionDiscovery.detail}{' '}
              The dashboard shows last-known sessions when they exist. Always confirm on the official site.
            </div>
          )
          : null}
        {!status?.sampleData && discoveryState === 'ok' && seatCaptureState === 'blocked'
          ? (
            <div className="notice notice-blocked" role="note">
              <strong>Automatic exact J-M preview is blocked.</strong>{' '}
              {status?.seatCapture.detail} Last-known exact seats remain visible where available.
            </div>
          )
          : null}
        {!status?.sampleData && discoveryState === 'ok' && seatCaptureState === 'error'
          ? (
            <div className="notice notice-blocked" role="note">
              <strong>Automatic exact J-M preview failed.</strong>{' '}
              {status?.seatCapture.detail} Last-known exact seats remain visible where available.
            </div>
          )
          : null}
        {!status?.sampleData && discoveryState === 'ok' && seatCaptureState === 'partial'
          ? (
            <div className="notice" role="note">
              <strong>Some exact J-M previews are last-known.</strong>{' '}
              {status?.seatCapture.detail}
            </div>
          )
          : null}
        {!status?.sampleData && discoveryState === 'ok' && seatCaptureState === 'pending' && uncapturedSessions > 0
          ? (
            <div className="notice" role="note">
              <strong>Session times and whole-session status are live.</strong>{' '}
              Exact J-M preview is pending for {uncapturedSessions} session{uncapturedSessions === 1 ? '' : 's'}.
            </div>
          )
          : null}
        {loadError
          ? <div className="notice notice-error" role="alert">Could not load the dashboard: {loadError}</div>
          : null}

        <section className="intro">
          <h1>Every session. Rows J-M when captured.</h1>
          {sessions.length > 0
            ? (
              <p className="intro-film">
                Tracking <strong>The Odyssey</strong> as separate 4K Laser and IMAX 70mm Film inventories.
              </p>
            )
            : null}
        </section>

        <FiltersPanel
          filters={filters}
          onChange={setFilters}
          onReset={() => setFilters(DEFAULT_FILTERS)}
        />

        <div className="results-bar">
          <h2>Sessions</h2>
          <p aria-live="polite">
            {loading ? 'Loading…' : `${filtered.length} of ${sessions.length} matching`}
          </p>
        </div>

        <section className="dashboard">
          <div className="session-list">
            {loading
              ? (
                <div className="loading-state" aria-hidden="true">
                  <span /><span /><span />
                </div>
              )
              : null}
            {!loading && !loadError && sessions.length === 0
              ? (
                <div className="empty-state">
                  <h3>No sessions captured yet</h3>
                  <p>
                    No public listing sessions or authorized seat observations have been captured yet.
                    Live session times and queue-free exact Rows J-M previews appear automatically when upstream permits;
                    signed manual ingest remains available.
                  </p>
                </div>
              )
              : null}
            {!loading && sessions.length > 0 && filtered.length === 0
              ? (
                <div className="empty-state">
                  <h3>No sessions match these filters</h3>
                  <p>Widen the day or time selection, or reset to see every captured session.</p>
                  <button type="button" className="ghost-button" onClick={() => setFilters(DEFAULT_FILTERS)}>
                    Reset filters
                  </button>
                </div>
              )
              : null}
            {filtered.map((session) => (
              <SessionCard
                key={session.id}
                 session={session}
                 freshnessText={listingFreshnessText}
                 sampleData={Boolean(status?.sampleData)}
                 selected={explicitSelected?.id === session.id}
                onSelect={() => selectSession(session)}
              />
            ))}
          </div>
          <aside className="desktop-detail" aria-label="Selected session seat map">
            {detailSession
              ? <SessionDetail session={detailSession} />
              : (
                <div className="detail-empty">
                  <p>Select a session to inspect Rows J-M.</p>
                </div>
              )}
          </aside>
        </section>
      </main>

      <dialog
        ref={detailDialogRef}
        className="sheet-dialog"
        onClose={() => setDetailOpen(false)}
        aria-label="Session seat map"
      >
        {detailOpen && explicitSelected
          ? <SessionDetail session={explicitSelected} onClose={() => setDetailOpen(false)} />
          : null}
      </dialog>

      <AlertDialog
        open={alertOpen}
        onClose={() => setAlertOpen(false)}
        filters={filters}
        configuredFilmIds={status?.filmIds ?? []}
        filmConfigurationLoading={loading}
        emailConfigured={emailConfigured}
        returnFocusRef={alertTriggerRef}
      />

      <footer>
        <p>
          Unofficial fan tool. Not affiliated with IMAX Melbourne or Museums Victoria.
          Seat data may lag behind the box office — always confirm availability and session
          details on the official site before booking.
        </p>
        <p className="footer-note">
          Alerts and observed sessions are ephemeral and reset whenever this service restarts or redeploys.
        </p>
      </footer>
    </>
  )
}
