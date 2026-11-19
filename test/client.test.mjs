/**
 * Peak Price Pal test harness.
 *
 * Loads the browser module in Node with a tiny React stub, then checks the
 * time math, the holiday table, the model gate, the manifest, the locale keys,
 * the icon rules, and the slot registration. No build step, no dependencies.
 */
import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** Minimal browser storage so the settings store has a real persistent surface. */
const settingsStorage = new Map()
globalThis.localStorage = {
  getItem: key => (settingsStorage.has(key) ? settingsStorage.get(key) : null),
  setItem: (key, value) => { settingsStorage.set(key, String(value)) },
  removeItem: key => { settingsStorage.delete(key) },
}

/** Captured window listeners, used by the cross-tab storage sync. */
const windowListeners = []

/** Minimal React surface used by the module under test. */
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: Symbol('Fragment'),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: callback => callback(),
  useRef: initial => ({ current: initial ?? null }),
  useId: () => ':r0:',
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
}

/** Minimal `react-dom` surface; the card portal is not opened in these tests. */
const ReactDOM = {
  createPortal: (element, container) => ({ type: 'portal', element, container }),
}

/** Captured `window.__ModuleLoader__.load` definition. */
let moduleDefinition = null
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      moduleDefinition = definition
    },
  },
  addEventListener: (type, listener) => { windowListeners.push({ type, listener }) },
  removeEventListener: (type, listener) => {
    const index = windowListeners.findIndex(entry => entry.type === type && entry.listener === listener)
    if (index >= 0) windowListeners.splice(index, 1)
  },
}

await import(new URL('../client.js', import.meta.url).href)
assert.ok(moduleDefinition, 'client.js registers a module')
const plugin = moduleDefinition.factory(name => {
  if (name === 'react') return React
  if (name === 'react-dom') return ReactDOM
  throw new Error(`unexpected require: ${name}`)
})
const api = plugin.__peakPricePal
assert.ok(api, 'the module exposes its test face')

beforeEach(() => {
  api.settings.reset()
  api.resetBalanceLedger()
  api.resetBalanceCache()
})

