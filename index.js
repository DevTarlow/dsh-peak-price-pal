/**
 * Peak Price Pal host half.
 *
 * The browser half owns the logo and the hover card. This half owns one
 * owner-only route that reads the DeepSeek balance the Harness already has:
 * the signed-in account when the session uses the account route, otherwise
 * the stored `DEEPSEEK_API_KEY` (or the reference the Models page derived).
 * It never asks for a second key and never returns a credential to the page.
 *
 * @module dsh-peak-price-pal
 */

import { readFileSync } from 'node:fs'

/** Exact route the browser half reads. Keep the client copy in step. */
const BALANCE_PATH = '/peak-price-pal/balance'
/** Fixed public endpoint; a key for another gateway cannot report a balance here. */
const BALANCE_URL = 'https://api.deepseek.com/user/balance'
/** Short in-process cache; the page polls once a minute. */
const CACHE_TTL_MS = 30_000
/** Upstream deadline; the browser gives up before the account service deadline. */
const REQUEST_TIMEOUT_MS = 10_000
/** The API reports one wallet per currency in practice. */
const MAX_WALLETS = 4
/** Platform decimal strings are short; anything longer is not a balance. */
const MAX_DECIMAL_LENGTH = 32
/** Decimal grammar shared with the account package: `0E-16` and `1e+3` are legal. */
const DECIMAL = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i
/** Conventional references, in the order the provider route resolves them. */
const KEY_REFS = ['DEEPSEEK_API_KEY', 'DEEPSEEK_OFFICIAL_API_KEY']
/** Stable error vocabulary translated by the browser half. */
const FAILURE_CODES = new Set(['unauthorized', 'network', 'timeout', 'protocol', 'failed'])
/** Longest accepted credential value; DeepSeek keys are far shorter. */
const MAX_KEY_LENGTH = 512

