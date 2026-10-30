// IPC wraps every rejection in its own prefix, which isn't for the user to read.

export function errorText(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : ''
  return message.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '') || fallback
}
