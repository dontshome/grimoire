# Changelog

All notable changes to Grimoire are documented here. Dates are when each version was released. Versions follow [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-07-23

First stable release. Grimoire has covered all four major addon providers,
all three desktop platforms, and auto-update since early 0.1.x/0.2.x — 1.0
marks the point where the safety net around that (transactional installs,
encrypted keys, real compatibility detection) is complete enough to call it
done, rather than a single new feature.

### Added
- **Real client-version compatibility detection**, not just "a newer build
  exists": Grimoire reads your WoW install's actual `.build.info` and flags
  any addon whose build predates the client's current content patch — the
  case that can make an addon fail to load or misbehave, which providers
  don't reliably flag on their own. Judged by patch era (X.Y), not exact
  build, so routine hotfixes never trigger a false alarm. Surfaced both for
  already-installed addons and, since 0.2.5, before you install from Browse
  — with a provider picker when more than one source carries the same
  addon, and a confirmation prompt before installing a stale build.
- **Fixed in this release:** multi-folder addons whose sub-modules are
  declared via `RequiredDeps`/`Dependencies` (DBM's `DBM-Test-Dungeons`,
  `DBM-Party-*`, etc. — the hyphenated-folder style, as opposed to the
  `Foo_Bar` underscore convention already handled) are now correctly
  grouped under their real parent by following that dependency chain. A
  stale or Classic-only sub-module's own `Interface` line could previously
  get reported as the whole addon's compatibility — DBM specifically showed
  a false "game version out of date" despite CurseForge's actual listing
  being current.
- **Also fixed:** a provider's own published file metadata can lag behind
  what's actually installed (found via the DBM fix above: the installed
  copy already declared support for the current patch, but the compatibility
  warning still showed "no build anywhere supports the current retail
  patch" because the *provider's* listed build hadn't caught up yet).
  Compatibility warnings now only fire when the installed `.toc`'s own
  Interface line — the one the game client itself checks — actually says
  the addon is behind; a provider lagging behind an already-working local
  copy is no longer reported as broken.
- One-command Linux installer (`install.sh`): download, `chmod`, and a
  proper `.desktop`/icon entry, no `sudo`.
- Auto-check for provider updates on launch, not just on manual request.

### Platform coverage
- Native builds for Linux (AppImage), macOS (dmg/zip, arm64+x64), and
  Windows (nsis) — Mac and Windows built via GitHub Actions on real hosted
  runners. Auto-update via `electron-updater`, verified end-to-end
  including differential (block-map) downloads on Windows and Linux; macOS
  has no auto-update (unsigned, no paid Apple Developer cert).

### Security
- API keys (CurseForge, Wago) encrypted at rest via the OS's own secure
  storage (Windows DPAPI / macOS Keychain / libsecret on Linux) and never
  sent back to the UI in decrypted form.
- Installs are fully transactional — a failure partway through restores
  the previously installed files, with the backup location always stated
  if an automatic restore can't complete.
- Downloaded archives are capped and validated against path-traversal and
  zip-bomb patterns before extraction.
- Settings are written atomically with corruption recovery from a backup.
- Dependencies swept for known CVEs before release (`adm-zip`,
  `electron-updater`, `electron-builder`) — clean as of this release.
  GitHub Actions build workflows pinned to exact commit SHAs with scoped
  credentials.

## [0.2.6] - 2026-07-23

### Changed
- Quieted a benign toast: a provider check that races the Wago ad panel's
  token handoff on a cold start could briefly show a 401 as an "error"
  before resolving itself within seconds — suppressed for the first 20
  seconds after launch, since it was never a real failure.
- Retook the README's Browse screenshot, which still showed the
  pre-0.2.5 undifferentiated Install button instead of the current
  provider-choice and compatibility-warning behavior.

## [0.2.5] - 2026-07-23

### Added
- Browse's Install button now always names the provider it installs from, and switches to a "Choose…" picker instead of silently installing from an arbitrary provider when an addon is carried by more than one.
- Search results now show a compatibility warning when a build predates your client's current retail patch — the same check Grimoire already ran for installed addons — so it's visible before you install, not just afterward from an update-check toast.
- The provider picker shows compatibility per provider, and asks for confirmation before installing a build that predates your patch.

## [0.2.4] - 2026-07-22

### Added
- `install.sh` — a one-command Linux installer (`curl | bash`): downloads the AppImage, makes it executable, and sets up a proper `.desktop` entry and icon, no `sudo` required.

### Changed
- Overhauled the README: grouped features, clearer reference tables, simplified non-technical setup instructions for Windows (SmartScreen) and macOS (Gatekeeper), and documented GNOME/Nautilus and `libfuse2` caveats for the Linux AppImage.
- Hardened the macOS/Windows GitHub Actions build workflows: actions pinned to exact commit SHAs instead of mutable version tags, credentials scoped down.

### Security
- Dependency CVE sweep (`adm-zip`, `electron-updater`, `electron-builder`) — all clean.

## [0.2.3] - 2026-07-22

### Fixed
- A GPU-process crash on NVIDIA graphics cards under native Wayland sessions, caused by Chromium's Vulkan/ANGLE initialization failing on that combination. Hardware acceleration is now disabled specifically for `linux` + Wayland sessions; every other platform and session type is unaffected.

## [0.2.2] - 2026-07-22

No functional changes. Republished after purging old screenshot images from git history that had exposed a local file path.

## [0.2.1] - 2026-07-22

No functional changes. Republished after removing internal tooling files that had been accidentally tracked in the repository.

## [0.2.0] - 2026-07-22

### Added
- Retail API-compatibility detection: Grimoire now reads your WoW client's actual installed version and flags any addon whose build predates the current content patch — the case that can make an addon fail to load or work incorrectly, which providers don't reliably flag on their own. Only differences that cross a real content-patch boundary are flagged; ordinary hotfix bumps are not, to avoid false alarms.
- Grimoire now checks providers for updates automatically on launch — no need to click "Check for updates" manually every time.

## [0.1.9] - 2026-07-22

### Added
- Native Linux support: an AppImage build with the same auto-update path as Windows.
- Auto-detects a Lutris/Wine WoW install (`~/Games/battlenet`).
- macOS and Windows installers are now built via GitHub Actions CI on real Apple/Microsoft-hosted runners.

## [0.1.8] - 2026-07-21

### Fixed
- Removing or replacing a saved API key could leave the old, still-decryptable copy sitting in a backup file. Settings backups now refresh whenever a key changes.
- Entering a key when the OS's secure credential storage is unavailable now fails with a clear error instead of silently saving it in plain text.
- Settings and backup files are written with owner-only file permissions.

## [0.1.7] - 2026-07-21

Version bump only, to ship the macOS update-notification changes below as a proper release.

## [0.1.6] - 2026-07-21

No code changes — release tag realigned to match what had already been built and published for macOS.

## [0.1.5] - 2026-07-21

### Changed
- Saved API keys no longer pass through to the app's UI process in decrypted form — the Settings screen now shows a "saved securely" placeholder with an explicit remove option, instead of ever rendering the key itself.
- CurseForge keys are now validated against CurseForge's own API when entered, so a mistyped or revoked key is caught immediately with a clear message, rather than only failing later during a search or update check.

## [0.1.4] - 2026-07-21

### Fixed
- A crash installing addons to a WoW folder on a different drive/volume than the OS temp directory (common with external drives or Wine/CrossOver prefixes) — installs now fall back to a safe copy-then-replace when a direct move isn't possible.
- Wago-sourced update checks and searches were silently using the retail game version on every WoW client flavor, including Classic.

### Security
- Installs are now fully transactional: if anything fails partway through, the previously installed addon files are restored, and the error message always says where your backup lives if an automatic restore can't complete.
- Downloaded addon archives are capped at 1 GB and validated against path traversal and zip-bomb style archives before being extracted.

## [0.1.3] - 2026-07-21

### Added
- macOS build target (dmg + zip, arm64 and x64), unsigned.

### Security
- CurseForge and Wago API keys are now encrypted at rest via the OS's own secure storage (Windows DPAPI / macOS Keychain) instead of being stored in plain text.

## [0.1.2] - 2026-07-21

Internal build only, not published publicly.

### Fixed
- Settings are now written atomically and recovered from a backup copy if the file is ever found corrupted. Installing or upgrading Grimoire no longer touches your WoW AddOns folder, and uninstalling on Windows keeps your settings by default.

## [0.1.1] - 2026-07-20

### Fixed
- The Wago ad panel (used only to obtain a free API token for users without their own) is now skipped entirely once a working key exists, removing the one embedded web page that could occasionally freeze the window.

## [0.1.0] - 2026-07-20

Initial release: a WoW addon manager covering **CurseForge, Wago, WoWInterface, and Tukui** in one place, with cross-provider update checking, unified search/browse, per-addon provider and release-channel selection, and provider-health warnings.