const t = (key, vars) => api.translateFallback(key, vars)
const at = (date, time) => Date.parse(`${date}T${time}:00+08:00`)
const fakeStore = {
  subscribe: () => () => {},
  getSnapshot: () => ({ current: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
}
const makeStore = current => ({
  subscribe: () => () => {},
  getSnapshot: () => ({ current }),
})

test('the module id matches the package name', () => {
  assert.equal(moduleDefinition.id, 'dsh-peak-price-pal')
  assert.equal(api.SLOT, 'conversation.composer.dock')
  assert.equal(api.SLOT_ID, 'peak-price-pal')
  assert.equal(api.SLOT_ORDER, 30)
})

test('peak windows start inclusive and end exclusive', () => {
  const day = '2026-11-19'
  assert.equal(api.isPeak(at(day, '08:59')), false)
  assert.equal(api.isPeak(at(day, '09:00')), true)
  assert.equal(api.isPeak(at(day, '11:59')), true)
  assert.equal(api.isPeak(at(day, '12:00')), false)
  assert.equal(api.isPeak(at(day, '13:59')), false)
  assert.equal(api.isPeak(at(day, '14:00')), true)
  assert.equal(api.isPeak(at(day, '17:59')), true)
  assert.equal(api.isPeak(at(day, '18:00')), false)
})

test('weekends are off-peak, including a make-up Saturday', () => {
  assert.equal(api.isPeak(at('2026-11-21', '10:00')), false)
  assert.equal(api.isPeak(at('2026-11-22', '10:00')), false)
  assert.equal(api.isPeak(at('2026-10-10', '10:00')), false)
})

test('bundled Chinese holidays are off-peak on weekdays', () => {
  assert.equal(api.isPeak(at('2026-10-01', '10:00')), false)
  assert.equal(api.isPeak(at('2026-10-08', '10:00')), true)
  assert.equal(api.isPeak(at('2027-02-08', '10:00')), false)
  assert.equal(api.isPeak(at('2027-02-15', '10:00')), true)
  assert.equal(api.isPeak(at('2026-02-15', '10:00')), false)
})

test('the next switch finds the right boundary', () => {
  assert.deepEqual(api.nextSwitch(at('2026-11-19', '12:30')), {
    at: at('2026-11-19', '14:00'),
    peak: true,
  })
  assert.deepEqual(api.nextSwitch(at('2026-11-19', '18:30')), {
    at: at('2026-11-20', '09:00'),
    peak: true,
  })
  assert.deepEqual(api.nextSwitch(at('2026-11-20', '18:30')), {
    at: at('2026-11-23', '09:00'),
    peak: true,
  })
  assert.deepEqual(api.nextSwitch(at('2026-09-30', '18:30')), {
    at: at('2026-10-08', '09:00'),
    peak: true,
  })
  assert.deepEqual(api.nextSwitch(at('2027-02-04', '18:30')), {
    at: at('2027-02-15', '09:00'),
    peak: true,
  })
  assert.deepEqual(api.nextSwitch(at('2026-11-19', '11:59')), {
    at: at('2026-11-19', '12:00'),
    peak: false,
  })
  assert.deepEqual(api.nextSwitch(at('2026-11-19', '17:59')), {
    at: at('2026-11-19', '18:00'),
    peak: false,
  })
})

test('the countdown is compact and rounds up', () => {
  assert.equal(api.durationText(0), '1m')
  assert.equal(api.durationText(30_000), '1m')
  assert.equal(api.durationText(60_000), '1m')
  assert.equal(api.durationText(60_001), '2m')
  assert.equal(api.durationText(3_600_000), '1h')
  assert.equal(api.durationText(3_660_000), '1h 1m')
  assert.equal(api.durationText(86_400_000), '1d')
  assert.equal(api.durationText(90_000_000), '1d 1h')
})

test('the countdown uses the active locale in Chinese', () => {
  const zhT = (key, vars) => api.ZH[key].replace(/\{(\w+)\}/g, (_, name) => String(vars[name]))
  assert.equal(api.durationText(60_000, zhT), '1 分钟')
  assert.equal(api.durationText(3_660_000, zhT), '1 小时 1 分')
  assert.equal(api.durationText(90_000_000, zhT), '1 天 1 小时')
})

test('settings default to the current behavior and reject unknown values', () => {
  assert.deepEqual(api.settings.normalize(undefined), api.settings.defaults)
  assert.deepEqual(api.settings.normalize({ icon: 'dot', clock: '12h', detail: 'minimal' }), {
    icon: 'dot', clock: '12h', detail: 'minimal', balance: 'show',
  })
  assert.deepEqual(api.settings.normalize({ icon: 'nope', clock: 'nope', detail: 'nope', balance: 'nope' }), api.settings.defaults)
  assert.deepEqual(api.settings.normalize({ icon: 'dot', balance: 'hide', extra: true }), {
    ...api.settings.defaults, icon: 'dot', balance: 'hide',
  })
})

test('settings persist and notify subscribers', () => {
  const seen = []
  const unsubscribe = api.settings.subscribe(() => seen.push(api.settings.getSnapshot()))
  api.settings.update({ icon: 'dot' })
  assert.equal(api.settings.getSnapshot().icon, 'dot')
  assert.equal(seen.length, 1)
  assert.equal(JSON.parse(settingsStorage.get(api.settings.key)).icon, 'dot')
  api.settings.update({ icon: 'dot' })
  assert.equal(seen.length, 1)
  api.settings.reset()
  assert.deepEqual(api.settings.getSnapshot(), api.settings.defaults)
  assert.equal(seen.length, 2)
  unsubscribe()
})

test('settings read tolerates bad JSON and blocked storage', () => {
  settingsStorage.set(api.settings.key, JSON.stringify({ icon: 'dot', clock: '12h', detail: 'minimal' }))
  assert.deepEqual(api.settings.read(), { icon: 'dot', clock: '12h', detail: 'minimal', balance: 'show' })
  settingsStorage.set(api.settings.key, '{bad json')
  assert.deepEqual(api.settings.read(), api.settings.defaults)
  const original = globalThis.localStorage
  try {
    globalThis.localStorage = {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
    }
    assert.deepEqual(api.settings.read(), api.settings.defaults)
    assert.doesNotThrow(() => api.settings.write(api.settings.defaults))
  } finally {
    globalThis.localStorage = original
  }
})

test('the clock formatter handles 24-hour and 12-hour in both locales', () => {
  assert.equal(api.formatClock(9, 5, '24h', t), '09:05')
  assert.equal(api.formatClock(14, 0, '24h', t), '14:00')
  assert.equal(api.formatClock(9, 5, '12h', t), '9:05 AM')
  assert.equal(api.formatClock(0, 30, '12h', t), '12:30 AM')
  assert.equal(api.formatClock(12, 0, '12h', t), '12:00 PM')
  assert.equal(api.formatClock(14, 0, '12h', t), '2:00 PM')
  const zhT = (key, vars) => api.ZH[key].replace(/\{(\w+)\}/g, (_, name) => String(vars[name]))
  assert.equal(api.formatClock(9, 5, '12h', zhT), '上午 9:05')
  assert.equal(api.formatClock(14, 5, '12h', zhT), '下午 2:05')
})

test('the 12-hour setting reaches the timestamps and the rule', () => {
  const view = api.describe(at('2026-11-19', '13:08'), t, {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
  }, { icon: 'sunMoon', clock: '12h', detail: 'all' })
  assert.match(view.tooltip, /Beijing: Thu 2026-11-19 1:08 PM/)
  assert.match(view.tooltip, /Peak: Monday to Friday 9:00 AM-12:00 PM and 2:00 PM-6:00 PM/)
  assert.match(view.tooltip, /Next: peak in .*Thu 2026-11-19 2:00 PM Beijing/)
})

test('minimal details without a balance keep the state and the next switch', () => {
  const view = api.describe(at('2026-11-19', '13:08'), t, {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
  }, { icon: 'sunMoon', clock: '24h', detail: 'minimal' })
  assert.equal(view.lines.length, 2)
  assert.match(view.tooltip, /^Off-peak rate/)
  assert.match(view.tooltip, /\nNext: peak in/)
  assert.equal(view.tooltip.includes('Beijing:'), false)
  assert.equal(view.tooltip.includes('Peak: Monday'), false)
  assert.equal(view.tooltip.includes('DeepSeek route'), false)
})

test('the settings choice group updates through its callback', () => {
  const changes = []
  const group = api.choiceGroup({
    label: 'Icon',
    value: 'sunMoon',
    onChange: value => changes.push(value),
    options: [
      { value: 'sunMoon', label: 'Sun and moon' },
      { value: 'dot', label: 'Dot' },
    ],
  })
  assert.equal(group.props.role, 'group')
  assert.equal(group.props['aria-label'], 'Icon')
  assert.equal(group.children.length, 2)
  assert.equal(group.children[1].props['aria-pressed'], false)
  group.children[1].props.onClick()
  assert.deepEqual(changes, ['dot'])
})

test('the settings page renders the preference rows and the balance status', () => {
  const page = api.settingsPage({ t })
  assert.equal(page.props.className, 'ppp_settings')
  assert.ok(page.children.some(child => child.type === 'h2' && child.children[0] === 'Display settings'))
  const rows = page.children.filter(child => child.type === 'div' && child.props.className === 'ppp_settingRow')
  assert.equal(rows.length, 5)
  assert.deepEqual(rows.map(row => row.children[0].children[0].children[0]), [
    'Icon', 'Clock', 'Details', 'Balance', 'Balance source',
  ])
  const balanceRow = rows[3]
  assert.equal(balanceRow.children[1].type, api.choiceGroup)
  assert.equal(balanceRow.children[1].props.value, 'show')
  assert.deepEqual(balanceRow.children[1].props.options.map(option => option.value), ['show', 'hide'])
  const statusRow = rows[4]
  assert.equal(statusRow.children[1].props.className, 'ppp_balanceValue')
  assert.equal(statusRow.children[1].props['aria-live'], 'polite')
  assert.equal(statusRow.children[1].children[0], 'Checking…')
  assert.ok(page.children.some(child => child.type === 'button' && child.props.className === 'ppp_reset'))
})

test('the balance source follows the DeepSeek route', () => {
  assert.equal(api.balanceSource('deepseek-account'), 'account')
  assert.equal(api.balanceSource('deepseek-official'), 'apiKey')
  assert.equal(api.balanceSource('deepseek'), 'apiKey')
  assert.equal(api.balanceSource('deepseek-custom'), 'auto')
  assert.equal(api.balanceSource('openrouter'), 'auto')
  assert.equal(api.balanceSource(null), 'auto')
})

test('the balance response is validated before display', () => {
  const wallets = [{ currency: 'CNY', total: '110.00', toppedUp: '100.00', granted: '10.00' }]
  assert.deepEqual(api.normalizeBalanceResponse({
    status: 'ready', source: 'apiKey', available: true, checkedAt: 7, wallets,
  }), { status: 'ready', source: 'apiKey', available: true, checkedAt: 7, wallets })
  assert.deepEqual(api.normalizeBalanceResponse({ status: 'unconfigured' }), { status: 'unconfigured' })
  assert.deepEqual(api.normalizeBalanceResponse({
    status: 'failed', code: 'unauthorized', source: 'account', checkedAt: 9,
  }), { status: 'failed', code: 'unauthorized', source: 'account', checkedAt: 9 })
  assert.equal(api.normalizeBalanceResponse({ status: 'failed', code: 'mystery', checkedAt: 9 }).code, 'failed')
  assert.equal(api.normalizeBalanceResponse({ status: 'ready', source: 'apiKey', wallets: [] }).code, 'protocol')
  assert.equal(api.normalizeBalanceResponse({
    status: 'ready', source: 'apiKey', wallets: [{ ...wallets[0], currency: 'EUR' }],
  }).code, 'protocol')
  assert.equal(api.normalizeBalanceResponse({
    status: 'ready', source: 'apiKey', wallets: [{ currency: 'CNY', total: '1,000', toppedUp: '1', granted: '0' }],
  }).code, 'protocol')
  assert.equal(api.normalizeBalanceResponse({
    status: 'ready', source: 'apiKey', wallets: [
      { currency: 'CNY', total: '1.00', toppedUp: '1.00', granted: '0.00' },
      { currency: 'CNY', total: '2.00', toppedUp: '2.00', granted: '0.00' },
    ],
  }).code, 'protocol')
  assert.equal(api.normalizeBalanceResponse(null).code, 'protocol')
})

test('money formatting keeps symbols, grouping, and sub-cent values', () => {
  assert.equal(api.formatMoney('110', 'CNY'), '¥110.00')
  assert.equal(api.formatMoney('1234.5', 'USD'), '$1,234.50')
  assert.equal(api.formatMoney('0.004', 'USD'), '<$0.01')
  assert.equal(api.formatMoney('0', 'USD'), '$0.00')
  assert.equal(api.formatMoney('-1.5', 'CNY'), '-¥1.50')
  assert.equal(api.formatMoney('not a number', 'CNY'), '¥—')
})

test('the balance monitor polls, records, and stops', async () => {
  const flush = () => new Promise(resolve => setTimeout(resolve, 0))
  const states = []
  const recorded = []
  const listeners = {
    added: [],
    removed: [],
    add(type, handler) { this.added.push([type, handler]) },
    remove(type) { this.removed.push(type) },
  }
  let tick = null
  let cleared = null
  let visible = true
  let clock = 1000
  const values = [
    { status: 'ready', source: 'apiKey', checkedAt: 1000, wallets: [{ currency: 'CNY', total: '100.00', toppedUp: '100.00', granted: '0.00' }] },
    { status: 'ready', source: 'apiKey', checkedAt: 2000, wallets: [{ currency: 'CNY', total: '99.00', toppedUp: '99.00', granted: '0.00' }] },
  ]
  const lastValue = values[1]
  const monitor = api.createBalanceMonitor({
    source: 'apiKey',
    fetchValue: async () => values.shift() ?? lastValue,
    recordValue: (value, at) => {
      recorded.push({ value, at })
      return { spentToday: { CNY: 1 }, toppedUpToday: { CNY: 0 } }
    },
    onState: state => states.push(state),
    now: () => clock,
    setIntervalImpl: (callback, delay) => {
      tick = { callback, delay }
      return tick
    },
    clearIntervalImpl: handle => { cleared = handle },
    listeners,
    isVisible: () => visible,
  })
  await monitor.run(true)
  assert.equal(states.length, 1)
  assert.equal(states[0].status, 'ready')
  assert.equal(states[0].requestedSource, 'apiKey')
  assert.equal(states[0].spend.spentToday.CNY, 1)
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].at, 1000)
  assert.equal(tick.delay, api.BALANCE_POLL_MS)

  clock = 61_000
  tick.callback()
  await flush()
  assert.equal(states.length, 2)
  assert.equal(recorded.length, 2)
  assert.equal(recorded[1].at, 2000)

  // Returning to a visible tab inside the cache window does not read again.
  clock = 62_000
  listeners.added.find(([type]) => type === 'visibilitychange')[1]()
  await flush()
  assert.equal(states.length, 2)

  // Returning after the cache window reads again.
  clock = 100_000
  listeners.added.find(([type]) => type === 'visibilitychange')[1]()
  await flush()
  assert.equal(states.length, 3)

  monitor.stop()
  assert.equal(cleared, tick)
  assert.deepEqual(listeners.removed, ['visibilitychange', 'online'])
})

