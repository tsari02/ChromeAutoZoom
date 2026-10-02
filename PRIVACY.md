# Privacy Policy for AutoZoom — Per-Monitor Automatic Zoom

Last updated: 2026-10-02

AutoZoom does not collect, store on any server, or transmit any personal data or browsing information. Everything the extension needs lives on your own computer, inside Chrome's extension storage, and is deleted when you uninstall the extension.

## What the extension stores (locally only)

AutoZoom keeps the following settings in Chrome's local extension storage so that it can do its one job — applying a per-screen page zoom:

- **Per-screen zoom defaults**: for each display you have used, a label (the display name if your operating system reports one, otherwise its resolution, e.g. "External Display · 2560×1440"), whether it is the built-in screen, an identifier Chrome assigns to the display, and the zoom percentage you chose for it.
- **Per-site zoom adjustments**: the hostname of a website (e.g. `news.ycombinator.com`) and the number of zoom steps you adjusted it by with Cmd + / Cmd −. Only sites you have adjusted are stored.
- **Excluded sites**: the hostnames of websites you chose to exclude from AutoZoom.
- **Preferences**: whether AutoZoom is paused and whether first-run setup has been completed.
- **A per-session cache** (cleared automatically when Chrome quits): which screen each open window was last seen on, and whether the setup window is open.

## What the extension reads

- **Display information** (via Chrome's display API): display names (when available), whether a display is built-in, and its position/size on the desktop. This is used only to work out which screen a window is on and to label screens.
- **Tab URLs** (via Chrome's `tabs` permission): the web address of each tab, read in memory to find the site's hostname so that the right per-site adjustment or exclusion can be applied. Full URLs are never stored; page content is never read. This permission is why Chrome displays the "Read your browsing history" notice at install time.

## What the extension does NOT do

- It does not send any data to the developer or to any third party. The extension contains no network code at all.
- It does not use analytics, telemetry, cookies, advertising identifiers, or remote configuration.
- It does not inject scripts into web pages and has no access to page content.
- It does not sync data to your Google account (it uses local storage only, never `chrome.storage.sync`).
- It does not modify Chrome's own per-site zoom memory; pausing or uninstalling AutoZoom returns every tab to Chrome's native zoom.

## Third-party services

This extension does not use any third-party services.

## Data retention and deletion

All data stays on your device for as long as the extension is installed. You can:

- remove a single site's adjustment with **Reset** in the toolbar popup, or all of them with **Clear all site exceptions**;
- un-exclude a site by unticking **Exclude this site**;
- delete everything by uninstalling the extension (Chrome removes the extension's storage automatically).

## Changes to this policy

If the extension's data practices ever change, this policy will be updated, the "Last updated" date will be bumped, and the change will be noted in the Chrome Web Store listing's version history.

## Contact

Questions about privacy: use the support contact shown on the Chrome Web Store listing.
