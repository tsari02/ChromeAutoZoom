# AutoZoom v1.1.0 — Implementation Pitfalls Review

Reviewed: [change_proposals_review.md](file:///Users/saritesh/.gemini/jetski/brain/ad50dc32-150d-467d-b875-bb72d5bd2ca2/change_proposals_review.md) · [engineering_doc_v3.md](file:///Users/saritesh/.gemini/jetski/brain/ad50dc32-150d-467d-b875-bb72d5bd2ca2/engineering_doc_v3.md) · cross-checked against the shipped 1.0.0 source.

Verdict: the design is coherent and the decisions are sound. But the doc's own code sketches contain **five things that ship a bug if followed literally**, plus a handful of UX consequences the decisions imply but never state. Tiers below are ordered by "how much it hurts if missed".

---

## 🔴 Tier A — Follow the doc literally and you ship a bug

| # | Pitfall | Where | Fix |
|---|---|---|---|
| A1 | **`recommendedZoom` mis-classifies missing sizes.** `null <= 1920` is `true` in JS (null→0), `undefined <= 1920` is `false` (NaN). So a v2-migrated external (`width: null` per §3) is recommended **100%**, and a raw `DisplayUnitInfo` (size lives in `bounds`, not top-level) gets `"NaNxNaN"` as its `sizeKey` and the 125% fallback for *every* monitor, 4K included. Hand-built test fixtures `{isInternal, width, height}` will pass while production is wrong. | [doc §4 L138–145](file:///Users/saritesh/.gemini/jetski/brain/ad50dc32-150d-467d-b875-bb72d5bd2ca2/engineering_doc_v3.md#L138-L145) | Normalise input (`d.bounds ?? d`), require `Number.isFinite(w) && w > 0` before the ≤1920 rule, return fallback for unknown size. Test with the real `bounds` fixture shape from [_chrome-mock.js L406–429](file:///Users/saritesh/Desktop/ChromeAutoZoom/tests/_chrome-mock.js#L406-L429). Use `isInternalDisplay()` (name-regex fallback), not raw `isInternal`. |
| A2 | **"Restore Chrome's zoom" silently becomes Pause.** `RELEASE_ALL` is wired to `engine.setEnabled(false)`. v3 strips `releaseAll()` out of `setEnabled(false)`, so unless the router is rewired, the one explicit release path freezes instead. §8 lists `RELEASE_ALL` as *unchanged* — it is not. | [message-router.js L172–173](file:///Users/saritesh/Desktop/ChromeAutoZoom/src/background/message-router.js#L172-L173) · [doc §8 L322](file:///Users/saritesh/.gemini/jetski/brain/ad50dc32-150d-467d-b875-bb72d5bd2ca2/engineering_doc_v3.md#L322) | `RELEASE_ALL` → `patchState({enabled:false})` + `releaseAll()`. Test must assert ≥1 `setZoomSettings(per-origin)` call, not just `enabled === false`. |
| A3 | **Resume is described as "unchanged" but it isn't.** Doc says `setEnabled(true)` = `resyncAllWindows` **+ `normalizeScreen` for every connected key**. Current code only does `resyncAllWindows` (active tab per window, FR-7). Background tabs would stay frozen until activated — contradicting "re-applies everywhere immediately" (4.4). | [zoom-engine.js L308–312](file:///Users/saritesh/Desktop/ChromeAutoZoom/src/lib/zoom-engine.js#L308-L312) · [doc §5.4 L227](file:///Users/saritesh/.gemini/jetski/brain/ad50dc32-150d-467d-b875-bb72d5bd2ca2/engineering_doc_v3.md#L227) | Reuse the connected-key enumeration from `clearSiteExceptions()` ([L361–369](file:///Users/saritesh/Desktop/ChromeAutoZoom/src/lib/zoom-engine.js#L361-L369)). Test: tab in a *non-active* position on each screen gets `setZoom` on resume. |
| A4 | **`learnedDefaults` gets poisoned with `"0x0"`.** Update path with `onboardingCompleted=false` (user never finished v2 setup) → popup first-run → Accept → `confirmSetup` calls `setLearnedDefault(sizeKey(screen))` on migrated profiles whose `width/height` are `null` → `Math.round(null)` = 0. | [doc §5.4 L232](file:///Users/saritesh/.gemini/jetski/brain/ad50dc32-150d-467d-b875-bb72d5bd2ca2/engineering_doc_v3.md#L232) · [doc §3 L114](file:///Users/saritesh/.gemini/jetski/brain/ad50dc32-150d-467d-b875-bb72d5bd2ca2/engineering_doc_v3.md#L114) | `setLearnedDefault` refuses keys without positive dims; `storage.normalize()` drops malformed keys. |
| A5 | **`defaultScreenName(display, key, screens)` needs a live display, but migration runs with none.** §3 says auto-labels are rewritten "by `defaultScreenName()`" inside `migrateFrom`, which only has stored profiles. | [doc §5.1 L161](file:///Users/saritesh/.gemini/jetski/brain/ad50dc32-150d-467d-b875-bb72d5bd2ca2/engineering_doc_v3.md#L161) · [storage.js L131–172](file:///Users/saritesh/Desktop/ChromeAutoZoom/src/lib/storage.js#L131-L172) | Make it profile-driven (`{isInternal, name}` + sibling count); accept a display as optional input. |

> [!WARNING]
> A1 and A2 are the ones that would pass a naïve test suite and only show up on a real Mac. Make them explicit acceptance criteria.

---

## 🟠 Tier B — Consequences the decisions imply but don't state

| # | Pitfall | Why it matters | Options |
|---|---|---|---|
| B1 | **First-run discoverability cliff.** `onboardingCompleted=false` gates *all* zooming ([targetFor L27](file:///Users/saritesh/Desktop/ChromeAutoZoom/src/lib/zoom-engine.js#L26-L32)). If `openPopup()` fails, the extension is dormant with zero UI: no badge (removed), icon unpinned behind the puzzle menu. v2's setup window was unmissable. | Realistic failure modes: (a) Chrome's own "extension added" bubble is on screen at the exact moment `onInstalled` fires — **verify in live QA, this is the common path**; (b) no focused normal window (sync/policy install, Chrome in background); (c) a popup already open. The API doc only promises "opens in the currently-active window". | Cheap mitigation that honours "no badge, no window": retry `openPopup()` once on the next `windows.onFocusChanged` while unaccepted (D23 becomes "silent *first* failure"). Or accept the cliff and log it. |
| B2 | **Explicit-0 rows are a one-way door.** Once `{internal: {delta: 0}}` exists for a host, that screen can never inherit again. "Reset site" is gone (2.4); the only escapes are *Clear all* (nukes every host) or exclude→re-include (nukes that host on every screen). `pruneHost` only fires when *all* rows are 0. | Users who correct a site once on the laptop are permanently opted out of inheritance for it there — with no indication why. | Accept and document in D22, or add a small "use inherited (+1 from External Display)" affordance when an explicit row shadows an inheritable one. |
| B3 | **"recommended" label drifts to "whatever you chose last".** §7 derives N from `recommendedZoom` *with learned overrides*. Every stepper click on an external learns. So the screen you just changed always reads "· recommended", and a sibling identical-size monitor (`ext:2560x1440#2`) reads "150% recommended" while sitting at 125%. | The label stops carrying information. | Show the *table* value in the UI; let learned values only seed new profiles. |
| B4 | **Pause ≠ Chrome's native behaviour.** Frozen tabs stay in per-tab scope. A Cmd+ while paused is per-tab and discarded on navigation (Chrome native would remember it per-origin), and Resume overwrites it. | Users will expect Chrome-native zoom while paused. | Fine as a decision — but D21 should say it, and the popup "Paused" tooltip could too. |
| B5 | **Immediate-apply raises the cost of key instability.** Nameless monitors key on resolution ([buildKey L28–68](file:///Users/saritesh/Desktop/ChromeAutoZoom/src/lib/screen-keys.js#L28-L68)); identical monitors tie-break on display id. A "Looks like…" scaling change on a reconnected nameless monitor, or a macOS id swap between twins, creates a *new* profile → v3 re-zooms every tab on it to the map value with no prompt, orphaning the old profile's zoom and deltas. v2 would have asked. | Low frequency, high surprise. | At minimum: when a new profile is created post-first-run and an orphaned profile of the same class exists with no connected display, consider cloning its `zoomFactor` instead of the map value. Or accept and add to README caveats. |
| B6 | **`learnedDefaults` is invisible, permanent memory.** Nothing lists it, nothing clears it — not *Clear all site exceptions*, not *Restore Chrome's zoom*. A single accidental stepper click on a 4K monitor teaches 110% for every future 4K monitor. | Silent state that users can't inspect or undo. | Give it a reset path (fold into *Restore Chrome's zoom*, or a footer link), and mention it in PRD §schema. |
| B7 | **`External Display N` counts stale profiles.** N = 1 + count of *existing* external profiles, including long-disconnected ones → "External Display 4" for someone's only monitor. | Cosmetic, but it's the first thing the user sees in the two-line card. | Count connected profiles only, or number lazily on collision. |

---

## 🟡 Tier C — Lifecycle & concurrency traps specific to this codebase

| # | Pitfall | Detail |
|---|---|---|
| C1 | **Normalization storms from `resolveScreenForWindow`.** §5.4 has it fire `normalizeScreen(key)` when it creates a profile. It's called per window inside `syncWindow` → `resyncAllWindows`. N windows landing on a never-seen monitor → N full normalization passes, *plus* the one `syncDisplays` already triggered for the same key. The per-tab single-flight in [tab-zoom.js L19–40](file:///Users/saritesh/Desktop/ChromeAutoZoom/src/lib/tab-zoom.js#L19-L40) makes them no-ops but each still does `getZoomSettings` + `getZoom` on every tab. **Fix:** only the path that actually *created* the profile normalizes (check `upsertScreen`'s prior state), and reuse the module-level created-keys `Set` from §6 as an in-flight guard. |
| C2 | **`width/height` refresh has two callers; the doc spells out one.** §5.1 says "caller refreshes"; §5.4 only mentions `resolveScreenForWindow`. [`syncDisplays` L73–81](file:///Users/saritesh/Desktop/ChromeAutoZoom/src/lib/zoom-engine.js#L73-L81) currently patches only `lastSeenDisplayId` on match. Miss it and migrated profiles keep `null` sizes until a window-level sync happens → `areaGap` stays `Infinity` → inheritance degrades to pure recency. |
| C3 | **Migration fan-out makes recency ties arbitrary.** Every fanned-out row gets the same `updatedAt`. Fine while all screens are explicit, but a *new* screen inheriting among equal-area candidates picks whichever `Object.entries` yields first. Add a deterministic final tiebreaker (`createdAt`, then key) or tests will flake across Node versions. |
| C4 | **Dev-loop noise.** `onInstalled{reason:'update'}` fires on every unpacked reload; with `onboardingCompleted=false` the popup pops on every reload. Harmless, but the team should know it's expected and not "fix" it. `migrate()` is already idempotent at ≥ current version. |
| C5 | **Chrome resets per-tab scope on cross-document navigation** (already relied on in [service-worker.js L109](file:///Users/saritesh/Desktop/ChromeAutoZoom/src/background/service-worker.js#L108-L111)). Freeze-and-detach depends on Chromium's `ResetZoomModeOnNavigationIfNeeded` clearing the temporary level *without* copying it into the host zoom map — true today, but it's an undocumented Chromium internal. Keep the `releaseZoom` "write default first" dance as-is and add a manual QA step: pause → Cmd+ → navigate → `chrome://settings/content/zoomLevels` must not list the host. |

---

## 🔵 Tier D — Running this through teamwork

| # | Pitfall | Mitigation |
|---|---|---|
| D1 | **The spec lives outside the repo.** v3 says "everything else unchanged from v2" and links `engineering_doc_v2.md` in the brain dir. Agents can't be handed artifact paths (they may change). | Copy `engineering_doc_v3.md`, `change_proposals_review.md` (and v2 for reference) into `docs/` in the repo before launch; state that the current code *is* the v2 baseline. |
| D2 | **Tests are the only automated gate, and they're deletable.** `setup-window` scenarios will fail; the path of least resistance is to delete them rather than port them. `static-scan.mjs` doesn't catch dead imports or dangling `MSG.*` references. | Acceptance criteria must (a) name the scenarios in doc §10, (b) forbid net test-count decrease, (c) require a grep gate for `setup-window`, `SETUP_MODE`, `GET_SETUP_DATA`, `DISMISS_SETUP`, `OPEN_ONBOARDING`, `CLEAR_SITE_DELTA`, `.confirmed`, `defaults.internal/external` → zero hits in `src/`. |
| D3 | **Live QA is partly automatable, partly not.** The `chrome-devtools-mcp` server here has `install_extension`, `reload_extension`, `trigger_extension_action`, `list_extensions` — enough to verify install → first-run popup → Accept → zoom applied → `RELEASE_ALL` releases. Display hot-plug, "Looks like…" changes, and the install-bubble race (B1) remain manual on this Mac. | Split acceptance criteria into *automated* (must pass) and *manual QA checklist* (you sign off). |
| D4 | **The doc is prescriptive by design** (file names, signatures). If the prompt copies it as *requirements*, judges will score structural conformance instead of behaviour. | Cite the doc as reference material; write requirements behaviourally; let judges verify behaviour via tests + the grep gate. |
| D5 | **House rules.** [GEMINI.md](file:///Users/saritesh/Desktop/ChromeAutoZoom/GEMINI.md) requires `CHROMEWEBSTORE.md` to be maintained; `package.json` version should move to 1.1.0 alongside the manifest (doc §2 only shows the manifest diff). | Make both explicit acceptance criteria. |
| D6 | **`minimum_chrome_version: 127` is a one-way publish decision.** The Web Store will never serve 1.1.0 to a profile below 127 — they stay on 1.0.0 indefinitely. Acceptable in 2026, but note it in CHROMEWEBSTORE.md Compatibility (doc §11 already says so). | — |

---

## Suggested amendments to the spec before launch

1. §4 `recommendedZoom`: accept `display | screen`, guard dims (A1).
2. §8: mark `RELEASE_ALL` **changed** and specify its new wiring (A2).
3. §5.4: mark `setEnabled(true)` **changed** (A3).
4. §5.3: `setLearnedDefault` validates `sizeKey` (A4); `defaultScreenName` is profile-driven (A5).
5. §6: `openPopup` retry-on-focus policy — decide (B1).
6. §7: "recommended" subtitle = table value, not learned (B3) — decide.
7. §5.2: deterministic final tiebreaker in `resolveDelta` (C3).
8. §5.4: dedupe `normalizeScreen` triggers for a freshly created key (C1).
9. §9: D21 wording covers B4; new deviation for `learnedDefaults` reset path (B6).