test('the balance monitor keeps the last value through a failed poll', async () => {
  const flush = () => new Promise(resolve => setTimeout(resolve, 0))
  const ready = { status: 'ready', source: 'apiKey', checkedAt: 1, wallets: [{ currency: 'CNY', total: '100.00', toppedUp: '100.00', granted: '0.00' }] }
  let mode = 'ready'
  let tick = null
  const states = []
  const monitor = api.createBalanceMonitor({
    source: 'apiKey',
    fetchValue: async () => {
      if (mode === 'throw') throw new TypeError('offline')
      if (mode === 'failed') return { status: 'failed', code: 'network' }
      return ready
    },
    recordValue: () => null,
    onState: state => states.push(state),
    now: () => 0,
    setIntervalImpl: callback => {
      tick = callback
      return 1
    },
    clearIntervalImpl: () => {},
  })
  await monitor.run(true)
  assert.equal(states.length, 1)
  assert.equal(states[0].status, 'ready')

  mode = 'throw'
  tick()
  await flush()
  assert.equal(states.length, 1, 'a thrown poll keeps the last value')

  mode = 'failed'
  tick()
  await flush()
  assert.equal(states.length, 1, 'a failed poll keeps the last value')
  monitor.stop()

  const firstStates = []
  mode = 'throw'
  const failing = api.createBalanceMonitor({
    source: 'apiKey',
    fetchValue: async () => { throw new TypeError('offline') },
    recordValue: () => null,
    onState: state => firstStates.push(state),
    now: () => 0,
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
  })
  await failing.run(true)
  assert.equal(firstStates.length, 1)
  assert.equal(firstStates[0].status, 'failed')
  failing.stop()
})

