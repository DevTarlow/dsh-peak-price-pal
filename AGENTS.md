# AGENTS.md — Peak Price Pal

A DeepSeek Harness plugin. The visible half is `client.js`: a 20px sun or moon in `conversation.composer.dock`, to the right of the context ring. The Host half is an empty `apply()`.

## Layout

```
index.js            the Harness row: apply() and nothing else
client.js           the browser half: time math, holiday table, model gate, logo, hover card
cordis.patch.yml    the bundle layer: one insert row
locale/*.json       inventory title and description (en, zh)
icon.svg            the plugin-list mark
docs/               detail documents and the text-free preview
test/               the Node harness
```

## Invariants

1. **Beijing time is UTC+8, always.** Compute it from `Date.UTC`, never from the host time zone. Beijing has no daylight saving time.
2. **Peak is Monday to Friday, 09:00-12:00 and 14:00-18:00, excluding bundled Chinese holidays.** Starts are inclusive, ends are exclusive. Weekends are off-peak all day, including make-up working weekends.
3. **Off-peak is half the peak rate.** The hover card says that; it does not quote per-model prices.
4. **The gate is the provider id, not the model name.** `deepseek`, `deepseek-official`, and `deepseek-account` show. `openrouter` with a `deepseek/...` model stays hidden. Unknown routes stay hidden.
5. **The logo is icon-only.** The hover/focus card is the detail surface, and it colors the peak and off-peak words with the state tokens. No click action, settings, storage, network, or Host route.
6. **`order: 1` is required.** The slot wrapper uses `display: contents`, and the host renders `ContextMeter` as the last flex child with default `order: 0`. Removing the rule puts the logo to the left of the ring.
7. **Theme tokens only, platform modules only.** No literal colors in the CSS and no Harness Client package imports. The factory requests `react` and `react-dom` and nothing else.
8. **Holidays are bundled.** 2026 and 2027 only, off-days only. A later year falls back to the weekday rule and says so in the card.

## Development loop

1. **Edit.** Keep `client.js` self-contained. Pure functions stay testable through the non-enumerable `__peakPricePal` face.
2. **Verify.** Run `npm test`. It syntax-checks both JS files and runs the Node harness. There is no build or typecheck step.
3. **Try it.** Edit `client.js` and refresh the Harness page. Edit `index.js`, `package.json`, or `cordis.patch.yml` and restart the Harness.
4. **Commit.** One task, one commit. Imperative subject, no type prefix, no trailing period.
5. **Push.** Only when the human explicitly asks. A green suite is not permission.

## Git contract

- The remote is `origin` -> <https://github.com/DevTarlow/dsh-peak-price-pal.git>.
- Never commit secrets, `node_modules/`, logs, or `.DS_Store`.
- Never rewrite published history.
- Before a push, run `npm test` and confirm `git status --short` is clean.
