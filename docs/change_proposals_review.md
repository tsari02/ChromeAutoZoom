# AutoZoom — Change Proposals Review (grill-me outcome, rev 2)

Status: **decisions agreed, no architecture or code yet.**
Rev 2 folds in your inline comments. Changed items are marked **(rev 2)**.

---

## Background: what `defaults{internal, external}` is today

You asked what this is. Current logic, as built:

- Two seed numbers in `storage.local`: `defaults.internal = 1.0`, `defaults.external = 1.25`
  ([constants.js L17](file:///Users/saritesh/Desktop/ChromeAutoZoom/src/lib/constants.js#L17)).
- The first time AutoZoom sees a display it has no profile for, it creates a **screen profile** with
  `zoomFactor = isInternal ? defaults.internal : defaults.external`
  ([zoom-engine.js L82–89](file:///Users/saritesh/Desktop/ChromeAutoZoom/src/lib/zoom-engine.js#L82-L89), again at L113–116).
  Externals are created `confirmed: false`, which triggers the setup window; the internal screen is auto-confirmed after onboarding.
- The setup window has one row per detected monitor plus an "all external displays" row; accepting writes `defaults.external` and the per-screen `zoomFactor`s.
- After that, `defaults` is **only** used to seed *future* unseen screens. Changing a screen's zoom in the popup edits that screen's profile, not the defaults.

So "defaults" = *two global seeds, one per monitor class*. Change 1 replaces those two seeds with a **resolution → zoom lookup** (below). Everything downstream (per-screen `zoomFactor`, confirmed flag, popup stepper) stays.

---

## Change 1 — Seamless, per-screen setup

| # | Decision |
|---|----------|
| 1.1 | A **resolution → recommended zoom map** replaces `defaults{internal, external}`. Keyed on Chrome's *logical* size + `isInternal`. Table in §Map. |
| 1.2 | **Skip check:** if every tab on a screen is already at the map value → do nothing; screen is set up. |
| 1.3 | **Screen discovered after install:** apply the map value to all tabs on that screen immediately. **No badge, no auto-opened UI (rev 2).** The user changes it from the popup if they disagree. |
| 1.4 | **Install (rev 2):** no window. AutoZoom opens its **toolbar popup** (`chrome.action.openPopup`), in first-run state: a list of every monitor with its recommended zoom and one **Accept** button. Nothing is applied to any screen until Accept. If the popup is dismissed, the next click on the toolbar icon shows the same first-run state. |
| 1.5 | Popup prompt copy for a single screen: "Default zoom for this screen?" + pills. **No tab counts.** |
| ~~1.6~~ | ~~Pre-select detected uniform level~~ — **removed (rev 2).** The map value is always the pre-selection. |

**Notes / risks**
- 1.2 compares against tabs AutoZoom may already have zoomed (per-tab scope). The check is only meaningful on first contact with a screen; harmless afterwards.
- 1.4 depends on `chrome.action.openPopup()`, available to all extensions from **Chrome 127**; it also fails if no normal window is focused. Manifest is currently `minimum_chrome_version: "102"`. See Open item 1.
- With no `!` badge, the only discovery surface is the toolbar icon. Chrome does not auto-pin new extensions; the first-run popup should include "Pin AutoZoom for quick access".

---

## Map — logical resolution → recommended zoom (rev 2)

Baseline: MacBook built-in panel at 100% ≈ **123–126 logical PPI** at ~50 cm
(e.g. 1728×1117 on 16.2", 1512×982 on 14.2", 1470×956 on 13.6").
External monitors sit farther (~60–75 cm), so matching *perceived* size needs
roughly `(MacBook PPI ÷ monitor PPI) × 1.2`, snapped to Chrome's ladder (100 / 110 / 125 / 150 / 175 / 200).

| Logical size (Chrome `bounds`) | Typical panel | Logical PPI | Ratio × 1.2 | **Recommended** |
|---|---|---|---|---|
| Internal, any | MacBook | 123–126 | 1.0 | **100%** |
| ≤ 1920×1200 (1080p / WUXGA) | 24" 1080p, 24" 1200p | 92–94 | 1.6 → but text already larger than MacBook | **100%** |
| 2560×1080 | 29" ultrawide | 96 | 1.5 | **110%** |
| 2560×1440 | 27" QHD, 27" 5K Retina, Studio Display | 109 | 1.37 | **125%** |
| 2560×1600 | 30" 16:10, 16" 4K@~1.5× | 101 | 1.48 | **125%** |
| 3008×1692 | Pro Display XDR default | 108 | 1.38 | **125%** |
| 3440×1440 | 34" ultrawide | 110 | 1.36 | **125%** |
| 3840×1600 | 38" ultrawide | 111 | 1.35 | **125%** |
| 3840×2160 at 1× | 27"/32" 4K unscaled | 138–163 | 1.08–0.92 | **150%** |
| 5120×1440 | 49" super-ultrawide | 109 | 1.37 | **125%** |
| 5120×2880 at 1× | 27" 5K unscaled | 218 | 0.69 | **200%** |
| Any other external | — | — | — | **125%** |

Why 1080p stays at 100% despite the ratio: a 24" 1080p panel already renders text ~35% *larger* than the MacBook; the viewing-distance factor roughly cancels, and 100% is what Windows/macOS also pick for it.

Sources used (search results were sparse; Reddit blocks comment scraping):
- DPReview forum: *"With a 27"/28" 1440p monitor I'd use 100% scaling to get the same text size as the UHD monitor at 150%"* — confirms 4K@1× ≈ 1440p + 1 ladder step above.
- Whirlpool forum: *"get a 27" 1440p and run it at 125% scaling"* — matches 2560×1440 → 125%.
- r/Monitors: some users stay at 100% on 27" 1440p (image-scaling purists) — so the popup must stay one tap away.
- screensizecomparison.org scaling guide: 32" 4K → "many prefer 125%, 150% also sensible"; 34" 3440×1440 text size at 100% ≈ 27" 1440p.
- Windows "Recommended" DPI: 24" 1080p → 100%, 27" 4K → 150%, 13–14" 1080p laptop → 125–150% (not relevant on Mac, internal is always 100% here).

> [!WARNING]
> Chrome only reports **logical** size. A 32" 1440p (92 PPI) and a 27" 1440p (109 PPI) key identically → both get 125%. `chrome.system.display` has `dpiX/dpiY` fields that *may* carry physical PPI on macOS; if they do, the map can use PPI directly. To be verified during design (Open item 3).

---

## Change 2 — Per-screen site deltas

| # | Decision |
|---|----------|
| 2.1 | Deltas stored per `(host, screen)`. Effective zoom = screen default stepped along the ladder: 125% +1 = **150%**, 100% +1 = 110%. |
| 2.2 | **Inheritance:** no row on the current screen → inherit from another screen. **Metric (rev 2, confirmed):** same `isInternal` first, then smallest \|Δ logical area\|, tie → most recently adjusted. If no same-class screen has a row, fall through to the other class with the same rule. |
| 2.3 | First Cmd+/− on a screen writes an explicit row for that screen (including 0). |
| 2.4 | **No "Reset site" button.** Excluding a host clears its rows on all screens. "Clear all site exceptions" wipes everything. Dropping an inherited delta on one screen = step it to 0 there (accepted, rev 2). |
| 2.5 | Popup shows the inheritance source when applicable ("+1 · inherited from External Display"). |

**Note:** rows key on the screen key, not the display name, so renaming (3.1) never orphans deltas.

---

## Change 3 — Current Screen card clipping

| # | Decision |
|---|----------|
| 3.1 | Two-line card: line 1 = short **editable** name (defaults "MacBook Screen" / "External Display"), line 2 = muted "2560×1440 · 125% recommended". |
| 3.2 | Inline rename doubles as the way to tell two identical nameless monitors apart. |

---

## Change 4 — Turn Off

| # | Decision |
|---|----------|
| 4.1 | **Freeze & detach:** tabs keep their current zoom exactly as-is; AutoZoom stops intervening. A tab that navigates to another site gets Chrome's own zoom for that site. |
| 4.2 | Popup wording: just **"Paused"**. |
| 4.3 | "Restore Chrome's zoom" remains as the explicit full release. |
| 4.4 | **Resume** re-applies screen defaults + deltas everywhere immediately (unchanged). |

**Note:** reverses the "Pause releases immediately" decision in `PRD.md` FR-13 / `DEVIATIONS.md`; both get amended in v3. Cmd+/− while paused is still not recorded (existing `enabled=false` guard).

---

## Open items — all resolved (rev 3)

| # | Item | Decision |
|---|---|---|
| 1 | `openPopup` fallback | **(a)** `minimum_chrome_version` → 127; on failure do nothing until the user clicks the icon. |
| 2 | User edits teach the map | **Yes** — `learnedDefaults` keyed by logical size, externals only. |
| 3 | `dpiX/dpiY` | **Not used.** Map stays a simple exact-size table + "≤1920×1200 → 100%" + 125% fallback. |
| — | "Pin AutoZoom" tip in first-run popup | **Yes.** |

Design: [engineering_doc_v3.md](file:///Users/saritesh/.gemini/jetski/brain/ad50dc32-150d-467d-b875-bb72d5bd2ca2/engineering_doc_v3.md).
