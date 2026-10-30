// The one place for store and license settings. Nothing here is secret.

export const WHOP_URL = 'https://whop.com/getdolly/dolly-lifetime-sub'
export const WHOP_PRODUCT_ID = 'prod_REPLACE_ME' // Filled in once the Whop product ID is known
export const VALIDATE_ENDPOINT = 'https://REPLACE_ME.vercel.app/api/validate' // Filled in after the Vercel deploy
export const LICENSE_PUBLIC_KEY = 'REPLACE_ME' // Ed25519 public key, base64 of the raw 32 bytes
export const REPO_URL = 'https://github.com/percyitchy/dolly'

export const MAX_DEVICES = 3
export const DEVICE_ID_SALT = 'dolly-device-v1'
