# Grimoire

A World of Warcraft addon manager that handles **CurseForge, Wago, WoWInterface, and Tukui** in one place — because no existing manager covers CurseForge and Wago together.

![Grimoire](build/icon.png)

## Features

- **Auto-detects installed addons** by reading their `.toc` files and install markers — multi-folder addons (BigWigs, ElvUI, Details!) group into a single entry.
- **Cross-provider updates.** Checks each addon against the provider it was installed from and installs updates in place, backing up the old version first.
- **Search and browse** across all four providers at once, with typo tolerance, category filtering, and deep pagination.
- **Per-addon provider choice** so CurseForge and Wago never fight over the same addon.
- **Release channels** (stable / beta / alpha) — global default plus per-addon overrides, showing only the channels each addon actually publishes.
- **Provider-health warnings** — flags addons removed from a provider, gone stale, or available fresher elsewhere, with one-click provider switching.
- **Automatic updates** for Grimoire itself via GitHub Releases.

## Setup

1. Download the latest installer from [Releases](https://github.com/dontshome/grimoire/releases) and run it.
2. On first launch, Grimoire auto-detects your WoW `_retail_` folder (change it in Settings if needed).
3. **CurseForge:** paste a free API key from [console.curseforge.com](https://console.curseforge.com) into Settings. This is required — Grimoire only ever talks to CurseForge through their official API, using your own key.
4. **Wago:** connects automatically (no key needed). A Patreon token can be added in Settings if you have one.
5. **WoWInterface / Tukui:** work out of the box, no key.

## Building from source

```sh
npm install
npm start          # run in development
npm run dist       # build the Windows installer → dist/
```

The installer is unsigned, so Windows SmartScreen will warn on first run — choose **More info → Run anyway**.

## How it talks to each provider

- **CurseForge** — official API (`api.curseforge.com`) with your own key only. No scraping.
- **Wago** — the public external API (`addons.wago.io/api/external`), the same integration path Wago offers third-party managers.
- **WoWInterface** — public API (`api.mmoui.com`).
- **Tukui** — public API (`api.tukui.org`).

Grimoire never hosts or redistributes any addon. It downloads each addon directly from its provider using that provider's own links, on your behalf.

## Legal & Terms of Use

Grimoire is a free, open-source client for managing World of Warcraft addons. Please read the following before using or distributing it.

**Bring your own credentials.** Grimoire does not include or provide access to any provider's service. To use CurseForge you must supply your own CurseForge API key, obtained directly from CurseForge ([console.curseforge.com](https://console.curseforge.com)). By doing so you agree to CurseForge's and Overwolf's API Terms of Service, and you — not the authors of Grimoire — are responsible for complying with them. The same applies to any Wago, WoWInterface, or Tukui credentials you use. Grimoire acts only as a client that sends requests using the credentials you provide, much like a web browser.

**No addon content is hosted or redistributed.** Grimoire does not store, bundle, mirror, or redistribute any addon. When you install or update an addon, Grimoire downloads it directly from the provider you selected, using that provider's own download links, on your behalf. All addons remain the property of their respective authors and are subject to those authors' and providers' terms.

**Official interfaces only.** Grimoire communicates with each provider through that provider's official or public API. It does not circumvent access controls, rate limits, or authentication.

**No affiliation.** Grimoire is an independent project and is not affiliated with, endorsed by, or sponsored by Blizzard Entertainment, Overwolf, CurseForge, Wago, WoWInterface, or Tukui. World of Warcraft is a trademark of Blizzard Entertainment. All product names, logos, and trademarks are the property of their respective owners and are used for identification purposes only.

**No warranty.** Grimoire is provided "as is", without warranty of any kind, under the MIT License. You use it at your own risk.

## Contributors

- **[dontshome](https://github.com/dontshome)** — author and maintainer.
- **[Blake Burns Technologies Inc.](https://github.com/Blake-Burns-Technologies)** — macOS support and platform testing; cross-volume (EXDEV) install fix; download, archive, and IPC hardening; CurseForge API key validation; keeping credentials out of the renderer process.

## License

[MIT](LICENSE)
