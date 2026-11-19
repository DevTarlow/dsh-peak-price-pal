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
     * @returns {string} Weekday, date, and 24-hour clock in Beijing.
     */
    function beijingStamp(ms, t) {
      const parts = beijingParts(ms)
      return `${t(`weekday.${parts.weekday}`)} ${parts.dateKey} ${pad2(parts.hour)}:${pad2(parts.minute)}`
    }

    /**
     * A timestamp in the browser's local zone for the hover text.
     * @param {number} ms - Epoch milliseconds.
     * @param {(key: string, vars?: Record<string, unknown>) => string} t - Translate seat.
     * @returns {string} Weekday, date, and 24-hour clock locally.
     */
    function localStamp(ms, t) {
      const date = new Date(ms)
      const dateKey = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
      return `${t(`weekday.${date.getDay()}`)} ${dateKey} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
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
      'tip.today': 'Today in Beijing: {status}',
      'tip.calendarMissing': 'The Chinese holiday calendar for {years} is not bundled; using the weekday rule.',
      'tip.model': 'DeepSeek route: {route}',
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
      'tip.today': '北京今天：{status}',
      'tip.calendarMissing': '{years} 年中国法定节假日表尚未内置，暂按周一至周五规则判断。',
      'tip.model': 'DeepSeek 路由：{route}',
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
     * Build the logo state and the full hover text.
     * @param {number} ms - Epoch milliseconds.
     * @param {(key: string, vars?: Record<string, unknown>) => string} t - Translate seat.
     * @param {{ provider: string, model: string }} route - DeepSeek route.
     * @returns {{ peak: boolean, tooltip: string, lines: { text: string, tone: 'peak' | 'offPeak' | null }[][] }} View model.
     */
    function describe(ms, t, route) {
      const peak = isPeak(ms)
      const next = nextSwitch(ms)
      const nowBeijing = beijingStamp(ms, t)
      const nowLocal = localStamp(ms, t)
      const lines = [
        peak ? t('tip.peak') : t('tip.offPeak'),
        t('tip.beijing', { stamp: nowBeijing }),
      ]
      if (nowLocal !== nowBeijing) {
        lines.push(t('tip.local', {
          stamp: nowLocal,
          zone: localZoneName() || t('tip.localZoneUnknown'),
        }))
      }
      if (next !== null) {
        const period = next.peak ? t('period.peak') : t('period.offPeak')
        const countdown = durationText(next.at - ms, t)
        const nextBeijing = beijingStamp(next.at, t)
        let line = t('tip.next', { period, countdown, beijing: nextBeijing })
        const nextLocal = localStamp(next.at, t)
        if (nextLocal !== nextBeijing) line += t('tip.nextLocal', { local: nextLocal })
        lines.push(line)
      }
      lines.push(t('tip.rule'))
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
      const now = useNow()
      const view = useMemo(() => describe(now, t, route), [now, t, route])
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
        h(view.peak ? SunGlyph : MoonGlyph),
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
     * Register the locale dictionaries and the composer dock entry.
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
        translateFallback,
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
