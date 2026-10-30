import { useState, type FormEvent } from 'react'
import { MAX_DEVICES } from '../../shared/config'
import type { LicenseFailure } from '../../shared/ipc'
import { announcePlan, usePlan } from './usePlan'
import './upgrade.css'

export const FAILURE_MESSAGES: Record<LicenseFailure, string> = {
  invalid_key: "That license key isn't valid, so check it against your Whop receipt.",
  inactive: 'This license is no longer active, and your orders on Whop show why.',
  wrong_product: 'That key is for a different product, not Dolly Pro.',
  device_limit: `This key is already on ${MAX_DEVICES} devices, so reset it from your orders on Whop to free them, then enter it here again.`,
  network: "Couldn't reach the license server. Try again when you're online.",
  rate_limited: 'There have been too many activation attempts, so wait a minute and try again.',
  device_id: "Dolly couldn't read this computer's ID, so it can't activate here until that's fixed.",
  save: "Your key is fine, but Dolly couldn't save the license on this computer, so check for free disk space and try again."
}

interface Props {
  onActivated?: () => void
}

export function LicenseSettings({ onActivated }: Props) {
  const plan = usePlan()
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<LicenseFailure | null>(null)

  async function activate(event: FormEvent) {
    event.preventDefault()
    const trimmed = key.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setFailure(null)
    try {
      const result = await window.dolly.license.activate(trimmed)
      if (result.ok) {
        setKey('')
        announcePlan('pro')
        onActivated?.()
      } else {
        setFailure(result.reason)
      }
    } catch {
      setFailure('network')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    await window.dolly.license.deactivateLocal()
    announcePlan('free')
  }

  if (plan === 'pro') {
    return (
      <section className="dolly-license">
        <p className="dolly-license-on">Dolly Pro is on for this device.</p>
        <p className="dolly-license-note">Removing it here doesn't free a device. Reset your key from your orders on Whop for that.</p>
        <button type="button" className="dolly-ghost" onClick={remove}>
          Remove from this device
        </button>
      </section>
    )
  }

  return (
    <form className="dolly-license" onSubmit={activate}>
      <label className="dolly-field">
        <span>Enter license key</span>
        <input
          value={key}
          onChange={(event) => setKey(event.target.value)}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          disabled={busy}
          aria-invalid={failure !== null}
          aria-describedby={failure ? 'dolly-license-error' : undefined}
        />
      </label>
      {failure && (
        <p id="dolly-license-error" className="dolly-license-error" role="alert">
          {FAILURE_MESSAGES[failure]}
        </p>
      )}
      <button type="submit" className="dolly-primary" disabled={busy || !key.trim()}>
        {busy ? 'Checking…' : 'Activate'}
      </button>
    </form>
  )
}
