# Grimoire

[![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-303747?style=flat-square)](#install-grimoire)
[![License: MIT](https://img.shields.io/badge/license-MIT-6dbf73?style=flat-square)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-43-47848f?style=flat-square)](https://www.electronjs.org/)

**Your cross-provider World of Warcraft addon manager.**

A World of Warcraft addon manager that handles **CurseForge, Wago, WoWInterface, and Tukui** in one place — because no existing manager covers CurseForge and Wago together.

[Download](https://github.com/dontshome/grimoire/releases/latest) · [Report a problem](https://github.com/dontshome/grimoire/issues)

![Grimoire](docs/screenshots/installed.png)

## Contents

- [What Grimoire does](#what-grimoire-does)
- [Screenshots](#screenshots)
- [Supported WoW clients](#supported-wow-clients)
- [Providers and credentials](#providers-and-credentials)
- [Install Grimoire](#install-grimoire)
- [First run](#first-run)
- [How updates stay safe](#how-updates-stay-safe)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Legal & Terms of Use](#legal--terms-of-use)
- [Contributors](#contributors)
- [License](#license)

## What Grimoire does

### One library, four providers

- Scans installed addons from their `.toc` metadata, provider markers, and folder fingerprints.
- Groups multi-folder packages such as BigWigs, ElvUI, and Details! into a single entry.
- Searches CurseForge, Wago, WoWInterface, and Tukui together, with typo tolerance, category filtering, and deep pagination.
- Shows the provider, installed version, available version, and update state in one list.

### Updates without provider fights

- Remembers where each addon was installed and checks that provider by default.
- Finds the same addon on other providers, so you can pin or reinstall it from the one you prefer.
- Supports a global **stable**, **beta**, or **alpha** release channel plus per-addon overrides.
- Imports existing per-addon stability overrides from the Wago App once, if it's installed.

### Warnings that are actually useful

- Flags addons that disappeared from their provider, look abandoned, or have a fresher build elsewhere, with one-click provider switching.
- Reads Blizzard's own `.build.info` and compares your installed client's content-patch interface number against each addon's `.toc` interface.
- Warns when an addon predates the current content patch and may need WoW's **Load out of date AddOns** option — judged by content-patch era, not every hotfix, so routine patches don't get flagged.
- Surfaces a compatible build from another provider when one is found.

### Desktop conveniences

- Detects installed WoW clients and switches between them from the header.
- Installs, updates, changes provider, or uninstalls a complete multi-folder addon as one unit.
- Automatically downloads Grimoire updates on Windows and Linux, then offers a one-click restart.
- Notifies macOS users when a new release is available and links to the manual download, since it isn't code-signed.
- Keeps the running Grimoire version visible in the header and Settings.

## Screenshots

### Browse every provider together

Search results are merged across providers, with game-flavor compatibility and install state visible before you click.

![Grimoire Browse view with merged provider results](docs/screenshots/browse.png)

### Find addons that need attention

Compatibility and provider-health checks separate actionable problems from addons that are simply up to date.

![Grimoire Needs attention view showing compatibility and stale-addon warnings](docs/screenshots/needs-attention.png)

## Supported WoW clients

Grimoire detects the clients that actually exist beneath your chosen **World of Warcraft** root and creates `Interface/AddOns` on first install when needed.

| Family | Detected client folders |
| --- | --- |
| Retail | `_retail_`, `_ptr_`, `_xptr_`, `_beta_` |
| Classic progression | `_classic_`, `_classic_ptr_`, `_classic_beta_` (MoP Classic as of this release — Blizzard advances this client periodically) |
| Classic Era | `_classic_era_`, `_classic_era_ptr_` |
| Classic Anniversary | `_anniversary_`, `_anniversary_ptr_` |

## Providers and credentials

| Provider | Connection | Credential needed? | Notes |
| --- | --- | --- | --- |
| CurseForge | Official API at `api.curseforge.com` | **Yes** — bring your own free API key | Create one at [console.curseforge.com](https://console.curseforge.com). |
| Wago | Public external API at `addons.wago.io/api/external` | No | Connects automatically. Patreon supporters can add their token in Settings for ad-free access. |
| WoWInterface | Public API at `api.mmoui.com` | No | Works out of the box. |
| Tukui | Public API at `api.tukui.org` | No | Works out of the box; availability depends on the selected game flavor. |

Grimoire never hosts, mirrors, or redistributes addon files — every download comes straight from the provider you chose. Any key you enter is encrypted at rest through Electron's OS-backed secure storage and written to disk owner-only; if secure storage isn't available yet, older plaintext credentials are migrated automatically once it becomes available. Credentials never leave Grimoire's main process — the UI only ever sees whether a provider is configured, not the key itself.

## Install Grimoire

Download the appropriate package from [Releases](https://github.com/dontshome/grimoire/releases/latest).

### Windows

1. Download `Grimoire-Setup-<version>.exe` and run it.
2. Windows will likely show a blue "Windows protected your PC" screen. This just means Grimoire is a small independent app rather than something from a big company — it's expected and normal. Click **More info**, then **Run anyway**.

### macOS

1. Download `Grimoire-<version>-mac-<arch>.dmg` — `arm64` if you have an Apple Silicon Mac (M1/M2/M3/M4), `x64` if it's an older Intel Mac.
2. Open the file and drag Grimoire into your Applications folder.
3. The first time, don't just double-click it — instead **right-click (or Control-click) Grimoire in Applications and choose Open**, then click **Open** again in the popup that appears. This step is only needed once. (A plain double-click will refuse to open it with no explanation — right-click → Open is what actually lets you through.)
4. If macOS says Grimoire "is damaged and can't be opened," it isn't really damaged — that's just macOS being extra cautious about apps that aren't from the App Store or a paid developer account. Open the **Terminal** app, paste this line, press Enter, then try opening Grimoire again:
   ```sh
   xattr -cr /Applications/Grimoire.app
   ```

Because Grimoire doesn't have a paid Apple developer certificate, it also can't update itself automatically on Mac the way it does on Windows/Linux — you'll just get a popup with a download link whenever a new version is out.

### Linux

The easiest way — one command installs Grimoire, adds it to your application menu with its icon, and needs no `sudo`:

```sh
curl -fsSL https://raw.githubusercontent.com/dontshome/grimoire/main/install.sh | bash
```

Run that same command again any time to update to the latest version. (As
with any script you pipe into `bash`, feel free to
[read it first](https://github.com/dontshome/grimoire/blob/main/install.sh)
— it only downloads the AppImage and adds a menu entry under your home
directory, nothing else.)

<details>
<summary>Prefer to install by hand instead?</summary>

Grimoire ships as an AppImage — no installer, no package manager needed.

1. Download `Grimoire-<version>-linux-x86_64.AppImage` from [Releases](https://github.com/dontshome/grimoire/releases).
2. Make it executable and run it: `chmod +x Grimoire-*.AppImage && ./Grimoire-*.AppImage`.

   (GNOME's Nautilus file manager won't run an AppImage from a double-click — it's been disabled there since 2018 for security reasons, regardless of file permissions. Use a terminal, or the one-command installer above, which adds a proper menu entry that GNOME's app grid *will* launch.)

That's a working install — nothing else is required. To make it appear in your application menu like a normally-installed program, either:

- Install [AppImageLauncher](https://github.com/TheAssassin/AppImageLauncher) (`sudo dnf install appimagelauncher` on Fedora/Nobara) — it offers to integrate any AppImage the first time you run it, and takes care of everything below automatically.
- Or do it by hand:
  ```sh
  mkdir -p ~/Applications ~/.local/share/applications ~/.local/share/icons/hicolor/512x512/apps
  cp Grimoire-*.AppImage ~/Applications/Grimoire.AppImage
  chmod +x ~/Applications/Grimoire.AppImage
  curl -L -o ~/.local/share/icons/hicolor/512x512/apps/grimoire.png \
    https://raw.githubusercontent.com/dontshome/grimoire/main/build/icon.png
  cat > ~/.local/share/applications/grimoire.desktop <<EOF
  [Desktop Entry]
  Type=Application
  Name=Grimoire
  Comment=World of Warcraft addon manager — CurseForge and Wago in one place
  Exec=$HOME/Applications/Grimoire.AppImage %U
  Icon=grimoire
  Terminal=false
  Categories=Game;
  StartupWMClass=grimoire
  EOF
  update-desktop-database ~/.local/share/applications
  ```
</details>

**Note for Wayland sessions:** Grimoire runs with GPU hardware acceleration disabled when launched under native Wayland (`XDG_SESSION_TYPE=wayland`). This works around a Chromium GPU-process crash seen on some NVIDIA + Wayland setups during Vulkan initialization. Software rendering has no real visual cost for an addon list — X11 sessions, and every other platform, are unaffected and keep full hardware acceleration.

**Note for newer distros (e.g. Ubuntu 24.04+):** some recent distro releases stopped including `libfuse2` by default, which older AppImages need to mount themselves — if Grimoire fails to start with a FUSE-related error, either install it (`sudo apt install libfuse2t64` on Ubuntu) or run the AppImage with `--appimage-extract-and-run` instead, which works without FUSE at all.

## First run

1. Launch Grimoire. It looks for a World of Warcraft root and lists every installed client it recognizes — on Linux, this includes the Battle.net install Lutris's official installer creates (`~/Games/battlenet`).
2. If detection misses your install, open **Settings** and choose the main `World of Warcraft` folder — not an individual `_retail_` or `_classic_` folder.
3. Add credentials for any providers that need them (see [Providers and credentials](#providers-and-credentials) above) — CurseForge is the only one that requires a key.
4. Choose a WoW client in the header, click **Rescan**, then **Check for updates**.

Use **Browse** to discover new addons. Click any installed addon for its folders, known providers, release-channel override, reinstall choices, update action, and recoverable uninstall action.

## How updates stay safe

Grimoire treats each addon's folder(s) as the unit of change, and never touches your live AddOns directory without a way back out:

1. The archive downloads to a temporary directory, capped at a 1 GB compressed/expanded size and 100,000 files — a safety limit against corrupt or hostile downloads, not a real-world addon size.
2. Archive contents and folder names are validated before anything is written into the live AddOns directory.
3. Every folder being replaced is moved into a timestamped backup first — never deleted outright.
4. New folders get a `.grimoire` marker recording provider, provider ID, version, and install time, so Grimoire can track what it installed and from where.
5. If installation fails partway through, Grimoire removes the partial install and restores the backup automatically.

Uninstalling works the same way — folders are moved to backup, not deleted. Backups live under your Grimoire user-data directory in `backups/`:

| Platform | Grimoire user-data location |
| --- | --- |
| Windows | `%APPDATA%\Grimoire` |
| macOS | `~/Library/Application Support/Grimoire` |
| Linux | `$XDG_CONFIG_HOME/Grimoire`, or `~/.config/Grimoire` when unset |

If an update or uninstall ever goes wrong, your previous copy is sitting in that `backups/` folder — move it back into `Interface/AddOns` by hand to undo it.

## Development

### Requirements

- [Node.js](https://nodejs.org/) 22 or a compatible current release
- npm
- Git (release builds check that `HEAD` matches `origin/main`)

```sh
git clone https://github.com/dontshome/grimoire.git
cd grimoire
npm install
npm start          # run in development
npm test           # run the Node test suite
npm run dist       # build the installer for your OS → dist/
```

`npm run dist` builds whatever electron-builder can produce for the host platform: an NSIS installer on Windows, a dmg/zip on macOS, and an AppImage on Linux. A locally-built installer is unsigned the same way the published releases are — see the platform-specific notes under [Install Grimoire](#install-grimoire) for what that means on each OS.

Run `npm run verify-build -- <path-to-app.asar>` to read a packaged build's embedded source/version provenance and confirm it matches a commit that's actually been published.

<details>
<summary>Project map</summary>

```text
grimoire/
├── main.js                 Electron main process, settings, IPC, app updates
├── preload.js              Narrow renderer-to-main API bridge
├── src/
│   ├── scanner.js          Addon discovery and multi-folder grouping
│   ├── fingerprint.js      Folder-to-addon identity matching
│   ├── providers.js        Provider search, matching, and update resolution
│   ├── installer.js        Validated install, backup, rollback, uninstall
│   ├── flavors.js          WoW client and provider-flavor mappings
│   ├── credentials.js      Encrypted credential persistence and migration
│   └── bundledKeys.js      Bundled default API access
├── ui/                      HTML, CSS, and renderer behavior
├── test/                    Node test suite
├── build/                   Icons, packaging, and provenance verification
└── docs/screenshots/        README product screenshots
```

</details>

## Troubleshooting

| Symptom | What to try |
| --- | --- |
| No addons or clients appear | In Settings, select the World of Warcraft **root** folder (the one containing `_retail_`, `_classic_era_`, and similar folders — not a specific client folder itself), then click **Rescan**. |
| CurseForge data is missing | Create a free API key at [console.curseforge.com](https://console.curseforge.com) and paste it into Settings. |
| Wago is unavailable | Wait for the panel to show **connected**, reload the app, or add a Patreon token in Settings if you have one. |
| An addon is marked out of date | Update it, switch to a compatible provider build if Grimoire found one, or enable WoW's **Load out of date AddOns** option if you trust the addon anyway. |
| AppImage doesn't open from a double-click | Run it from a terminal, use the [one-command installer](#linux), or integrate it with [AppImageLauncher](https://github.com/TheAssassin/AppImageLauncher). |
| AppImage fails with a FUSE error | Install `libfuse2` (`libfuse2t64` on Ubuntu 24.04+) or run with `--appimage-extract-and-run`. |
| A bad update or uninstall needs reversing | Open the `backups/` folder for your platform (see [How updates stay safe](#how-updates-stay-safe)) and move the saved addon folders back into `Interface/AddOns`. |

For reproducible bugs, open a [GitHub issue](https://github.com/dontshome/grimoire/issues) with your operating system, WoW client flavor, Grimoire version, provider, and the exact error message. Never paste API keys or Wago tokens into an issue.

## Legal & Terms of Use

Grimoire is a free, open-source client for managing World of Warcraft addons. Please read the following before using or distributing it.

**Bring your own credentials.** Grimoire does not include or provide access to any provider's service. To use CurseForge you must supply your own CurseForge API key, obtained directly from CurseForge ([console.curseforge.com](https://console.curseforge.com)). By doing so you agree to CurseForge's and Overwolf's API Terms of Service, and you — not the authors of Grimoire — are responsible for complying with them. The same applies to any Wago, WoWInterface, or Tukui credentials you use. Grimoire acts only as a client that sends requests using the credentials you provide, much like a web browser.

**No addon content is hosted or redistributed.** Grimoire does not store, bundle, mirror, or redistribute any addon. When you install or update an addon, Grimoire downloads it directly from the provider you selected, using that provider's own download links, on your behalf. All addons remain the property of their respective authors and are subject to those authors' and providers' terms.

**No affiliation.** Grimoire is an independent project and is not affiliated with, endorsed by, or sponsored by Blizzard Entertainment, Overwolf, CurseForge, Wago, WoWInterface, or Tukui. World of Warcraft is a trademark of Blizzard Entertainment. All product names, logos, and trademarks are the property of their respective owners and are used for identification purposes only.

**No warranty.** Grimoire is provided "as is", without warranty of any kind, under the MIT License. You use it at your own risk.

## Contributors

- **[dontshome](https://github.com/dontshome)** — author and maintainer.
- **[Blake Burns Technologies Inc.](https://github.com/Blake-Burns-Technologies)** — macOS platform testing and bug reports.

## License

[MIT](LICENSE)
