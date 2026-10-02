# AutoZoom — Per-Monitor Automatic Zoom (Chrome, Manifest V3)

AutoZoom gives each physical display its own default page zoom (100% on the built-in MacBook screen; external monitors start from a recommendation based on their resolution — 125% for most) and applies it automatically to whichever Chrome window is on that screen. Per-site `Cmd +` / `Cmd −` adjustments are remembered as *relative steps* per screen — a screen without its own adjustment borrows the closest screen's — and any site can be excluded.

- **Permissions**: `system.display`, `tabs`, `storage` — no host permissions, no content scripts.
- **Zero build step, zero dependencies**: native ES modules; load the folder directly.
- **Fully reversible**: AutoZoom zooms tabs in per-tab scope and never writes Chrome's own per-site zoom memory. Exclude a site, click *Restore Chrome's zoom*, or uninstall and every tab returns to Chrome's native zoom. *Pause* simply freezes tabs where they are.

## Requirements

- Google Chrome **127 or newer** (needed so the first-run popup can open by itself right after install; `chrome.storage.session` needs 102). Chrome below 127 is not offered 1.1.0 by the Web Store and stays on 1.0.0.
- For tests/scripts: **Node.js 20+** (`node --test`), **Python 3** (icon generator, standard library only), `zip` (packaging).

## Load unpacked (development)

1. Clone or download this folder.
2. Build the loadable copy: `sh scripts/package-extension.sh` → creates **`dist/unpacked/`** (plus the Web Store ZIP).
   Do **not** point Chrome at the repository root: it contains `_agents/`, and Chrome refuses to load any unpacked folder with a file or directory name starting with `_` ("Cannot load extension with file or directory name _agents"). `dist/unpacked/` is a plain copy of `manifest.json`, `icons/` and `src/` with nothing else.
3. Open `chrome://extensions`, turn on **Developer mode** (top right).
4. Click **Load unpacked** and select **`dist/unpacked/`**.
5. The **toolbar popup opens in its first-run state**, listing every connected display with a recommended zoom (see the table below). Adjust if you like and click **Accept and start** — nothing is zoomed before that, and closing the popup just shows the same state next time. If Chrome doesn't open the popup by itself (its own "extension added" bubble is often in the way), AutoZoom tries once more the next time a window gets focus; after that, click the AutoZoom icon (behind the puzzle-piece menu until you pin it) to see the same first-run screen.
6. Pin the toolbar icon. The badge shows the zoom in effect for the current tab (`125`), `PIN` for an excluded site, `OFF` when paused, and nothing at 100%. A monitor you connect later needs no setup: its tabs get the recommended zoom for its resolution right away, and you can change it from the popup.

After editing code, re-run `sh scripts/package-extension.sh` and click ↻ on the extension card (or load `dist/unpacked/` once and let Chrome pick up the overwritten files on reload).

