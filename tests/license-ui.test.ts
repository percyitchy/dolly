import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { can, FEATURE_LABELS, lockedInOutput, PRO_ITEMS, upgradeTitle, type Feature } from '../src/shared/entitlements'
import { FAILURE_MESSAGES, LicenseSettings } from '../src/renderer/upgrade/LicenseSettings'
import { UpgradeSheet } from '../src/renderer/upgrade/UpgradeSheet'

const features = Object.keys(FEATURE_LABELS) as Feature[]
const sheet = (feature: Feature) => renderToStaticMarkup(createElement(UpgradeSheet, { feature, onClose: () => {} }))

describe('entitlements', () => {
  it.each(features)('locks %s on Free and opens it on Pro', (feature) => {
    expect(can('free', feature)).toBe(false)
    expect(can('pro', feature)).toBe(true)
  })

  it('lists exactly what the plan lacks', () => {
    const output = { shapes: ['16:9', '9:16'], format: 'gif', resolution: '4k', fps: 60, folder: '' } as const
    expect(lockedInOutput('free', { ...output, shapes: [...output.shapes] }).sort()).toEqual(['export4k', 'export60fps', 'gif', 'vertical'])
    expect(lockedInOutput('pro', { ...output, shapes: [...output.shapes] })).toEqual([])
  })
})

describe('upgrade sheet', () => {
  it.each([
    ['export4k', '4K export is in Dolly Pro'],
    ['export60fps', '60 fps export is in Dolly Pro'],
    ['captions', 'Captions are in Dolly Pro'],
    ['webcam', 'The webcam bubble is in Dolly Pro'],
    ['gif', 'GIF export is in Dolly Pro'],
    ['vertical', 'The vertical cut is in Dolly Pro'],
    ['customBackground', 'Your own backgrounds are in Dolly Pro']
  ] as [Feature, string][])('titles %s', (feature, title) => {
    expect(upgradeTitle(feature)).toBe(title)
    expect(sheet(feature)).toContain(`<h2>${title}</h2>`)
  })

  it('has the concept\'s words and buttons', () => {
    const html = sheet('export4k').replaceAll('&#x27;', "'")
    expect(html).toContain('One payment, no subscription. Works on up to 3 devices.')
    expect(PRO_ITEMS).toHaveLength(6)
    for (const item of PRO_ITEMS) expect(html).toContain(`<li>${item}</li>`)
    for (const label of ['Get Pro for $9.99', 'I have a license key', 'Not now']) expect(html).toContain(label)
    expect(html).toContain('role="dialog"')
  })
})

describe('license field', () => {
  it('has the Enter license key field', () => {
    const html = renderToStaticMarkup(createElement(LicenseSettings))
    expect(html).toContain('Enter license key')
    expect(html).toContain('<input')
  })

  it('has one plain sentence for every failure', () => {
    expect(Object.keys(FAILURE_MESSAGES).sort()).toEqual(['device_id', 'device_limit', 'inactive', 'invalid_key', 'network', 'rate_limited', 'save', 'wrong_product'])
    for (const [reason, message] of Object.entries(FAILURE_MESSAGES)) {
      if (reason !== 'network') expect(message.match(/[.!?](\s|$)/g), reason).toHaveLength(1)
    }
  })

  it('uses the spec\'s words when the server is out of reach', () => {
    expect(FAILURE_MESSAGES.network).toBe("Couldn't reach the license server. Try again when you're online.")
  })

  it('does not blame the network for what the network did not do', () => {
    for (const reason of ['rate_limited', 'device_id', 'save'] as const) {
      expect(FAILURE_MESSAGES[reason]).not.toMatch(/online|reach/i)
    }
    expect(FAILURE_MESSAGES.rate_limited).toMatch(/wait/)
    expect(FAILURE_MESSAGES.save).toMatch(/disk/)
  })

  it('says how to free a device from Whop', () => {
    expect(FAILURE_MESSAGES.device_limit).toMatch(/3 devices/)
    expect(FAILURE_MESSAGES.device_limit).toMatch(/orders on Whop/)
  })
})
