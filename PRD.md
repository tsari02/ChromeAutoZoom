# Product Requirements Document (PRD): AutoZoom Chrome Extension

> **Amended per Engineering Doc v2 §9.** The following items were changed in place to match the implemented design:
> FR-3 (3), Journey 1 Case A, Journey 5, Journey 6, FR-2 key rule, FR-10, FR-11 badge text, FR-12 reset actions, §6.2 storage schema, new FR-13 (Reversibility), new §2.2 non-goal (`Cmd+0`).

## 1. Overview & Problem Statement

### 1.1 Problem
MacBook users frequently switch between working on their built-in laptop Retina display, one or more external monitors, or in clamshell mode (external monitors only). Because external monitors sit further away from the user and have different pixel densities (PPI) and scaling characteristics than a MacBook's built-in display, web pages that are comfortably readable at `100%` on a MacBook look too small on an external monitor.

Furthermore, users who search for and install an extension like AutoZoom are typically **already frustrated on their external monitor** and have manually zoomed various websites inconsistently (`110%` on one site, `125%` on another, `100%` on new sites).

### 1.2 Solution
**AutoZoom** is a sleek, minimal-permission Chrome Extension (Manifest V3) built around **Persistent Per-Screen Default Zoom %**:
- Each physical screen (Built-in MacBook display, External Monitor 1, External Monitor 2, etc.) has its own **persisted default Zoom %** (defaulting to **`100%`** on the MacBook built-in screen and **`125%`** on external monitors).
- On first install (or when a brand-new monitor is connected), AutoZoom shows a sleek, low-friction startup prompt on the monitor window asking the user to confirm the default Zoom % for their setup (pre-selected to `125%` for external monitors and `100%` for the MacBook display).
- Immediately upon confirmation, AutoZoom normalizes the tabs on that monitor window to the confirmed Zoom % (e.g., `125%`), wiping away inconsistent pre-install zoom levels.
- Whenever a Chrome window moves to or is active on a screen, AutoZoom automatically applies that screen's persisted Zoom %.

---

## 2. Goals & Non-Goals