To inspect the service worker: `chrome://extensions` → AutoZoom → **Service worker** (opens DevTools; it should be free of errors through install → first-run popup → Accept — a logged `openPopup` failure followed by one retry on the next window focus is expected if Chrome's own "extension added" bubble was in the way). To reload after code changes click the ↻ icon on the extension card. Note that reloading an unpacked build fires the `update` path: while first run is unaccepted the popup will pop again on every reload — expected, not a bug.

## Run the tests

```sh
node --test tests/
# or
npm test
```

No npm install is needed. The suite (`tests/*.test.js`) uses a small in-memory `chrome.*` mock (`tests/_chrome-mock.js`) that models Chrome's real zoom semantics (per-origin propagation, per-tab isolation, the scope-change echo event, and host-level writes on release). It covers every pure module (including the resolution → zoom map and per-screen delta inheritance), the engine scenarios from the engineering docs' §10 (`docs/engineering_doc_v2.md`, `docs/engineering_doc_v3.md`), the v2 → v3 storage migration, plus an end-to-end boot of the real service worker (install → first-run popup → Accept → Cmd ± → navigation → drag → display change → pause/resume).

Other checks:

```sh
node scripts/static-scan.mjs     # CSP/MV3 hygiene: no inline scripts, no eval, no .then chains, setZoom only in tab-zoom.js, icons valid…
python3 scripts/generate-icons.py  # regenerate icons/icon-{16,48,128}.png
sh scripts/package-extension.sh   # dist/unpacked/ (Load unpacked) + dist/autozoom-v<version>.zip (Chrome Web Store)
```

## Project layout

```
manifest.json
icons/                      icon-16/48/128.png (generated)
src/
  background/
    service-worker.js       top-level listener registration + dispatch only (install → first-run popup; new displays → normalize)
    sync-scheduler.js       per-window single-flight + 150 ms bounds debounce
    message-router.js       runtime.onMessage handlers (async IIFE + return true)
  lib/
    constants.js            ladder, recommended-zoom table, timings, message types
    zoom-ladder.js          PURE step math
    zoom-map.js             PURE logical resolution → recommended zoom (+ learned overrides)
    site-deltas.js          PURE per-(site, screen) step rows + inheritance (explicit 0, all-0 pruning)
    geometry.js             PURE window → display resolution (center / overlap / nearest)
    screen-keys.js          PURE stable display keys + matching + default screen names
    url-rules.js            PURE isZoomableUrl / hostOf
    storage.js              typed storage wrappers (schema v3 + v2→v3 migration); ALL read-modify-writes serialized through one queue
    display-cache.js        system.display.getInfo cache
    tab-zoom.js             the ONLY module that calls setZoom / setZoomSettings
    zoom-engine.js          syncWindow · syncTab · normalizeScreen · handleZoomChange · releaseAll
    badge.js                toolbar badge (+ hover title with inherited source)
  popup/                    toolbar popup — the only UI: first-run state, two-line renameable screen card, site card, saved screens
scripts/                    generate-icons.py · package-extension.sh · static-scan.mjs
tests/                      node --test suites + chrome mock
docs/                       engineering docs (v2 = 1.0.0 baseline, v3 = 1.1.0), change proposals, implementation pitfalls review
CHROMEWEBSTORE.md           store listing, permission justifications, privacy disclosure, version history
PRIVACY.md                  privacy policy text to host publicly
DEVIATIONS.md               every departure from the engineering design, with the section it changes
PRD.md                      product requirements (amended per engineering doc §9)
```

## How it works (short version)

1. **Which screen?** `windows.onBoundsChanged` / `onFocusChanged` / `system.display.onDisplayChanged` → the window's centre is matched to a display (fallbacks: largest overlap, then nearest; minimized windows are skipped and keep their last screen).
2. **Apply** — the active tab is put into `per-tab` zoom scope and set to `expectedZoom(screenZoom, resolveDelta(host, screenKey))`. Background tabs are updated lazily on `tabs.onActivated` / `tabs.onUpdated`. Changing a screen's default normalizes every tab on that screen through an 8-wide pool, active tabs first. A screen seen for the first time after setup is seeded from the resolution table below (or a learned override) and every tab on it is normalized immediately — no prompt.
3. **Manual zoom detection** is stateless: an `onZoomChange` event is ignored unless its scope is `per-tab` and its new factor differs from the expected one; the difference in ladder steps is saved for that hostname **on the current screen** as an explicit row — `0` included (a `0` pins the site to the screen default there and blocks inheritance; a site whose rows are all `0` is dropped). `Cmd+0` is treated like any other manual zoom.
4. **Exclude / Restore Chrome's zoom** release tabs back to `per-origin` scope (after resetting them to Chrome's default so Chromium does not copy AutoZoom's level into its per-host memory). **Pause does not release** — see below.

## Recommended zoom by resolution

The first time AutoZoom sees a screen it starts from this table (keyed on the *logical* size Chrome reports — what macOS calls "Looks like"). Nothing here is a hard rule: change the screen's zoom in the popup whenever you disagree.

| Display (logical size) | Recommended |
|---|---|
| Built-in MacBook display (any size) | **100%** |
| ≤ 1920×1200 (24" 1080p / WUXGA) | **100%** |
| 2560×1080 (29" ultrawide) | **110%** |
| 2560×1440 (27" QHD, 27" 5K / Studio Display at default scaling) | **125%** |
| 2560×1600 · 3008×1692 (Pro Display XDR default) · 3440×1440 · 3840×1600 · 5120×1440 | **125%** |
| 3840×2160 at 1× (4K, unscaled) | **150%** |
| 5120×2880 at 1× (5K, unscaled) | **200%** |
| Any other external size | **125%** |

Only logical size is known, so a 27" and a 32" 1440p monitor get the same recommendation. When you change an **external** screen's zoom (popup stepper, or in the first-run popup before accepting), that value is remembered for its logical size as a *learned override* and becomes the recommendation for the next never-seen monitor of that size; screens you already have keep their own value, and the built-in display is never learned. Learned overrides are not cleared by *Clear all site exceptions* or *Restore Chrome's zoom*.

## Per-screen site adjustments

`Cmd +` / `Cmd −` on a site is remembered as a number of ladder steps **for the screen you pressed it on**: +1 on a 125% monitor gives 150%; the same +1 on the 100% MacBook gives 110%. A screen that has no adjustment of its own for a site **borrows the closest screen's**: built-in vs. external class first, then the nearest logical area, then whichever was adjusted most recently. The popup says where a borrowed step came from (*"+1 step · inherited from External Display → 110%"*).

To stop inheriting on one screen, press `Cmd −`/`Cmd +` there until the site is back at that screen's default — that stores an explicit *0* for that screen, which sticks. There is no "Reset site" button: excluding a site clears its steps on every screen, and *Clear all site exceptions* wipes them all.

## Renaming screens

The Current Screen card has two lines — an editable name (✎, up to 40 characters; Enter/blur saves, Esc cancels, empty reverts to the default) over `2560×1440 · 125% recommended`. Defaults are "MacBook Screen" and "External Display" (or the name macOS reports). Names are cosmetic: screen keys and site adjustments are untouched by a rename, and the Saved screens list is editable in the same way.

## Pause vs. Restore Chrome's zoom

- **Pause** (header toggle; label *Paused*) freezes every tab exactly where it is and AutoZoom stops intervening. Nothing is re-zoomed. A paused tab follows Chrome's own zoom again on its next navigation; a `Cmd +`/`Cmd −` while paused is per-tab, is not remembered by AutoZoom or by Chrome, and is lost on that tab's next navigation. **Resume** re-applies screen defaults and site steps to every tab on every connected screen.
- **Restore Chrome's zoom** (footer) is the one action that hands every tab back to Chrome's native per-origin zoom — what you would see with AutoZoom uninstalled. It also switches AutoZoom off; your screens and site steps are kept for when you turn it back on.

## Display names and screen keys on macOS

Chrome's `system.display.getInfo()` on macOS frequently returns **`name: ""` for every display** (observed on real hardware: built-in and external both nameless, ids `"1"` and `"2"`), and display ids are not stable across reconnects. AutoZoom therefore:

- keys the built-in display as `internal` regardless of name;
- keys a **named** external display as `ext:<slug(name)>` (e.g. `ext:lg-ultrafine`), ignoring resolution so macOS "Looks like" scaling changes don't create a new profile;
- keys a **nameless** external display by its DIP resolution instead, `ext:2560x1440`, and names it "External Display" (a second one "External Display 2") with the resolution on the card's second line — so two different nameless monitors never share a profile; rename either from the popup if you like;
- suffixes **identical** monitors (same name, or nameless with the same resolution) `#2`, `#3`, … by ascending display id.

**Known limitation:** identical monitors are told apart only by id order, so if macOS re-numbers them on reconnect their two profiles may swap. Different monitors are unaffected. Display ids are stored only as `lastSeenDisplayId` (a fast-path match, never part of the key). **Since 1.1.0 new screens are applied immediately, without a prompt**, so a nameless monitor whose macOS "Looks like" scaling changes after a reconnect keys differently and may be treated as a brand-new screen: its tabs get the recommended zoom for the new resolution (or your learned override for it) and the old profile's zoom, name and site adjustments stay behind under the old key. Named monitors are unaffected (resolution is not part of their key); for nameless ones, pick a scaling and keep it, then adjust in the popup if a new profile does appear.

## Manual QA matrix (macOS)

MacBook only · MacBook + 1 external · clamshell · two identical monitors · change macOS "Looks like" scaling · Chrome restart · extension update (1.0.0 → 1.1.0: global site steps fan out to every screen; a user who never finished 1.0.0 setup gets the first-run popup) · fresh install → first-run popup → Accept · new monitor after setup (no prompt, tabs at the recommended zoom, also in the +1.5 s pass) · Gmail +1 on the external / −1 on the MacBook (inherited, then explicit 0) · Pause → `Cmd +` → navigate (follows Chrome's zoom; host not listed in `chrome://settings/content/zoomLevels`) → Resume · rename a screen (card and badge title update) · two-line card not clipped at 340 px. Expected behaviours are listed in `CHROMEWEBSTORE.md → Review Notes` and the engineering docs (`docs/`).
