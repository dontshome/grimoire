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

## Disclaimer

Grimoire is an independent project, not affiliated with or endorsed by Blizzard Entertainment, Overwolf, CurseForge, Wago, WoWInterface, or Tukui. World of Warcraft is a trademark of Blizzard Entertainment. All addon names and trademarks belong to their respective owners.

## License

[MIT](LICENSE)