test('the ledger accumulates same-day drops and top-ups', () => {
  const wallet = (total, currency = 'CNY') => ({
    status: 'ready', source: 'apiKey', checkedAt: 0,
    wallets: [{ currency, total, toppedUp: total, granted: '0.00' }],
  })
  const noon = new Date(2026, 10, 18, 12, 0, 0).getTime()
  assert.deepEqual(api.recordBalanceReading(wallet('100.00'), noon), {
    spentToday: { CNY: 0 }, toppedUpToday: { CNY: 0 },
  })
  assert.deepEqual(api.recordBalanceReading(wallet('98.50'), noon + 60_000), {
    spentToday: { CNY: 1.5 }, toppedUpToday: { CNY: 0 },
  })
  assert.deepEqual(api.recordBalanceReading(wallet('97.00'), noon + 120_000), {
    spentToday: { CNY: 3 }, toppedUpToday: { CNY: 0 },
  })
  assert.deepEqual(api.recordBalanceReading(wallet('102.00'), noon + 180_000), {
    spentToday: { CNY: 3 }, toppedUpToday: { CNY: 5 },
  })
  assert.deepEqual(api.readTodaySpend(wallet('102.00'), noon + 180_000), {
    spentToday: { CNY: 3 }, toppedUpToday: { CNY: 5 },
  })
  // A gap larger than fifteen minutes re-seeds rather than attributing old usage.
  assert.deepEqual(api.recordBalanceReading(wallet('100.00'), noon + 180_000 + 16 * 60_000), {
    spentToday: { CNY: 3 }, toppedUpToday: { CNY: 5 },
  })
  assert.deepEqual(api.recordBalanceReading(wallet('99.00'), noon + 180_000 + 17 * 60_000), {
    spentToday: { CNY: 4 }, toppedUpToday: { CNY: 5 },
  })
})

test('the ledger keeps sources, currencies, and days apart', () => {
  const balance = (source, currency, total) => ({
    status: 'ready', source, checkedAt: 0,
    wallets: [{ currency, total, toppedUp: total, granted: '0.00' }],
  })
  const noon = new Date(2026, 10, 18, 12, 0, 0).getTime()
  api.recordBalanceReading(balance('apiKey', 'CNY', '100.00'), noon)
  api.recordBalanceReading(balance('account', 'CNY', '100.00'), noon)
  api.recordBalanceReading(balance('apiKey', 'CNY', '90.00'), noon + 60_000)
  api.recordBalanceReading(balance('account', 'CNY', '80.00'), noon + 60_000)
  assert.deepEqual(api.readTodaySpend(balance('apiKey', 'CNY', '90.00'), noon + 60_000).spentToday, { CNY: 10 })
  assert.deepEqual(api.readTodaySpend(balance('account', 'CNY', '80.00'), noon + 60_000).spentToday, { CNY: 20 })

  const nextDay = new Date(2026, 10, 19, 0, 1, 0).getTime()
  api.recordBalanceReading(balance('apiKey', 'CNY', '70.00'), nextDay)
  assert.deepEqual(api.readTodaySpend(balance('apiKey', 'CNY', '70.00'), nextDay).spentToday, { CNY: 0 })
})

test('the ledger separates currencies', () => {
  const balance = (cny, usd) => ({
    status: 'ready', source: 'apiKey', checkedAt: 0,
    wallets: [
      { currency: 'CNY', total: cny, toppedUp: cny, granted: '0.00' },
      { currency: 'USD', total: usd, toppedUp: usd, granted: '0.00' },
    ],
  })
  const noon = new Date(2026, 10, 18, 12, 0, 0).getTime()
  api.recordBalanceReading(balance('100.00', '50.00'), noon)
  const after = balance('90.00', '47.50')
  assert.deepEqual(api.recordBalanceReading(after, noon + 60_000).spentToday, { CNY: 10, USD: 2.5 })
  assert.deepEqual(api.readTodaySpend(after, noon + 60_000).toppedUpToday, { CNY: 0, USD: 0 })
})

