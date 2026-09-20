import { useEffect, useState } from 'react'
import type { EvalReport, EvalTotals } from '@shared/types'
import { EVAL_MIN_WORDS, EVAL_WEEKS_SHOWN } from '@shared/constants'

const perHundred = (rate: number | null): string => (rate === null ? '—' : rate.toFixed(1))

function weekLabel(start: string): string {
  const d = new Date(`${start}T00:00:00`)
  return Number.isNaN(d.getTime()) ? start : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function Side({ label, totals }: { label: string; totals: EvalTotals }): React.JSX.Element {
  return (
    <div className="eval-side">
      <div className="eval-side-label">{label}</div>
      <div className="eval-side-rate">{perHundred(totals.rate)}</div>
      <div className="eval-side-meta">
        fixes per 100 words · {totals.words} words
      </div>
    </div>
  )
}

/**
 * "Is learning helping?" (Learned tab): how many words the user has had to fix per 100 dictated,
 * week by week, and — once there is enough of each — with learning on versus off. It only counts
 * fixes made in History → Edit, and says so.
 */
export function EvalCard(): React.JSX.Element {
  const [report, setReport] = useState<EvalReport | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)

  useEffect(() => {
    let alive = true
    const refresh = (): void => {
      window.api
        .getEval()
        .then((r) => {
          if (alive) setReport(r)
        })
        .catch(() => {
          /* optional card — keep whatever is shown */
        })
    }
    refresh()
    // Both a new dictation and a fix arrive as a History change.
    const off = window.api.onHistoryChanged(refresh)
    return () => {
      alive = false
      off()
    }
  }, [])

  useEffect(() => {
    if (!confirmReset) return
    const t = setTimeout(() => setConfirmReset(false), 4000)
    return () => clearTimeout(t)
  }, [confirmReset])

  function reset(): void {
    if (!confirmReset) {
      setConfirmReset(true)
      return
    }
    setConfirmReset(false)
    void window.api.resetEval().then(setReport)
  }

  if (!report) return <></>

  const { all, on, off, weeks } = report
  const peak = Math.max(0, ...weeks.map((w) => w.rate ?? 0))
  const canCompare = on.words >= EVAL_MIN_WORDS && off.words >= EVAL_MIN_WORDS

  return (
    <>
      <div className="learned-head">
        <h3 className="learned-sub">Is learning helping?</h3>
        {all.dictations > 0 && (
          <button className={`danger${confirmReset ? ' armed' : ''}`} onClick={reset}>
            {confirmReset ? 'Click again to reset' : 'Reset statistics'}
          </button>
        )}
      </div>

      {all.dictations === 0 ? (
        <p className="learned-empty">
          Nothing measured yet. Dictate for a while and fix what is wrong in History — Wispra counts how often
          you need to.
        </p>
      ) : (
        <>
          <div className="eval-headline">
            <span className="eval-rate">{perHundred(all.rate)}</span>
            <span className="eval-rate-unit">
              word fixes per 100 dictated words
              <br />
              <span className="eval-rate-meta">
                last {EVAL_WEEKS_SHOWN} weeks · {all.dictations} dictations · {all.edited} of them fixed
              </span>
            </span>
          </div>

          <div className="eval-bars" role="img" aria-label="Word fixes per 100 words, by week">
            {weeks.map((w) => {
              const height = w.rate === null || peak === 0 ? 0 : Math.max(4, Math.round((w.rate / peak) * 100))
              const title =
                w.dictations === 0
                  ? `Week of ${weekLabel(w.start)}: no dictations`
                  : `Week of ${weekLabel(w.start)}: ${perHundred(w.rate)} fixes per 100 words · ${w.dictations} dictations, ${w.words} words`
              return (
                <div key={w.start} className="eval-col" title={title}>
                  <div className="eval-track">
                    <div className={`eval-bar${w.dictations === 0 ? ' is-empty' : ''}`} style={{ height: `${height}%` }} />
                  </div>
                  <div className="eval-col-value">{w.dictations === 0 ? '' : perHundred(w.rate)}</div>
                  <div className="eval-col-label">{weekLabel(w.start)}</div>
                </div>
              )
            })}
          </div>

          {canCompare ? (
            <div className="eval-compare">
              <Side label="Learning on" totals={on} />
              <Side label="Learning off" totals={off} />
            </div>
          ) : (
            <p className="hint learned-note">
              The learning on / off comparison appears once you have dictated {EVAL_MIN_WORDS}+ words in each
              state (so far: {on.words} on, {off.words} off).
            </p>
          )}
        </>
      )}

      <p className="hint learned-note">
        Counts only the fixes you make yourself in History → Edit, and only changed words (punctuation-only
        fixes are not counted). A dictation you never corrected counts as fine, so treat this as a rough guide.
        Only counts are stored, never your text.
      </p>
    </>
  )
}
