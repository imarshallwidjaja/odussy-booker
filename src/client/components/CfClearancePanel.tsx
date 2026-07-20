import { useCallback, useEffect, useRef, useState } from 'react'

interface CfClearanceStatus {
  state: 'valid' | 'expired' | 'never_acquired' | 'acquiring' | 'auto_failed'
  detail: string
}

export function CfClearancePanel({ sampleData, seatBlocked }: { sampleData: boolean; seatBlocked: boolean }) {
  const [status, setStatus] = useState<CfClearanceStatus | null>(null)
  const [acquiring, setAcquiring] = useState(false)
  const [error, setError] = useState('')
  const mountedRef = useRef(true)

  const fetchStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/cf-clearance')
      if (response.ok) {
        const data = (await response.json()) as CfClearanceStatus
        if (mountedRef.current) setStatus(data)
      }
    } catch {
      // API may not be available
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    fetchStatus()
    return () => { mountedRef.current = false }
  }, [fetchStatus])

  const handleAcquire = useCallback(async () => {
    setAcquiring(true)
    setError('')
    try {
      const response = await fetch('/api/cf-clearance/acquire', { method: 'POST' })
      const data = await response.json()
      if (mountedRef.current) {
        if (response.ok) {
          setStatus({ state: 'valid', detail: 'Cloudflare clearance acquired successfully.' })
          setAcquiring(false)
          return
        }
        if (response.status === 409) {
          setStatus({ state: 'acquiring', detail: 'Acquisition already in progress.' })
          return
        }
        setError(data.detail ?? 'Acquisition failed.')
        setStatus(data)
      }
    } catch {
      if (mountedRef.current) setError('Failed to acquire Cloudflare clearance.')
    } finally {
      if (mountedRef.current) setAcquiring(false)
    }
  }, [])

  useEffect(() => {
    if (status?.state === 'acquiring') {
      const interval = setInterval(fetchStatus, 3000)
      return () => clearInterval(interval)
    }
  }, [status?.state, fetchStatus])

  if (!status || sampleData) return null

  const acquiringInProgress = status.state === 'acquiring' || acquiring

  if (status.state === 'valid' && !seatBlocked) return null

  return (
    <div className={`notice ${acquiringInProgress ? '' : 'notice-blocked'}`} role="note">
      {acquiringInProgress
        ? (
          <>
            <strong>Acquiring Cloudflare clearance…</strong>
            {' '}Opening a headless browser to solve the challenge. This may take 10-30 seconds.
          </>
        )
        : (
          <>
            <strong>Cloudflare clearance needed.</strong>
            {' '}{status.detail}
            {' '}
            <button type="button" className="ghost-button" onClick={handleAcquire}>
              Acquire clearance
            </button>
          </>
        )}
      {error ? <p className="error-text">{error}</p> : null}
    </div>
  )
}
