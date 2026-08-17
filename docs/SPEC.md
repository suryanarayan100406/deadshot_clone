# Build Spec

Target: a browser FPS that matches deadshot.io's mechanics, layout and feel, built on
Three.js + TypeScript + an authoritative Node server. See `RESEARCH.md` for what was
verified about the original; this document is the plan for what we build.

Brand: **ONESHOT.io** — set in one place, `packages/shared/src/brand.ts`.

## 1. Architecture

```
oneshot/
├─ packages/shared/     # zero-dependency TS: the single source of truth
│  ├─ constants.ts      # tick rates, player dims, movement constants
│  ├─ math.ts           # Vec3 helpers, mutating + allocation-free
│  ├─ collision.ts      # AABB overlap, collide-and-slide, ray/box slab test
│  ├─ movement.ts       # stepMovement() — run by BOTH client and server
│  ├─ weapons.ts        # weapon data tables
│  ├─ maps.ts           # map geometry as brushes + spawn points
│  ├─ bitio.ts          # ByteWriter / ByteReader over DataView
│  └─ protocol.ts       # binary encode/decode for every message
├─ packages/server/     # Node + ws, 60 Hz authoritative simulation
│  ├─ index.ts          # WebSocket accept, room assignment
│  ├─ room.ts           # match state, tick loop, snapshot broadcast
│  ├─ lagcomp.ts        # position history ring buffer + rewind
│  └─ bots.ts           # server-side AI using the same movement code
└─ packages/client/     # Vite + Three.js
   ├─ main.ts           # boot, mode switching (menu ↔ game)
   ├─ net.ts            # socket, clock sync, snapshot buffer
   ├─ predict.ts        # local prediction + reconciliation
   ├─ world.ts          # build scene from map brushes
   ├─ actors.ts         # remote player meshes + interpolation
   ├─ viewmodel.ts      # first-person weapon, recoil, ADS, sway
   ├─ effects.ts        # tracers, impacts, muzzle flash, shake
   ├─ hud.ts            # crosshair canvas, health, ammo, killfeed
   ├─ menu.ts           # home screen matching the original's layout
   └─ settings.ts       # sliders/toggles/keybinds/crosshair editor
```

The client never contains a second copy of movement or collision logic. Prediction
and the server run the **same** `stepMovement()` from `shared`, which is what makes
reconciliation converge instead of jitter.

## 2. Netcode

Authoritative server, client prediction, entity interpolation, lag-compensated
hitscan. Three clocks matter and must not be confused:

| Rate | Value | What it is |
|---|---|---|
| Simulation tick | 60 Hz (`16.67 ms`) | Server advances physics; client predicts at the same rate |
| Snapshot rate | 20 Hz (`50 ms`) | Server → client authoritative state |
| Interpolation delay | 100 ms | How far in the past remote players are rendered |

**Client → server** — every tick, one `INPUT` command carrying a monotonic `seq`,
movement axes, button bitfield, and view angles. Inputs are also kept in a local
history array.

**Server → client** — every 50 ms, a `SNAPSHOT` containing server time, the
`lastAckedSeq` for that client, that client's authoritative position/velocity, and
every visible actor's state.

**Reconciliation** — on snapshot: snap local state to the authoritative values, drop
acked inputs from history, then re-simulate the remaining unacked inputs. If the
result differs from what was already displayed by less than 3 cm, blend the error out
over ~100 ms instead of snapping, so tiny float divergence is never visible.

**Interpolation** — remote actors are stored as timestamped samples and rendered at
`serverTimeEstimate − 100 ms`, interpolating the two bracketing samples. Clock offset
is estimated with a rolling minimum of `(recvTime − serverTime)` to reject jitter.

**Lag compensation** — the server stores 1 s of every player's position history. On a
shot it rewinds all targets to
`now − (rtt/2 + interpDelay)`, clamped to `[0, 1000] ms`, rebuilds their hitboxes at
those interpolated positions, and raycasts against *that* world. This is what makes a
shot that looked like a hit register as a hit on 80 ms ping.

**Hitboxes** — two AABBs per player: head (`0.28 m` cube at the crown, `1.7×` damage)
and body. Ray/box uses the slab method; the nearest of {world geometry, any hitbox}
wins, so walls correctly block shots.

**Anti-cheat floor** — the server validates every input: `dt` is fixed and ignored
from the client, axes are clamped to `[-1, 1]`, fire requests are rejected if they
arrive faster than the weapon's cycle time, and position is never accepted from the
client at all.

