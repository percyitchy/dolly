import { useEffect, useRef, useState } from 'react'
import { PRO_ITEMS, upgradeTitle, type Feature } from '../../shared/entitlements'
import { LicenseSettings } from './LicenseSettings'
import './upgrade.css'

interface Props {
  feature?: Feature
  onClose: () => void
}

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled)'

export function UpgradeSheet({ feature, onClose }: Props) {
  const [enteringKey, setEnteringKey] = useState(false)
  const card = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    return () => opener?.focus?.()
  }, [])

  useEffect(() => {
    card.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus()
  }, [enteringKey])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose()
        return
      }
      if (event.key !== 'Tab' || !card.current) return
      const items = [...card.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
      const first = items[0]
      const last = items[items.length - 1]
      const edge = event.shiftKey ? first : last
      if (card.current.contains(document.activeElement) && document.activeElement !== edge) return
      event.preventDefault()
      const wrapTo = event.shiftKey ? last : first
      wrapTo?.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <aside className="dolly-sheet" role="dialog" aria-modal="true" aria-label="Get Dolly Pro">
      <button type="button" className="dolly-sheet-scrim" aria-label="Close" tabIndex={-1} onClick={onClose} />
      <div className="dolly-sheet-card" ref={card}>
        <h2>{feature ? upgradeTitle(feature) : 'Get Dolly Pro'}</h2>
        <p>One payment, no subscription. Works on up to 3 devices.</p>
        <ul>
          {PRO_ITEMS.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        {enteringKey ? (
          <LicenseSettings onActivated={onClose} />
        ) : (
          <button type="button" className="dolly-primary" onClick={() => window.dolly.license.openStore()}>
            Get Pro for $9.99
          </button>
        )}
        <div className="dolly-sheet-sub">
          <button type="button" onClick={() => setEnteringKey(!enteringKey)}>
            {enteringKey ? 'Get a license key' : 'I have a license key'}
          </button>
          <button type="button" onClick={onClose}>
            Not now
          </button>
        </div>
      </div>
    </aside>
  )
}
