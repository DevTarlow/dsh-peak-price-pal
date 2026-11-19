/**
 * Peak Price Pal test harness.
 *
 * Loads the browser module in Node with a tiny React stub, then checks the
 * time math, the holiday table, the model gate, the manifest, the locale keys,
 * the icon rules, and the slot registration. No build step, no dependencies.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** Minimal React surface used by the module under test. */
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: Symbol('Fragment'),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: callback => callback(),
  useId: () => ':r0:',
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
}

/** Captured `window.__ModuleLoader__.load` definition. */
let moduleDefinition = null
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      moduleDefinition = definition
    },
  },
}

await import(new URL('../client.js', import.meta.url).href)
assert.ok(moduleDefinition, 'client.js registers a module')
const plugin = moduleDefinition.factory(name => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
})
const api = plugin.__peakPricePal
assert.ok(api, 'the module exposes its test face')

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
  assert.equal(manifest.version, '0.1.0')
  assert.equal(manifest.license, 'MIT')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.dsh.client.immediately, true)
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'))
  assert.equal(manifest.exports['./client'], './client.js')
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
  assert.equal(manifest.exports['./icon'], './icon.svg')
  assert.ok(manifest.files.includes('client.js'))
  assert.ok(manifest.files.includes('docs'))

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
})

test('apply registers the dock entry and resolves the model store', () => {
  const registrations = []
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
        assert.equal(slot, 'conversation.composer.dock')
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
  assert.equal(registrations.length, 1)
  const { options, component } = registrations[0]
  assert.equal(options.name, 'conversation.composer.dock')
  assert.equal(options.id, 'peak-price-pal')
  assert.equal(options.order, 30)
  assert.equal(options.locale, 'peak-price-pal')
  assert.equal(component, api.component)
  const face = options.inject('session-1')
  assert.equal(face.modelStore, fakeStore)
  assert.equal(typeof face.fallbackT, 'function')
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

test('the live logo renders a title with the current details', () => {
  const tree = api.live({
    route: { provider: 'deepseek-official', model: 'deepseek-flash' },
    t,
  })
  assert.equal(tree.type, React.Fragment)
  const span = tree.children.find(child => child.type === 'span')
  assert.ok(span, 'the logo span renders')
  assert.equal(span.props.role, 'img')
  assert.match(span.props.title, /Beijing:/)
  assert.match(span.props.title, /DeepSeek route: deepseek-official \/ deepseek-flash/)
  assert.match(span.props.title, /Peak rate|Off-peak rate/)
  assert.match(span.props.className, /ppp/)
  assert.ok(['peak', 'off-peak'].includes(span.props['data-peak-price-pal']))
  assert.match(span.props['aria-label'], /^Peak Price Pal: (peak|off-peak) rate$/)
  assert.match(span.props['aria-describedby'], /^ppp-desc-/)
  const hidden = span.children.find(child => child.type === 'span' && child.props.className === 'ppp_sr')
  assert.ok(hidden, 'the full description is exposed to assistive technology')
  assert.match(hidden.children.join(' '), /DeepSeek route: deepseek-official \/ deepseek-flash/)
})
