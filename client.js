/**
 * Peak Price Pal browser half.
 *
 * Registers one list entry in `conversation.composer.dock`, the row under the
 * composer card. The host renders the context-occupancy ring as the last child
 * of that flex row, so the entry root carries CSS `order: 1` to sit to its
 * right. Peak hours are fixed in Beijing time (UTC+8) and are computed from
 * UTC, never from the host time zone.
 *
 * The module requests `react` and no other package. Every style is a theme
 * token, every timer lives in the React tree, and the entry returns null on a
 * non-DeepSeek provider. There is no storage, network, or Host route.
 *
 * @module dsh-peak-price-pal
 */
window.__ModuleLoader__.load({
  id: 'dsh-peak-price-pal',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
    const { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } = React
    const { createPortal } = ReactDOM

    /** Locale namespace for the synthesized `t` seat and the meta files. */
    const NS = 'peak-price-pal'
    /** The composer's ambient row under the input card. */
    const SLOT = 'conversation.composer.dock'
    /** Stable entry id; a different id would add another cell beside the host pills. */
    const SLOT_ID = 'peak-price-pal'
    /** Position after the host's activity (0) and usage (1) entries. */
    const SLOT_ORDER = 30
    /** Beijing is UTC+8 and has no daylight saving time. */
    const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
    /** Minute of day for the two peak windows, Beijing time. */
    const PEAK_WINDOWS = [
      { start: 9 * 60, end: 12 * 60 },
      { start: 14 * 60, end: 18 * 60 },
    ]
    /** One calendar day in milliseconds; only used on UTC-midnight arithmetic. */
    const DAY_MS = 24 * 60 * 60 * 1000
    /** Upper bound on the day scan; comfortably above the longest Chinese holiday stretch. */
    const MAX_SCAN_DAYS = 62

    /** Browser-local display preferences and their versioned storage key. */
    const SETTINGS_KEY = 'dsh-peak-price-pal.settings.v1'
    const ICON_CHOICES = new Set(['sunMoon', 'dot'])
    const CLOCK_CHOICES = new Set(['24h', '12h'])
    const DETAIL_CHOICES = new Set(['all', 'minimal'])
    const BALANCE_CHOICES = new Set(['show', 'hide'])
    const DEFAULT_SETTINGS = Object.freeze({ icon: 'sunMoon', clock: '24h', detail: 'all', balance: 'show' })
    /** The Host route; keep in step with `BALANCE_PATH` in index.js. */
    const BALANCE_PATH = '/peak-price-pal/balance'
    /** The card's mounted lifetime is the polling window. */
    const BALANCE_POLL_MS = 60_000
    /** A repeated read inside this window reuses the last answer. */
    const BALANCE_CACHE_MS = 30_000
    /** The browser gives up before the account service deadline. */
    const BALANCE_TIMEOUT_MS = 20_000
    /** A larger gap is treated as a new baseline, so old usage is not blamed on today. */
    const BALANCE_MAX_GAP_MS = 15 * 60 * 1000
    /** Local daily buckets and the last reading, in this browser only. */
    const BALANCE_LEDGER_KEY = 'dsh-peak-price-pal.balance.v1'
    const BALANCE_LEDGER_VERSION = 1
    const BALANCE_DAY_LIMIT = 8
    const BALANCE_MAX_READINGS = 12
    /** Shared grammar with the Host; the client re-validates every field it displays. */
    const BALANCE_DECIMAL = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i
    const BALANCE_FAILURE_CODES = new Set(['unauthorized', 'network', 'timeout', 'protocol', 'failed', 'missing'])
    const BALANCE_MAX_DECIMAL_LENGTH = 32

    /**
     * Validate one settings value against the supported choices.
     * @param {unknown} value - Parsed settings or a partial patch.
     * @returns {{ icon: 'sunMoon' | 'dot', clock: '24h' | '12h', detail: 'all' | 'minimal', balance: 'show' | 'hide' }} A complete, frozen settings object.
     */
    function normalizeSettings(value) {
      const source = value !== null && typeof value === 'object' ? value : {}
      return Object.freeze({
        icon: ICON_CHOICES.has(source.icon) ? source.icon : DEFAULT_SETTINGS.icon,
        clock: CLOCK_CHOICES.has(source.clock) ? source.clock : DEFAULT_SETTINGS.clock,
        detail: DETAIL_CHOICES.has(source.detail) ? source.detail : DEFAULT_SETTINGS.detail,
        balance: BALANCE_CHOICES.has(source.balance) ? source.balance : DEFAULT_SETTINGS.balance,
      })
    }

    /**
     * Read the browser-local settings, falling back to defaults on bad JSON or blocked storage.
     * @returns {{ icon: 'sunMoon' | 'dot', clock: '24h' | '12h', detail: 'all' | 'minimal', balance: 'show' | 'hide' }} The stored or default settings.
     */
    function readSettings() {
      try {
        const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(SETTINGS_KEY)
        if (raw === null) return normalizeSettings(DEFAULT_SETTINGS)
        return normalizeSettings(JSON.parse(raw))
      } catch {
        return normalizeSettings(DEFAULT_SETTINGS)
      }
    }

    /**
     * Persist the settings. A blocked or full storage keeps the in-memory value only.
     * @param {{ icon: string, clock: string, detail: string, balance: string }} settings - Settings to write.
     */
    function writeSettings(settings) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
      } catch {
        // The settings still apply for this page; they just will not survive a reload.
      }
    }

    /**
     * Compare two complete settings objects.
     * @param {{ icon: string, clock: string, detail: string, balance: string }} left - First settings.
     * @param {{ icon: string, clock: string, detail: string, balance: string }} right - Second settings.
     * @returns {boolean} True when every value matches.
     */
    function sameSettings(left, right) {
      return left.icon === right.icon && left.clock === right.clock && left.detail === right.detail
        && left.balance === right.balance
    }

    /** Current settings snapshot and its subscribers. */
    let currentSettings = readSettings()
    const settingsListeners = new Set()

    /** @returns {{ icon: 'sunMoon' | 'dot', clock: '24h' | '12h', detail: 'all' | 'minimal', balance: 'show' | 'hide' }} The current settings. */
    function settingsSnapshot() {
      return currentSettings
    }

    /**
     * Subscribe to settings changes.
     * @param {() => void} listener - Called after each accepted change.
     * @returns {() => void} Unsubscribe.
     */
    function subscribeSettings(listener) {
      settingsListeners.add(listener)
      return () => settingsListeners.delete(listener)
    }

    /**
     * Replace the current settings when the values differ from the snapshot.
     * @param {{ icon: string, clock: string, detail: string, balance: string }} next - Complete settings.
     */
    function publishSettings(next) {
      if (sameSettings(currentSettings, next)) return
      currentSettings = next
      for (const listener of [...settingsListeners]) listener()
    }

    /**
     * Merge a patch into the current settings, persist, and notify.
     * @param {{ icon?: string, clock?: string, detail?: string, balance?: string }} patch - Values to change.
     * @returns {{ icon: 'sunMoon' | 'dot', clock: '24h' | '12h', detail: 'all' | 'minimal', balance: 'show' | 'hide' }} The normalized settings.
     */
    function updateSettings(patch) {
      const next = normalizeSettings({ ...currentSettings, ...patch })
      writeSettings(next)
      publishSettings(next)
      return next
    }

    /** Restore and persist the defaults. */
    function resetSettings() {
      updateSettings(DEFAULT_SETTINGS)
    }

    /** Re-read storage, for a `storage` event from another tab. */
    function reloadSettings() {
      publishSettings(readSettings())
    }

    /** Chinese public holidays, off-days only. Sources are the State Council notices. */
    const HOLIDAY_SCHEDULE = {
      2026: {
        notice: 'https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm',
        blocks: [
          { key: 'newYear', from: '2026-01-01', to: '2026-01-03' },
          { key: 'springFestival', from: '2026-02-15', to: '2026-02-23' },
          { key: 'qingming', from: '2026-04-04', to: '2026-04-06' },
          { key: 'labour', from: '2026-05-01', to: '2026-05-05' },
          { key: 'dragonBoat', from: '2026-06-19', to: '2026-06-21' },
          { key: 'midAutumn', from: '2026-09-25', to: '2026-09-27' },
          { key: 'nationalDay', from: '2026-10-01', to: '2026-10-07' },
        ],
      },
      2027: {
        notice: 'https://www.gov.cn/zhengce/zhengceku/202611/content_7085102.htm',
        blocks: [
          { key: 'newYear', from: '2027-01-01', to: '2027-01-03' },
          { key: 'springFestival', from: '2027-02-05', to: '2027-02-13' },
          { key: 'qingming', from: '2027-04-03', to: '2027-04-05' },
          { key: 'labour', from: '2027-05-01', to: '2027-05-05' },
          { key: 'dragonBoat', from: '2027-06-09', to: '2027-06-09' },
          { key: 'midAutumn', from: '2027-09-15', to: '2027-09-15' },
          { key: 'nationalDay', from: '2027-10-01', to: '2027-10-07' },
        ],
      },
    }

    /** Dictionary keys for the holiday names, in the same order as the blocks. */
    const HOLIDAY_KEYS = [
      'newYear', 'springFestival', 'qingming', 'labour',
      'dragonBoat', 'midAutumn', 'nationalDay',
    ]

    /**
     * Two-digit pad for date and clock strings.
     * @param {number} value - Integer to pad.
     * @returns {string} At least two digits.
     */
    function pad2(value) {
      return String(value).padStart(2, '0')
    }

    /**
     * Format a wall-clock hour and minute in the selected clock style.
     * @param {number} hour - 0-23.
     * @param {number} minute - 0-59.
     * @param {'24h' | '12h'} clock - Selected clock style.
     * @param {(key: string, vars?: Record<string, unknown>) => string} t - Translate seat.
     * @returns {string} `09:00` or `9:00 AM` / `上午 9:00`.
     */
    function formatClock(hour, minute, clock, t) {
      if (clock === '12h') {
        const hour12 = hour % 12 === 0 ? 12 : hour % 12
        return t('clock.time12', {
          time: `${hour12}:${pad2(minute)}`,
          period: t(hour < 12 ? 'clock.am' : 'clock.pm'),
        })
      }
      return `${pad2(hour)}:${pad2(minute)}`
    }

    /**
     * Expand an inclusive date range in `YYYY-MM-DD` form.
     * @param {string} from - First date.
     * @param {string} to - Last date, inclusive.
     * @returns {string[]} Every date key in the range.
     */
    function expandDateRange(from, to) {
      const [fromYear, fromMonth, fromDay] = from.split('-').map(Number)
      const [toYear, toMonth, toDay] = to.split('-').map(Number)
      let cursor = Date.UTC(fromYear, fromMonth - 1, fromDay)
      const end = Date.UTC(toYear, toMonth - 1, toDay)
      const dates = []
      while (cursor <= end) {
        const date = new Date(cursor)
        dates.push(`${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`)
        cursor += DAY_MS
      }
      return dates
    }

    /** Beijing date key to `{ key, year }` for every bundled off-day. */
    const HOLIDAY_INDEX = new Map()
    for (const [yearText, schedule] of Object.entries(HOLIDAY_SCHEDULE)) {
      const year = Number(yearText)
      for (const block of schedule.blocks) {
        for (const dateKey of expandDateRange(block.from, block.to)) {
          HOLIDAY_INDEX.set(dateKey, { key: block.key, year })
        }
      }
    }

    /**
     * Read the Beijing wall-clock parts of an instant.
     * @param {number} ms - Epoch milliseconds.
     * @returns {{ year: number, month: number, day: number, weekday: number, hour: number, minute: number, second: number, minutes: number, dateKey: string }} Beijing parts.
     */
    function beijingParts(ms) {
      const shifted = new Date(ms + BEIJING_OFFSET_MS)
      const year = shifted.getUTCFullYear()
      const month = shifted.getUTCMonth() + 1
      const day = shifted.getUTCDate()
      const hour = shifted.getUTCHours()
      const minute = shifted.getUTCMinutes()
      const weekday = shifted.getUTCDay()
      return {
        year,
        month,
        day,
        weekday,
        hour,
        minute,
        second: shifted.getUTCSeconds(),
        minutes: hour * 60 + minute,
        dateKey: `${year}-${pad2(month)}-${pad2(day)}`,
      }
    }

    /**
     * The holiday block for a Beijing date, if the date is a bundled off-day.
     * @param {string} dateKey - `YYYY-MM-DD`.
     * @returns {{ key: string, year: number } | null} Holiday block or null.
     */
    function holidayFor(dateKey) {
      return HOLIDAY_INDEX.get(dateKey) ?? null
    }

    /**
     * Whether an instant falls in a peak-price window.
     * @param {number} ms - Epoch milliseconds.
     * @returns {boolean} True on a weekday, non-holiday, inside 09:00-12:00 or 14:00-18:00 Beijing.
     */
    function isPeak(ms) {
      const parts = beijingParts(ms)
      if (parts.weekday === 0 || parts.weekday === 6) return false
      if (HOLIDAY_INDEX.has(parts.dateKey)) return false
      return PEAK_WINDOWS.some(windowPart => (
        parts.minutes >= windowPart.start && parts.minutes < windowPart.end
      ))
    }

    /**
     * Build the epoch milliseconds of a Beijing wall-clock time.
     * @param {number} year - Beijing year.
     * @param {number} month - 1-based Beijing month.
     * @param {number} day - Beijing day.
     * @param {number} hour - Beijing hour, 0-23.
     * @param {number} minute - Beijing minute.
     * @returns {number} Epoch milliseconds.
     */
    function beijingInstant(year, month, day, hour, minute) {
      return Date.UTC(year, month - 1, day, hour - 8, minute, 0, 0)
    }

    /**
     * Move a Beijing calendar date by whole days.
     * @param {{ year: number, month: number, day: number }} parts - Calendar parts.
     * @param {number} offset - Days to add.
     * @returns {{ year: number, month: number, day: number, weekday: number, dateKey: string }} The shifted date.
     */
    function addBeijingDays(parts, offset) {
      const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + offset))
      const year = shifted.getUTCFullYear()
      const month = shifted.getUTCMonth() + 1
      const day = shifted.getUTCDate()
      return {
        year,
        month,
        day,
        weekday: shifted.getUTCDay(),
        dateKey: `${year}-${pad2(month)}-${pad2(day)}`,
      }
    }

    /**
     * The next instant at which the billing state flips.
     * @param {number} ms - Epoch milliseconds.
     * @returns {{ at: number, peak: boolean } | null} The next boundary, or null if the scan found none.
     */
    function nextSwitch(ms) {
      if (isPeak(ms)) {
        const parts = beijingParts(ms)
        const windowPart = parts.minutes < PEAK_WINDOWS[0].end ? PEAK_WINDOWS[0] : PEAK_WINDOWS[1]
        const endHour = windowPart.end / 60
        return { at: beijingInstant(parts.year, parts.month, parts.day, endHour, 0), peak: false }
      }
      const now = beijingParts(ms)
      for (let offset = 0; offset <= MAX_SCAN_DAYS; offset += 1) {
        const day = addBeijingDays(now, offset)
        if (day.weekday === 0 || day.weekday === 6) continue
        if (HOLIDAY_INDEX.has(day.dateKey)) continue
        for (const windowPart of PEAK_WINDOWS) {
          const startHour = windowPart.start / 60
          const at = beijingInstant(day.year, day.month, day.day, startHour, 0)
          if (at > ms) return { at, peak: true }
        }
      }
      return null
    }

    /**
     * Compact countdown: days and hours, hours and minutes, or minutes.
     * @param {number} ms - Positive duration in milliseconds.
     * @param {(key: string, vars?: Record<string, unknown>) => string} [t] - Translate seat.
     * @returns {string} For example `2d 4h`, `1h 51m`, or `52m`, localized through `t`.
     */
    function durationText(ms, t = translateFallback) {
      const totalMinutes = Math.max(1, Math.ceil(ms / 60_000))
      const days = Math.floor(totalMinutes / 1_440)
      const hours = Math.floor((totalMinutes % 1_440) / 60)
      const minutes = totalMinutes % 60
      if (days > 0) {
        return hours > 0
          ? t('duration.daysHours', { days, hours })
          : t('duration.days', { days })
      }
      if (hours > 0) {
        return minutes > 0
          ? t('duration.hoursMinutes', { hours, minutes })
          : t('duration.hours', { hours })
      }
      return t('duration.minutes', { minutes })
    }

    /**
     * The browser's IANA time-zone name, or an empty string when unavailable.
     * @returns {string} Zone name such as `America/Los_Angeles`.
     */
    function localZoneName() {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''
      } catch {
        return ''
      }
    }

    /**
     * A Beijing timestamp for the hover text.
     * @param {number} ms - Epoch milliseconds.
     * @param {(key: string, vars?: Record<string, unknown>) => string} t - Translate seat.
     * @param {'24h' | '12h'} [clock] - Selected clock style.
     * @returns {string} Weekday, date, and clock in Beijing.
     */
    function beijingStamp(ms, t, clock = '24h') {
      const parts = beijingParts(ms)
      return `${t(`weekday.${parts.weekday}`)} ${parts.dateKey} ${formatClock(parts.hour, parts.minute, clock, t)}`
    }

    /**
     * A timestamp in the browser's local zone for the hover text.
     * @param {number} ms - Epoch milliseconds.
     * @param {(key: string, vars?: Record<string, unknown>) => string} t - Translate seat.
     * @param {'24h' | '12h'} [clock] - Selected clock style.
     * @returns {string} Weekday, date, and clock locally.
     */
    function localStamp(ms, t, clock = '24h') {
      const date = new Date(ms)
      const dateKey = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
      return `${t(`weekday.${date.getDay()}`)} ${dateKey} ${formatClock(date.getHours(), date.getMinutes(), clock, t)}`
    }

    /**
     * Today's Beijing status, in words.
     * @param {number} ms - Epoch milliseconds.
     * @param {(key: string, vars?: Record<string, unknown>) => string} t - Translate seat.
     * @returns {string} Workday, weekend, or a named holiday.
     */
    function todayStatus(ms, t) {
      const parts = beijingParts(ms)
      const holiday = holidayFor(parts.dateKey)
      if (holiday !== null) return t('today.holiday', { name: t(`holiday.${holiday.key}`) })
      if (parts.weekday === 0 || parts.weekday === 6) return t('today.weekend')
      return t('today.workday')
    }

    /**
     * Whether a provider id belongs to DeepSeek's own platform.
     * @param {unknown} provider - Provider id from the session route.
     * @returns {boolean} True for `deepseek`, `deepseek-official`, `deepseek-account`, and similar official ids.
     */
    function isDeepSeekProvider(provider) {
      return typeof provider === 'string' && /^deepseek(?:[-_]|$)/i.test(provider.trim())
    }

    /**
     * Normalize a `{ provider, model }` value.
     * @param {unknown} value - Selection or route object.
     * @returns {{ provider: string, model: string } | null} Normalized route, or null when the provider is absent.
     */
    function routeOf(value) {
      if (value === null || typeof value !== 'object') return null
      const provider = value.provider
      if (typeof provider !== 'string' || provider.trim() === '') return null
      return {
        provider: provider.trim(),
        model: typeof value.model === 'string' ? value.model : '',
      }
    }

    /**
     * The current route in a model directory snapshot.
     * @param {unknown} snapshot - Store snapshot from `modelDirectories`.
     * @returns {{ provider: string, model: string } | null} Current route or null.
     */
    function snapshotRoute(snapshot) {
      return snapshot !== null && typeof snapshot === 'object' ? routeOf(snapshot.current) : null
    }

    /**
     * The current route in a `modelSelection` projection.
     * @param {unknown} projection - `{ next, lastUsed }` or undefined.
     * @returns {{ provider: string, model: string } | null} Current route or null.
     */
    function projectionRoute(projection) {
      if (projection === null || typeof projection !== 'object') return null
      return routeOf(projection.next) ?? routeOf(projection.lastUsed)
    }

    /**
     * Resolve the session's model directory store, catching a missing service,
     * an unknown session, or a store that is not ready yet.
     * @param {object} ctx - Client context.
     * @param {unknown} sessionId - Slot session id.
     * @returns {object | null} The store, or null when unavailable.
     */
    function directoryStore(ctx, sessionId) {
      if (sessionId === undefined || sessionId === null || sessionId === '') return null
      try {
        const service = ctx.get('modelDirectories')
        if (service === null || service === undefined || typeof service.directoryFor !== 'function') return null
        const directory = service.directoryFor(sessionId)
        if (directory === null || directory === undefined || directory.store === undefined) return null
        return directory.store
      } catch {
        return null
      }
    }

    /**
     * Which balance source a route uses.
     * @param {string} provider - Session provider id.
     * @returns {'apiKey' | 'account' | 'auto'} Source preference.
     */
    function balanceSource(provider) {
      if (typeof provider !== 'string') return 'auto'
      const id = provider.trim()
      if (/^deepseek-account(?:[-_]|$)/i.test(id)) return 'account'
      if (/^deepseek(?:-official)?$/i.test(id)) return 'apiKey'
      return 'auto'
    }

    /**
     * Whether a value is a finite decimal string the card may format.
     * @param {unknown} value - Candidate.
     * @returns {boolean} True for a bounded decimal string.
     */
    function isDecimalString(value) {
      return typeof value === 'string'
        && value.length > 0
        && value.length <= BALANCE_MAX_DECIMAL_LENGTH
        && BALANCE_DECIMAL.test(value)
        && Number.isFinite(Number(value))
    }

    /**
     * Validate the Host's ready wallets.
     * @param {unknown} value - Candidate wallet array.
     * @returns {object[] | null} Normalized wallets or null.
     */
    function normalizeWallets(value) {
      if (!Array.isArray(value) || value.length < 1 || value.length > 4) return null
      const wallets = []
      const currencies = new Set()
      for (const wallet of value) {
        if (wallet === null || typeof wallet !== 'object') return null
        if (wallet.currency !== 'CNY' && wallet.currency !== 'USD') return null
        if (currencies.has(wallet.currency)) return null
        currencies.add(wallet.currency)
        if (!isDecimalString(wallet.total) || !isDecimalString(wallet.toppedUp) || !isDecimalString(wallet.granted)) {
          return null
        }
        wallets.push({
          currency: wallet.currency,
          total: wallet.total,
          toppedUp: wallet.toppedUp,
          granted: wallet.granted,
        })
      }
      return wallets
    }

    /**
     * Validate the Host's balance response before it reaches the card.
     * @param {unknown} value - Parsed route body.
     * @returns {object} A ready, unconfigured, or failed view.
     */
    function normalizeBalanceResponse(value) {
      if (value === null || typeof value !== 'object') return { status: 'failed', code: 'protocol' }
      if (value.status === 'unconfigured') return { status: 'unconfigured' }
      if (value.status === 'failed') {
        const code = BALANCE_FAILURE_CODES.has(value.code) ? value.code : 'failed'
        const source = value.source === 'apiKey' || value.source === 'account' ? value.source : undefined
        const checkedAt = Number.isFinite(value.checkedAt) ? value.checkedAt : Date.now()
        const failure = { status: 'failed', code, checkedAt }
        if (source !== undefined) failure.source = source
        return failure
      }
      if (value.status !== 'ready') return { status: 'failed', code: 'protocol' }
      if (value.source !== 'apiKey' && value.source !== 'account') {
        return { status: 'failed', code: 'protocol' }
      }
      const wallets = normalizeWallets(value.wallets)
      if (wallets === null) return { status: 'failed', code: 'protocol' }
      const result = {
        status: 'ready',
        source: value.source,
        checkedAt: Number.isFinite(value.checkedAt) ? value.checkedAt : Date.now(),
        wallets,
      }
      if (typeof value.available === 'boolean') result.available = value.available
      return result
    }

    /**
     * The symbol the card uses for one currency.
     * @param {string} currency - `CNY` or `USD`.
     * @returns {string} Currency symbol with a spacing fallback.
     */
    function currencySymbol(currency) {
      if (currency === 'CNY') return '¥'
      if (currency === 'USD') return '$'
      return `${currency} `
    }

    /**
     * Format a decimal string for the card and the settings status.
     * @param {string | number} value - Decimal amount.
     * @param {string} currency - `CNY` or `USD`.
     * @returns {string} For example `¥110.00`, `<$0.01`, or `$1,234.50`.
     */
    function formatMoney(value, currency) {
      const number = Number(value)
      const symbol = currencySymbol(currency)
      if (!Number.isFinite(number)) return `${symbol}—`
      if (number === 0) return `${symbol}0.00`
      if (number < 0) return `-${formatMoney(-number, currency)}`
      if (number < 0.01) return `<${symbol}0.01`
      const rounded = Math.floor(number * 100) / 100
      return `${symbol}${rounded.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`
    }

    /**
     * A local calendar day key, matching Price Track Buddy's spend buckets.
     * @param {number} ms - Epoch milliseconds.
     * @returns {string} `YYYY-MM-DD` in the browser's zone.
     */
    function localDayKey(ms) {
      const date = new Date(ms)
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    }

    /** @returns {{ version: number, readings: object, days: object }} A fresh ledger. */
    function emptyLedger() {
      return { version: BALANCE_LEDGER_VERSION, readings: {}, days: {} }
    }

    /**
     * Whether a value is a non-array object.
     * @param {unknown} value - Candidate.
     * @returns {boolean} True for a plain object.
     */
    function isPlainObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    }

    /**
     * A finite number, or zero for a missing or corrupt amount.
     * @param {unknown} value - Candidate.
     * @returns {number} Finite amount.
     */
    function finiteAmount(value) {
      const number = Number(value)
      return Number.isFinite(number) ? number : 0
    }

    /**
     * Read the local balance ledger, falling back to an empty ledger on bad JSON.
     * @returns {{ version: number, readings: object, days: object }} The ledger.
     */
    function readLedger() {
      try {
        const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(BALANCE_LEDGER_KEY)
        if (raw === null) return emptyLedger()
        const parsed = JSON.parse(raw)
        if (!isPlainObject(parsed) || parsed.version !== BALANCE_LEDGER_VERSION) return emptyLedger()
        return {
          version: BALANCE_LEDGER_VERSION,
          readings: isPlainObject(parsed.readings) ? parsed.readings : {},
          days: isPlainObject(parsed.days) ? parsed.days : {},
        }
      } catch {
        return emptyLedger()
      }
    }

    /**
     * Persist the ledger. A blocked or full storage reports failure so the card omits spend.
     * @param {{ version: number, readings: object, days: object }} ledger - Ledger to write.
     * @returns {boolean} True when the write landed.
     */
    function writeLedger(ledger) {
      try {
        if (typeof localStorage === 'undefined') return false
        localStorage.setItem(BALANCE_LEDGER_KEY, JSON.stringify(ledger))
        return true
      } catch {
        return false
      }
    }

    /**
     * Keep eight local days and a bounded set of readings.
     * @param {{ version: number, readings: object, days: object }} ledger - Ledger to prune.
     */
    function pruneLedger(ledger) {
      const days = Object.keys(ledger.days).sort()
      while (days.length > BALANCE_DAY_LIMIT) delete ledger.days[days.shift()]
      const readings = Object.entries(ledger.readings)
        .filter(([, entry]) => isPlainObject(entry) && Number.isFinite(entry.at))
        .sort((left, right) => right[1].at - left[1].at)
        .slice(0, BALANCE_MAX_READINGS)
      ledger.readings = Object.fromEntries(readings)
    }

    /**
     * Today's spent and topped-up totals for the wallets of one ready balance.
     * @param {{ readings: object, days: object }} ledger - Ledger.
     * @param {object} balance - Ready balance.
     * @param {number} now - Epoch milliseconds.
     * @returns {{ spentToday: Record<string, number>, toppedUpToday: Record<string, number> } | null} Totals or null.
     */
    function spendFromLedger(ledger, balance, now = Date.now()) {
      if (balance === null || balance === undefined || balance.status !== 'ready') return null
      const dayKey = localDayKey(now)
      const day = isPlainObject(ledger.days[dayKey]) ? ledger.days[dayKey] : {}
      const spentToday = {}
      const toppedUpToday = {}
      for (const wallet of balance.wallets) {
        const key = `${balance.source}:${wallet.currency}`
        const reading = isPlainObject(ledger.readings[key]) ? ledger.readings[key] : null
        // No reading today means tracking has not covered this wallet yet; omit rather than claim zero.
        if (reading === null || !Number.isFinite(reading.at) || localDayKey(reading.at) !== dayKey) continue
        const bucket = isPlainObject(day[key]) ? day[key] : null
        spentToday[wallet.currency] = bucket === null ? 0 : finiteAmount(bucket.spent)
        toppedUpToday[wallet.currency] = bucket === null ? 0 : finiteAmount(bucket.toppedUp)
      }
      return { spentToday, toppedUpToday }
    }

    /**
     * Tell whether the ledger can be read; a blocked store has no spend to show.
     * @returns {boolean} True when local storage is readable.
     */
    function canReadLedger() {
      try {
        if (typeof localStorage === 'undefined' || typeof localStorage.getItem !== 'function') return false
        localStorage.getItem(BALANCE_LEDGER_KEY)
        return true
      } catch {
        return false
      }
    }

    /**
     * Read today's totals without recording a new reading.
     * @param {object} balance - Ready balance.
     * @param {number} [now] - Epoch milliseconds.
     * @returns {{ spentToday: Record<string, number>, toppedUpToday: Record<string, number> } | null} Totals or null.
     */
    function readTodaySpend(balance, now = Date.now()) {
      if (!canReadLedger()) return null
      return spendFromLedger(readLedger(), balance, now)
    }

    /**
     * Record one reading and accumulate same-day, close-enough balance drops.
     * A larger gap or a new local day only re-seeds the baseline, so usage the
     * page never saw is not blamed on today.
     * @param {object} balance - Ready balance.
     * @param {number} [now] - Reading time.
     * @returns {{ spentToday: Record<string, number>, toppedUpToday: Record<string, number> } | null} Today's totals, or null when storage is blocked.
     */
    function recordBalanceReading(balance, now = Date.now()) {
      if (balance === null || balance === undefined || balance.status !== 'ready') return null
      if (!Number.isFinite(now)) now = Date.now()
      try {
        const ledger = readLedger()
        const dayKey = localDayKey(now)
        const day = isPlainObject(ledger.days[dayKey]) ? ledger.days[dayKey] : {}
        for (const wallet of balance.wallets) {
          const current = Number(wallet.total)
          if (!Number.isFinite(current)) continue
          const key = `${balance.source}:${wallet.currency}`
          const previous = isPlainObject(ledger.readings[key]) ? ledger.readings[key] : null
          if (previous !== null && Number.isFinite(Number(previous.total)) && Number.isFinite(previous.at)) {
            const elapsed = now - previous.at
            if (elapsed >= 0 && elapsed <= BALANCE_MAX_GAP_MS && localDayKey(previous.at) === dayKey) {
              const bucket = isPlainObject(day[key]) ? day[key] : { spent: 0, toppedUp: 0 }
              const delta = current - Number(previous.total)
              if (delta < -0.005) {
                bucket.spent = finiteAmount(bucket.spent) + Math.abs(delta)
                day[key] = bucket
              } else if (delta > 0.005) {
                bucket.toppedUp = finiteAmount(bucket.toppedUp) + delta
                day[key] = bucket
              }
            }
          }
          ledger.readings[key] = { total: wallet.total, at: now }
        }
        ledger.days[dayKey] = day
        pruneLedger(ledger)
        if (!writeLedger(ledger)) return null
        return spendFromLedger(ledger, balance, now)
      } catch {
        return null
      }
    }

    /**
     * The localized balance and spend lines for the hover card.
     * @param {object | null} balance - Latest monitor state.
     * @param {(key: string, vars?: Record<string, unknown>) => string} t - Translate seat.
     * @returns {string[]} Zero or more lines.
     */
    function balanceLines(balance, t) {
      if (balance === null || balance === undefined || balance.status === 'idle') return []
      if (balance.status === 'loading') return [t('tip.balanceLoading')]
      if (balance.status === 'unconfigured') {
        const source = balance.requestedSource
        if (source === 'account') return [t('tip.balanceUnconfiguredAccount')]
        if (source === 'apiKey') return [t('tip.balanceUnconfiguredKey')]
        return [t('tip.balanceUnconfiguredGeneric')]
      }
      if (balance.status === 'failed') {
        if (balance.code === 'missing') return [t('tip.balanceMissingRoute')]
        if (balance.code === 'unauthorized') {
          const source = balance.source ?? balance.requestedSource
          if (source === 'account') return [t('tip.balanceRejectedAccount')]
          if (source === 'apiKey') return [t('tip.balanceRejectedKey')]
          return [t('tip.balanceRejectedGeneric')]
        }
        return [t('tip.balanceUnavailable')]
      }
      if (balance.status !== 'ready' || !Array.isArray(balance.wallets) || balance.wallets.length === 0) {
        return [t('tip.balanceUnavailable')]
      }
      const lines = []
      for (const wallet of balance.wallets) {
        lines.push(t('tip.balance', { amount: formatMoney(wallet.total, wallet.currency) }))
        lines.push(t('tip.balanceSplit', {
          toppedUp: formatMoney(wallet.toppedUp, wallet.currency),
          granted: formatMoney(wallet.granted, wallet.currency),
        }))
        const spent = balance.spend?.spentToday?.[wallet.currency]
        if (spent !== undefined) lines.push(t('tip.spentToday', { amount: formatMoney(spent, wallet.currency) }))
        const toppedUp = balance.spend?.toppedUpToday?.[wallet.currency]
        if (toppedUp !== undefined && toppedUp > 0.005) {
          lines.push(t('tip.toppedUpToday', { amount: formatMoney(toppedUp, wallet.currency) }))
        }
      }
      if (balance.available === false) lines.push(t('tip.balanceLow'))
      return lines
    }

    /**
     * The read-only status shown on the settings page: which credential it checked, and whether that worked.
     * The amounts stay in the hover card.
     * @param {object} status - Settings status state.
     * @param {(key: string, vars?: Record<string, unknown>) => string} t - Translate seat.
     * @returns {string} Status text.
     */
    function balanceStatusText(status, t) {
      if (status === null || status === undefined || status.status === 'hidden') return t('settings.balance.hidden')
      if (status.status === 'loading' || status.status === 'idle') return t('settings.balance.checking')
      if (status.status === 'unconfigured') return t('settings.balance.unconfigured')
      if (status.status === 'failed') {
        if (status.code === 'missing') return t('settings.balance.missing')
        return status.code === 'unauthorized' ? t('settings.balance.rejected') : t('settings.balance.unavailable')
      }
      if (status.status !== 'ready' || !Array.isArray(status.wallets) || status.wallets.length === 0) {
        return t('settings.balance.unavailable')
      }
      return t(status.source === 'account'
        ? 'settings.balance.source.account'
        : 'settings.balance.source.apiKey')
    }

    /** The client cache for on-demand balance reads. */
    const balanceCache = new Map()

    /**
     * Whether a fetch error is the request deadline or a caller abort.
     * @param {unknown} error - Thrown value.
     * @returns {boolean} True for an abort.
     */
    function isAbortError(error) {
      const name = error !== null && typeof error === 'object' ? error.name : ''
      return name === 'AbortError' || name === 'TimeoutError'
    }

    /**
     * Read one balance source through the Host route.
     * @param {'apiKey' | 'account' | 'auto'} source - Source preference.
     * @param {AbortSignal} [signal] - Caller lifetime.
     * @returns {Promise<object>} A ready, unconfigured, or failed view.
     */
    async function fetchBalance(source, signal) {
      const key = source === 'account' ? 'account' : source === 'apiKey' ? 'apiKey' : 'auto'
      const hit = balanceCache.get(key)
      if (hit !== undefined && Date.now() - hit.at < BALANCE_CACHE_MS) return hit.value
      if (typeof fetch !== 'function') return { status: 'failed', code: 'network' }
      let response
      try {
        response = await fetch(`${BALANCE_PATH}?source=${encodeURIComponent(key)}`, {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { accept: 'application/json' },
          signal,
        })
      } catch (error) {
        return { status: 'failed', code: isAbortError(error) ? 'timeout' : 'network' }
      }
      if (!response.ok) return { status: 'failed', code: response.status === 404 ? 'missing' : 'failed' }
      let payload
      try {
        payload = await response.json()
      } catch (error) {
        return { status: 'failed', code: isAbortError(error) ? 'timeout' : 'protocol' }
      }
      const value = normalizeBalanceResponse(payload)
      if (value.status !== 'failed') balanceCache.set(key, { at: Date.now(), value })
      return value
    }

    /** English UI and hover strings. */
    const EN = {
      'tip.peak': 'Peak rate · standard price',
      'tip.offPeak': 'Off-peak rate · half of peak',
      'tip.beijing': 'Beijing: {stamp}',
      'tip.local': 'Your time: {stamp} ({zone})',
      'tip.localZoneUnknown': 'your time zone',
      'tip.next': 'Next: {period} in {countdown} ({beijing} Beijing)',
      'tip.nextLocal': ' · {local} your time',
      'tip.rule': 'Peak: Monday to Friday 09:00-12:00 and 14:00-18:00 Beijing time, excluding Chinese public holidays.',
      'tip.rule12': 'Peak: Monday to Friday 9:00 AM-12:00 PM and 2:00 PM-6:00 PM Beijing time, excluding Chinese public holidays.',
      'clock.time12': '{time} {period}',
      'clock.am': 'AM',
      'clock.pm': 'PM',
      'tip.today': 'Today in Beijing: {status}',
      'tip.calendarMissing': 'The Chinese holiday calendar for {years} is not bundled; using the weekday rule.',
      'tip.model': 'DeepSeek route: {route}',
      'tip.balance': 'Balance: {amount}',
      'tip.balanceSplit': 'Topped up {toppedUp} · Granted {granted}',
      'tip.spentToday': 'Tracked today: {amount}',
      'tip.toppedUpToday': 'Topped up today: {amount}',
      'tip.balanceLow': 'Balance is too low for new API calls.',
      'tip.balanceLoading': 'Balance: checking…',
      'tip.balanceUnconfiguredKey': 'Balance: no DeepSeek API key found in this Harness.',
      'tip.balanceUnconfiguredAccount': 'Balance: sign in to DeepSeek to see it.',
      'tip.balanceUnconfiguredGeneric': 'Balance: no DeepSeek key or sign-in found.',
      'tip.balanceRejectedKey': 'Balance: the DeepSeek key was rejected.',
      'tip.balanceRejectedAccount': 'Balance: sign in again to see it.',
      'tip.balanceRejectedGeneric': 'Balance: the DeepSeek credential was rejected.',
      'tip.balanceUnavailable': 'Balance: unavailable.',
      'tip.balanceMissingRoute': 'Balance: restart the Harness to load the balance route.',
      'duration.daysHours': '{days}d {hours}h',
      'duration.days': '{days}d',
      'duration.hoursMinutes': '{hours}h {minutes}m',
      'duration.hours': '{hours}h',
      'duration.minutes': '{minutes}m',
      'logo.ariaPeak': 'Peak Price Pal: peak rate',
      'logo.ariaOffPeak': 'Peak Price Pal: off-peak rate',
      'word.peak': 'Peak',
      'word.offPeak': 'Off-peak',
      'period.peak': 'peak',
      'period.offPeak': 'off-peak',
      'today.workday': 'a workday',
      'today.weekend': 'a weekend, off-peak all day',
      'today.holiday': 'a holiday, {name}, off-peak all day',
      'holiday.newYear': "New Year's Day",
      'holiday.springFestival': 'Spring Festival',
      'holiday.qingming': 'Qingming Festival',
      'holiday.labour': 'Labour Day',
      'holiday.dragonBoat': 'Dragon Boat Festival',
      'holiday.midAutumn': 'Mid-Autumn Festival',
      'holiday.nationalDay': 'National Day',
      'weekday.0': 'Sun',
      'weekday.1': 'Mon',
      'weekday.2': 'Tue',
      'weekday.3': 'Wed',
      'weekday.4': 'Thu',
      'weekday.5': 'Fri',
      'weekday.6': 'Sat',
      'settings.tab': 'Peak Price Pal',
      'settings.title': 'Display settings',
      'settings.description': 'Choose the icon, the clock, how much the hover card shows, and whether it reads your balance.',
      'settings.icon': 'Icon',
      'settings.icon.sunMoon': 'Sun and moon',
      'settings.icon.dot': 'Dot',
      'settings.icon.help': 'The dot is a plain state-colored circle.',
      'settings.clock': 'Clock',
      'settings.clock.24': '24-hour',
      'settings.clock.12': '12-hour',
      'settings.clock.help': 'Applies to the times in the hover card.',
      'settings.details': 'Details',
      'settings.details.all': 'All details',
      'settings.details.minimal': 'Minimal',
      'settings.details.help': 'Minimal keeps the state, the balance rows, and the next switch. Balance tracking still runs.',
      'settings.balance': 'Balance',
      'settings.balance.help': 'Shows your balance and tracked spend. The logo reads once a minute while the Harness page is open; this page reads once on open. Hide stops the reads.',
      'settings.balance.show': 'Show',
      'settings.balance.hide': 'Hide',
      'settings.balanceSource': 'Balance source',
      'settings.balanceSource.help': 'The credential this page checked. The amounts stay in the hover card.',
      'settings.balance.checking': 'Checking…',
      'settings.balance.hidden': 'Hidden',
      'settings.balance.unconfigured': 'No key or sign-in',
      'settings.balance.rejected': 'Credential rejected',
      'settings.balance.unavailable': 'Unavailable',
      'settings.balance.missing': 'Restart the Harness',
      'settings.balance.source.apiKey': 'API key',
      'settings.balance.source.account': 'Account',
      'settings.reset': 'Reset to defaults',
      'settings.saved': 'Saved in this browser. Balance reads happen while the Harness page is open, and once when this page opens.',
    }

    /** Chinese UI and hover strings. */
    const ZH = {
      'tip.peak': '高峰价 · 标准价格',
      'tip.offPeak': '空闲价 · 高峰价的一半',
      'tip.beijing': '北京时间：{stamp}',
      'tip.local': '本地时间：{stamp}（{zone}）',
      'tip.localZoneUnknown': '本地时区',
      'tip.next': '下次切换：{period}，还有 {countdown}（北京时间 {beijing}）',
      'tip.nextLocal': ' · 本地 {local}',
      'tip.rule': '高峰：北京时间周一至周五 09:00-12:00、14:00-18:00，中国法定节假日除外。',
      'tip.rule12': '高峰：北京时间周一至周五上午 9:00-中午 12:00、下午 2:00-6:00，中国法定节假日除外。',
      'clock.time12': '{period} {time}',
      'clock.am': '上午',
      'clock.pm': '下午',
      'tip.today': '北京今天：{status}',
      'tip.calendarMissing': '{years} 年中国法定节假日表尚未内置，暂按周一至周五规则判断。',
      'tip.model': 'DeepSeek 路由：{route}',
      'tip.balance': '余额：{amount}',
      'tip.balanceSplit': '充值 {toppedUp} · 赠送 {granted}',
      'tip.spentToday': '今日已跟踪：{amount}',
      'tip.toppedUpToday': '今日充值：{amount}',
      'tip.balanceLow': '余额不足以发起新的 API 调用。',
      'tip.balanceLoading': '余额：正在查询…',
      'tip.balanceUnconfiguredKey': '余额：此 Harness 中未找到 DeepSeek API 密钥。',
      'tip.balanceUnconfiguredAccount': '余额：登录 DeepSeek 后即可查看。',
      'tip.balanceUnconfiguredGeneric': '余额：未找到 DeepSeek 密钥或登录状态。',
      'tip.balanceRejectedKey': '余额：DeepSeek 密钥被拒绝。',
      'tip.balanceRejectedAccount': '余额：请重新登录后查看。',
      'tip.balanceRejectedGeneric': '余额：DeepSeek 凭据被拒绝。',
      'tip.balanceUnavailable': '余额：暂时不可用。',
      'tip.balanceMissingRoute': '余额：请重启 Harness 以加载余额路由。',
      'duration.daysHours': '{days} 天 {hours} 小时',
      'duration.days': '{days} 天',
      'duration.hoursMinutes': '{hours} 小时 {minutes} 分',
      'duration.hours': '{hours} 小时',
      'duration.minutes': '{minutes} 分钟',
      'logo.ariaPeak': '峰谷小助手：高峰价',
      'logo.ariaOffPeak': '峰谷小助手：空闲价',
      'word.peak': '高峰',
      'word.offPeak': '空闲',
      'period.peak': '高峰',
      'period.offPeak': '空闲',
      'today.workday': '工作日',
      'today.weekend': '周末，全天空闲',
      'today.holiday': '法定节假日（{name}），全天空闲',
      'holiday.newYear': '元旦',
      'holiday.springFestival': '春节',
      'holiday.qingming': '清明节',
      'holiday.labour': '劳动节',
      'holiday.dragonBoat': '端午节',
      'holiday.midAutumn': '中秋节',
      'holiday.nationalDay': '国庆节',
      'weekday.0': '周日',
      'weekday.1': '周一',
      'weekday.2': '周二',
      'weekday.3': '周三',
      'weekday.4': '周四',
      'weekday.5': '周五',
      'weekday.6': '周六',
      'settings.tab': '峰谷小助手',
      'settings.title': '显示设置',
      'settings.description': '选择图标、时钟格式、悬停卡显示多少内容，以及是否读取余额。',
      'settings.icon': '图标',
      'settings.icon.sunMoon': '太阳和月亮',
      'settings.icon.dot': '圆点',
      'settings.icon.help': '圆点是纯状态色的圆点。',
      'settings.clock': '时钟',
      'settings.clock.24': '24 小时',
      'settings.clock.12': '12 小时',
      'settings.clock.help': '用于悬停卡中的时间。',
      'settings.details': '详情',
      'settings.details.all': '全部详情',
      'settings.details.minimal': '精简',
      'settings.details.help': '精简模式保留当前时段、余额和下次切换；余额仍会跟踪。',
      'settings.balance': '余额',
      'settings.balance.help': '显示余额和今日已跟踪的消费。Harness 页面打开时徽标每分钟读取一次；打开本页时读取一次。选择“隐藏”可停止读取。',
      'settings.balance.show': '显示',
      'settings.balance.hide': '隐藏',
      'settings.balanceSource': '余额来源',
      'settings.balanceSource.help': '本页检查到的凭据。金额只在悬停卡中显示。',
      'settings.balance.checking': '正在查询…',
      'settings.balance.hidden': '已隐藏',
      'settings.balance.unconfigured': '未找到密钥或登录',
      'settings.balance.rejected': '凭据被拒绝',
      'settings.balance.unavailable': '不可用',
      'settings.balance.missing': '需要重启 Harness',
      'settings.balance.source.apiKey': 'API 密钥',
      'settings.balance.source.account': '账户',
      'settings.reset': '恢复默认',
      'settings.saved': '设置保存在此浏览器。Harness 页面打开时读取余额，打开本页时读取一次。',
    }

    /**
     * English fallback translator used when the synthesized `t` seat is absent.
     * @param {string} key - Dictionary key.
     * @param {Record<string, unknown>} [vars] - Placeholder values.
     * @returns {string} Resolved string.
     */
    function translateFallback(key, vars) {
      const template = EN[key]
      if (typeof template !== 'string') return key
      if (vars === undefined) return template
      return template.replace(/\{(\w+)\}/g, (_, name) => (
        vars[name] === undefined ? `{${name}}` : String(vars[name])
      ))
    }

    /**
     * Escape a literal string for use inside a regular expression.
     * @param {string} value - Literal text.
     * @returns {string} Escaped text.
     */
    function escapeRegExp(value) {
      return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }

    /**
     * Split a line into plain and state-colored segments.
     * Longer terms win so `Off-peak` is one segment instead of `Off-` plus `peak`.
     * @param {string} text - One line of the hover card.
     * @param {{ word: string, tone: 'peak' | 'offPeak' }[]} terms - Words to color.
     * @returns {{ text: string, tone: 'peak' | 'offPeak' | null }[]} Ordered segments.
     */
    function highlightWords(text, terms) {
      const usable = terms.filter(term => typeof term.word === 'string' && term.word !== '')
      if (usable.length === 0) return [{ text, tone: null }]
      const ordered = [...usable].sort((left, right) => right.word.length - left.word.length)
      const tones = new Map(ordered.map(term => [term.word.toLowerCase(), term.tone]))
      const pattern = new RegExp(`(${ordered.map(term => escapeRegExp(term.word)).join('|')})`, 'gi')
      const segments = []
      let last = 0
      for (const match of text.matchAll(pattern)) {
        if (match.index > last) segments.push({ text: text.slice(last, match.index), tone: null })
        segments.push({ text: match[0], tone: tones.get(match[0].toLowerCase()) ?? null })
        last = match.index + match[0].length
      }
      if (last < text.length) segments.push({ text: text.slice(last), tone: null })
      return segments
    }

    /** Component-local styles; a theme token drives every color. */
    const CSS = `
.ppp{order:1;position:relative;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;flex:none;width:20px;height:20px;border-radius:999px;color:var(--dsw-alias-label-secondary);line-height:1;cursor:help;transition:background-color 120ms ease}
@media (hover:hover){.ppp:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.ppp:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.ppp_peak{color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 75%, var(--dsw-alias-label-primary))}
.ppp_valley{color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 75%, var(--dsw-alias-label-primary))}
.ppp svg{display:block;width:16px;height:16px;pointer-events:none}
.ppp_sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.ppp_card{position:fixed;z-index:1200;box-sizing:border-box;position-area:none;top:auto;right:auto;bottom:calc(anchor(top) + 8px);left:calc(anchor(left) + (anchor(right) - anchor(left)) / 2);transform:translateX(-50%);width:min(340px, calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow-y:auto;margin:0;padding:10px 12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-tooltip-bg);color:var(--dsw-alias-tooltip-label);box-shadow:var(--dsw-elevation-prominent);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;white-space:normal;overflow-wrap:anywhere;pointer-events:auto;cursor:default;user-select:text;text-align:left;animation:ppp-card-in 120ms ease-out;position-try-fallbacks:--ppp-card-end, --ppp-card-start, --ppp-card-top}
.ppp_cardLine:first-child{font-weight:500}
.ppp_cardLine + .ppp_cardLine{margin-top:2px}
.ppp_tonePeak{color:var(--dsw-alias-state-warn-primary);font-weight:600}
.ppp_toneOffPeak{color:var(--dsw-alias-state-success-primary);font-weight:600}
@keyframes ppp-card-in{from{opacity:0}to{opacity:1}}
@position-try --ppp-card-end{left:auto;right:12px;transform:none}
@position-try --ppp-card-start{left:12px;right:auto;transform:none}
@position-try --ppp-card-top{top:12px;bottom:auto;left:12px;right:12px;width:auto;max-width:none;transform:none;max-height:calc(100dvh - 24px);overflow-y:auto}
@media (prefers-reduced-motion:reduce){.ppp{transition:none}.ppp_card{animation:none}}
.ppp_settings{display:flex;flex-direction:column;max-width:620px;padding:4px 0 24px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.ppp_settingsTitle{margin:0;font-size:15px;line-height:22px;font-weight:600}
.ppp_settingsLead{margin:2px 0 8px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.ppp_settingRow{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:10px 24px;padding:12px 0;border-top:.5px solid var(--dsw-alias-border-l2)}
.ppp_settingCopy{display:flex;flex-direction:column;gap:2px;min-width:0}
.ppp_settingLabel{font-size:13px;line-height:20px;font-weight:500}
.ppp_settingHelp{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.ppp_choices{display:inline-flex;flex:none;gap:2px;padding:2px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2)}
.ppp_choice{display:inline-flex;align-items:center;justify-content:center;gap:5px;min-height:26px;padding:2px 9px;border:1px solid transparent;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap}
.ppp_choice:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ppp_choiceActive{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-weight:500}
.ppp_choice:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.ppp_choiceGlyphs{display:inline-flex;align-items:center;gap:1px;line-height:0}
.ppp_choiceGlyphs svg{display:block;width:14px;height:14px;pointer-events:none}
.ppp_previewPeak{display:inline-flex;color:var(--dsw-alias-state-warn-primary)}
.ppp_previewValley{display:inline-flex;color:var(--dsw-alias-state-success-primary)}
.ppp_reset{margin-top:16px;align-self:flex-start;padding:4px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.ppp_reset:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ppp_reset:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.ppp_balanceValue{max-width:280px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;text-align:right;overflow-wrap:anywhere}
.ppp_saved{margin:10px 0 0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
`.trim()

    /** A sun glyph for the peak window. */
    function SunGlyph() {
      const rays = []
      for (let index = 0; index < 8; index += 1) {
        const angle = (Math.PI / 4) * index
        rays.push(h('line', {
          key: `ray-${index}`,
          x1: 8 + Math.cos(angle) * 5.1,
          y1: 8 + Math.sin(angle) * 5.1,
          x2: 8 + Math.cos(angle) * 6.6,
          y2: 8 + Math.sin(angle) * 6.6,
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
        }))
      }
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 16,
        height: 16,
        'aria-hidden': true,
        focusable: 'false',
      }, h('circle', { cx: 8, cy: 8, r: 3.1, fill: 'currentColor' }), rays)
    }

    /** A crescent moon glyph for the off-peak window. */
    function MoonGlyph() {
      const rawId = useId()
      const maskId = `ppp-moon-${String(rawId).replace(/[^a-zA-Z0-9_-]/g, '')}`
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 16,
        height: 16,
        'aria-hidden': true,
        focusable: 'false',
      },
      h('defs', null,
        h('mask', {
          id: maskId,
          maskUnits: 'userSpaceOnUse',
          x: 0,
          y: 0,
          width: 16,
          height: 16,
        },
        h('rect', { x: 0, y: 0, width: 16, height: 16, fill: '#fff' }),
        h('circle', { cx: 10.6, cy: 7.2, r: 5.2, fill: '#000' }),
        ),
      ),
      h('circle', { cx: 8, cy: 8, r: 6.2, fill: 'currentColor', mask: `url(#${maskId})` }))
    }

    /** A plain state-colored dot, for the compact icon choice. */
    function DotGlyph() {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 16,
        height: 16,
        'aria-hidden': true,
        focusable: 'false',
      }, h('circle', { cx: 8, cy: 8, r: 4.6, fill: 'currentColor' }))
    }

    /**
     * Subscribe to the model directory store without breaking React's snapshot contract.
     * @param {object | null} store - `modelDirectories` store.
     * @returns {object | null} Latest snapshot.
     */
    function useModelSnapshot(store) {
      const subscribe = useMemo(() => {
        if (store === null || store === undefined || typeof store.subscribe !== 'function') {
          return () => () => {}
        }
        return notify => {
          const dispose = store.subscribe(notify)
          return typeof dispose === 'function' ? dispose : () => {}
        }
      }, [store])
      const getSnapshot = useMemo(() => {
        if (store === null || store === undefined || typeof store.getSnapshot !== 'function') {
          return () => null
        }
        return () => {
          try {
            return store.getSnapshot() ?? null
          } catch {
            return null
          }
        }
      }, [store])
      return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    }

    /** Subscribe to the browser-local display settings. */
    function useSettings() {
      return useSyncExternalStore(subscribeSettings, settingsSnapshot, settingsSnapshot)
    }

    /** A quarter-minute clock: the countdown is minute-resolution, and model switches arrive through the store subscription. */
    function useNow() {
      const [now, setNow] = useState(() => Date.now())
      useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 15_000)
        return () => clearInterval(timer)
      }, [])
      return now
    }

    /**
     * Create the poll loop for one balance source. Extracted from the React hook
     * so the lifecycle can be tested without a renderer.
     * @param {object} options - Source, callbacks, timers, and listeners.
     * @returns {{ run: (force?: boolean) => Promise<void>, stop: () => void }} Controller.
     */
    function createBalanceMonitor(options) {
      const {
        source,
        fetchValue = fetchBalance,
        recordValue = recordBalanceReading,
        onState,
        now = () => Date.now(),
        intervalMs = BALANCE_POLL_MS,
        timeoutMs = BALANCE_TIMEOUT_MS,
        setIntervalImpl = (callback, delay) => setInterval(callback, delay),
        clearIntervalImpl = handle => clearInterval(handle),
        listeners,
        isVisible = () => true,
      } = options
      let live = true
      let fetching = false
      let lastFetchAt = 0
      let lastReady = null
      let controller = null
      const run = async (force = true) => {
        if (!live || fetching) return
        if (!force && now() - lastFetchAt < BALANCE_CACHE_MS) return
        fetching = true
        controller = new AbortController()
        const timeout = setTimeout(() => {
          if (controller !== null) controller.abort()
        }, timeoutMs)
        try {
          const value = await fetchValue(source, controller.signal)
          if (!live) return
          lastFetchAt = now()
          if (value.status === 'ready') {
            const readingAt = Number.isFinite(value.checkedAt) ? value.checkedAt : now()
            const spend = recordValue(value, readingAt)
            lastReady = { ...value, spend, requestedSource: source }
            onState(lastReady)
          } else if (!(value.status === 'failed' && lastReady !== null)) {
            onState({ ...value, requestedSource: source })
          }
        } catch {
          // A transient poll failure never replaces a number the card already has.
          if (live && lastReady === null) {
            onState({ status: 'failed', code: 'failed', requestedSource: source })
          }
        } finally {
          clearTimeout(timeout)
          fetching = false
          controller = null
        }
      }
      const timer = setIntervalImpl(() => { void run(true) }, intervalMs)
      const onVisible = () => {
        if (isVisible()) void run(false)
      }
      const onOnline = () => { void run(true) }
      if (listeners !== undefined) {
        listeners.add('visibilitychange', onVisible)
        listeners.add('online', onOnline)
      }
      return {
        run,
        stop() {
          live = false
          clearIntervalImpl(timer)
          if (controller !== null) controller.abort()
          if (listeners !== undefined) {
            listeners.remove('visibilitychange', onVisible)
            listeners.remove('online', onOnline)
          }
        },
      }
    }

    /**
     * Poll one balance source while the card is mounted.
     * The first read happens on mount, not on hover, so the tracked total is covered.
     * The timer keeps running in a background tab while the page stays open; the
     * visibility listener only refreshes on return.
     * @param {'apiKey' | 'account' | 'auto'} source - Source preference.
     * @param {boolean} enabled - False when balance is hidden.
     * @returns {object} Latest monitor state.
     */
    function useBalanceMonitor(source, enabled) {
      const [state, setState] = useState(() => ({ status: 'idle' }))
      useEffect(() => {
        if (!enabled) {
          setState({ status: 'idle' })
          return () => {}
        }
        setState(current => (
          current !== null && current.status === 'ready' && current.requestedSource === source
            ? current
            : { status: 'loading', requestedSource: source }
        ))
        const listeners = typeof document !== 'undefined' && typeof window !== 'undefined'
          ? {
              add(type, handler) {
                const target = type === 'visibilitychange' ? document : window
                if (typeof target.addEventListener === 'function') target.addEventListener(type, handler)
              },
              remove(type, handler) {
                const target = type === 'visibilitychange' ? document : window
                if (typeof target.removeEventListener === 'function') target.removeEventListener(type, handler)
              },
            }
          : undefined
        const monitor = createBalanceMonitor({
          source,
          onState: setState,
          listeners,
          isVisible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
        })
        void monitor.run(true)
        return () => monitor.stop()
      }, [source, enabled])
      return state
    }

    /**
     * Read the balance once for the settings page without recording a spend reading.
     * @param {boolean} enabled - False when balance is hidden.
     * @returns {object} Latest status state.
     */
    function useBalanceStatus(enabled) {
      const [status, setStatus] = useState(() => ({ status: enabled ? 'loading' : 'hidden' }))
      useEffect(() => {
        if (!enabled) {
          setStatus({ status: 'hidden' })
          return () => {}
        }
        let live = true
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), BALANCE_TIMEOUT_MS)
        setStatus({ status: 'loading' })
        void fetchBalance('auto', controller.signal).then(value => {
          if (live) setStatus(value)
        }).catch(() => {
          if (live) setStatus({ status: 'failed', code: 'failed' })
        })
        return () => {
          live = false
          clearTimeout(timer)
          controller.abort()
        }
      }, [enabled])
      return status
    }

    /**
     * Build the logo state and the hover card content.
     * @param {number} ms - Epoch milliseconds.
     * @param {(key: string, vars?: Record<string, unknown>) => string} t - Translate seat.
     * @param {{ provider: string, model: string }} route - DeepSeek route.
     * @param {{ icon: string, clock: '24h' | '12h', detail: 'all' | 'minimal', balance?: 'show' | 'hide' }} [settings] - Display preferences.
     * @param {object | null} [balance] - Latest balance monitor state.
     * @returns {{ peak: boolean, tooltip: string, lines: { text: string, tone: 'peak' | 'offPeak' | null }[][] }} View model.
     */
    function describe(ms, t, route, settings = DEFAULT_SETTINGS, balance = null) {
      const peak = isPeak(ms)
      const next = nextSwitch(ms)
      const clock = settings.clock
      const nowBeijing = beijingStamp(ms, t, clock)
      const nowLocal = localStamp(ms, t, clock)
      const stateLine = peak ? t('tip.peak') : t('tip.offPeak')
      let nextLine = null
      if (next !== null) {
        const period = next.peak ? t('period.peak') : t('period.offPeak')
        const countdown = durationText(next.at - ms, t)
        const nextBeijing = beijingStamp(next.at, t, clock)
        nextLine = t('tip.next', { period, countdown, beijing: nextBeijing })
        const nextLocal = localStamp(next.at, t, clock)
        if (nextLocal !== nextBeijing) nextLine += t('tip.nextLocal', { local: nextLocal })
      }
      const lines = [stateLine]
      if (settings.balance !== 'hide') lines.push(...balanceLines(balance, t))
      if (settings.detail === 'minimal') {
        if (nextLine !== null) lines.push(nextLine)
      } else {
        lines.push(t('tip.beijing', { stamp: nowBeijing }))
        if (nowLocal !== nowBeijing) {
          lines.push(t('tip.local', {
            stamp: nowLocal,
            zone: localZoneName() || t('tip.localZoneUnknown'),
          }))
        }
        if (nextLine !== null) lines.push(nextLine)
        lines.push(t(clock === '12h' ? 'tip.rule12' : 'tip.rule'))
        lines.push(t('tip.today', { status: todayStatus(ms, t) }))
        const parts = beijingParts(ms)
        const missingYears = new Set()
        if (HOLIDAY_SCHEDULE[parts.year] === undefined) missingYears.add(parts.year)
        if (next !== null) {
          const nextParts = beijingParts(next.at)
          if (HOLIDAY_SCHEDULE[nextParts.year] === undefined) missingYears.add(nextParts.year)
        }
        if (missingYears.size > 0) {
          lines.push(t('tip.calendarMissing', { years: [...missingYears].join(', ') }))
        }
        const routeText = route.model === '' ? route.provider : `${route.provider} / ${route.model}`
        lines.push(t('tip.model', { route: routeText }))
      }
      const highlightTerms = [
        { word: t('word.offPeak'), tone: 'offPeak' },
        { word: t('word.peak'), tone: 'peak' },
      ]
      return {
        peak,
        tooltip: lines.join('\n'),
        lines: lines.map(line => highlightWords(line, highlightTerms)),
      }
    }

    /** The live logo, mounted only while the route is DeepSeek. */
    function PeakPricePalLive({ route, t }) {
      const settings = useSettings()
      const now = useNow()
      const source = balanceSource(route.provider)
      const balance = useBalanceMonitor(source, settings.balance !== 'hide')
      const view = useMemo(
        () => describe(now, t, route, settings, balance),
        [now, t, route, settings, balance],
      )
      const [hovered, setHovered] = useState(false)
      const [focused, setFocused] = useState(false)
      const closeTimer = useRef(null)
      const instanceId = String(useId()).replace(/[^a-zA-Z0-9_-]/g, '')
      const descriptionId = `ppp-desc-${instanceId}`
      const anchorName = `--ppp-anchor-${instanceId}`
      useEffect(() => () => {
        if (closeTimer.current !== null) clearTimeout(closeTimer.current)
      }, [])
      const showCard = () => {
        if (closeTimer.current !== null) {
          clearTimeout(closeTimer.current)
          closeTimer.current = null
        }
        setHovered(true)
      }
      const hideCardSoon = () => {
        if (closeTimer.current !== null) clearTimeout(closeTimer.current)
        closeTimer.current = setTimeout(() => {
          closeTimer.current = null
          setHovered(false)
        }, 180)
      }
      const card = hovered || focused
        ? createPortal(
          h('div', {
            className: 'ppp_card',
            style: { positionAnchor: anchorName },
            'aria-hidden': 'true',
            onMouseEnter: showCard,
            onMouseLeave: hideCardSoon,
          },
          view.lines.map((line, lineIndex) => h('div', {
            key: `line-${lineIndex}`,
            className: 'ppp_cardLine',
          }, line.map((segment, segmentIndex) => (
            segment.tone === null
              ? segment.text
              : h('span', {
                key: `segment-${segmentIndex}`,
                className: segment.tone === 'peak' ? 'ppp_tonePeak' : 'ppp_toneOffPeak',
              }, segment.text)
          ))))),
          document.body,
        )
        : null
      return h(React.Fragment, null,
        h('style', { key: 'ppp-style' }, CSS),
        h('span', {
          key: 'ppp-logo',
          className: view.peak ? 'ppp ppp_peak' : 'ppp ppp_valley',
          role: 'img',
          tabIndex: 0,
          style: { anchorName },
          'aria-label': t(view.peak ? 'logo.ariaPeak' : 'logo.ariaOffPeak'),
          'aria-describedby': descriptionId,
          'data-peak-price-pal': view.peak ? 'peak' : 'off-peak',
          onMouseEnter: showCard,
          onMouseLeave: hideCardSoon,
          onFocus: () => setFocused(true),
          onBlur: () => setFocused(false),
          onKeyDown: event => {
            if (event.key === 'Escape') event.currentTarget.blur()
          },
        },
        settings.icon === 'dot' ? h(DotGlyph) : h(view.peak ? SunGlyph : MoonGlyph),
        h('span', { className: 'ppp_sr', id: descriptionId }, view.tooltip)),
        card)
    }

    /** Gate the entry on the provider route before mounting the clock. */
    function PeakPricePal(props) {
      const modelStore = props.modelStore ?? null
      const t = typeof props.t === 'function'
        ? props.t
        : typeof props.fallbackT === 'function'
          ? props.fallbackT
          : translateFallback
      const snapshot = useModelSnapshot(modelStore)
      const useProjectionHook = typeof props.useProjection === 'function'
        ? props.useProjection
        : () => undefined
      const projection = useProjectionHook('modelSelection')
      const useSessionHook = typeof props.useSession === 'function'
        ? props.useSession
        : () => null
      const subagent = useSessionHook(snapshotValue => (
        snapshotValue === undefined || snapshotValue === null ? null : snapshotValue.subagent
      ))
      const route = snapshotRoute(snapshot) ?? projectionRoute(projection)
      if (subagent !== null && subagent !== undefined) return null
      if (route === null || !isDeepSeekProvider(route.provider)) return null
      return h(PeakPricePalLive, { route, t })
    }

    /**
     * One segmented choice group for the settings page.
     * @param {{ label: string, value: string, options: { value: string, label: string, preview?: unknown }[], onChange: (value: string) => void }} props - Group props.
     */
    function ChoiceGroup({ label, value, options, onChange }) {
      return h('div', { className: 'ppp_choices', role: 'group', 'aria-label': label },
        ...options.map(option => h('button', {
          key: option.value,
          type: 'button',
          className: option.value === value ? 'ppp_choice ppp_choiceActive' : 'ppp_choice',
          'aria-pressed': option.value === value,
          onClick: () => onChange(option.value),
        }, option.preview ?? null, option.label)))
    }

    /**
     * The Plugins settings page. Display choices are browser-local and apply live.
     * @param {{ t: (key: string, vars?: Record<string, unknown>) => string }} props - Slot locale seat.
     */
    function SettingsPage({ t }) {
      const settings = useSettings()
      const balanceStatus = useBalanceStatus(settings.balance !== 'hide')
      const sunMoonPreview = h('span', { className: 'ppp_choiceGlyphs', 'aria-hidden': 'true' },
        h('span', { className: 'ppp_previewPeak' }, h(SunGlyph)),
        h('span', { className: 'ppp_previewValley' }, h(MoonGlyph)))
      const dotPreview = h('span', { className: 'ppp_choiceGlyphs', 'aria-hidden': 'true' },
        h('span', { className: 'ppp_previewPeak' }, h(DotGlyph)),
        h('span', { className: 'ppp_previewValley' }, h(DotGlyph)))
      const row = (label, help, control) => h('div', { className: 'ppp_settingRow' },
        h('div', { className: 'ppp_settingCopy' },
          h('span', { className: 'ppp_settingLabel' }, label),
          h('span', { className: 'ppp_settingHelp' }, help)),
        control)
      return h('div', { className: 'ppp_settings' },
        h('style', { key: 'ppp-style' }, CSS),
        h('h2', { className: 'ppp_settingsTitle' }, t('settings.title')),
        h('p', { className: 'ppp_settingsLead' }, t('settings.description')),
        row(t('settings.icon'), t('settings.icon.help'), h(ChoiceGroup, {
          label: t('settings.icon'),
          value: settings.icon,
          onChange: icon => updateSettings({ icon }),
          options: [
            { value: 'sunMoon', label: t('settings.icon.sunMoon'), preview: sunMoonPreview },
            { value: 'dot', label: t('settings.icon.dot'), preview: dotPreview },
          ],
        })),
        row(t('settings.clock'), t('settings.clock.help'), h(ChoiceGroup, {
          label: t('settings.clock'),
          value: settings.clock,
          onChange: clock => updateSettings({ clock }),
          options: [
            { value: '24h', label: t('settings.clock.24') },
            { value: '12h', label: t('settings.clock.12') },
          ],
        })),
        row(t('settings.details'), t('settings.details.help'), h(ChoiceGroup, {
          label: t('settings.details'),
          value: settings.detail,
          onChange: detail => updateSettings({ detail }),
          options: [
            { value: 'all', label: t('settings.details.all') },
            { value: 'minimal', label: t('settings.details.minimal') },
          ],
        })),
        row(t('settings.balance'), t('settings.balance.help'), h(ChoiceGroup, {
          label: t('settings.balance'),
          value: settings.balance,
          onChange: balance => updateSettings({ balance }),
          options: [
            { value: 'show', label: t('settings.balance.show') },
            { value: 'hide', label: t('settings.balance.hide') },
          ],
        })),
        row(t('settings.balanceSource'), t('settings.balanceSource.help'), h('span', {
          className: 'ppp_balanceValue',
          'aria-live': 'polite',
        }, balanceStatusText(balanceStatus, t))),
        h('button', { type: 'button', className: 'ppp_reset', onClick: () => resetSettings() }, t('settings.reset')),
        h('p', { className: 'ppp_saved' }, t('settings.saved')))
    }

    /**
     * Register the locale dictionaries, the composer dock entry, and the settings tab.
     * @param {object} ctx - Client context carrying `locale` and `slots`.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), `${NS}: dictionaries`)
      const fallbackT = ctx.locale.bind(NS)
      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        id: SLOT_ID,
        order: SLOT_ORDER,
        locale: NS,
        inject: sessionId => ({
          modelStore: directoryStore(ctx, sessionId),
          fallbackT,
        }),
      }, PeakPricePal))
      ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
        name: 'settings.plugins.tab',
        id: SLOT_ID,
        order: 100,
        locale: NS,
        label: () => fallbackT('settings.tab'),
      }, SettingsPage))
      ctx.effect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {}
        const onStorage = event => {
          if (event.key !== null && event.key !== SETTINGS_KEY) return
          reloadSettings()
        }
        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
      }, `${NS}: settings storage`)
    }

    const plugin = { inject: ['slots', 'locale'], apply }

    // Expose the pure parts to the repository test harness. Non-enumerable so
    // the Loader sees the same plugin shape as every other bundle.
    Object.defineProperty(plugin, '__peakPricePal', {
      value: {
        NS,
        SLOT,
        SLOT_ID,
        SLOT_ORDER,
        CSS,
        EN,
        ZH,
        HOLIDAY_KEYS,
        HOLIDAY_SCHEDULE,
        beijingParts,
        isPeak,
        nextSwitch,
        durationText,
        beijingStamp,
        localStamp,
        todayStatus,
        isDeepSeekProvider,
        routeOf,
        snapshotRoute,
        projectionRoute,
        directoryStore,
        describe,
        highlightWords,
        formatClock,
        translateFallback,
        BALANCE_PATH,
        BALANCE_POLL_MS,
        BALANCE_CACHE_MS,
        BALANCE_MAX_GAP_MS,
        BALANCE_LEDGER_KEY,
        BALANCE_DAY_LIMIT,
        balanceSource,
        normalizeBalanceResponse,
        formatMoney,
        localDayKey,
        readLedger,
        readTodaySpend,
        recordBalanceReading,
        balanceLines,
        balanceStatusText,
        fetchBalance,
        createBalanceMonitor,
        resetBalanceCache: () => { balanceCache.clear() },
        resetBalanceLedger: () => {
          try {
            if (typeof localStorage !== 'undefined') localStorage.removeItem(BALANCE_LEDGER_KEY)
          } catch {
            // Nothing to clear when storage is blocked.
          }
        },
        settings: {
          key: SETTINGS_KEY,
          defaults: DEFAULT_SETTINGS,
          getSnapshot: settingsSnapshot,
          subscribe: subscribeSettings,
          update: updateSettings,
          reset: resetSettings,
          reload: reloadSettings,
          normalize: normalizeSettings,
          read: readSettings,
          write: writeSettings,
        },
        dotGlyph: DotGlyph,
        settingsPage: SettingsPage,
        choiceGroup: ChoiceGroup,
        holidayFor,
        holidayYears: Object.keys(HOLIDAY_SCHEDULE).map(Number),
        holidayCount: HOLIDAY_INDEX.size,
        component: PeakPricePal,
        live: PeakPricePalLive,
      },
      enumerable: false,
    })

    return plugin
  },
})
