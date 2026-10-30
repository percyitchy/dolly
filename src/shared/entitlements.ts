// The only place that decides what Pro unlocks. The UI reads it and the export job checks it again.

import type { OutputSettings, Project, Shape } from './project'

export type Feature = 'export4k' | 'export60fps' | 'captions' | 'webcam' | 'gif' | 'vertical' | 'customBackground'

export const FEATURE_LABELS: Record<Feature, string> = {
  export4k: '4K export',
  export60fps: '60 fps export',
  captions: 'Captions',
  webcam: 'The webcam bubble',
  gif: 'GIF export',
  vertical: 'The vertical cut',
  customBackground: 'Your own backgrounds'
}

// The labels that need "are" rather than "is" in the upgrade sheet's title
const PLURAL_LABELS: ReadonlySet<Feature> = new Set<Feature>(['captions', 'customBackground'])

export function upgradeTitle(feature: Feature): string {
  return `${FEATURE_LABELS[feature]} ${PLURAL_LABELS.has(feature) ? 'are' : 'is'} in Dolly Pro`
}

export const PRO_ITEMS = [
  '4K and 60 fps',
  'Captions',
  'Webcam bubble',
  'GIF export',
  '9:16 vertical cut',
  'Your own backgrounds'
] as const

export type Plan = 'free' | 'pro'

export function can(plan: Plan, _feature: Feature): boolean {
  return plan === 'pro'
}

export function shapeFeature(shape: Shape): Feature | null {
  return shape === '9:16' ? 'vertical' : null
}

// Everything in these settings that the plan doesn't include
export function lockedInOutput(plan: Plan, output: OutputSettings): Feature[] {
  const used: Feature[] = []
  if (output.resolution === '4k') used.push('export4k')
  if (output.fps === 60) used.push('export60fps')
  if (output.format === 'gif') used.push('gif')
  if (output.shapes.includes('9:16')) used.push('vertical')
  return used.filter((f) => !can(plan, f))
}

// Pro items a project uses. They're kept in the project and left out of the export on Free
export function lockedInProject(plan: Plan, project: Project): Feature[] {
  const used: Feature[] = []
  if (project.webcam) used.push('webcam')
  if (project.captions.length > 0) used.push('captions')
  if (project.look.background.kind === 'image') used.push('customBackground')
  return used.filter((f) => !can(plan, f))
}
