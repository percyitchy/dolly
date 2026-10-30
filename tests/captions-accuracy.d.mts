export const SCRIPTS: { name: string; voice: string; language: string; text: string }[]
export function normalise(text: string): string[]
export function wordAccuracy(reference: string, hypothesis: string): { accuracy: number; words: number; errors: number }