## 3. Movement — [DESIGNED]

Quake-lineage feel: separate ground and air acceleration, friction only on the ground,
and no air friction — that combination is what makes browser-FPS strafing feel right.

```
tick               60 Hz            gravity            22.0 m/s²
player radius      0.40 m           jump velocity      7.40 m/s
stand height       1.80 m           walk speed         6.20 m/s
crouch height      1.15 m           sprint speed       8.80 m/s
eye height         1.68 m           crouch speed       3.00 m/s
step-up height     0.35 m           ground accel       90 m/s²
                                    air accel          26 m/s²
                                    ground friction    11 /s
```

Collision is axis-separated collide-and-slide against static AABBs: move X and
resolve, move Z and resolve, move Y and resolve. Landing sets `onGround` and zeroes
vertical velocity; hitting a ceiling zeroes it too. A `0.35 m` step-up lets players
walk up stairs and crate stacks without jumping: when a horizontal move is blocked
while grounded, retry it lifted by the step height, then settle back down.

Air control is deliberately generous, and there is **no** air-strafe speed cap beyond
`air accel`, so bunny-hopping emerges naturally — as it does in this genre.

## 4. Weapons — [DESIGNED]

Health is 100. Every value lives in `weapons.ts`; nothing is hardcoded in logic.

| Weapon | Class | Mode | DMG | RPM | Mag | Reload | Shots to kill | Notes |
|---|---|---|---|---|---|---|---|---|
| Ranger | Assault rifle | Auto | 28 | 640 | 30 | 2.1 s | 4 body / 3 head | The baseline |
| Vector | SMG | Auto | 18 | 900 | 35 | 1.9 s | 6 body / 4 head | Wide spread, fast ADS |
| Breacher | Shotgun | Pump | 9 × 14 | 75 | 6 | 3.0 s | 1 point-blank | Hard falloff past 12 m |
| Longshot | Sniper | Bolt | 100 | 45 | 5 | 3.2 s | 1 body | Scoped, 4× zoom |
| Sidearm | Pistol | Single | 26 | 400 | 12 | 1.5 s | 4 body / 3 head | Always-available secondary |
| Blade | Melee | Melee | 55 / 100 | 120 | — | — | 2 front / 1 back | Backstab is lethal |

Every weapon carries: damage falloff (`falloffStart` → `falloffEnd` → `minMult`),
spread (`base`, `perShot`, `max`, `recovery`), recoil (`vertical`, `horizontal`,
`recovery`), `adsTime`, `adsFovMult`, `adsSpreadMult`, `moveSpeedMult`, `switchTime`,
and `headMult`. Firing while moving or airborne widens spread; ADS narrows it. The
crosshair reads the live spread value, so the HUD never lies about accuracy.

Recoil is applied as a camera-space kick that decays, plus a first-shot-accurate
spread cone — so tapping is rewarded over holding.

## 5. Maps — [DESIGNED]

Five levels, 520 brushes, twelve spawn points each. Every one is built from
axis-aligned brushes only, so render geometry and collision geometry are literally
the same array — there is no separate collision mesh to fall out of sync with what
the player can see.

Each map exists to make one argument about how a fight should go, and the set is
chosen so that no two make the same one:

| Map | Size | Brushes | Rotation | The argument |
| --- | --- | --- | --- | --- |
| `dustworks` | 60 m | 171 | FFA, TDM | Open courtyard around a raised centre, four enterable corner buildings with walkable roofs, two flanking alleys. The all-rounder, and the only map that never asks you to trade the middle for anything. |
| `foundry` | 48 m | 86 | FFA, TDM | Indoor hall whose central furnace breaks the centre sightline from *every* direction. Long shots exist only down the two side lanes, both overlooked from catwalks climbed at the far ends — so distance costs you the middle. |
| `overpass` | 68 m | 125 | FFA, TDM | A 44 m road deck on pillars: the highest ground and the longest sightline, reachable only from the two ends, with a gap in its parapet that anyone underneath can shoot up through. Strong to hold, survivable to lose. |
| `meridian` | 64 m | 88 | TDM | Mirror symmetric about one axis, two bases, all six of a side's spawns behind its own. The only map with a back line, a front, and a direction that means *forward*. |
| `cistern` | 40 m | 50 | FFA | A sunken floor inside a walkway ring that overlooks all of it. Built so a fight cannot be declined — which is what the Breacher and the Blade need and what the larger maps never give them. |

