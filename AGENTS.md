# AGENTS.md: Peak Price Pal

A DeepSeek Harness plugin. The visible half is `client.js`: a 20px sun or moon in `conversation.composer.dock`, to the right of the context ring, with a hover card for the rate, the balance, and today's tracked spend. The Host half is `index.js`: one owner-only balance route that reads the credential the Harness already has.

## Layout

```
index.js            the Host half: balance route, source reads, normalization, cache
client.js           the browser half: time math, holiday table, model gate, settings store and page, logo, hover card, balance monitor and ledger
cordis.patch.yml    the bundle layer: one insert row
locale/*.json       inventory title and description (en, zh)
icon.svg            the plugin-list mark
docs/               detail documents and the text-free preview
test/               the two Node harnesses (host and client)
```

## Invariants

1. **Beijing time is UTC+8, always.** Compute it from `Date.UTC`, never from the host time zone. Beijing has no daylight saving time.
2. **Peak is Monday to Friday, 09:00-12:00 and 14:00-18:00, excluding bundled Chinese holidays.** Starts are inclusive, ends are exclusive. Weekends are off-peak all day, including make-up working weekends.
3. **Off-peak is half the peak rate.** The hover card says that; it does not quote per-model prices.
4. **The gate is the provider id, not the model name.** `deepseek`, `deepseek-official`, and `deepseek-account` show. `openrouter` with a `deepseek/...` model stays hidden. Unknown routes stay hidden.
5. **The logo is icon-only.** The hover/focus card is the detail surface, and it colors the peak and off-peak words with the state tokens. The card has no click action. Browser-local settings, the last balance reading, and the daily spend buckets are the only storage; the one Host route is read-only and owner-only.
6. **`order: 1` is required.** The slot wrapper uses `display: contents`, and the host renders `ContextMeter` as the last flex child with default `order: 0`. Removing the rule puts the logo to the left of the ring.
7. **Theme tokens only, platform modules only.** No literal colors in the CSS and no Harness Client package imports. The factory requests `react` and `react-dom` and nothing else.
8. **Holidays are bundled.** 2026 and 2027 only, off-days only. A later year falls back to the weekday rule and says so in the card.
9. **Settings are browser-local, versioned, and live.** The `settings.plugins.tab` page writes the `dsh-peak-price-pal.settings.v1` store with icon, clock, detail, and balance choices; the logo, card, and monitor read it through `useSyncExternalStore`. Unknown values fall back to defaults, and blocked storage keeps the in-memory choice for the page. Controls are custom and token-styled, never imported from a Harness Client package.
10. **Display choices reach every surface.** The icon choice changes the logo glyph. The clock choice changes the current and next stamps and picks `tip.rule12`. Minimal detail keeps the state line, the balance rows, and the next-switch line, in the card and in the accessible description, and drops the stamps, the rule, today's status, and the route. Minimal does not stop tracking; only the balance choice does. Show reads and tracks, Hide stops both. The balance and tracked spend live in the hover card, not the settings page; the settings page shows the choice and the source the page checked, never an amount.
11. **The balance follows the route.** `deepseek-account` reads the signed-in account wallet; `deepseek` and `deepseek-official` read the API key; other `deepseek-*` ids try the key and then the account. A route never borrows another route's credential, because the two can be different billing accounts.
12. **No second key.** The Host resolves `DEEPSEEK_API_KEY`, then `DEEPSEEK_OFFICIAL_API_KEY`, through `ctx.credentials`; without that service it reads the process environment. The account route uses `ctx.deepseekAccount`. No secret enters settings, local storage, the route response, or a log.
13. **The balance route is one guarded read.** `GET /peak-price-pal/balance`, `auth: 'required'`, owner check, `cache-control: no-store`, a 30-second in-process cache per source, and failures are not cached. The page reads on mount and once a minute while the balance is shown, including while the tab is in the background; opening Settings reads once. There is no Host timer.
14. **Tracked today is an observed local-day total.** The card labels it `Tracked today`. The ledger keys on source and currency. A drop counts as spend only when the previous reading is from the same local day and no more than 15 minutes old; a larger gap or a new day seeds a baseline. Only eight days and the last reading are kept. It is not an invoice, and granted-balance expiry or a changed key can look like a drop.
15. **The Host and client share one contract.** Both sides validate the route path and the ready/failed/unconfigured shape; an untrusted field is never displayed or formatted.

## Documentation upkeep

The README is part of the build. When a change affects what it describes, update it in the same task and commit. That covers behavior, defaults, settings, install steps, limits, privacy, prices, holidays, images, and the version.

Keep the existing sections and voice. Weave the new detail into the section that already owns it. Rewrite only the text the change makes wrong. Do not reorder or restyle the README for a small update, and do not replace a working paragraph with a fresh one just because you are editing.

The README keeps its plain product-note voice: concrete, varied sentence lengths, no stock AI phrases, no em dashes. Run the my-voice checker from the DSH checkout when it is available:

```sh
node <checkout>/.agents/skills/my-voice/scripts/voice-check.mjs README.md --format=note
```

This file follows the same rule. When an invariant, layout entry, or development step changes, update the relevant AGENTS.md section instead of rewriting the file.

## Development loop

1. **Edit.** Keep `client.js` self-contained. Pure functions stay testable through the non-enumerable `__peakPricePal` face; pure Host helpers stay testable through `apply.__peakPricePalHost`.
2. **Verify.** Run `npm test`. It syntax-checks both JS files and runs `test/host.test.mjs` and `test/client.test.mjs`. There is no build, typecheck, or lint step, and the suite finishes well under a second.
3. **Update the docs.** If the change affects the README, update it in the same task. Keep its sections and voice, and rewrite only what the change makes wrong. Update this file the same way.
4. **Try it.** Edit `client.js` and refresh the Harness page. Edit `index.js`, `package.json`, or `cordis.patch.yml` and restart the Harness.
5. **Commit when the task is done.** One task, one commit. Commit as soon as the change is complete and the suite is green; do not wait for a push instruction. Imperative subject, no type prefix, no trailing period. Add a body explaining why for anything non-obvious.
6. **Report.** Give the short SHA, the subject, the test result, and anything you could not verify. Say it has not been pushed.
7. **Push only on an explicit instruction.** The human says "push", "push it", or "push that" when they are ready. That instruction covers the current commit, not the next one. A green suite, a finished task, or a previous push is not permission.

## Git contract

- The remote is `origin` -> <https://github.com/DevTarlow/dsh-peak-price-pal.git>.

| Action | Who | When |
| --- | --- | --- |
| `git commit` | the agent, unprompted | as soon as a task is complete and verified |
| `git push` | only when the human explicitly says so | on an unambiguous instruction such as "push", "push it", or "push that" |

- Never push on your own initiative. A green suite, a clean diff, a finished task, or a previous push is not permission.
- Never rewrite published history.
- One task, one commit. Keep unrelated fixes out; an unrelated fix gets its own commit.
- A question or analysis with no file changes needs no commit. A red suite does not get committed; report the failure instead.
- Never commit secrets, `node_modules/`, logs, or `.DS_Store`.
- Before a push, run `npm test` and confirm `git status --short` is clean.
