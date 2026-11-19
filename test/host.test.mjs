/**
 * Peak Price Pal host harness.
 *
 * Runs the Host route with a stub Cordis context and a stub `fetch`, then
 * checks source selection, normalization, cache behavior, and the owner-only
 * contract. No build step, no dependencies, no real credential.
 */
import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

const api = apply.__peakPricePalHost
assert.ok(api, 'the host module exposes its test face')

const originalFetch = globalThis.fetch

beforeEach(() => {
  globalThis.fetch = originalFetch
  delete process.env.DEEPSEEK_API_KEY
  delete process.env.DEEPSEEK_OFFICIAL_API_KEY
})

afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env.DEEPSEEK_API_KEY
  delete process.env.DEEPSEEK_OFFICIAL_API_KEY
})

/**
 * Build a fake Host context and apply the plugin.
 * @param {object} services - Services returned by `ctx.get`.
 * @returns {{ ctx: object, route: object, listeners: Map<string, Function> }} Harness.
 */
function host(services = {}) {
  const routes = []
  const listeners = new Map()
  const ctx = {
    get(name) {
      return services[name]
    },
    on(name, listener) {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
    inject(_names, callback) {
      callback(ctx)
      return () => {}
    },
    effect(factory) {
      return factory()
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
  apply(ctx)
  assert.equal(routes.length, 1, 'one route is registered')
  return { ctx, route: routes[0], listeners }
}

/** A request for the balance route. @param {string} [source] - Query source. @returns {Request} Request. */
function balanceRequest(source, headers = { 'accept-language': 'en-US' }) {
  const suffix = source === undefined ? '' : `?source=${encodeURIComponent(source)}`
  return new Request(`http://localhost${api.BALANCE_PATH}${suffix}`, { headers })
}

const owner = { principal: { kind: 'owner' } }
const viewer = { principal: { kind: 'viewer' } }

/**
 * Call the route resource and decode the body.
 * @param {object} route - Registered route.
 * @param {string} [source] - Query source.
 * @param {object} [peer] - Admitted peer.
 * @param {object} [headers] - Request headers.
 * @returns {Promise<{ res: Response, body: object }>} Response and decoded body.
 */
async function read(route, source, peer = owner, headers) {
  const res = await route.resource(balanceRequest(source, headers), peer)
  return { res, body: await res.json() }
}

/** A JSON response for the stub. @param {unknown} body - Payload. @param {number} [status] - Status. @returns {Response} Response. */
function jsonResponse(body, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** A credentials service that resolves one reference. @param {string} [key] - Value. @returns {object} Service with recorded refs. */
function credentialsWith(key = 'sk-test-secret') {
  const refs = []
  return {
    refs,
    service: {
      async resolve(ref) {
        refs.push(ref)
        return ref === 'DEEPSEEK_API_KEY' ? { value: key } : undefined
      },
    },
  }
}

/** A signed-in account service. @returns {object} Service with recorded calls. */
function accountWith() {
  const calls = []
  return {
    calls,
    service: {
      async getState() {
        return { status: 'credential-stored' }
      },
      async getBalance(metadata) {
        calls.push(metadata)
        return {
          status: 'ready',
          value: [{ currency: 'CNY', balance: '100.00' }],
          bonusWallets: [{ currency: 'CNY', balance: '10.00' }],
        }
      },
    },
  }
}

const apiPayload = {
  is_available: true,
  balance_infos: [
    { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
  ],
}

test('the route is exact, authenticated, and owner-only', async () => {
  const { route } = host()
  assert.equal(route.kind, 'exact')
  assert.equal(route.path, api.BALANCE_PATH)
  assert.equal(route.auth, 'required')
  assert.equal(typeof route.resource, 'function')

  const denied = await read(route, 'apiKey', viewer)
  assert.equal(denied.res.status, 403)
  assert.deepEqual(denied.body, { code: 'forbidden' })
  assert.equal(denied.res.headers.get('cache-control'), 'no-store')
})

test('no configured source reads as unconfigured', async () => {
  const { route } = host()
  for (const source of [undefined, 'apiKey', 'account', 'auto']) {
    const { res, body } = await read(route, source)
    assert.equal(res.status, 200)
    assert.deepEqual(body, { status: 'unconfigured' }, `source ${String(source)}`)
    assert.equal(res.headers.get('cache-control'), 'no-store')
  }
})

test('the API key path sends only the key and returns normalized wallets', async () => {
  const credentials = credentialsWith()
  const { route } = host({ credentials: credentials.service })
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return jsonResponse(apiPayload)
  }

  const { res, body } = await read(route, 'apiKey')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, api.BALANCE_URL)
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test-secret')
  assert.equal(calls[0].init.headers.accept, 'application/json')
  assert.equal(calls[0].init.redirect, 'error')

  assert.equal(body.status, 'ready')
  assert.equal(body.source, 'apiKey')
  assert.equal(body.available, true)
  assert.equal(typeof body.checkedAt, 'number')
  assert.deepEqual(body.wallets, [
    { currency: 'CNY', total: '110.00', toppedUp: '100.00', granted: '10.00' },
  ])
  assert.equal(JSON.stringify(body).includes('sk-test-secret'), false)
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
})

test('the derived credential reference is a fallback', async () => {
  const service = {
    async resolve(ref) {
      return ref === 'DEEPSEEK_OFFICIAL_API_KEY' ? { value: 'sk-derived' } : undefined
    },
  }
  const { route } = host({ credentials: service })
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push(init)
    return jsonResponse(apiPayload)
  }
  const { body } = await read(route, 'apiKey')
  assert.equal(body.status, 'ready')
  assert.equal(calls[0].headers.authorization, 'Bearer sk-derived')
})

test('the process environment is read only without a credentials service', async () => {
  process.env.DEEPSEEK_API_KEY = 'sk-env'
  const { route } = host()
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push(init)
    return jsonResponse(apiPayload)
  }
  const { body } = await read(route, 'apiKey')
  assert.equal(body.status, 'ready')
  assert.equal(calls[0].headers.authorization, 'Bearer sk-env')
})

test('the account path merges recharge and bonus wallets', async () => {
  const account = accountWith()
  const { route } = host({ deepseekAccount: account.service })
  const { body } = await read(route, 'account', owner, { 'accept-language': 'zh-CN,zh;q=0.9' })
  assert.equal(body.status, 'ready')
  assert.equal(body.source, 'account')
  assert.deepEqual(body.wallets, [
    { currency: 'CNY', total: '110.00', toppedUp: '100.00', granted: '10.00' },
  ])
  assert.equal(account.calls.length, 1)
  assert.equal(account.calls[0].locale, 'zh-CN')
  assert.equal(account.calls[0].timezoneOffsetSeconds, 0)
  assert.match(account.calls[0].version, /^\d+\.\d+\.\d+/)
  assert.equal('available' in body, false)
})

test('account sign-out and expired reads map to stable outcomes', async () => {
  const signedOut = host({
    deepseekAccount: {
      async getState() { return { status: 'signed-out' } },
      async getBalance() { throw new Error('must not read a signed-out wallet') },
    },
  }).route
  assert.deepEqual((await read(signedOut, 'account')).body, { status: 'unconfigured' })

  const expired = host({
    deepseekAccount: {
      async getState() { return { status: 'credential-stored' } },
      async getBalance() { return null },
    },
  }).route
  const expiredBody = (await read(expired, 'account')).body
  assert.equal(expiredBody.status, 'failed')
  assert.equal(expiredBody.code, 'unauthorized')
  assert.equal(expiredBody.source, 'account')

  const failed = host({
    deepseekAccount: {
      async getState() { return { status: 'credential-stored' } },
      async getBalance() { return { status: 'failed' } },
    },
  }).route
  const failedBody = (await read(failed, 'account')).body
  assert.equal(failedBody.status, 'failed')
  assert.equal(failedBody.code, 'failed')
  assert.equal(failedBody.source, 'account')
})

test('a route never borrows the other source', async () => {
  const credentials = credentialsWith()
  const account = accountWith()

  const accountRoute = host({ credentials: credentials.service }).route
  const accountOnly = await read(accountRoute, 'account')
  assert.deepEqual(accountOnly.body, { status: 'unconfigured' })
  assert.equal(credentials.refs.length, 0, 'the account route does not resolve the key')

  const keyRoute = host({ deepseekAccount: account.service }).route
  const keyOnly = await read(keyRoute, 'apiKey')
  assert.deepEqual(keyOnly.body, { status: 'unconfigured' })
  assert.equal(account.calls.length, 0, 'the key route does not call the account')

  const bothRoute = host({ credentials: credentials.service, deepseekAccount: account.service }).route
  globalThis.fetch = async () => jsonResponse(apiPayload)
  const both = await read(bothRoute, 'apiKey')
  assert.equal(both.body.source, 'apiKey')
  assert.equal(account.calls.length, 0)
})

test('auto tries the key first and falls back to the account', async () => {
  const account = accountWith()
  const accountOnly = host({ deepseekAccount: account.service }).route
  const fallback = await read(accountOnly, 'auto')
  assert.equal(fallback.body.status, 'ready')
  assert.equal(fallback.body.source, 'account')

  const credentials = credentialsWith()
  const both = host({ credentials: credentials.service, deepseekAccount: account.service }).route
  globalThis.fetch = async () => jsonResponse(apiPayload)
  const preferred = await read(both, 'auto')
  assert.equal(preferred.body.status, 'ready')
  assert.equal(preferred.body.source, 'apiKey')
})

test('upstream failures map to stable codes without leaking prose', async () => {
  const credentials = credentialsWith()
  const { route } = host({ credentials: credentials.service })

  globalThis.fetch = async () => jsonResponse('denied', 401)
  const rejected = await read(route, 'apiKey')
  assert.equal(rejected.body.status, 'failed')
  assert.equal(rejected.body.code, 'unauthorized')
  assert.equal(rejected.body.source, 'apiKey')
  assert.equal(JSON.stringify(rejected.body).includes('denied'), false)

  globalThis.fetch = async () => { throw new TypeError('network down') }
  const network = await read(route, 'apiKey')
  assert.equal(network.body.code, 'network')

  globalThis.fetch = async () => { throw new DOMException('The operation was aborted.', 'TimeoutError') }
  const timeout = await read(route, 'apiKey')
  assert.equal(timeout.body.code, 'timeout')

  globalThis.fetch = async () => jsonResponse('not json')
  const protocol = await read(route, 'apiKey')
  assert.equal(protocol.body.code, 'protocol')

  globalThis.fetch = async () => jsonResponse('server error', 500)
  const failed = await read(route, 'apiKey')
  assert.equal(failed.body.code, 'failed')
})

test('the cache reuses a ready answer and retries a failure', async () => {
  const credentials = credentialsWith()
  const { route, listeners } = host({ credentials: credentials.service })
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return jsonResponse(apiPayload)
  }
  const first = await read(route, 'apiKey')
  const second = await read(route, 'apiKey')
  assert.equal(calls, 1)
  assert.deepEqual(second.body, first.body)

  listeners.get('credentials/reference-updated')?.()
  const third = await read(route, 'apiKey')
  assert.equal(calls, 2)
  assert.equal(third.body.status, 'ready')

  calls = 0
  globalThis.fetch = async () => {
    calls += 1
    throw new TypeError('offline')
  }
  const retryRoute = host({ credentials: credentials.service }).route
  await read(retryRoute, 'apiKey')
  await read(retryRoute, 'apiKey')
  assert.equal(calls, 2, 'a failure is not cached')
})