Symmetry is a fairness requirement rather than a style: four of the five are
rotationally symmetric, Meridian is mirror symmetric, and in both cases the point
is that no spawn reaches the middle first.

**Rotation is per mode**, because the difference is not cosmetic. Meridian's
behind-the-base spawns are the whole point of it for teams and actively wrong for a
free-for-all, where twelve players with no teams would appear in two piles facing
each other. So it is in the team rotation only; the other four appear in both, in a
different order per mode so switching modes does not hand you the same level twice.
The boundary is enforced by a measurable rule rather than a comment — an FFA map
keeps its two closest spawns more than 8 m apart, and Meridian's are 5.5 m.

Rotations are keyed by map `key`, not by id: a rotation is a statement about which
*levels* are in play, and `[3, 2, 0, 1]` would be a statement about array indices
that quietly means something else the first time a map is inserted rather than
appended.

A room picks its map when it is created and never mid-match, because `MatchMsg`
carries no map id — the level reaches the client in the welcome message only, so a
running match has no way to tell anyone the geometry changed. Public lobbies walk
the rotation in order; a party derives its map from a hash of its code, so a code
names a level as well as a room.

All five draw from one nine-entry material table (`MATERIALS` in `maps.ts`) —
sand, concrete, rust, wood, metal, accent, glass and two darker variants — and
differentiate themselves through which subset they use plus their own sky and fog:
Foundry and Cistern close the fog in to 82 m and 64 m because they are interiors,
Overpass pushes it to 190 m because its sightline is the point.

Rendering merges brushes into one buffer geometry per material, giving a handful of
draw calls for the whole level. Faces get slight per-normal shading so the flat
low-poly look still reads three-dimensionally without textures.

## 6. Game modes

- **Free-for-all** — first to 30 kills, 10-minute cap.
- **Team deathmatch** — two teams, first to 75.
- Bots fill empty slots so the game is always playable solo, and are removed as humans
  join. Bots run through the identical movement and weapon code paths, with
  reaction delay and aim error tuned per difficulty.
- **Parties** — a shared join code, and nothing else: no lobby screen, no invite
  list, no state to synchronise. Typing the same code lands everyone in the same
  room *and on the same side*; leaving the field blank means "anywhere with space".
  Codes are generated at five characters and accepted up to twelve, drawn from a
  32-symbol alphabet with `I`, `O`, `0` and `1` removed, because a code's whole job
  is to survive being read aloud and typed by somebody else. The alphabet, both
  bounds and the canonicaliser live in `shared` so the two ends cannot disagree
  about what a code means.

## 7. UI

Structure mirrors the original (see `RESEARCH.md` §3–6), with our own branding:

- **Home** — nav row (`PLAY GAME` / `SETTINGS` / `SHOP` / `LOCKER` / `LEADERBOARD`),
  wordmark, live 3D character preview over a blurred live 3D backdrop, Daily/Weekly
  challenge panel, two loadout slots, big blue `PLAY`, `Private` + `Join`, live
  player count, footer links.
- **Settings** — sectioned scroll list with the exact control taxonomy found in the
  original: sliders with paired numeric entry, toggles, custom dropdowns, and a
  keybind list where each row captures the next keypress while `listening`.
- **Crosshair editor** — live preview canvas plus shape, length, thickness, gap,
  outline, dot, dynamic-spread and colour controls.
- **In-game HUD** — crosshair (canvas, driven by live spread), health bar, ammo
  counter, killfeed, hitmarkers, floating damage numbers, `Tab` scoreboard, and a
  respawn screen.

Visual language: translucent dark panels, `#e2e2e2` text, condensed-bold headings,
white fills that step up in alpha on hover, `scale(0.94)` on press.

## 8. Milestones

| # | Scope | Status |
|---|---|---|
| **M1** | Monorepo, shared sim, authoritative server, prediction + reconciliation + interpolation + lag comp, one map, Ranger + Sidearm, bots, HUD, killfeed, scoreboard, menu shell | **done** |
| **M2** | Full weapon roster, recoil/spread/ADS tuning, melee, damage falloff, hitmarkers, damage numbers | **done** |
| **M2.5** | Layered procedural gunshots, per-weapon voicing, resupply-on-kill, detailed weapon and character models, firing visuals, sniper scope, view-model animation | **done** — pulled forward from M5 after playtest |
| **M3** | Four more maps with a per-mode rotation, TDM, private lobbies with join codes, match flow and end-of-round | **done** |
| M4 | Full settings + crosshair editor, keybinds, XP/levels, shop, locker, leaderboard, challenges | next |
| M5 | Post-processing pass, mobile touch controls, deploy | |