test('the ledger tolerates blocked storage and keeps eight days', () => {
  const wallet = (total) => ({
    status: 'ready', source: 'apiKey', checkedAt: 0,
    wallets: [{ currency: 'CNY', total, toppedUp: total, granted: '0.00' }],
  })
  for (let index = 0; index < 10; index += 1) {
    api.recordBalanceReading(wallet('100.00'), new Date(2026, 10, 1 + index, 12).getTime())
  }
  assert.equal(Object.keys(api.readLedger().days).length, api.BALANCE_DAY_LIMIT)

  const original = globalThis.localStorage
  try {
    globalThis.localStorage = {
      getItem: () => null,
      setItem: () => { throw new Error('blocked') },
      removeItem: () => {},
    }
    assert.equal(api.recordBalanceReading(wallet('99.00'), Date.now()), null)
  } finally {
    globalThis.localStorage = original
  }
})

test('the card shows balance, split, tracked today, and top-ups', () => {
  const balance = {
    status: 'ready', source: 'apiKey', requestedSource: 'apiKey', checkedAt: 1, available: true,
    wallets: [{ currency: 'CNY', total: '110.00', toppedUp: '100.00', granted: '10.00' }],
    spend: { spentToday: { CNY: 1.2 }, toppedUpToday: { CNY: 5 } },
  }
  const settings = { icon: 'sunMoon', clock: '24h', detail: 'all', balance: 'show' }
  const route = { provider: 'deepseek-official', model: 'deepseek-flash' }
  const view = api.describe(at('2026-11-19', '13:08'), t, route, settings, balance)
  assert.match(view.tooltip, /Off-peak rate[^\n]*\nBalance: ¥110\.00/)
  assert.ok(view.tooltip.includes('Topped up ¥100.00 · Granted ¥10.00'))
  assert.match(view.tooltip, /Tracked today: ¥1\.20/)
  assert.match(view.tooltip, /Topped up today: ¥5\.00/)
  const noTopUp = { ...balance, spend: { spentToday: { CNY: 1.2 }, toppedUpToday: { CNY: 0 } } }
  assert.equal(api.describe(at('2026-11-19', '13:08'), t, route, settings, noTopUp).tooltip.includes('Topped up today'), false)
  const hidden = api.describe(at('2026-11-19', '13:08'), t, route, { ...settings, balance: 'hide' }, balance)
  assert.equal(hidden.tooltip.includes('Balance:'), false)
  const minimal = api.describe(at('2026-11-19', '13:08'), t, route, { ...settings, detail: 'minimal' }, balance)
  assert.match(minimal.tooltip, /\nBalance: ¥110\.00/)
  assert.match(minimal.tooltip, /Tracked today: ¥1\.20/)
  assert.match(minimal.tooltip, /\nNext: /)
  assert.equal(minimal.tooltip.includes('Beijing:'), false)
  const minimalHidden = api.describe(at('2026-11-19', '13:08'), t, route, { ...settings, detail: 'minimal', balance: 'hide' }, balance)
  assert.equal(minimalHidden.tooltip.includes('Balance:'), false)
  assert.equal(minimalHidden.lines.length, 2)
})

test('balance failures and missing sources stay short', () => {
  assert.match(api.balanceLines({ status: 'loading' }, t)[0], /checking/)
  assert.match(api.balanceLines({ status: 'unconfigured', requestedSource: 'apiKey' }, t)[0], /API key/)
  assert.match(api.balanceLines({ status: 'unconfigured', requestedSource: 'account' }, t)[0], /sign in/)
  assert.match(api.balanceLines({ status: 'failed', code: 'unauthorized', requestedSource: 'apiKey' }, t)[0], /rejected/)
  assert.match(api.balanceLines({ status: 'failed', code: 'network', requestedSource: 'apiKey' }, t)[0], /unavailable/)
  assert.match(api.balanceLines({ status: 'failed', code: 'missing' }, t)[0], /restart/i)
  const ready = {
    status: 'ready', source: 'apiKey',
    wallets: [{ currency: 'USD', total: '0.00', toppedUp: '0.00', granted: '0.00' }],
    available: false,
  }
  assert.ok(api.balanceLines(ready, t).some(line => line.includes('too low')))
})

test('the settings status names the source without the amounts', () => {
  const status = {
    status: 'ready', source: 'apiKey', checkedAt: 1,
    wallets: [{ currency: 'CNY', total: '110.00', toppedUp: '100.00', granted: '10.00' }],
    spend: { spentToday: { CNY: 1.2 }, toppedUpToday: { CNY: 0 } },
  }
  const text = api.balanceStatusText(status, t)
  assert.equal(text, 'API key')
  assert.equal(text.includes('¥'), false)
  assert.equal(api.balanceStatusText({ ...status, source: 'account' }, t), 'Account')
  assert.equal(api.balanceStatusText({ status: 'hidden' }, t), 'Hidden')
  assert.equal(api.balanceStatusText({ status: 'loading' }, t), 'Checking…')
  assert.equal(api.balanceStatusText({ status: 'unconfigured' }, t), 'No key or sign-in')
  assert.equal(api.balanceStatusText({ status: 'failed', code: 'unauthorized' }, t), 'Credential rejected')
  assert.equal(api.balanceStatusText({ status: 'failed', code: 'missing' }, t), 'Restart the Harness')
})

