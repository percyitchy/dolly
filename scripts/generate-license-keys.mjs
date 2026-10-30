#!/usr/bin/env node
// Prints a new Ed25519 keypair to the terminal. It writes no files.
// Run it once, in a terminal, and never redirect the output into this repo:
//   node scripts/generate-license-keys.mjs

import { generateKeyPairSync } from 'node:crypto'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')

// The last 32 bytes of the SPKI encoding are the raw public key
const rawPublic = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
const pkcs8Private = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')

console.log(`LICENSE_PUBLIC_KEY, safe to commit. Paste into src/shared/config.ts:

${rawPublic}

LICENSE_SIGNING_KEY, secret. Paste into Vercel as an env variable and nowhere else:

${pkcs8Private}
`)