### Why M2.5 exists

The first real playtest returned one unambiguous judgement — the gunfire sounded
bad — and audio was scheduled last. It could not stay there. A shooter is judged
on the feel of firing a weapon before anything else, so the whole of it moved
ahead of new maps and modes:

- **Gunshots** are built as five layers per shot (transient, filter-swept noise
  blast, low punch, mechanical action, room tail) rather than as a tone with an
  envelope. The old version swept a square wave 630 → 126 Hz over 128 ms, which
  is a musical note, not a gunshot — and on a 94 ms cycle those notes overlapped
  into a chord. Every layer is jittered per shot, because fixed values make
  automatic fire one waveform retriggered, which the ear hears as a loop.
- **`WeaponDef.sfx`** went from four mixer values to eight that describe the gun
  physically (bore, brightness, saturation, action). One `freq` field cannot make
  a 12-gauge differ from a 9 mm in kind rather than in pitch.
- **Reserve ammunition** now refills on a kill. It previously only reset on
  respawn, so the player who was winning was the one who ran dry and finished the
  round holding a knife — the mode punishing exactly what it scores.
- **Models** gained per-class detail: handguards, charging handle, pump, bolt
  knob, a scope with glass; and characters gained helmets, plate carriers,
  shoulders, belts, knee pads and boots. All character gear stays inside the
  collider envelope the server traces against, because visible geometry outside
  the hitbox produces shots that look like hits and deal no damage.
- **Firing visuals** followed the same argument the audio did. Tracers are now
  camera-facing quads: `LineBasicMaterial.linewidth` is silently ignored by every
  WebGL implementation — the spec lets a driver support only 1.0 — so the old
  line-based tracer was a one-pixel hairline regardless of the width asked for.
  The muzzle flash is sized from the bore and the charge behind the shot, gets a
  white core and a cone of gas down the barrel, and its duration is clamped inside
  the weapon's own cycle time; past that it stops strobing per shot and reads as a
  lamp on the muzzle. Cases eject from a port carried by the gun's own transform.
  Enemy fire flashes at its muzzle, because a tracer says where a bullet went and
  only a flash says where the shooter is standing.
- **World particle scale** was wrong by a factor of a hundred: sizes were written
  in centimetres and consumed as metres, so a 4.5 cm spark was drawn 4.5 m across
  — a screen-filling additive disc on every bullet impact. The unit now lives in
  the parameter name, and the pixel conversion carries the camera FOV as well as
  the viewport height, so a scope magnifies distant hits instead of shrinking
  them.
- **The sniper scope** was a hard black vignette with two hairlines across it. It
  is now a duplex reticle — heavy posts in from the rim, a fine stem, mil hash
  marks for holdover, and a gap around the aim point so the reticle never covers
  the target — on a tinted lens with rim darkening and a soft edge. The idle drift
  animates the glass only, never the aiming marks: the bullet goes to the centre
  of the screen, and drifting the marks to sell breathing would be the overlay
  lying about where the weapon points.
- **View-model animation** stopped being one shared shake. Each weapon now plays
  the stroke its own action would: a bolt lifts, draws and returns; a slide runs
  and locks back on the last round; a pump rocks the forend. Reloads are scripted
  off the *server's* timers rather than a local clock, so the animation always ends
  exactly when the weapon becomes usable again — an animation that finished early
  would advertise a gun that cannot fire yet, and one that finished late would hide
  a gun that can. A tube-fed reload rocks the forend once per shell, so its tempo
  comes off the magazine size instead of a constant.

  The knife swing is three phases rather than one sine curve, and that is the whole
  point of it: a symmetric arc is fastest at the exact midpoint and decelerates for
  as long as it accelerated, which reads as a wave rather than a cut. A wind-up
  that rolls the edge into line, a deliberately *linear* slash across and down —
  an eased slash is a slash in slow motion — and a slower recovery gives the swing
  a visible moment of contact. That moment sits near the front of the animation
  because the server resolves the hit on the trigger pull, so a contact point in
  the middle of the stroke would land damage before the blade appeared to arrive.

### What M3 delivered