test('the balance route read validates, caches, and retries failures', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  const payload = {
    status: 'ready', source: 'apiKey', available: true, checkedAt: 1,
    wallets: [{ currency: 'CNY', total: '110.00', toppedUp: '100.00', granted: '10.00' }],
  }
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const first = await api.fetchBalance('apiKey')
    assert.equal(first.status, 'ready')
    assert.equal(calls[0].url, '/peak-price-pal/balance?source=apiKey')
    assert.equal(calls[0].init.credentials, 'same-origin')
    assert.equal(calls[0].init.cache, 'no-store')
    const second = await api.fetchBalance('apiKey')
    assert.equal(second, first)
    assert.equal(calls.length, 1)

    calls.length = 0
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init })
      return new Response('nope', { status: 500 })
    }
    assert.equal((await api.fetchBalance('account')).code, 'failed')
    assert.equal((await api.fetchBalance('account')).code, 'failed')
    assert.equal(calls.length, 2, 'a failure is not cached')

    globalThis.fetch = async () => new Response('not json', { status: 200 })
    assert.equal((await api.fetchBalance('auto')).code, 'protocol')

    globalThis.fetch = async () => new Response('not found', { status: 404 })
    assert.equal((await api.fetchBalance('auto')).code, 'missing')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('the client and Host agree on the balance route', () => {
  const hostSource = readFileSync(join(root, 'index.js'), 'utf8')
  assert.ok(hostSource.includes(`'${api.BALANCE_PATH}'`))
  assert.equal(api.BALANCE_PATH, '/peak-price-pal/balance')
})

test('the provider gate is DeepSeek-only', () => {
  for (const provider of ['deepseek', 'deepseek-official', 'deepseek-account', 'DEEPSEEK-API', 'deepseek_proxy']) {
    assert.equal(api.isDeepSeekProvider(provider), true, provider)
  }
  for (const provider of ['openrouter', 'openai', 'ds-deepseek', 'deepseekx', '', null, undefined, 42]) {
    assert.equal(api.isDeepSeekProvider(provider), false, String(provider))
  }
})