test('the normalizers reject untrusted payloads', () => {
  assert.equal(api.isDecimal('0E-16'), true)
  assert.equal(api.isDecimal('1e+3'), true)
  assert.equal(api.isDecimal('1,000'), false)
  assert.equal(api.isDecimal(''), false)
  assert.equal(api.sourceOf('apiKey'), 'apiKey')
  assert.equal(api.sourceOf('account'), 'account')
  assert.equal(api.sourceOf('nope'), 'auto')

  const valid = api.normalizeApiBalance(apiPayload, 123)
  assert.equal(valid.status, 'ready')
  assert.equal(valid.checkedAt, 123)

  assert.equal(api.normalizeApiBalance({ is_available: true, balance_infos: [] }), null)
  assert.equal(api.normalizeApiBalance({
    is_available: true,
    balance_infos: [{ currency: 'EUR', total_balance: '1.00', granted_balance: '0.00', topped_up_balance: '1.00' }],
  }), null)
  assert.equal(api.normalizeApiBalance({
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '1,00', granted_balance: '0.00', topped_up_balance: '1.00' }],
  }), null)
  assert.equal(api.normalizeApiBalance({
    is_available: true,
    balance_infos: Array.from({ length: 5 }, () => ({
      currency: 'CNY', total_balance: '1.00', granted_balance: '0.00', topped_up_balance: '1.00',
    })),
  }), null)
  assert.equal(api.normalizeApiBalance({
    is_available: true,
    balance_infos: [
      { currency: 'CNY', total_balance: '1.00', granted_balance: '0.00', topped_up_balance: '1.00' },
      { currency: 'CNY', total_balance: '2.00', granted_balance: '0.00', topped_up_balance: '2.00' },
    ],
  }), null)

  const merged = api.normalizeAccountBalance({
    status: 'ready',
    value: [
      { currency: 'CNY', balance: '10.00' },
      { currency: 'CNY', balance: '2.50' },
      { currency: 'USD', balance: '3.00' },
    ],
    bonusWallets: [{ currency: 'CNY', balance: '1.00' }],
  }, 42)
  assert.equal(merged.status, 'ready')
  assert.equal(merged.checkedAt, 42)
  assert.deepEqual(merged.wallets, [
    { currency: 'CNY', total: '13.50', toppedUp: '12.50', granted: '1.00' },
    { currency: 'USD', total: '3.00', toppedUp: '3.00', granted: '0.00' },
  ])
  assert.equal(api.normalizeAccountBalance({ status: 'ready', value: [], bonusWallets: [] }), null)
  assert.equal(api.normalizeAccountBalance({ status: 'failed' }), null)
})
