import { useEffect, useState } from 'react'

interface CfClearanceStatus {
  state: 'idle' | 'acquiring' | 'succeeded' | 'failed'
  detail: string
}

export function CfClearancePanel({ sampleData, seatBlocked }: { sampleData: boolean; seatBlocked: boolean }) {
  const [status, setStatus] = useState<CfClearanceStatus | null>(null)

  useEffect(() => {
    if (sampleData || !seatBlocked) return
    let active = true
    const fetchStatus = async () => {
      try {
        const response = await fetch('/api/cf-clearance')
        if (!response.ok) return
        const data = (await response.json()) as CfClearanceStatus
        if (active) setStatus(data)
      } catch {
        // API may not be available
      }
    }
    void fetchStatus()
    const interval = setInterval(fetchStatus, 3000)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [sampleData, seatBlocked])

  if (!status || sampleData) return null

  if (status.state === 'succeeded' && !seatBlocked) return null

  return (
    <div className={`notice ${status.state === 'acquiring' ? '' : 'notice-blocked'}`} role="note">
      {status.state === 'acquiring'
        ? (
          <>
            <strong>Fetching the protected film bootstrap…</strong>
            {' '}Opening a headless browser. This may take up to a minute.
          </>
        )
        : status.state === 'succeeded'
          ? (
            <>
              <strong>Protected fallback last succeeded.</strong>
              {' '}{status.detail} Waiting for the next exact-seat preview attempt.
            </>
          )
          : status.state === 'failed'
            ? (
              <>
                <strong>Protected preview fallback failed.</strong>
                {' '}{status.detail} It will retry on the next scheduled preview attempt.
              </>
            )
            : (
              <>
                <strong>Protected preview fallback is waiting.</strong>
                {' '}It will run on the next scheduled exact-seat preview attempt.
              </>
            )}
    </div>
  )
}