test('route normalization keeps the provider and model pair', () => {
  assert.deepEqual(api.routeOf({ provider: 'deepseek-official', model: 'deepseek-flash' }), {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
  })
  assert.deepEqual(api.routeOf({ provider: 'deepseek-official' }), {
    provider: 'deepseek-official',
    model: '',
  })
  assert.equal(api.routeOf({ provider: '  ' }), null)
  assert.equal(api.routeOf(null), null)
  assert.deepEqual(api.snapshotRoute({
    current: { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash-1017' },
  }), {
    provider: 'openrouter',
    model: 'deepseek/deepseek-v4.1-flash-1017',
  })
  assert.equal(api.snapshotRoute({ current: null }), null)
  assert.deepEqual(api.projectionRoute({
    next: null,
    lastUsed: { provider: 'deepseek', model: 'deepseek-flash' },
  }), {
    provider: 'deepseek',
    model: 'deepseek-flash',
  })
  assert.deepEqual(api.projectionRoute({
    next: { provider: 'deepseek-account', model: 'deepseek-v4-pro' },
  }), {
    provider: 'deepseek-account',
    model: 'deepseek-v4-pro',
  })
  assert.equal(api.projectionRoute(undefined), null)
})

test('a missing directory service or store resolves to null', () => {
  const ctx = {
    get: name => (name === 'modelDirectories' ? { directoryFor: () => ({ store: fakeStore }) } : undefined),
  }
  assert.equal(api.directoryStore(ctx, 'session-1'), fakeStore)
  assert.equal(api.directoryStore({ get: () => undefined }, 'session-1'), null)
  assert.equal(api.directoryStore(ctx, undefined), null)
  assert.equal(api.directoryStore({ get: () => { throw new Error('no service') } }, 'session-1'), null)
  assert.equal(api.directoryStore({
    get: () => ({ directoryFor: () => { throw new Error('no session') } }),
  }, 'session-1'), null)
})

test('the holiday table covers 2026 and 2027', () => {
  assert.deepEqual(api.holidayYears, [2026, 2027])
  assert.equal(api.holidayCount, 62)
  assert.deepEqual(api.holidayFor('2026-02-15'), { key: 'springFestival', year: 2026 })
  assert.deepEqual(api.holidayFor('2027-10-07'), { key: 'nationalDay', year: 2027 })
  assert.equal(api.holidayFor('2026-02-24'), null)
  for (const key of api.HOLIDAY_KEYS) {
    assert.ok(api.EN[`holiday.${key}`], `English label for ${key}`)
    assert.ok(api.ZH[`holiday.${key}`], `Chinese label for ${key}`)
  }
  for (const schedule of Object.values(api.HOLIDAY_SCHEDULE)) {
    for (const block of schedule.blocks) {
      assert.ok(api.HOLIDAY_KEYS.includes(block.key), `known holiday key ${block.key}`)
    }
  }
})

test('the Beijing clock is independent of the host time zone', () => {
  const parts = api.beijingParts(Date.parse('2026-11-19T01:00:00Z'))
  assert.equal(parts.hour, 9)
  assert.equal(parts.minute, 0)
  assert.equal(parts.dateKey, '2026-11-19')
  assert.equal(api.isPeak(Date.parse('2026-11-19T01:00:00Z')), true)
  assert.equal(api.isPeak(Date.parse('2026-11-19T05:00:00Z')), false)
  assert.match(api.beijingStamp(at('2026-11-19', '13:08'), t), /^Thu 2026-11-19 13:08$/)
  assert.match(api.localStamp(at('2026-11-19', '13:08'), t), /^[A-Z][a-z]{2} \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
})

test('today status names a workday, a weekend, and a holiday', () => {
  assert.match(api.todayStatus(at('2026-11-19', '10:00'), t), /workday/)
  assert.match(api.todayStatus(at('2026-11-21', '10:00'), t), /weekend/)
  assert.match(api.todayStatus(at('2026-10-01', '10:00'), t), /holiday/)
})

test('the hover text carries the state, time, rule, and route', () => {
  const view = api.describe(at('2026-11-19', '13:08'), t, {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
  })
  assert.equal(view.peak, false)
  assert.match(view.tooltip, /Off-peak rate/)
  assert.match(view.tooltip, /Beijing:/)
  assert.match(view.tooltip, /Next: peak in/)
  assert.match(view.tooltip, /Peak: Monday to Friday/)
  assert.match(view.tooltip, /Today in Beijing: a workday/)
  assert.match(view.tooltip, /DeepSeek route: deepseek-official \/ deepseek-flash/)
  const flattened = view.lines.map(line => line.map(segment => segment.text).join('')).join('\n')
  assert.equal(flattened, view.tooltip)
  const firstLine = view.lines[0]
  assert.ok(firstLine.some(segment => segment.tone === 'offPeak' && segment.text === 'Off-peak'))
  assert.ok(firstLine.some(segment => segment.tone === 'peak' && segment.text === 'peak'))
  const nextLine = view.lines.find(line => line.map(segment => segment.text).join('').startsWith('Next:'))
  assert.ok(nextLine.some(segment => segment.tone === 'peak'))
  const ruleLine = view.lines.find(line => line.map(segment => segment.text).join('').startsWith('Peak:'))
  assert.ok(ruleLine.some(segment => segment.tone === 'peak'))
  const peakView = api.describe(at('2026-11-19', '10:00'), t, {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
  })
  assert.equal(peakView.peak, true)
  assert.match(peakView.tooltip, /Peak rate/)
  const missing = api.describe(Date.parse('2028-11-16T02:00:00Z'), t, {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
  })
  assert.match(missing.tooltip, /Chinese holiday calendar for 2028 is not bundled/)
  const yearBoundary = api.describe(at('2027-12-31', '18:30'), t, {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
  })
  assert.match(yearBoundary.tooltip, /Chinese holiday calendar for 2028 is not bundled/)
})

test('the colored words pick the longer term first', () => {
  const segments = api.highlightWords('Off-peak and peak', [
    { word: 'peak', tone: 'peak' },
    { word: 'Off-peak', tone: 'offPeak' },
  ])
  assert.deepEqual(segments.map(segment => [segment.text, segment.tone]), [
    ['Off-peak', 'offPeak'],
    [' and ', null],
    ['peak', 'peak'],
  ])
  assert.deepEqual(api.highlightWords('plain', []), [{ text: 'plain', tone: null }])
})

test('the Chinese hover segments use the Chinese state words', () => {
  const zhT = (key, vars) => api.ZH[key].replace(/\{(\w+)\}/g, (_, name) => String(vars[name]))
  const view = api.describe(at('2026-11-19', '13:08'), zhT, {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
  })
  const firstLine = view.lines[0]
  assert.ok(firstLine.some(segment => segment.tone === 'offPeak' && segment.text === '空闲'))
  assert.ok(firstLine.some(segment => segment.tone === 'peak' && segment.text === '高峰'))
})

test('the English and Chinese dictionaries stay in step', () => {
  const enKeys = Object.keys(api.EN).sort()
  const zhKeys = Object.keys(api.ZH).sort()
  assert.deepEqual(zhKeys, enKeys)
  const placeholders = value => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
  for (const key of enKeys) {
    assert.deepEqual(placeholders(api.ZH[key]), placeholders(api.EN[key]), `placeholders for ${key}`)
  }
})

test('the manifest, patch, locale, and display files are complete', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'dsh-peak-price-pal')
  assert.equal(manifest.version, '0.5.0')
  assert.equal(manifest.license, 'MIT')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.dsh.client.immediately, true)
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'))
  assert.equal(manifest.exports['./client'], './client.js')
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
  assert.equal(manifest.exports['./icon'], './icon.svg')
  assert.ok(manifest.files.includes('client.js'))
  assert.ok(manifest.files.includes('index.js'))
  assert.ok(manifest.files.includes('docs'))
  assert.equal(manifest.exports['.'], './index.js')

  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /id: peak-price-pal/)
  assert.match(patch, /name: dsh-peak-price-pal/)

  const enMeta = JSON.parse(readFileSync(join(root, 'locale/en.json'), 'utf8'))
  const zhMeta = JSON.parse(readFileSync(join(root, 'locale/zh.json'), 'utf8'))
  assert.equal(enMeta.meta.title, 'Peak Price Pal')
  assert.ok(enMeta.meta.description.length > 40)
  assert.equal(enMeta.meta.detail, 'docs/DETAIL.md')
  assert.equal(zhMeta.meta.detail, 'docs/DETAIL.zh.md')
  assert.ok(readFileSync(join(root, 'docs/DETAIL.md'), 'utf8').includes('preview.svg'))
  assert.ok(readFileSync(join(root, 'docs/DETAIL.zh.md'), 'utf8').includes('preview.svg'))

  const icon = readFileSync(join(root, 'icon.svg'), 'utf8')
  assert.match(icon, /<svg[^>]*width="36"[^>]*height="36"/)
  const preview = readFileSync(join(root, 'docs/preview.svg'), 'utf8')
  assert.match(preview, /<svg[^>]*width="640"[^>]*height="300"/)
  for (const file of [icon, preview]) {
    for (const forbidden of ['<script', '<style', '<text', '<image', '<foreignObject', '<animate']) {
      assert.equal(file.includes(forbidden), false, forbidden)
    }
  }
})

