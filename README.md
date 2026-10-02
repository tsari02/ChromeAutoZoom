# AutoZoom — Per-Monitor Automatic Zoom (Chrome, Manifest V3)

AutoZoom gives each physical display its own default page zoom (100% on the built-in MacBook screen, 125% on external monitors by default) and applies it automatically to whichever Chrome window is on that screen. Per-site `Cmd +` / `Cmd −` adjustments are remembered as *relative steps* that follow the site across screens, and any site can be excluded.

- **Permissions**: `system.display`, `tabs`, `storage` — no host permissions, no content scripts.
- **Zero build step, zero dependencies**: native ES modules; load the folder directly.
- **Fully reversible**: AutoZoom zooms tabs in per-tab scope and never writes Chrome's own per-site zoom memory. Pause, Exclude or uninstall and every tab returns to Chrome's native zoom.

## Requirements

- Google Chrome **102 or newer** (uses `chrome.storage.session`).
- For tests/scripts: **Node.js 20+** (`node --test`), **Python 3** (icon generator, standard library only), `zip` (packaging).

## Load unpacked (development)

1. Clone or download this folder.
2. Build the loadable copy: `sh scripts/package-extension.sh` → creates **`dist/unpacked/`** (plus the Web Store ZIP).
   Do **not** point Chrome at the repository root: it contains `_agents/`, and Chrome refuses to load any unpacked folder with a file or directory name starting with `_` ("Cannot load extension with file or directory name _agents"). `dist/unpacked/` is a plain copy of `manifest.json`, `icons/` and `src/` with nothing else.
3. Open `chrome://extensions`, turn on **Developer mode** (top right).
4. Click **Load unpacked** and select **`dist/unpacked/`**.
5. The **onboarding window** opens on the display of your focused Chrome window, listing every connected display. Click **Apply**.
6. Pin the toolbar icon. The badge shows the zoom in effect for the current tab (`125`), `PIN` for an excluded site, `OFF` when paused, and nothing at 100%.

After editing code, re-run `sh scripts/package-extension.sh` and click ↻ on the extension card (or load `dist/unpacked/` once and let Chrome pick up the overwritten files on reload).

To inspect the service worker: `chrome://extensions` → AutoZoom → **Service worker** (opens DevTools; it should be free of errors through install → onboarding → confirm). To reload after code changes click the ↻ icon on the extension card.

## Run the tests

```sh
node --test tests/
# or
npm test
```

No npm install is needed. The suite (`tests/*.test.js`) uses a small in-memory `chrome.*` mock (`tests/_chrome-mock.js`) that models Chrome's real zoom semantics (per-origin propagation, per-tab isolation, the scope-change echo event, and host-level writes on release). It covers every pure module and all seven engine scenarios from the engineering doc §10, plus an end-to-end boot of the real service worker.

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
    service-worker.js       top-level listener registration + dispatch only
    sync-scheduler.js       per-window single-flight + 150 ms bounds debounce
    message-router.js       runtime.onMessage handlers (async IIFE + return true)
  lib/
    constants.js            ladder, defaults, timings, message types
    zoom-ladder.js          PURE step math
    geometry.js             PURE window → display resolution (center / overlap / nearest)
    screen-keys.js          PURE stable display keys + matching
    url-rules.js            PURE isZoomableUrl / hostOf
    storage.js              typed storage wrappers; ALL read-modify-writes serialized through one queue
    display-cache.js        system.display.getInfo cache
    tab-zoom.js             the ONLY module that calls setZoom / setZoomSettings
    zoom-engine.js          syncWindow · syncTab · normalizeScreen · handleZoomChange · releaseAll
    setup-window.js         onboarding / new-display window launcher (single-flight, one at a time)
    badge.js                toolbar badge
  setup/                    onboarding + new-display page
  popup/                    toolbar popup
scripts/                    generate-icons.py · package-extension.sh · static-scan.mjs
tests/                      node --test suites + chrome mock
CHROMEWEBSTORE.md           store listing, permission justifications, privacy disclosure, version history
PRIVACY.md                  privacy policy text to host publicly
DEVIATIONS.md               every departure from the engineering design, with the section it changes
PRD.md                      product requirements (amended per engineering doc §9)
```

## How it works (short version)

1. **Which screen?** `windows.onBoundsChanged` / `onFocusChanged` / `system.display.onDisplayChanged` → the window's centre is matched to a display (fallbacks: largest overlap, then nearest; minimized windows are skipped and keep their last screen).
2. **Apply** — the active tab is put into `per-tab` zoom scope and set to `expectedZoom(screenZoom, siteDelta)`. Background tabs are updated lazily on `tabs.onActivated` / `tabs.onUpdated`. Changing a screen's default normalizes every tab on that screen through an 8-wide pool, active tabs first.
3. **Manual zoom detection** is stateless: an `onZoomChange` event is ignored unless its scope is `per-tab` and its new factor differs from the expected one; the difference in ladder steps is saved for that hostname (0 removes the entry). `Cmd+0` is treated like any other manual zoom.
4. **Pause / Exclude / Restore** release tabs back to `per-origin` scope (after resetting them to Chrome's default so Chromium does not copy AutoZoom's level into its per-host memory).

## Display names and screen keys on macOS

Chrome's `system.display.getInfo()` on macOS frequently returns **`name: ""` for every display** (observed on real hardware: built-in and external both nameless, ids `"1"` and `"2"`), and display ids are not stable across reconnects. AutoZoom therefore:

- keys the built-in display as `internal` regardless of name;
- keys a **named** external display as `ext:<slug(name)>` (e.g. `ext:lg-ultrafine`), ignoring resolution so macOS "Looks like" scaling changes don't create a new profile;
- keys a **nameless** external display by its DIP resolution instead, `ext:2560x1440`, and labels it "External Display · 2560×1440" in the UI — so two different nameless monitors never share a profile;
- suffixes **identical** monitors (same name, or nameless with the same resolution) `#2`, `#3`, … by ascending display id.

**Known limitation:** identical monitors are told apart only by id order, so if macOS re-numbers them on reconnect their two profiles may swap. Different monitors are unaffected. Display ids are stored only as `lastSeenDisplayId` (a fast-path match, never part of the key).

## Manual QA matrix (macOS)

MacBook only · MacBook + 1 external · clamshell · two identical monitors · change macOS "Looks like" scaling · Chrome restart · extension update. Expected behaviours are listed in `CHROMEWEBSTORE.md → Review Notes` and the engineering doc.
