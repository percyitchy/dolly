import { useEffect, useState } from 'react'
import type { Plan } from '../../shared/entitlements'

const listeners = new Set<(plan: Plan) => void>()

export function announcePlan(plan: Plan): void {
  listeners.forEach((listener) => listener(plan))
}

// The current plan. Stays up to date when a key is activated or removed anywhere in the window
export function usePlan(): Plan {
  const [plan, setPlan] = useState<Plan>('free')

  useEffect(() => {
    let live = true
    listeners.add(setPlan)
    window.dolly.license.status().then((status) => {
      if (live) setPlan(status.plan)
    })
    return () => {
      live = false
      listeners.delete(setPlan)
    }
  }, [])

  return plan
}