test('the client keeps the no-dependency contract and the CSS order', () => {
  const source = readFileSync(join(root, 'client.js'), 'utf8')
  assert.match(source, /window\.__ModuleLoader__\.load/)
  assert.match(source, /id: 'dsh-peak-price-pal'/)
  assert.match(source, /require\('react'\)/)
  assert.match(source, /require\('react-dom'\)/)
  assert.equal(source.includes('@deepseek-ai/dsh-client-'), false)
  assert.equal(/#[0-9a-f]{3,8}/i.test(api.CSS), false)
  assert.match(api.CSS, /order:1/)
  assert.match(api.CSS, /--dsw-alias-state-warn-primary/)
  assert.match(api.CSS, /--dsw-alias-state-success-primary/)
  assert.match(api.CSS, /--dsw-alias-interactive-bg-hover/)
  assert.match(api.CSS, /border-radius:999px/)
  assert.ok(api.CSS.includes('color-mix(in srgb, var(--dsw-alias-state-warn-primary) 75%'))
  assert.ok(api.CSS.includes('color-mix(in srgb, var(--dsw-alias-state-success-primary) 75%'))
  assert.ok(api.CSS.includes('.ppp_sr{'))
  assert.ok(api.CSS.includes('.ppp_card{'))
  assert.ok(api.CSS.includes('.ppp_tonePeak{'))
  assert.ok(api.CSS.includes('.ppp_toneOffPeak{'))
  assert.ok(api.CSS.includes('@position-try --ppp-card-end'))
  assert.ok(api.CSS.includes('anchor(top)'))
  assert.ok(api.CSS.includes(':focus-visible'))
  assert.ok(api.CSS.includes('.ppp_settings{'))
  assert.ok(api.CSS.includes('.ppp_settingRow{'))
  assert.ok(api.CSS.includes('.ppp_choice{'))
  assert.ok(api.CSS.includes('.ppp_balanceValue{'))
  assert.ok(api.CSS.includes('--dsw-alias-bg-layer-2'))
})

test('apply registers the dock entry and the settings tab', () => {
  const registrations = []
  const injectedSlots = []
  const ctx = {
    effect(callback) {
      const dispose = callback()
      assert.equal(typeof dispose, 'function')
    },
    locale: {
      register: () => () => {},
      bind: () => (key, vars) => api.translateFallback(key, vars),
    },
    get: name => (name === 'modelDirectories' ? { directoryFor: () => ({ store: fakeStore }) } : undefined),
    slots: {
      inject(slot, callback) {
        injectedSlots.push(slot)
        callback()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  assert.deepEqual(plugin.inject, ['slots', 'locale'])
  plugin.apply(ctx)
  assert.deepEqual(injectedSlots, ['conversation.composer.dock', 'settings.plugins.tab'])
  assert.equal(registrations.length, 2)
  const dock = registrations.find(entry => entry.options.name === 'conversation.composer.dock')
  assert.equal(dock.options.id, 'peak-price-pal')
  assert.equal(dock.options.order, 30)
  assert.equal(dock.options.locale, 'peak-price-pal')
  assert.equal(dock.component, api.component)
  const face = dock.options.inject('session-1')
  assert.equal(face.modelStore, fakeStore)
  assert.equal(typeof face.fallbackT, 'function')
  const tab = registrations.find(entry => entry.options.name === 'settings.plugins.tab')
  assert.equal(tab.options.id, 'peak-price-pal')
  assert.equal(tab.options.order, 100)
  assert.equal(tab.options.locale, 'peak-price-pal')
  assert.equal(tab.component, api.settingsPage)
  assert.equal(tab.options.label(), 'Peak Price Pal')
  assert.equal(windowListeners.filter(entry => entry.type === 'storage').length, 1)
})

test('the component hides on a third-party route and on a subagent', () => {
  const common = {
    t,
    useProjection: () => undefined,
    useSession: () => null,
  }
  const visible = api.component({
    ...common,
    modelStore: makeStore({ provider: 'deepseek-official', model: 'deepseek-flash' }),
  })
  assert.notEqual(visible, null)
  assert.equal(visible.type, api.live)
  const openrouter = api.component({
    ...common,
    modelStore: makeStore({ provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash-1017' }),
  })
  assert.equal(openrouter, null)
  const subagent = api.component({
    ...common,
    modelStore: makeStore({ provider: 'deepseek-official', model: 'deepseek-flash' }),
    useSession: () => ({ subagent: { address: {} } }),
  })
  assert.equal(subagent, null)
  const unknown = api.component({
    ...common,
    modelStore: makeStore(null),
  })
  assert.equal(unknown, null)
})

test('the live logo is focusable and exposes the full description', () => {
  const tree = api.live({
    route: { provider: 'deepseek-official', model: 'deepseek-flash' },
    t,
  })
  assert.equal(tree.type, React.Fragment)
  const span = tree.children.find(child => child.type === 'span')
  assert.ok(span, 'the logo span renders')
  assert.equal(span.props.role, 'img')
  assert.equal(span.props.tabIndex, 0)
  assert.equal(span.props.style.anchorName, '--ppp-anchor-r0')
  assert.equal(span.props.title, undefined)
  assert.match(span.props.className, /ppp/)
  assert.ok(['peak', 'off-peak'].includes(span.props['data-peak-price-pal']))
  assert.match(span.props['aria-label'], /^Peak Price Pal: (peak|off-peak) rate$/)
  assert.equal(span.props['aria-describedby'], 'ppp-desc-r0')
  const hidden = span.children.find(child => child.type === 'span' && child.props.className === 'ppp_sr')
  assert.ok(hidden, 'the full description is exposed to assistive technology')
  assert.equal(hidden.props.id, 'ppp-desc-r0')
  assert.match(hidden.children.join(' '), /DeepSeek route: deepseek-official \/ deepseek-flash/)
  assert.equal(tree.children.includes(null), true, 'the card stays closed until hover or focus')
})

test('the live logo follows the dot icon setting', () => {
  api.settings.update({ icon: 'dot' })
  const tree = api.live({
    route: { provider: 'deepseek-official', model: 'deepseek-flash' },
    t,
  })
  const span = tree.children.find(child => child.type === 'span')
  assert.ok(span)
  assert.equal(span.children[0].type, api.dotGlyph)
})

test('the live description follows the minimal detail setting', () => {
  api.settings.update({ detail: 'minimal' })
  const tree = api.live({
    route: { provider: 'deepseek-official', model: 'deepseek-flash' },
    t,
  })
  const span = tree.children.find(child => child.type === 'span')
  const hidden = span.children.find(child => child.type === 'span' && child.props.className === 'ppp_sr')
  const text = hidden.children.join(' ')
  assert.match(text, /^(Peak|Off-peak) rate/)
  assert.match(text, /\nNext: /)
  assert.equal(text.includes('DeepSeek route'), false)
  assert.equal(text.includes('Beijing:'), false)
})