**Four more maps**, taking the count from one to five: Foundry, Overpass, Meridian
and Cistern. Each is built around a single argument about how a fight should go,
stated in its own doc comment so the *reason* it exists survives — Foundry blocks
the centre from every angle so distance costs you the middle; Overpass is a 44 m
deck that is strong to hold and survivable to lose; Meridian is the only
mirror-symmetric map, so it is the only one where a direction means *forward*;
Cistern is small enough that a fight cannot be declined, and short on purpose,
because a map that relentless is excellent for one round and exhausting for three.

Every dimension was checked against the movement constants rather than eyeballed.
`STEP_HEIGHT` is 0.35 m and a jump clears `v²/2g ≈ 1.24 m`, so a staircase has to
step at or under 0.35, a ledge is reachable up to 1.24, and Cistern's ring at
1.6 m is deliberately *above* that — the ramps are the only way up, which makes the
ring a position rather than a ledge.

**Rotation is per mode**, because Meridian puts all six of a side's spawns behind
that side's own base: correct for teams, and actively wrong for a free-for-all
where twelve players with no teams would appear in two piles facing each other. So
it is in the team rotation only, and the boundary is enforced by a measurable rule
instead of a comment — an FFA map keeps its two closest spawns more than 8 m
apart, and Meridian's are 5.5 m. The rotation is keyed by map key rather than by
id, because `[3, 2, 0, 1]` is a statement about array indices and would quietly
mean something else the first time a map was inserted rather than appended.

A room picks its map when it opens, not mid-match: `MatchMsg` carries no map id, so
a running match has no way to tell connected clients the level changed.

**Parties** are a named room and nothing else — no lobby screen, no invite list, no
state to synchronise. This needed no protocol change at all, because *"I typed a
code"* versus *"put me anywhere"* was already expressible as a non-empty versus
empty `room` field in the join message.

Two bugs were behind what looked like a missing feature. Team assignment used
`thinnerTeam` for everyone, which coin-flips the first player into an empty room
and then puts the second on whichever side is emptier — *always* the other one, so
two friends joining a team match landed on opposite sides every single time.
Playing with a friend was impossible by construction rather than merely unlikely.
And the client sent a hardcoded room name, which the server treats as a *named*
room: every player in the world therefore shared one twelve-slot lobby, the
auto-lobby overflow path never executed, the thirteenth connection was refused
outright, and the map rotation would never have rotated.

Making party rooms meaningful introduced a third problem that had to be closed in
the same change: the public search matched on free space alone, so the next
stranger who pressed Play would have been dropped into somebody's private match.

Codes are drawn from a 32-symbol alphabet with `I`, `O`, `0` and `1` removed,
because a code's only job is to survive being read aloud and typed by somebody
else. The alphabet and the canonicalisation live in `shared`, called by both ends —
briefly they were a copy each, which is the setup for the worst failure this
feature has: a code the menu happily produces, silently mangled into a different
room by the server, splitting a party in half with nothing on screen to explain
why. The server re-canonicalises on arrival regardless of what the client did,
since the client is only ever whatever connected to the socket.

Friends stack onto one side, which is the opposite of what a public lobby wants.
The stacking stops at half the lobby so a large private group self-balances into a
real match rather than a firing squad — and because bots keep using plain balance,
two friends in a six-player match get a bot *teammate* and an even 3v3 rather than
a 2v4 against everything in the room.

Room selection was moved out of `index.ts` into its own module to make any of this
testable: that file opens a listening socket and starts the 60 Hz tick as
import-time side effects, so every decision in it was unreachable from a test as
long as it stayed there.

Still zero asset files: every sound is Web Audio oscillators and noise buffers,
every model Three.js primitives, every icon inline SVG.

## 9. Verification

- `npm run dev` — server on `:8787`, client on `:5173`.
- Movement/collision: a headless script runs 10 000 ticks of scripted input through
  `stepMovement()` and asserts the player never ends up inside a brush.
- Prediction: with the client's artificial-latency toggle at 150 ms, holding forward
  into a wall must not produce visible rubber-banding.
- Lag comp: two clients at different simulated pings shooting the same crossing bot
  must both register hits at the crosshair.
- Protocol: round-trip encode/decode of every message type asserts byte-identical
  results.
- Maps: every spawn on every map is checked for room to stand, for solid ground
  under it, and for facing the centre — a backwards spawn is legal geometry, looks
  correct from above, and shows up only as players dying a second after appearing.
  Every map is also asserted to appear in a rotation, since an unreachable level is
  no level at all.
- Rooms: `npm run test:server` drives team assignment and room selection headlessly.
  Neither is reachable from the shared suite, and the smoke test cannot see either —
  it connects one socket, and the whole point of a party is the *second* one.
