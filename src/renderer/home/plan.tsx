import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { can as canPlan, type Feature, type Plan } from '../../shared/entitlements'
import { UpgradeSheet } from '../upgrade/UpgradeSheet'
import { usePlan } from '../upgrade/usePlan'

interface Access {
  plan: Plan
  can(feature: Feature): boolean
  upgrade(feature: Feature): void
  sheetOpen: boolean
}

const AccessContext = createContext<Access | null>(null)

export function useAccess(): Access {
  const value = useContext(AccessContext)
  if (!value) throw new Error('useAccess needs an AccessProvider')
  return value
}

export function AccessProvider({ children }: { children: ReactNode }) {
  const plan = usePlan()
  const [feature, setFeature] = useState<Feature | null>(null)

  const value = useMemo<Access>(
    () => ({ plan, can: (f) => canPlan(plan, f), upgrade: setFeature, sheetOpen: feature !== null }),
    [plan, feature]
  )

  return (
    <AccessContext.Provider value={value}>
      {children}
      {feature && <UpgradeSheet feature={feature} onClose={() => setFeature(null)} />}
    </AccessContext.Provider>
  )
}

// The one small badge. It disappears the moment the plan includes the feature
export function ProBadge({ feature }: { feature: Feature }) {
  const { can } = useAccess()
  return can(feature) ? null : <i className="pro">Pro</i>
}