/** Read this package's version for the account client headers, tolerating a stripped install. */
function packageVersion() {
  try {
    const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    return typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * Map the route's `source` query to a balance source.
 * @param {unknown} value - Raw query value.
 * @returns {'apiKey' | 'account' | 'auto'} Balance source.
 */
function sourceOf(value) {
  if (value === 'apiKey') return 'apiKey'
  if (value === 'account') return 'account'
  return 'auto'
}

/**
 * A decimal string the browser half can format safely.
 * @param {unknown} value - Candidate value.
 * @returns {boolean} True for a finite decimal string within the length bound.
 */
function isDecimal(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_DECIMAL_LENGTH
    && DECIMAL.test(value)
    && Number.isFinite(Number(value))
}

/**
 * Build one failure outcome without leaking upstream prose.
 * @param {string} code - Supported failure code.
 * @param {'apiKey' | 'account'} source - Source that failed.
 * @param {number} checkedAt - Epoch milliseconds of the attempt.
 * @returns {{ status: 'failed', code: string, source: string, checkedAt: number }} Failure payload.
 */
function failure(code, source, checkedAt = Date.now()) {
  return {
    status: 'failed',
    code: FAILURE_CODES.has(code) ? code : 'failed',
    source,
    checkedAt,
  }
}

/**
 * Normalize the public balance API response.
 * @param {unknown} payload - Parsed `/user/balance` body.
 * @param {number} [now] - Reading time.
 * @returns {object | null} Ready balance or null when the payload is not trusted.
 */
function normalizeApiBalance(payload, now = Date.now()) {
  try {
    if (payload === null || typeof payload !== 'object') return null
    const available = payload.is_available
    const infos = payload.balance_infos
    if (typeof available !== 'boolean') return null
    if (!Array.isArray(infos) || infos.length < 1 || infos.length > MAX_WALLETS) return null
    const wallets = []
    const currencies = new Set()
    for (const info of infos) {
      if (info === null || typeof info !== 'object') return null
      if (info.currency !== 'CNY' && info.currency !== 'USD') return null
      if (currencies.has(info.currency)) return null
      currencies.add(info.currency)
      const total = info.total_balance
      const toppedUp = info.topped_up_balance
      const granted = info.granted_balance
      if (!isDecimal(total) || !isDecimal(toppedUp) || !isDecimal(granted)) return null
      wallets.push({ currency: info.currency, total, toppedUp, granted })
    }
    return { status: 'ready', source: 'apiKey', available, checkedAt: now, wallets }
  } catch {
    return null
  }
}

/**
 * Merge the account service's recharge and bonus wallets by currency.
 * @param {unknown} payload - `deepseekAccount.getBalance()` result.
 * @param {number} [now] - Reading time.
 * @returns {object | null} Ready balance or null when the payload is not trusted.
 */
function normalizeAccountBalance(payload, now = Date.now()) {
  try {
    if (payload === null || typeof payload !== 'object' || payload.status !== 'ready') return null
    if (!Array.isArray(payload.value) || !Array.isArray(payload.bonusWallets)) return null
    const merged = new Map()
    const add = (wallet, field) => {
      if (wallet === null || typeof wallet !== 'object') return false
      if (wallet.currency !== 'CNY' && wallet.currency !== 'USD') return false
      if (!isDecimal(wallet.balance)) return false
      const entry = merged.get(wallet.currency) ?? { toppedUp: 0, granted: 0 }
      entry[field] += Number(wallet.balance)
      merged.set(wallet.currency, entry)
      return true
    }
    for (const wallet of payload.value) if (!add(wallet, 'toppedUp')) return null
    for (const wallet of payload.bonusWallets) if (!add(wallet, 'granted')) return null
    if (merged.size === 0 || merged.size > MAX_WALLETS) return null
    const wallets = [...merged.entries()].map(([currency, entry]) => ({
      currency,
      total: (entry.toppedUp + entry.granted).toFixed(2),
      toppedUp: entry.toppedUp.toFixed(2),
      granted: entry.granted.toFixed(2),
    }))
    return { status: 'ready', source: 'account', checkedAt: now, wallets }
  } catch {
    return null
  }
}

/**
 * Read the first usable DeepSeek key reference.
 * @param {object} ctx - Host context.
 * @returns {Promise<{ key?: string, failure?: object }>} Key, an explicit failure, or neither when unconfigured.
 */
async function resolveApiKey(ctx) {
  const credentials = ctx.get('credentials')
  for (const ref of KEY_REFS) {
    let raw
    try {
      raw = credentials === undefined ? process.env[ref] : (await credentials.resolve(ref))?.value
    } catch {
      return { failure: failure('failed', 'apiKey') }
    }
    if (raw === undefined) continue
    const key = String(raw).trim()
    // An empty or malformed value is not a usable credential; try the next reference.
    if (key === '' || key.length > MAX_KEY_LENGTH || /\s/.test(key)) continue
    return { key }
  }
  return {}
}

/**
 * Query the public balance endpoint with the stored key.
 * @param {object} ctx - Host context.
 * @param {number} now - Attempt time.
 * @returns {Promise<object>} Normalized result; never throws.
 */
async function readApiBalance(ctx, now) {
  const { key, failure: keyFailure } = await resolveApiKey(ctx)
  if (keyFailure !== undefined) return keyFailure
  if (key === undefined) return { status: 'unconfigured' }
  let response
  try {
    response = await fetch(BALANCE_URL, {
      method: 'GET',
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    const name = error !== null && typeof error === 'object' ? error.name : ''
    return failure(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network', 'apiKey', now)
  }
  if (response.status === 401 || response.status === 403) return failure('unauthorized', 'apiKey', now)
  if (!response.ok) return failure('failed', 'apiKey', now)
  let payload
  try {
    payload = await response.json()
  } catch {
    return failure('protocol', 'apiKey', now)
  }
  return normalizeApiBalance(payload, now) ?? failure('protocol', 'apiKey', now)
}

/**
 * Read the signed-in account's wallet balance through the account service.
 * @param {object} ctx - Host context.
 * @param {string} locale - Request language.
 * @param {string} version - This package's version for the Platform client headers.
 * @param {number} now - Attempt time.
 * @returns {Promise<object>} Normalized result; never throws.
 */
async function readAccountBalance(ctx, locale, version, now) {
  const account = ctx.get('deepseekAccount')
  if (account === undefined || typeof account.getState !== 'function' || typeof account.getBalance !== 'function') {
    return { status: 'unconfigured' }
  }
  let state
  try {
    state = await account.getState()
  } catch {
    return failure('failed', 'account', now)
  }
  if (state === null || typeof state !== 'object' || state.status !== 'credential-stored') {
    return { status: 'unconfigured' }
  }
  let details
  try {
    details = await account.getBalance({ version, locale, timezoneOffsetSeconds: 0 })
  } catch {
    return failure('failed', 'account', now)
  }
  // A stored grant that disappears during the read is an expired sign-in, not a zero balance.
  if (details === null || details === undefined) return failure('unauthorized', 'account', now)
  if (details.status === 'failed') return failure('failed', 'account', now)
  return normalizeAccountBalance(details, now) ?? failure('protocol', 'account', now)
}

/**
 * Read one source without its cache.
 * @param {object} ctx - Host context.
 * @param {'apiKey' | 'account' | 'auto'} source - Requested source.
 * @param {string} locale - Request language.
 * @param {string} version - This package's version.
 * @returns {Promise<object>} Normalized result.
 */
async function readUncached(ctx, source, locale, version) {
  const now = Date.now()
  if (source === 'account') return readAccountBalance(ctx, locale, version, now)
  if (source === 'apiKey') return readApiBalance(ctx, now)
  const key = await readApiBalance(ctx, now)
  if (key.status !== 'unconfigured') return key
  return readAccountBalance(ctx, locale, version, now)
}

/**
 * Read through the short cache, sharing one in-flight read per source.
 * @param {object} ctx - Host context.
 * @param {'apiKey' | 'account' | 'auto'} source - Requested source.
 * @param {string} locale - Request language.
 * @param {string} version - This package's version.
 * @param {Map<string, { at: number, value: object }>} cache - Ready/unconfigured cache.
 * @param {Map<string, Promise<object>>} inflight - Shared reads.
 * @returns {Promise<object>} Normalized result.
 */
async function readBalance(ctx, source, locale, version, cache, inflight) {
  const hit = cache.get(source)
  if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return hit.value
  const pending = inflight.get(source)
  if (pending !== undefined) return pending
  const promise = readUncached(ctx, source, locale, version)
    .then((value) => {
      // A failure is retried on the next open; a ready or unconfigured answer is reusable.
      if (value.status !== 'failed') cache.set(source, { at: Date.now(), value })
      return value
    })
    .finally(() => { inflight.delete(source) })
  inflight.set(source, promise)
  return promise
}

/**
 * A JSON response with no caching and no credential echo.
 * @param {number} status - HTTP status.
 * @param {object} value - JSON body.
 * @returns {Response} Response.
 */
function json(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/**
 * Pick the Platform wire language from the browser request.
 * @param {Request} request - Resource request.
 * @returns {string} `zh-CN` or `en-US`.
 */
function localeFrom(request) {
  let header = ''
  try {
    header = request.headers.get('accept-language') ?? ''
  } catch {
    header = ''
  }
  return /^\s*zh\b/i.test(header) ? 'zh-CN' : 'en-US'
}

/**
 * Create the route resource, closing over the shared cache.
 * @param {object} ctx - Host context.
 * @param {string} version - This package's version.
 * @param {Map<string, { at: number, value: object }>} cache - Ready/unconfigured cache.
 * @param {Map<string, Promise<object>>} inflight - Shared reads.
 * @returns {(request: Request, peer?: object) => Promise<Response>} Route resource.
 */
function createResource(ctx, version, cache, inflight) {
  return async (request, peer) => {
    if (peer === null || peer === undefined || peer.principal === null || peer.principal === undefined
      || peer.principal.kind !== 'owner') {
      return json(403, { code: 'forbidden' })
    }
    let source = 'auto'
    try {
      source = sourceOf(new URL(request.url, 'http://localhost').searchParams.get('source'))
    } catch {
      source = 'auto'
    }
    let value
    try {
      value = await readBalance(ctx, source, localeFrom(request), version, cache, inflight)
    } catch {
      value = failure('failed', source === 'account' ? 'account' : 'apiKey')
    }
    return json(200, value)
  }
}

/**
 * Register the balance route and its cache invalidations.
 * @param {object} ctx - Host plugin context.
 */
export function apply(ctx) {
  const version = packageVersion()
  const cache = new Map()
  const inflight = new Map()
  const invalidate = () => { cache.clear() }
  ctx.on('credentials/reference-updated', invalidate)
  ctx.on('credentials/record-updated', invalidate)
  ctx.on('deepseek-account/signed-out', invalidate)
  ctx.on('deepseek-account/session-expired', invalidate)
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: BALANCE_PATH,
      auth: 'required',
      resource: createResource(ctx, version, cache, inflight),
    }), `peak-price-pal: GET ${BALANCE_PATH}`)
  })
}

// Expose the pure parts to the repository test harness. Non-enumerable so the
// Loader sees the same plugin shape as every other bundle.
Object.defineProperty(apply, '__peakPricePalHost', {
  value: {
    BALANCE_PATH,
    BALANCE_URL,
    CACHE_TTL_MS,
    REQUEST_TIMEOUT_MS,
    MAX_WALLETS,
    MAX_DECIMAL_LENGTH,
    KEY_REFS,
    FAILURE_CODES,
    packageVersion,
    sourceOf,
    isDecimal,
    failure,
    normalizeApiBalance,
    normalizeAccountBalance,
    localeFrom,
  },
  enumerable: false,
})