### 2.1 Goals
- **Persistent Per-Screen Zoom %**: Let users define and persist an explicit default Zoom % for each display (e.g., Built-in MacBook = `100%`, Dell 27" Monitor = `125%`, Ultrawide Monitor = `110%`).
- **Frustration-Free First-Install Onboarding**: Handle all 3 common initial hardware setups seamlessly—**(a) MacBook Only**, **(b) MacBook + Single/Multiple External Monitors**, and **(c) Clamshell Mode (External Monitors Only)**—via a sleek startup prompt requiring minimal permissions.
- **Clean Slate on Confirmation**: Immediately apply the confirmed Zoom % (e.g., `125%`) across the tabs in that monitor's window upon setup confirmation so pre-existing messy zoom states are cleaned up immediately.
- **100+ Tab Performance (Lazy Evaluation on Day-to-Day Transitions)**: During ongoing monitor switches or window drags, immediately update the active tab in each window and lazily update background tabs as the user switches to them (`tabs.onActivated`).
- **Relative Per-Site Exceptions (`Cmd +` / `Cmd -`)**: By default, every website uses the active screen's exact default Zoom %. If a user manually adjusts a specific site via `Cmd +` or `Cmd -` *after* AutoZoom is installed, remember that site's relative step delta (e.g., `+1 step` above the current screen's default).
- **Minimal Permissions & Zero Content Scripts**: Use only `"system.display"`, `"tabs"`, and `"storage"`—no `<all_urls>` host permissions or injected webpage scripts.

### 2.2 Non-Goals
- Preserving messy, inconsistent per-site zoom levels that existed *before* AutoZoom was installed.
- Injecting DOM/CSS content scripts into webpages (which require broad host permissions and break page layouts).
- Honoring `Cmd+0` (Chrome's "reset zoom") specially. A `Cmd+0` press is treated like any other manual zoom: the resulting factor is recorded as a normal relative step delta for the site (which may be `0`, clearing the exception, or non-zero on a non-100% screen).
- Path-level site rules (e.g. `docs.google.com/presentation`). Site exceptions and exclusions are **host-level only** in v1.

---

## 3. Standard Chrome Zoom Ladder

AutoZoom uses Chrome's official 17-step zoom scale both for selecting a screen's **Default Zoom %** and for calculating relative per-site `Cmd +` / `Cmd -` exceptions:

| Step Index | Zoom % | Zoom Factor | Typical Screen Assignment / Role |
| :--- | :--- | :--- | :--- |
| 0–4 | 25%–75% | `0.25`–`0.75` | Available in advanced steps |
| 5 | 80% | `0.80` | -2 steps from 100% |
| 6 | 90% | `0.90` | -1 step from 100% |
| 7 | **100%** | `1.00` | **Default for Built-in MacBook Display** |
| 8 | 110% | `1.10` | +1 step above 100% |
| 9 | **125%** | `1.25` | **Default for External Monitors (+2 steps above 100%)** |
| 10 | 150% | `1.50` | +3 steps above 100% (or +1 step above 125% monitor) |
| 11 | 175% | `1.75` | +4 steps above 100% |
| 12 | 200% | `2.00` | +5 steps above 100% |
| 13–16 | 250%–500% | `2.50`–`5.00` | High-zoom accessibility steps |

---

## 4. End-to-End Customer User Journeys

### Journey 1: First-Time Installation & Per-Screen Startup Prompt
Because users may install AutoZoom under any of three hardware states, AutoZoom inspects `chrome.system.display.getInfo()` and `chrome.windows.getAll()` on `runtime.onInstalled`:

#### Case A: Installed with MacBook + 1 or More External Monitors Connected
1. AutoZoom detects the internal display (`isInternal: true`) and each connected external monitor (`isInternal: false`).
2. AutoZoom opens **one onboarding window** (`chrome.windows.create({ type: "popup" })`, `setup.html`) listing **all connected displays** in a single card — one row per display — centered on the focused window's display. (Amended per Eng Doc v2 §9: previously "a popup per external monitor".)
3. Each row identifies the display by hardware name (e.g., *"LG UltraFine"*) with a zoom selector along Chrome's ladder:
   - **External monitors**: Pre-selected to **`125%`** *(+2 steps from MacBook 100%)*, with quick-select pills (`100%`, `110%`, `125%`, `150%`, etc.).
   - **Built-in MacBook display**: Pre-selected to **`100%`**.
   - Any display class that is *not currently connected* (e.g. the built-in display in clamshell mode, or "External monitors (when connected)") is shown as an editable default row so the user can set it ahead of time.
4. **Instant Confirmation**: As soon as the user clicks the single **"Apply"** button (or presses `Enter`), the window closes and **all tabs on every listed display's window(s) are normalized to that display's confirmed zoom**, immediately fixing any inconsistent zoom states the user had prior to installing.

#### Case B: Installed in Clamshell Mode (External Monitor(s) Only, MacBook Lid Closed)
1. AutoZoom detects one or more external displays (`isInternal: false`) and no active internal display.
2. AutoZoom opens the single **onboarding window** listing each external monitor with **`125%`** pre-selected, plus an editable **Built-in MacBook display** row pre-set to **`100%`** (saved as the default even though the display is absent).
3. Upon confirmation, all tabs on the external monitor window(s) immediately update to `125%`.
4. Later, when the user unplugs the monitor and opens their MacBook lid, AutoZoom already knows the MacBook screen is `100%` and transitions seamlessly with zero prompts.

#### Case C: Installed on MacBook Only (No External Monitor Connected Yet)
1. AutoZoom detects only the built-in display (`isInternal: true`).
2. A single sleek **Startup Setup Popup** appears centered on the MacBook screen with:
   - **Built-in MacBook Display**: Pre-selected to **`100%`**.
   - **Default for External Monitors (when connected)**: Pre-selected to **`125%`** *(+2 steps)*.
3. When the user later plugs in an external monitor for the first time, AutoZoom shows a **compact new-display prompt** on that monitor pre-selected to the external default (`125%`). Confirming (or closing the prompt) saves the display and normalizes the tabs on it.

---

### Journey 2: Plugging In, Unplugging, or Dragging Windows Across Screens
1. **Window Moves to External Monitor**:
   - The user plugs in their monitor (macOS moves the Chrome window) or drags a Chrome window from their MacBook (`100%`) onto their External Monitor (`125%`).
   - `chrome.system.display.onDisplayChanged` and/or `chrome.windows.onBoundsChanged` fires.
   - AutoZoom maps the window's center coordinates `(left + width/2, top + height/2)` to the external display's `bounds`.
   - AutoZoom updates the **active tab** in that window to the monitor's persisted Zoom % (`125%`) and updates the toolbar icon badge to `125`.
2. **Switching Tabs on the Monitor (Lazy Zoom for 100+ Tabs)**:
   - To avoid CPU spikes when switching monitors with 100+ open tabs, background tabs are updated lazily: the moment the user clicks a background tab (`chrome.tabs.onActivated`), AutoZoom ensures its zoom matches the current screen's persisted Zoom % (`125%`).
3. **Unplugging / Returning to MacBook**:
   - When the monitor is unplugged or the window is dragged back to the MacBook display (`100%`), AutoZoom immediately updates the active tab back to `100%` (and background tabs lazily as they are visited).

---

### Journey 3: Multi-Monitor Independence (MacBook + 2 External Monitors)
1. A user has a **MacBook (`100%`)**, a **27" 4K Monitor (`125%`)**, and a **34" Ultrawide (`110%`)**.
2. Each screen's chosen Zoom % is persisted in `chrome.storage.local` keyed by a stable screen key (`internal` for the built-in display, `ext:<slug(name)>` for external monitors — see FR-2).
3. Whichever screen a Chrome window is placed on, AutoZoom enforces that screen's persisted Zoom % on the active tab.
4. Switching focus between windows on different monitors (`chrome.windows.onFocusChanged`) ensures the focused window's active tab always renders at its screen's persisted Zoom %.

---

### Journey 4: Manual Zoom Adjustments (`Cmd +` / `Cmd -`) After Setup
1. By default, every website has a relative step delta of `0` (`siteStepDelta = 0`), meaning it always renders at the exact **Screen Default Zoom %** (`100%` on MacBook, `125%` on Monitor).
2. Suppose while on the External Monitor (`125%`, step index 9), the user visits a website with unusually tiny font and manually presses `Cmd +` once to reach `150%` (step index 10).
3. AutoZoom detects the user-initiated zoom change via `chrome.tabs.onZoomChange` and saves a relative exception for that host: `siteStepDeltas[hostname] = +1 step` (`10 - 9 = +1`).
4. When the user moves back to their MacBook (`100%`, step index 7), that website automatically renders at `110%` (`step index 7 + 1 = 8`), preserving the `+1 step` preference relative to each screen's default zoom.

---

### Journey 5: Excluding / Pinning Specific Websites
1. The user opens `www.figma.com` or `www.canva.com` and wants it to remain untouched by AutoZoom.
2. Clicking the AutoZoom toolbar icon and toggling **"Exclude `www.figma.com`"** pins the host so AutoZoom never modifies its zoom on any screen. Excluding a site **releases** its open tabs back to Chrome's native per-origin zoom (see FR-13); un-excluding re-manages them.
3. Exclusions are **host-level only** in v1 (Amended per Eng Doc v2 §9). Path-level rules such as `docs.google.com/presentation` are a non-goal; the user would exclude `docs.google.com` as a whole.

---

### Journey 6: Changing a Screen's Default Zoom % Anytime, Global Pause, & Reset
1. Clicking the AutoZoom toolbar icon opens the popup showing the **Current Display Card** (e.g., *"LG UltraFine — Screen Zoom: 125%"*).
2. If the user changes the screen's zoom in the popup from `125%` to `150%`, AutoZoom persists `150%` for that monitor and **immediately updates all open tabs in windows on that monitor** to reflect the new screen zoom.
3. The user can also toggle **Global Pause**. Pausing immediately releases every managed tab back to Chrome's native zoom; resuming re-applies screen zoom to the active tab of each window (background tabs lazily).
4. Two separate reset actions replace the former "Reset All to 100%" (Amended per Eng Doc v2 §9):
   - **"Clear all site exceptions"** — removes every `siteStepDeltas` entry and re-applies the plain screen zoom to affected tabs.
   - **"Restore Chrome's zoom"** — releases all managed tabs back to Chrome's native per-origin zoom (what the user would see with AutoZoom uninstalled) without changing any saved settings.

---

## 5. Functional Requirements

### 5.1 Display Detection & Window-to-Screen Mapping
- **FR-1 (Display Enumeration)**: Use `chrome.system.display.getInfo()` to identify connected displays (`id`, `name`, `isInternal`, `bounds`).
- **FR-2 (Persistent Screen Profile Store)**:
  - Key display profiles cleanly so monitors are recognized across reboots and cable reconnects. The key is `isInternal ? "internal" : "ext:" + slug(display.name)`; `display.id` is **not** part of the key (it is not stable across reconnects on macOS) and is stored only as `lastSeenDisplayId` for diagnostics. Resolution is not part of the key either.
  - Default internal display (`isInternal: true`) to `100%` (`1.0`).
  - Default external displays (`isInternal: false`) to `125%` (`1.25`).
- **FR-3 (Window-to-Display Resolution)**: Map each `chrome.windows.Window` to a display by:
  1. Checking which display's `bounds` contains the window's center point `(left + width / 2, top + height / 2)`.
  2. Falling back to the display with the largest intersecting bounding-box area.
  3. **Skipping sync for minimized (or non-`normal`) windows and keeping the window's last known screen** (Amended per Eng Doc v2 §9; previously "fall back to the primary display"). The window is re-resolved when it is restored/focused.
- **FR-4 (Real-Time Screen Change Listeners)**:
  - `chrome.windows.onBoundsChanged` (debounced at ~150ms).
  - `chrome.system.display.onDisplayChanged`.
  - `chrome.windows.onFocusChanged`.

### 5.2 Sleek Onboarding & New-Monitor Calibration Prompt
- **FR-5 (Zero-Host-Permission Popup Prompt)**:
  - On first install (`chrome.runtime.onInstalled`), or when an unrecognized external display is connected, open a compact extension popup window (`setup.html`) centered on the target display's `bounds`.
  - Show the detected display name, pre-select `125%` (with step controls / percentage presets along Chrome's zoom ladder), and allow one-click confirmation.
- **FR-6 (Immediate Window-Wide Normalization on Confirm)**:
  - When a user confirms or updates a display's target Zoom % (either in the startup prompt or in the toolbar popup), iterate through all tabs belonging to windows currently on that display and apply the confirmed Zoom % (clearing any stale pre-install zoom states).

### 5.3 Day-to-Day Lazy Tab Zoom Engine
- **FR-7 (Active-Tab Execution on Screen Switch)**: When a window is dragged between screens or a known monitor is plugged/unplugged, immediately update the `active: true` tab of each affected window.
- **FR-8 (Lazy Background Tab Sync)**:
  - Listen to `chrome.tabs.onActivated` and `chrome.tabs.onUpdated`: Whenever a user switches to a tab or navigates to a URL, compute `targetZoom = stepZoom(screenDefaultZoom, siteStepDeltas[hostname] || 0)` and apply it if the tab's current zoom differs.
- **FR-9 (Restricted URL Filtering)**: Ignore restricted schemes (`chrome://`, `chrome-extension://`, `devtools://`, `about:`, `edge://`, Chrome Web Store).

### 5.4 Manual Zoom Exception Tracking (`Cmd +` / `Cmd -`)
- **FR-10 (Programmatic vs. User Zoom Detection — stateless)** (Amended per Eng Doc v2 §9 / §5.7; previously "track in-flight setZoom calls in memory", which does not survive service-worker restarts):
  - Before any `chrome.tabs.setZoom`, AutoZoom calls `chrome.tabs.setZoomSettings(tabId, { scope: "per-tab" })` so managed tabs are always in per-tab scope.
  - When `chrome.tabs.onZoomChange` fires:
    1. **Scope guard**: ignore the event unless `zoomSettings.scope === "per-tab"` (per-origin events come from unmanaged tabs or Chrome's own navigation resets).
    2. **No-op guard**: ignore events where `oldZoomFactor === newZoomFactor` (Chrome emits one when switching a tab into per-tab scope).
    3. **Expected-value comparison**: recompute the tab's expected zoom from persisted state (`stepZoom(screenDefaultZoom, siteStepDeltas[hostname] || 0)`); if `newZoomFactor` equals it, the event is our own write — ignore it.
    4. Otherwise it is a user zoom: `siteStepDeltas[hostname] = stepIndex(newZoomFactor) - stepIndex(screenDefaultZoom)`; persist in `chrome.storage.local` (if `0`, remove the entry).
  - No in-memory lock or TTL is used; the detector is correct across service-worker restarts.

### 5.5 Toolbar Popup UI & Icon Badge
- **FR-11 (Toolbar Icon Badge)**:
  - Show the active window's current screen zoom on the badge as a ≤3-character string (e.g., `125` on an external monitor, empty on a `100%` screen, `OFF` when paused, `PIN` on excluded sites). The `%` sign is omitted because badge text is limited to ~4 characters.
- **FR-12 (Popup Controls)**:
  - **Current Screen Card**: Displays detected monitor name (e.g., *DELL U2723QE* or *Built-in Retina Display*) and a Zoom % selector (`25%` – `500%` along Chrome's zoom steps, with `100%` and `125%` highlighted).
  - **Other Saved Screens List**: Expandable section showing all configured displays (including Built-in MacBook even when in clamshell mode) so the user can edit any screen's persisted Zoom % at any time.
  - **Current Website Status & Exclude Toggle**: Shows the active domain, any manual step adjustment (`siteStepDelta`), a "Reset Site to Screen Default" button if modified, and an **Exclude / Pin Site** toggle.
  - **Global Pause & Reset Actions**: Master toggle to pause AutoZoom, plus two separate actions (Amended per Eng Doc v2 §9): **"Clear all site exceptions"** and **"Restore Chrome's zoom"** (see Journey 6).

### 5.6 Reversibility
- **FR-13 (Reversibility)**: **AutoZoom never writes Chrome's per-origin zoom memory.** All programmatic zoom is applied in per-tab scope only. Pause, Exclude, "Restore Chrome's zoom", and uninstall return tabs to Chrome's native per-origin zoom. When releasing a managed tab, AutoZoom first sets the tab back to Chrome's default zoom factor (still in per-tab scope) and only then switches the tab to per-origin scope, so that Chrome does not persist AutoZoom's temporary level into its own per-site memory.

---

## 6. Technical Architecture (Manifest V3)

### 6.1 Required Permissions (`manifest.json`)
- `"system.display"`: Read monitor hardware IDs, names, `isInternal` flag, and screen coordinates (`bounds`).
- `"storage"`: Persist per-screen default Zoom %, per-site relative step exceptions, and excluded domains in `chrome.storage.local`.
- `"tabs"`: Read tab URLs and apply zoom via `chrome.tabs.getZoom` / `chrome.tabs.setZoom`.

### 6.2 Storage Schema (replaced per Eng Doc v2 §4 / §9)

```jsonc
// chrome.storage.local
{
  "schemaVersion": 2,
  "enabled": true,
  "onboardingCompleted": false,
  "defaults": { "internal": 1.00, "external": 1.25 },
  "screens": {
    "internal": { "key": "internal", "name": "Built-in Retina Display", "isInternal": true,
                  "zoomFactor": 1.00, "confirmed": true, "lastSeenDisplayId": "69733382" },
    "ext:lg-ultrafine": { "key": "ext:lg-ultrafine", "name": "LG UltraFine", "isInternal": false,
                  "zoomFactor": 1.25, "confirmed": true, "lastSeenDisplayId": "1026386291" }
  },
  "siteStepDeltas": { "news.ycombinator.com": 1 },     // keyed by hostname; 0 ⇒ entry removed
  "excludedHosts":  { "www.figma.com": true }          // record keyed by hostname, not an array
}

// chrome.storage.session (cleared on browser exit; survives service-worker restarts)
{
  "windowScreen": { "1234": "ext:lg-ultrafine" },      // last resolved screen key per windowId
  "setupWindowId": 5678,                                // dedupe: at most one setup window
  "pendingSetupKeys": ["ext:dell-u2723qe"]              // unrecognised displays awaiting a prompt
}
```

- Screen keys are `internal` or `ext:<slug(name)>` (see FR-2). `display.id` is kept only as `lastSeenDisplayId`.
- Site exceptions and exclusions are keyed by **hostname** (Chrome's own zoom memory is per host; `http://` and `https://` of the same site share a rule). Path-level rules are out of scope for v1.
- `schemaVersion` enables forward migration in `runtime.onInstalled({ reason: "update" })`.
