# Product Requirements Document (PRD): AutoZoom Chrome Extension

> **Amended per Engineering Doc v2 §9.** The following items were changed in place to match the implemented design:
> FR-3 (3), Journey 1 Case A, Journey 5, Journey 6, FR-2 key rule, FR-10, FR-11 badge text, FR-12 reset actions, §6.2 storage schema, new FR-13 (Reversibility), new §2.2 non-goal (`Cmd+0`).
>
> **Amended for 1.1.0 (2026-10-03) per Engineering Doc v3 §9** (`docs/engineering_doc_v3.md`; decisions in `docs/change_proposals_review.md`): §1.2, §2.1, §2.2 (`Cmd+0`), §3 ladder roles, Journey 1 (toolbar-popup first-run state; Accept applies), Journey 2 (new monitor → recommended zoom applied immediately), Journey 4 (per-screen deltas with inheritance), Journey 5, Journey 6 (two-line renameable card; Pause freezes), FR-2 defaults (resolution map + learned overrides — the eng doc calls this "FR-4 / defaults"), FR-5/FR-6, FR-8, FR-10 (per (site, screen) rows, explicit `0`, inheritance — the eng doc calls this "FR-11 (site deltas)"), FR-11 hover title, FR-12 (Reset-site button removed), FR-13 (Pause freezes; *Restore Chrome's zoom* is the explicit release), §6.2 storage schema v3.
>
> **1.1.0 polish (2026-10-03, `DEVIATIONS.md` D24–D26):** Journey 6 / FR-5 / FR-11 — the first-run rows and the Current Screen card show the screen's size only (no "recommended" label; the recommendation is simply pre-selected); FR-11 — no badge text on excluded sites (`PIN` removed); FR-11 / Journey 6 — *Restore Chrome's zoom* acts on one click with no confirmation dialog.

## 1. Overview & Problem Statement

### 1.1 Problem
MacBook users frequently switch between working on their built-in laptop Retina display, one or more external monitors, or in clamshell mode (external monitors only). Because external monitors sit further away from the user and have different pixel densities (PPI) and scaling characteristics than a MacBook's built-in display, web pages that are comfortably readable at `100%` on a MacBook look too small on an external monitor.

Furthermore, users who search for and install an extension like AutoZoom are typically **already frustrated on their external monitor** and have manually zoomed various websites inconsistently (`110%` on one site, `125%` on another, `100%` on new sites).

### 1.2 Solution
**AutoZoom** is a sleek, minimal-permission Chrome Extension (Manifest V3) built around **Persistent Per-Screen Default Zoom %**:
- Each physical screen (Built-in MacBook display, External Monitor 1, External Monitor 2, etc.) has its own **persisted default Zoom %** — **`100%`** on the MacBook built-in screen, and for external monitors a **recommended value derived from the monitor's resolution** (`125%` for most, e.g. 2560×1440; `110%` for 2560×1080; `150%` for 4K at 1×; `100%` for 1080p-class panels) that the user can override per screen.
- On first install the **toolbar popup opens in a first-run state** listing every connected display with its recommended Zoom % pre-selected; nothing is applied until the user clicks **Accept**. A monitor connected later gets its recommended zoom applied **immediately, with no prompt**, and can be adjusted from the popup at any time.
- Immediately upon Accept, AutoZoom normalizes the tabs on every listed display to the confirmed Zoom % (e.g., `125%`), wiping away inconsistent pre-install zoom levels.
- Whenever a Chrome window moves to or is active on a screen, AutoZoom automatically applies that screen's persisted Zoom %.

---

## 2. Goals & Non-Goals

### 2.1 Goals
- **Persistent Per-Screen Zoom %**: Let users define and persist an explicit default Zoom % for each display (e.g., Built-in MacBook = `100%`, Dell 27" Monitor = `125%`, Ultrawide Monitor = `110%`), seeded from a resolution → recommended-zoom map so most users never have to pick a number.
- **Frustration-Free First-Install Onboarding**: Handle all 3 common initial hardware setups seamlessly—**(a) MacBook Only**, **(b) MacBook + Single/Multiple External Monitors**, and **(c) Clamshell Mode (External Monitors Only)**—via the toolbar popup's first-run state (no extra window) requiring minimal permissions. Monitors connected later need no prompt at all.
- **Clean Slate on Confirmation**: Immediately apply the confirmed Zoom % (e.g., `125%`) across the tabs in that monitor's window upon Accept so pre-existing messy zoom states are cleaned up immediately.
- **100+ Tab Performance (Lazy Evaluation on Day-to-Day Transitions)**: During ongoing monitor switches or window drags, immediately update the active tab in each window and lazily update background tabs as the user switches to them (`tabs.onActivated`).
- **Relative Per-Site Exceptions (`Cmd +` / `Cmd -`), Per Screen**: By default, every website uses the active screen's exact default Zoom %. If a user manually adjusts a specific site via `Cmd +` or `Cmd -` *after* AutoZoom is installed, remember that site's relative step delta for the screen it was adjusted on (e.g. `+1 step` above that screen's default); screens without their own adjustment inherit the closest screen's.
- **Minimal Permissions & Zero Content Scripts**: Use only `"system.display"`, `"tabs"`, and `"storage"`—no `<all_urls>` host permissions or injected webpage scripts.

### 2.2 Non-Goals
- Preserving messy, inconsistent per-site zoom levels that existed *before* AutoZoom was installed.
- Injecting DOM/CSS content scripts into webpages (which require broad host permissions and break page layouts).
- Honoring `Cmd+0` (Chrome's "reset zoom") specially. A `Cmd+0` press is treated like any other manual zoom: the resulting factor is recorded as a normal relative step delta for the site on the current screen (which may be `0` — stored as an explicit row that pins the site to this screen's default and blocks inheritance — or non-zero on a non-100% screen).
- Path-level site rules (e.g. `docs.google.com/presentation`). Site exceptions and exclusions are **host-level only** in v1.

---

## 3. Standard Chrome Zoom Ladder

AutoZoom uses Chrome's official 17-step zoom scale both for selecting a screen's **Default Zoom %** and for calculating relative per-site `Cmd +` / `Cmd -` exceptions:

| Step Index | Zoom % | Zoom Factor | Typical Screen Assignment / Role |
| :--- | :--- | :--- | :--- |
| 0–4 | 25%–75% | `0.25`–`0.75` | Available in advanced steps |
| 5 | 80% | `0.80` | -2 steps from 100% |
| 6 | 90% | `0.90` | -1 step from 100% |
| 7 | **100%** | `1.00` | **Default for Built-in MacBook Display**; recommended for external monitors ≤ 1920×1200 |
| 8 | 110% | `1.10` | +1 step above 100%; recommended for 2560×1080 ultrawides |
| 9 | **125%** | `1.25` | **Recommended for most external monitors** (2560×1440, 3440×1440, … and any unlisted size) (+2 steps above 100%) |
| 10 | 150% | `1.50` | +3 steps above 100% (or +1 step above 125% monitor); recommended for 3840×2160 at 1× |
| 11 | 175% | `1.75` | +4 steps above 100% |
| 12 | 200% | `2.00` | +5 steps above 100%; recommended for 5120×2880 at 1× |
| 13–16 | 250%–500% | `2.50`–`5.00` | High-zoom accessibility steps |

---

## 4. End-to-End Customer User Journeys

### Journey 1: First-Time Installation & First-Run Popup
Because users may install AutoZoom under any of three hardware states, AutoZoom inspects `chrome.system.display.getInfo()` and `chrome.windows.getAll()` on `runtime.onInstalled` and then opens the **toolbar popup in its first-run state** (`chrome.action.openPopup()`). (Amended for 1.1.0 per Eng Doc v3 §9: previously a separate onboarding window, `setup.html`.)

#### Case A: Installed with MacBook + 1 or More External Monitors Connected
1. AutoZoom detects the internal display (`isInternal: true`) and each connected external monitor (`isInternal: false`).
2. The toolbar popup opens in its **first-run state**, listing **all connected displays** in a single card — one two-line row per display (name / `W×H · recommended`) — anchored to the toolbar of the active window. (Amended for 1.1.0 per Eng Doc v3 §9: previously "one onboarding window"; per Eng Doc v2 §9 before that: "a popup per external monitor".)
3. Each row identifies the display by its default name (*MacBook Screen*, *External Display*, or the hardware name macOS reports, e.g. *"LG UltraFine"*) with a zoom selector along Chrome's ladder:
   - **External monitors**: Pre-selected to the **recommended zoom for their resolution** (FR-2) — `125%` for most monitors (e.g. 2560×1440), `110%` for 2560×1080, `150%` for 3840×2160, `200%` for 5120×2880, `100%` for anything ≤ 1920×1200 — with quick-select pills (`100%`, `110%`, `125%`, `150%`, etc.).
   - **Built-in MacBook display**: Pre-selected to **`100%`**.
   - There is **no row for displays that are not connected**: a monitor plugged in later receives its recommended zoom automatically (Journey 2).
4. **Instant Confirmation**: As soon as the user clicks the single **"Accept"** button, **all tabs on every listed display's window(s) are normalized to that display's confirmed zoom**, immediately fixing any inconsistent zoom states the user had prior to installing, and the popup switches to its normal state. An external value the user changed before accepting is also remembered as the recommendation for future monitors of that resolution.
5. **Nothing is zoomed before Accept.** Closing the popup without accepting changes nothing; the same first-run state appears on the next click of the toolbar icon. If Chrome cannot open the popup automatically (e.g. its own "extension added" bubble is showing at that moment), AutoZoom retries once on the next window-focus change and otherwise waits for the user to click the icon. The first-run state includes a tip to pin AutoZoom to the toolbar.

#### Case B: Installed in Clamshell Mode (External Monitor(s) Only, MacBook Lid Closed)
1. AutoZoom detects one or more external displays (`isInternal: false`) and no active internal display.
2. The first-run popup lists each external monitor with its recommended zoom pre-selected (e.g. **`125%`** for 2560×1440). There is no row for the absent built-in display — it is always `100%` by the map.
3. Upon Accept, all tabs on the external monitor window(s) immediately update to the accepted zoom (e.g. `125%`).
4. Later, when the user unplugs the monitor and opens their MacBook lid, AutoZoom applies the built-in display's recommended `100%` and transitions seamlessly with zero prompts.

#### Case C: Installed on MacBook Only (No External Monitor Connected Yet)
1. AutoZoom detects only the built-in display (`isInternal: true`).
2. The first-run popup shows a single row — **Built-in MacBook Display**, pre-selected to **`100%`** — and the Accept button. (The former "Default for External Monitors (when connected)" row is gone: the resolution map covers monitors plugged in later.)
3. When the user later plugs in an external monitor for the first time, AutoZoom applies that monitor's recommended zoom (e.g. `125%` for 2560×1440) to every tab on it **immediately — no prompt** (Amended for 1.1.0 per Eng Doc v3 §9; previously a compact new-display prompt). The user can change it any time from the popup's Current Screen card; a change is also remembered as the recommendation for future never-seen monitors of the same resolution.

---

### Journey 2: Plugging In, Unplugging, or Dragging Windows Across Screens
1. **Window Moves to External Monitor**:
   - The user plugs in their monitor (macOS moves the Chrome window) or drags a Chrome window from their MacBook (`100%`) onto their External Monitor (`125%`).
   - `chrome.system.display.onDisplayChanged` and/or `chrome.windows.onBoundsChanged` fires.
   - AutoZoom maps the window's center coordinates `(left + width/2, top + height/2)` to the external display's `bounds`.
   - AutoZoom updates the **active tab** in that window to the monitor's persisted Zoom % (`125%`) and updates the toolbar icon badge to `125`.
2. **Brand-New Monitor (never seen before)** (Amended for 1.1.0 per Eng Doc v3 §9; previously a compact prompt on that monitor):
   - AutoZoom creates a profile for it seeded from the resolution → recommended-zoom map (or the learned override for that resolution, FR-2) and **applies that zoom to every tab on the screen immediately** — active tabs first, background tabs included — with **no prompt and no badge alert**. The same happens when a window is dragged onto a never-seen monitor.
   - If the user disagrees, they change it from the popup's Current Screen card (Journey 6); that correction is also learned for future monitors of the same resolution.
3. **Switching Tabs on the Monitor (Lazy Zoom for 100+ Tabs)**:
   - To avoid CPU spikes when switching monitors with 100+ open tabs, background tabs are updated lazily: the moment the user clicks a background tab (`chrome.tabs.onActivated`), AutoZoom ensures its zoom matches the current screen's persisted Zoom % (`125%`).
4. **Unplugging / Returning to MacBook**:
   - When the monitor is unplugged or the window is dragged back to the MacBook display (`100%`), AutoZoom immediately updates the active tab back to `100%` (and background tabs lazily as they are visited).

---

### Journey 3: Multi-Monitor Independence (MacBook + 2 External Monitors)
1. A user has a **MacBook (`100%`)**, a **27" 4K Monitor (`125%`)**, and a **34" Ultrawide (`110%`)**.
2. Each screen's chosen Zoom % is persisted in `chrome.storage.local` keyed by a stable screen key (`internal` for the built-in display, `ext:<slug(name)>` for external monitors — see FR-2).
3. Whichever screen a Chrome window is placed on, AutoZoom enforces that screen's persisted Zoom % on the active tab.
4. Switching focus between windows on different monitors (`chrome.windows.onFocusChanged`) ensures the focused window's active tab always renders at its screen's persisted Zoom %.

---

### Journey 4: Manual Zoom Adjustments (`Cmd +` / `Cmd -`) After Setup
1. By default, every website has a relative step delta of `0` (`siteStepDelta = 0`), meaning it always renders at the exact **Screen Default Zoom %** (`100%` on MacBook, `125%` on Monitor). Since 1.1.0 deltas are stored **per (site, screen)** (Amended per Eng Doc v3 §5.2 / §9; previously one delta per site shared by every screen).
2. Suppose while on the External Monitor (`125%`, step index 9), the user visits a website with unusually tiny font and manually presses `Cmd +` once to reach `150%` (step index 10).
3. AutoZoom detects the user-initiated zoom change via `chrome.tabs.onZoomChange` and saves an explicit row for that host **on that screen**: `siteStepDeltas[hostname]["ext:2560x1440"] = { delta: +1 }` (`10 - 9 = +1`).
4. When the user moves back to their MacBook (`100%`, step index 7), the MacBook has no row of its own for that site, so it **inherits** the `+1` from the closest screen that has one (same class — built-in vs. external — first, then nearest logical area, then most recently adjusted; see FR-10) and renders the site at `110%` (`step index 7 + 1 = 8`). The popup labels this *"+1 step · inherited from External Display → 110%"*.
5. If the user then presses `Cmd -` on the MacBook to bring the site back to `100%`, AutoZoom writes an explicit `siteStepDeltas[hostname]["internal"] = { delta: 0 }`. An explicit `0` **blocks inheritance** on that screen, so the site stays at `100%` on the MacBook while remaining `+1` (`150%`) on the external monitor. A site whose rows are all `0` is dropped from storage entirely.

---

### Journey 5: Excluding / Pinning Specific Websites
1. The user opens `www.figma.com` or `www.canva.com` and wants it to remain untouched by AutoZoom.
2. Clicking the AutoZoom toolbar icon and toggling **"Exclude `www.figma.com`"** pins the host so AutoZoom never modifies its zoom on any screen. Excluding a site **releases** its open tabs back to Chrome's native per-origin zoom (see FR-13) and clears any per-screen step rows saved for it (1.1.0); un-excluding re-manages them at the plain screen default.
3. Exclusions are **host-level only** in v1 (Amended per Eng Doc v2 §9). Path-level rules such as `docs.google.com/presentation` are a non-goal; the user would exclude `docs.google.com` as a whole.

---

### Journey 6: Changing a Screen's Default Zoom % Anytime, Renaming, Global Pause, & Reset
1. Clicking the AutoZoom toolbar icon opens the popup showing the two-line **Current Screen card** (e.g., *"External Display"* over *"2560×1440"*). The name is editable in place (✎), so two identical nameless monitors can be told apart (*"Desk left"*, *"Desk right"*). (Amended for 1.1.0 per Eng Doc v3 §7 / §9; previously a single clipped line. 1.1.0 polish: line 2 is the size only — no "recommended" label.)
2. If the user changes the screen's zoom in the popup from `125%` to `150%`, AutoZoom persists `150%` for that monitor and **immediately updates all open tabs in windows on that monitor** to reflect the new screen zoom. For an external screen the value is also remembered as the recommendation for future never-seen monitors of the same resolution (FR-2 learned overrides).
3. The user can also toggle **Global Pause** (the popup header reads *Paused*). Pausing **freezes** every tab at its current zoom — nothing is released or re-zoomed — and AutoZoom stops intervening until resumed; resuming re-applies screen zoom and site steps to every tab on every connected screen immediately (see FR-13). (Amended for 1.1.0 per Eng Doc v3 §9; previously Pause released tabs to Chrome's native zoom.)
4. Two separate reset actions replace the former "Reset All to 100%" (Amended per Eng Doc v2 §9):
   - **"Clear all site exceptions"** — removes every `siteStepDeltas` entry and re-applies the plain screen zoom to affected tabs.
   - **"Restore Chrome's zoom"** — releases all managed tabs back to Chrome's native per-origin zoom (what the user would see with AutoZoom uninstalled). It is the **only** action that hands tabs back to Chrome; it also switches AutoZoom off, and saved screens and site steps are kept. It acts on a single click with no confirmation dialog (1.1.0 polish, D24): the header reading *Paused* is the feedback, and the button's hover text explains what it does.

---

## 5. Functional Requirements

### 5.1 Display Detection & Window-to-Screen Mapping
- **FR-1 (Display Enumeration)**: Use `chrome.system.display.getInfo()` to identify connected displays (`id`, `name`, `isInternal`, `bounds`).
- **FR-2 (Persistent Screen Profile Store)** (defaults amended for 1.1.0 per Eng Doc v3 §4 / §9; previously two fixed seeds, `100%` internal / `125%` external):
  - Key display profiles cleanly so monitors are recognized across reboots and cable reconnects. The key is `isInternal ? "internal" : "ext:" + slug(display.name)`; `display.id` is **not** part of the key (it is not stable across reconnects on macOS) and is stored only as `lastSeenDisplayId` for diagnostics. Resolution is not part of the key for named displays; a display that reports no name (common on macOS) falls back to `ext:<w>x<h>`.
  - Each profile stores a user-editable **name** (default *MacBook Screen* / *External Display*, *External Display 2*, …, or the name macOS reports), the display's logical **width/height** (refreshed each time the display is seen; used for the popup subtitle and for site-step inheritance), and its `zoomFactor`.
  - Default internal display (`isInternal: true`) to `100%` (`1.0`).
  - Seed external displays (`isInternal: false`) from a **resolution → recommended zoom map** keyed on the display's logical (DIP) size: `2560×1080 → 110%`, `3840×2160 → 150%`, `5120×2880 → 200%`, anything `≤ 1920×1200 → 100%`, every other size (`2560×1440`, `2560×1600`, `3008×1692`, `3440×1440`, `3840×1600`, `5120×1440`, …) → `125%`. Only logical size is known, so a 27" and a 32" 1440p monitor get the same recommendation.
  - **Learned overrides**: when the user sets an external screen's zoom (popup stepper, or a first-run Accept with a value other than the map's), that value is remembered for the screen's logical size (`learnedDefaults["2560x1440"]`) and takes precedence over the table for the **next never-seen** monitor of that size. Existing screens are untouched (each keeps its own `zoomFactor`); the built-in display is never learned.
- **FR-3 (Window-to-Display Resolution)**: Map each `chrome.windows.Window` to a display by:
  1. Checking which display's `bounds` contains the window's center point `(left + width / 2, top + height / 2)`.
  2. Falling back to the display with the largest intersecting bounding-box area.
  3. **Skipping sync for minimized (or non-`normal`) windows and keeping the window's last known screen** (Amended per Eng Doc v2 §9; previously "fall back to the primary display"). The window is re-resolved when it is restored/focused.
- **FR-4 (Real-Time Screen Change Listeners)**:
  - `chrome.windows.onBoundsChanged` (debounced at ~150ms).
  - `chrome.system.display.onDisplayChanged`.
  - `chrome.windows.onFocusChanged`.

### 5.2 Sleek Onboarding (Toolbar Popup) & New-Monitor Recommended Zoom
- **FR-5 (Zero-Host-Permission First-Run Popup & New-Monitor Defaults)** (Amended for 1.1.0 per Eng Doc v3 §9; previously a separate `setup.html` popup window for both first install and each unrecognized display):
  - On first install (`chrome.runtime.onInstalled`), open the **toolbar popup in its first-run state** (`chrome.action.openPopup()`, hence Chrome 127+): one two-line row per **connected** display (name / `W×H` — no "recommended" label since the 1.1.0 polish, D26), each with a zoom selector along Chrome's ladder pre-selected to the display's recommended zoom (FR-2), a single **Accept** button, and a tip to pin the toolbar icon. There is no row for displays that are not connected — the resolution map covers monitors plugged in later.
  - **Nothing is zoomed until Accept.** Closing the popup without accepting changes nothing; the same first-run state appears on the next click of the toolbar icon. If Chrome cannot open the popup automatically (e.g. its own "extension added" bubble is showing, or no normal window is focused), AutoZoom logs it, retries **once** on the next window-focus change while first run is still unaccepted, and otherwise waits for the user to click the icon.
  - When an unrecognized external display is connected **after** first run, **no prompt is shown**: its recommended zoom (or the learned override for that logical size) is applied to every tab on it immediately, and the screen appears in the popup for adjustment. No badge alert is shown either.
- **FR-6 (Immediate Window-Wide Normalization on Confirm)**:
  - When a user confirms or updates a display's target Zoom % (either in the popup's first-run state or in its normal state), iterate through all tabs belonging to windows currently on that display and apply the confirmed Zoom % (clearing any stale pre-install zoom states). The same normalization runs, without a prompt, when a never-seen display is discovered after first run (FR-5) — both in the immediate display-change pass and in the +1.5 s delayed pass, because macOS moves windows onto a new monitor after the first event.

### 5.3 Day-to-Day Lazy Tab Zoom Engine
- **FR-7 (Active-Tab Execution on Screen Switch)**: When a window is dragged between screens or a known monitor is plugged/unplugged, immediately update the `active: true` tab of each affected window.
- **FR-8 (Lazy Background Tab Sync)**:
  - Listen to `chrome.tabs.onActivated` and `chrome.tabs.onUpdated`: Whenever a user switches to a tab or navigates to a URL, compute `targetZoom = stepZoom(screenDefaultZoom, resolveDelta(hostname, screenKey))` — the site's explicit step for this screen, else the step inherited from the closest screen, else `0` (FR-10) — and apply it if the tab's current zoom differs.
- **FR-9 (Restricted URL Filtering)**: Ignore restricted schemes (`chrome://`, `chrome-extension://`, `devtools://`, `about:`, `edge://`, Chrome Web Store).

### 5.4 Manual Zoom Exception Tracking (`Cmd +` / `Cmd -`)
- **FR-10 (Programmatic vs. User Zoom Detection — stateless)** (Amended per Eng Doc v2 §9 / §5.7; previously "track in-flight setZoom calls in memory", which does not survive service-worker restarts. Steps 3–4 and the inheritance rule amended for 1.1.0 per Eng Doc v3 §5.2 / §9: deltas are per (site, screen); previously one global delta per host, `0` ⇒ entry removed):
  - Before any `chrome.tabs.setZoom`, AutoZoom calls `chrome.tabs.setZoomSettings(tabId, { scope: "per-tab" })` so managed tabs are always in per-tab scope.
  - When `chrome.tabs.onZoomChange` fires:
    1. **Scope guard**: ignore the event unless `zoomSettings.scope === "per-tab"` (per-origin events come from unmanaged tabs or Chrome's own navigation resets).
    2. **No-op guard**: ignore events where `oldZoomFactor === newZoomFactor` (Chrome emits one when switching a tab into per-tab scope).
    3. **Expected-value comparison**: recompute the tab's expected zoom from persisted state (`stepZoom(screenDefaultZoom, resolveDelta(hostname, screenKey))`, FR-8); if `newZoomFactor` equals it, the event is our own write — ignore it.
    4. Otherwise it is a user zoom: write an **explicit row for the current screen**, `siteStepDeltas[hostname][screenKey] = { delta: stepIndex(newZoomFactor) - stepIndex(screenDefaultZoom), updatedAt }`, and persist it in `chrome.storage.local`. **A `0` is persisted too** — it means "use this screen's default here; do not inherit". Only when every row of a host is `0` is the host removed entirely.
  - **Inheritance rule**: a screen that has no row for a site uses the row of the closest other screen — same class (built-in vs. external) first, then the smallest difference in logical area (`width × height`), then the most recently adjusted (`updatedAt`; remaining ties are broken deterministically by older profile first, then screen key); if no same-class screen has a row, the other class is searched with the same rule. The effective zoom is always the **current** screen's default stepped along the ladder: `125% + 1 step = 150%`, `100% + 1 step = 110%`.
  - Nothing is recorded while AutoZoom is paused (`enabled = false`, see FR-13).
  - No in-memory lock or TTL is used; the detector is correct across service-worker restarts.

### 5.5 Toolbar Popup UI & Icon Badge
- **FR-11 (Toolbar Icon Badge)**:
  - Show the active window's current screen zoom on the badge as a ≤3-character string (e.g., `125` on an external monitor, empty on a `100%` screen, `OFF` when paused, and empty on excluded sites — the former `PIN` text was dropped in the 1.1.0 polish, D25; the hover title still says the site is excluded). The `%` sign is omitted because badge text is limited to ~4 characters. The hover title spells it out and, when the site's step is inherited from another screen (FR-10), names the source: *"AutoZoom · External Display · 150% · +1 step for mail.google.com (inherited from MacBook Screen)"*.
- **FR-12 (Popup Controls)** (Current Screen card, Saved Screens rows and Current Website card amended for 1.1.0 per Eng Doc v3 §7 / §9):
  - **Current Screen Card — two lines, renameable**: line 1 is the screen's **editable name** — *MacBook Screen* / *External Display* (*External Display 2*, …) by default, or the name macOS reports when there is one; ✎ turns it into an inline field (max 40 characters; `Enter`/blur saves, `Esc` cancels, an empty name reverts to the default). Line 2 is the muted logical size, `2560×1440` (the recommended value is pre-selected in the selector, not labelled — 1.1.0 polish, D26). Beside the name sits the Zoom % selector (`25%` – `500%` along Chrome's zoom steps, with `100%` and `125%` highlighted). The name has its own line and truncates with an ellipsis, so it never collides with the stepper.
  - **Other Saved Screens List**: Expandable section showing all configured displays (including Built-in MacBook even when in clamshell mode) so the user can edit any screen's persisted Zoom % at any time. Each row is two-line as well (name / `W×H`) and the name is editable there too.
  - **Current Website Status & Exclude Toggle**: Shows the active domain and its effective step **on this screen** — `Uses screen default (125%)`, `+1 step on this screen → 150%`, or `+1 step · inherited from MacBook Screen → 150%` — and an **Exclude / Pin Site** toggle. The former *"Reset Site to Screen Default"* button is **removed** (1.1.0): to drop a step on one screen, press `Cmd +` / `Cmd -` back to the screen default there (this stores an explicit `0` for that screen); excluding a site clears its steps on every screen; **"Clear all site exceptions"** wipes everything.
  - **Global Pause & Reset Actions**: Master toggle to pause AutoZoom (the header reads **Paused** while off, **On** otherwise; semantics in FR-13), plus two separate actions (Amended per Eng Doc v2 §9): **"Clear all site exceptions"** and **"Restore Chrome's zoom"** (see Journey 6). The latter acts immediately with no confirmation dialog (1.1.0 polish, D24); its hover text states that it is the only action that hands tabs back to Chrome, and the header reads *Paused* afterwards.

### 5.6 Reversibility
- **FR-13 (Reversibility)** (Pause clause amended for 1.1.0 per Eng Doc v3 §9; previously "Pause … return[s] tabs to Chrome's native per-origin zoom"): **AutoZoom never writes Chrome's per-origin zoom memory.** All programmatic zoom is applied in per-tab scope only.
  - **Turning AutoZoom off (Pause) freezes tabs at their current zoom and stops intervening.** No tab is touched when pausing. A frozen tab keeps its zoom until its next cross-document navigation, after which Chrome's own zoom for the new page applies. A `Cmd +` / `Cmd -` on a frozen tab while paused is per-tab only: AutoZoom does not record it, Chrome does not remember it per site, and it is discarded on that tab's next navigation. **Resume** re-applies AutoZoom's screen defaults and site steps to every tab on every connected screen immediately, overwriting any such per-tab change.
  - **"Restore Chrome's zoom" is the explicit release**: it returns every managed tab to Chrome's native per-origin zoom (and switches AutoZoom off). Exclude does the same for one site, and uninstall for everything. When releasing a managed tab, AutoZoom first sets the tab back to Chrome's default zoom factor (still in per-tab scope) and only then switches the tab to per-origin scope, so that Chrome does not persist AutoZoom's temporary level into its own per-site memory.

---

## 6. Technical Architecture (Manifest V3)

### 6.1 Required Permissions (`manifest.json`)
- `"system.display"`: Read monitor hardware IDs, names, `isInternal` flag, and screen coordinates (`bounds`).
- `"storage"`: Persist per-screen default Zoom % and names, learned recommendations per resolution, per-site relative step exceptions (per screen), and excluded domains in `chrome.storage.local`.
- `"tabs"`: Read tab URLs and apply zoom via `chrome.tabs.getZoom` / `chrome.tabs.setZoom`.

### 6.2 Storage Schema (schema v3, replaced per Eng Doc v3 §3 / §9; previously v2 per Eng Doc v2 §4 / §9)

```jsonc
// chrome.storage.local
{
  "schemaVersion": 3,
  "enabled": true,
  "onboardingCompleted": false,          // = first-run Accept pressed. Gate for ALL zooming.
  "learnedDefaults": {                   // user-taught map overrides, externals only
    "2560x1440": 1.10
  },
  "screens": {
    "internal": {
      "key": "internal", "name": "MacBook Screen", "isInternal": true,
      "width": 1728, "height": 1117,     // logical (DIP) size, refreshed on every match
      "zoomFactor": 1.00, "lastSeenDisplayId": "1", "createdAt": 1790960000000
    },
    "ext:2560x1440": {
      "key": "ext:2560x1440", "name": "External Display", "isInternal": false,
      "width": 2560, "height": 1440,
      "zoomFactor": 1.25, "lastSeenDisplayId": "2", "createdAt": 1790960001000
    }
  },
  "siteStepDeltas": {
    "mail.google.com": {
      "ext:2560x1440": { "delta": 1, "updatedAt": 1790961000000 },
      "internal":      { "delta": 0, "updatedAt": 1790961500000 }   // explicit 0 = "do not inherit"
    }
  },
  "excludedHosts": { "www.figma.com": true }          // record keyed by hostname, not an array
}

// chrome.storage.session (cleared on browser exit; survives service-worker restarts)
{ "windowScreen": { "1234": "ext:2560x1440" } }      // last resolved screen key per windowId
```

**Removed in v3:** `defaults`, `screens[*].confirmed`, session `setupWindowId`, `pendingSetupKeys`.

- Screen keys are `internal` or `ext:<slug(name)>` (see FR-2); a nameless external display — the common case on macOS — falls back to `ext:<w>x<h>`. `display.id` is kept only as `lastSeenDisplayId`. `name` is the user-editable screen name (defaults *MacBook Screen* / *External Display*, *External Display 2*, … or the name macOS reports); `width`/`height` is the logical size used for the recommended-zoom subtitle and for delta inheritance.
- `learnedDefaults` is keyed by logical size (`WxH`) and holds only values the user chose for **external** screens (popup stepper or first-run Accept with a value other than the map's); it seeds future never-seen monitors of that size. It is not cleared by "Clear all site exceptions" or "Restore Chrome's zoom".
- Site exceptions are keyed by **hostname, then screen key** — `{ host: { screenKey: { delta, updatedAt } } }` — with `0` stored explicitly (see FR-10); a host whose rows are all `0` is removed. Exclusions are keyed by **hostname** (Chrome's own zoom memory is per host; `http://` and `https://` of the same site share a rule). Path-level rules remain out of scope.
- `schemaVersion` enables forward migration in `runtime.onInstalled({ reason: "update" })`. **v2 → v3 migration:** `defaults` and `confirmed` are dropped; a v2 global per-host delta `n` fans out to an explicit row `{ delta: n }` for **every** existing screen key (so behaviour is unchanged until the user adjusts a screen); auto-generated v2 names ("Built-in Display", "External Display · W×H") are rewritten to the new defaults while user-looking names are kept; `width`/`height` are `null` until the display is next seen (unknown sizes sort last in inheritance). A v2 user who never finished setup gets the first-run popup on update.
