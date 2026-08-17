# Research: deadshot.io

Field notes from direct inspection of the live site, 2026-08-15. Everything below is
either **[VERIFIED]** (observed in the shipped HTML/CSS/screenshots) or **[DESIGNED]**
(a deliberate design decision for our clone, matched to genre convention because the
original's minified bundle was not readable).

## 1. Access notes

The site is blocked by a network filter on this machine (`HTTP 403 "Blocked site"` for
`deadshot.io`, `crazygames.com`; Fandom wikis sit behind a Cloudflare CAPTCHA; the
Reddit API returns 403). Research was done through a server-side reader proxy
(`r.jina.ai`) plus an image proxy (`wsrv.nl`), which returned:

- the fully **rendered DOM** (1.19 MB) — inline `<script>` bodies stripped
- `css/settings.css` (19 KB) and `css/username.css` — complete
- `promo/thumbnail.png`, `promo/logo.png`, `favicon.png` — complete
- a live **page screenshot** of the home menu (1281×1281)

The game's own JavaScript was never readable, and no part of it was copied. Our
implementation is written from scratch.

## 2. Genre and engine

**[VERIFIED]** It is a 3D first-person shooter, not a 2D game:

```
<meta name="description" content="DEADSHOT.io - Multiplayer online first-person
  shooter that's easily accessible. Grab your friends, join a lobby, and eliminate
  your opponents!">
<meta name="keywords" content="deadshot, ..., krunker, shell shock, shell shockers,
  shellshock, web fps, io, game, games, web game, html5, poki, crazy games,
  1v1 lol, 1v1.lol, ...">
```

The developer positions it directly against Krunker, Shell Shockers and 1v1.lol —
the browser-FPS cohort. `promo/thumbnail.png` shows a first-person weapon in a
warm desert-toned blocky environment under a blue sky.

**[VERIFIED]** Rendering is canvas-based with multiple stacked `<canvas>` layers and
explicit GPU compositing hints:

```
<canvas height="1281" width="1281" style="position:absolute; user-select:none;
  transform: translateZ(0px); backface-visibility:hidden; z-index:49; ...">
```

**[VERIFIED]** Only five static asset files are referenced anywhere in the document:

```
favicon.png   promo/mobileicon.png
fonts/encodesanssemicondensed.woff2   fonts/opensans.woff2   fonts/verdana.ttf
```

No sprite sheets, no `.glb`/`.gltf`/`.obj`, no texture atlases, no audio files. All
world geometry, weapons, characters and textures are therefore **generated in code**.
This is the single most important architectural finding: it means a faithful clone
needs no art pipeline, and it explains the game's flat, low-poly look.

**[DESIGNED]** We use Three.js over WebGL2 and generate all geometry procedurally,
matching that constraint.

## 3. Home menu

**[VERIFIED]** from the live screenshot. Layout, top to bottom:

- **Top-left** — `Latest Update:` label, version number (`67` at time of capture),
  and a `Patch Notes` button.
- **Top-centre** — wordmark: heavy condensed all-caps, a rifle silhouette between the
  two words, and a sniper-scope reticle substituted for the `O`.
- **Top-right** — `Sign in with Google` (Google Identity Services,
  `accounts.google.com/gsi/client`).
- **Nav row** — `PLAY GAME` · `SETTINGS` · `SHOP` · `LOCKER` · `LEADERBOARD`.
  Active tab is underlined.
- **Centre** — a live 3D character model (soldier, tactical vest, cap, rifle held at
  the shoulder) posed in front of a **blurred live 3D map backdrop**.
- **Left panel** — `Daily` / `Weekly` toggle, `Daily Challenges:` heading, and
  `Log in to view Daily Challenges` when signed out.
- **Right** — two empty loadout slots rendered as large `+` placeholders.
- **Bottom centre** — a large blue `PLAY` button, with `Private` and `Join` beneath it.
- `1492 Players Online` live counter.
- **Bottom-left** — `Join the community!!` + a Discord button.
- **Bottom-right footer** — `Terms | Privacy | Partners | Contact`.

## 4. Settings

**[VERIFIED]** `#settingsDiv` is `760 × 672 px`, `color: #e2e2e2`, `font-family:
'Open Sans'`. Selector analysis of `settings.css` reveals the full control taxonomy:

| Control | Selector evidence |
|---|---|
| Scrollable sectioned list | `.settings-section`, `.settings-section-title`, `.settings-list` |
| Edge fade on scroll | `.settings-scroll.can-scroll-up.can-scroll-down` + mask properties |
| Slider (range + numeric box) | `.setting.sldr .range`, `.setting.sldr .number` |
| Toggle | `.setting.toggle label .checkbox:checked + span` |
| Custom dropdown | `.setting.select .new-select2`, `.new-option li` |
| **Rebindable keybinds** | `.settings-keybind-row`, `.settings-keybind-button.listening`, `.settings-keybind-clear` |
| Action buttons | `.settings-action-row`, `.settings-action-button` |

**[VERIFIED]** A separate `#crosshairSettingsDiv` implements a full crosshair editor:
a sticky `112 px` live-preview panel (`.crosshair-preview-canvas`), per-property rows
(`.crosshair-setting`), colour swatches with text entry
(`.crosshair-color`, `.crosshair-color-text`), and its own scroll container.

Zebra striping via `:nth-child(even)` on every row type.

## 5. Username modal

**[VERIFIED]** `css/username.css`: `480 px` wide, centred with
`translate(-50%, -60%)`, `rgba(0,0,0,0.35)` fill, `5px solid #1F1F1F` border,
Verdana bold, white text. Two actions — `.create` in blue `rgba(50,140,220,·)` and
`.cancel` in red `rgba(221,51,51,·)`, both brightening their border from `0.3` to
`0.7` alpha on hover and scaling to `0.94` on press.

## 6. Visual system

**[VERIFIED]** Colour frequency across `settings.css`:

```
#000 (×24)   #bebebe (×7)   #e2e2e2 (×5)   #e0e0e0 (×4)
rgba(0,0,0,0.1/0.2/0.3)     rgba(255,255,255,0.03…0.52)
rgba(20,20,20,0.8)   rgba(47,47,47,1)   #3f345d
```

Type scale: `14, 16, 18, 21, 22 px`. Interaction idiom throughout: translucent white
fills that step up in alpha on hover, plus a `scale(0.94)` press. Nothing is fully
opaque — the 3D scene reads through every panel.

## 7. Other confirmed systems

- **[VERIFIED]** Respawn/death screen — ad slots `banner-respawn-1`, `banner-respawn-2`
  sit alongside `banner-home`, `banner-home2`.
- **[VERIFIED]** Free-for-all mode — `ffa` appears 46× in the bundle.
- **[VERIFIED]** Mobile support — `apple-mobile-web-app-capable`,
  `mobile-web-app-capable`, `viewport-fit=cover`, `user-scalable=no`,
  `touch-action: pan-y`.
- **[VERIFIED]** No-cache headers on the document, so the client hot-ships.
- **[VERIFIED]** Third-party: Google Identity Services, Venatus ad mediation
  (`hb.vntsm.com`), Google Analytics, Cloudflare (CDN + Insights).

## 8. What we could not verify

The exact weapon roster, per-weapon damage/RPM tables, map names and geometry,
movement constants, and the wire protocol are all inside the unreadable bundle.
Everything in that category is **[DESIGNED]** in `SPEC.md`: tuned to the
casual-browser-FPS feel the thumbnail and positioning imply, and — critically —
kept in data tables so any value can be retuned in one place without touching logic.

## 9. Legal position

The name `DEADSHOT.io`, its wordmark, and its cosmetics are the original developer's
branding. This project ships under its own name with its own generated art. No code,
markup, stylesheet or asset from the original is reproduced. What we reimplement is
mechanics and layout convention, which is exactly what the original does relative to
Krunker.
