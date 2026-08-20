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
│  ├─ combat.ts         # hitbox construction, hitscan tracing
│  ├─ maps.ts           # brushes, spawns, props + the prop placement rules
│  ├─ brand.ts          # the name, palette and wordmark, defined once
│  ├─ bitio.ts          # ByteWriter / ByteReader over DataView
│  └─ protocol.ts       # binary encode/decode for every message
├─ packages/server/     # Node + ws, 60 Hz authoritative simulation
│  ├─ index.ts          # WebSocket accept, handshake, room assignment
│  ├─ matchmaking.ts    # room registry, party keying, public room scoring
│  ├─ room.ts           # match + lobby state, tick loop, snapshot broadcast
│  ├─ player.ts         # per-connection state, loadout, respawn
│  ├─ lagcomp.ts        # position history ring buffer + rewind
│  └─ bots.ts           # server-side AI using the same movement code
└─ packages/client/     # Vite + Three.js
   ├─ main.ts           # boot, mode switching, the single WebGLRenderer
   ├─ net.ts            # socket, clock sync, snapshot buffer
   ├─ input.ts          # keyboard/mouse, pointer lock, keybinds
   ├─ predict.ts        # local prediction + reconciliation
   ├─ world.ts          # scene from map brushes, merged + contact-shaded
   ├─ props.ts          # round decoration as instanced primitives
   ├─ actors.ts         # buildCharacter() + remote player interpolation
   ├─ viewmodel.ts      # first-person weapon, recoil, ADS, sway
   ├─ weaponart.ts      # weapon silhouettes as inline SVG
   ├─ effects.ts        # tracers, impacts, muzzle flash, shake
   ├─ audio.ts          # every sound, synthesised through Web Audio
   ├─ hud.ts            # crosshair canvas, health, ammo, killfeed
   ├─ lobby.ts          # the lobby screen: roster, consent, invite
   ├─ lobbystage.ts     # the 3D staging room behind it
   ├─ menu.ts           # home screen, quick match / create / join
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

Six levels, 976 brushes, 2 432 props, twelve spawn points each. Collision geometry
is axis-aligned brushes only, and the renderer reads that same array — there is no
separate collision mesh to fall out of sync with what the player can see. Props are
the one thing drawn and not collided, which is why they get their own rules below.

Each map exists to make one argument about how a fight should go, and the set is
chosen so that no two make the same one:

| Map | Size | Brushes | Props | Rotation | The argument |
| --- | --- | --- | --- | --- | --- |
| `dustworks` | 76 m | 267 | 597 | FFA, TDM | Open courtyard around a raised centre, four enterable corner buildings with walkable roofs, two flanking alleys. The all-rounder, and the only map that never asks you to trade the middle for anything. |
| `foundry` | 48 m | 86 | 446 | FFA, TDM | Indoor hall whose central furnace breaks the centre sightline from *every* direction. Long shots exist only down the two side lanes, both overlooked from catwalks climbed at the far ends — so distance costs you the middle. |
| `overpass` | 68 m | 171 | 182 | FFA, TDM | A 44 m road deck on pillars: the highest ground and the longest sightline, reachable only from the two ends, with a gap in its parapet that anyone underneath can shoot up through. Strong to hold, survivable to lose. |
| `meridian` | 64 m | 134 | 239 | TDM | Mirror symmetric about one axis, two bases, all six of a side's spawns behind its own. The only map with a back line, a front, and a direction that means *forward*. |
| `cistern` | 40 m | 70 | 189 | FFA | A sunken floor inside a walkway ring that overlooks all of it. Built so a fight cannot be declined — which is what the Breacher and the Blade need and what the larger maps never give them. |
| `refinery` | 92 m | 248 | 779 | FFA, TDM | A place rather than an arena. Two process halls facing each other across a yard, joined by a pipe rack at 4.4 m that is a route and not scenery; a tank farm inside a 1 m bund on one flank, a loading dock under a gantry on the other. Twice the area of anything else, and the answer to a level being small. |

Symmetry is a fairness requirement rather than a style: four are rotationally
symmetric, Meridian and Refinery are mirror symmetric, and in every case the point
is that no spawn reaches the middle first.

**Rotation is per mode**, because the difference is not cosmetic. Meridian's
behind-the-base spawns are the whole point of it for teams and actively wrong for a
free-for-all, where twelve players with no teams would appear in two piles facing
each other. So it is in the team rotation only; the other five appear in both, in a
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

All six draw from one twelve-entry material table (`MATERIALS` in `maps.ts`) —
sand, concrete, rust, wood, metal, accent and glass, three darker variants, plus
red-oxide industrial paint and a pale warm `light` for bulbs and lit panels. The
last two exist because a palette of desaturated greys and browns needs one
saturated colour somewhere to look photographed rather than sculpted. Maps
differentiate themselves through which subset they use plus their own sky and fog:
Foundry and Cistern close the fog in to 82 m and 64 m because they are interiors,
Overpass pushes it to 190 m because its sightline is the point.

### 5.1 Props — round geometry that is not collision geometry

A brush is a box because the brush array *is* what bullets stop on, and a level of
nothing but boxes reads as a pile of boxes however well it is laid out: there is no
curve anywhere in it. So `GameMap` carries a second array. A `Prop` is a cylinder,
cone, dome, sphere or torus with a position, a radius, a length, an axis and a
material, drawn and almost never collided — pipes, barrels, vessels, flanges, valve
wheels, lamps, ladder rungs, handrails, roof plant, skyline tanks.

That makes every prop a potential lie: decoration a player reads as cover and dies
behind, or as a step and walks into. Four grounds make one legal, checked for every
prop on every map by `propPlacementIssue` and asserted by the suite:

1. **It carries its own collider.** A prop may set `solid`, which inscribes a box
   inside it and appends that box to the collision set. Cylinders only, radius
   at most `SOLID_PROP_MAX_R` (1.6 m) — a cylinder is the one shape whose inscribed
   box is close enough to its silhouette that the discrepancy stays under the
   step-up height and nobody can feel it.
2. **It is backed.** Its bounding box lies inside a brush's or a solid prop's, to
   within `PROP_FLUSH` (0.3 m). Flush detail on a wall face cannot be mistaken for
   cover, because the wall behind it *is* cover.
3. **It is out of reach.** Its bottom is at least `PROP_OVERHEAD` (2.6 m) above the
   highest brush surface beneath it. Ceiling trusses, hanging lamps and roof pipes
   live here. The clearance is measured against brushes only, deliberately: a
   vessel's domed head stands 0.62 r proud of the cylinder it caps, so counting
   solid-prop tops as floors would outlaw the most useful shape in the set.
4. **It is outside.** Entirely past the perimeter on some axis, i.e. skyline. A
   distant tank farm cannot mislead anyone about cover inside the arena.

Anything that should read as cover is authored as a brush instead. The check reports
which ground failed and by how much, which is what makes it usable: Refinery arrived
with forty violations — pipes overhanging a bund wall by 30 cm, a lamp at 2.59 m
over a stair tread where the rule asks 2.60, a ladder in open air with nothing
behind it — and each message named the governing brush.

### 5.2 Rendering

Brushes merge into one buffer geometry per material, so a 248-brush level is nine
draw calls. Faces carry per-normal shading and a small position-derived tint, so the
flat low-poly look still reads three-dimensionally without textures, and two
identical crates never look stamped from a mould.

On top of that, vertical faces split into at most three horizontal bands and take a
baked gradient: a squared falloff darkening the bottom 60 cm toward the floor, and a
brighter lip on the top 16 cm. Both clamp to a fraction of the brush's own height,
because a 35 cm coping course darkened over its bottom 60 cm is not a shadow under a
coping, it is a black stripe where a coping was. This is the largest realism gain
available with no texture data at all — the eye locates an edge by the shadow under
it rather than by the line itself. It roughly doubles the vertex count at the same
draw-call count, so the merge computes its buffer size exactly rather than bounding
it: writing past a `Float32Array` is silently dropped in JS, and a mismatch would
appear as missing faces rather than as an error.

Props go through `InstancedMesh`, grouped by kind, axis, material, segment count and
tube ratio — 779 props in about sixty draw calls, every pipe of a given gauge in a
given metal being one of them. Each group holds one shape built at radius 1 and
length 1 with its axis rotation baked into the geometry, so the per-instance
transform stays a scale and a translate read straight off the prop's own numbers.
Segment counts bucket by radius (5, 9, 15, 21): a 3 cm ladder rung and a 1 m vessel
do not need the same silhouette budget, and bucketing rather than scaling
continuously is what keeps the group count low. Ring tube ratios are floored, never
rounded, so a drawn ring can only ever be thinner than the box its placement was
proven legal against.

## 6. Game modes

- **Free-for-all** — first to 30 kills, 10-minute cap.
- **Team deathmatch** — two teams, first to 75.
- Bots fill empty slots in a **public** room so the game is always playable solo, and
  are removed as humans join. Bots run through the identical movement and weapon code
  paths, with reaction delay and aim error tuned per difficulty. A **private** room
  gets none unless its host asks for them: it is somebody's group, and filling it
  with strangers-shaped robots the moment the first friend connects is what a player
  reports as random bots joining their game.
- **Parties** — a shared join code. Typing the same code lands everyone in the same
  room *and on the same side*; leaving the field blank means "anywhere with space".
  Codes are generated at five characters and accepted up to twelve, drawn from a
  32-symbol alphabet with `I`, `O`, `0` and `1` removed, because a code's whole job
  is to survive being read aloud and typed by somebody else. The alphabet, both
  bounds and the canonicaliser live in `shared` so the two ends cannot disagree
  about what a code means. A `?party=CODE` link prefills the field on load — prefill
  and not auto-join, because the name and the weapon are still the player's to pick.
- **Room phases** — `LOBBY → LIVE → OVER`, held on the room and mirrored to clients
  in an `S_LOBBY` packet at 4 Hz. A private room opens in `LOBBY`, a public one in
  `LIVE`, since pressing PLAY means "a game, now" and a waiting room would be a
  worse answer than the match already running. `OVER` holds the result for eight
  seconds; a party then returns to `LOBBY`, a public room straight to `LIVE`.
- **The lobby is a live map, not a screen.** Players are spawned and can move and
  shoot while they wait. The clock is *pinned* rather than paused — `matchEndsAt` is
  pushed forward every tick, which looks identical on screen and leaves one
  timestamp to reason about — and the scoreline is wiped when the round begins, so
  warming up costs nothing and there is no advantage in farming your friends first.
  The alternative, a "connected but not in the world" state, would have reached into
  spawning, snapshots and damage for no visible gain.
- **Host** — the first human in the room, reassigned to the longest-standing
  remaining human the instant they leave, and `0` when nobody is left so an empty
  party room can be re-hosted by whoever comes back. Never a bot: a bot could not
  press Start, and a lobby waiting on a decision nothing will make is a deadlock.
  A departed host's countdown keeps running, because the others were already
  promised a start.
- **Starting** — the host presses Start for a 5 s countdown, and pressing it again
  cancels, so a misclick is not a commitment. A full ready-up starts the match on
  its own once at least two humans are present; below that the sole occupant of a
  room would be unable to wait in it. `C_LOBBY` carries an action and a value only;
  the room checks authority and phase and silently drops anything else, because the
  client is whatever connected to the socket.

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
- **Pre-match lobby** — a full-screen staging room. Everyone in the room stands on a
  platform in 3D, each holding their own weapon, with a nameplate, a ready tick and a
  crown on the host; over it, HTML chrome carries mode and map, the invite code with a
  copy-link button, the ready tally, the host's bot switch, a line of plain text
  saying what the room is waiting for, Ready, Start and Leave. Seeing the other
  players *as players* is the entire point — a roster of names does not answer the
  question anyone actually asks before a match, which is who is here. It sits in the
  menu z-band rather than the HUD's, and pointer lock is declined while it is open,
  because it is a surface built to be clicked. It is a screen on the client only: the
  server still has the room in its lobby phase with everyone spawned on the map
  behind it, so nothing about spawning, snapshots or damage needed a special case.

Visual language: translucent dark panels, `#e2e2e2` text, condensed-bold headings,
white fills that step up in alpha on hover, `scale(0.94)` on press.

## 8. Milestones

| # | Scope | Status |
|---|---|---|
| **M1** | Monorepo, shared sim, authoritative server, prediction + reconciliation + interpolation + lag comp, one map, Ranger + Sidearm, bots, HUD, killfeed, scoreboard, menu shell | **done** |
| **M2** | Full weapon roster, recoil/spread/ADS tuning, melee, damage falloff, hitmarkers, damage numbers | **done** |
| **M2.5** | Layered procedural gunshots, per-weapon voicing, resupply-on-kill, detailed weapon and character models, firing visuals, sniper scope, view-model animation | **done** — pulled forward from M5 after playtest |
| **M3** | Four more maps with a per-mode rotation, TDM, private lobbies with join codes, match flow and end-of-round | **done** |
| **M3.5** | Room phases, pre-match lobby with roster and invite link, host and countdown, bots as a host-side opt-in | **done** — bug report, not a planned milestone |
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

**Parties** are a named room. Routing them needed no protocol change at all,
because *"I typed a code"* versus *"put me anywhere"* was already expressible as a
non-empty versus empty `room` field in the join message.

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

### What M3.5 delivered

Not a planned milestone. It came from a report with two halves: random bots keep
joining my game, and there should be a lobby you gather in before the match.

**Bots were a missing idea, not a broken one.** `manageBots` topped every room up to
eight whenever a human was present, and nothing anywhere expressed whether the
people in the room wanted that. In a public lobby it is exactly right — a solo
player pressing PLAY needs opponents, and an empty map is a worse first impression
than robots. In a private room it is somebody's group of friends being packed with
strangers-shaped bots they never asked for and could not decline. So the room now
carries `botsEnabled`, defaulting to `!party`, exposed as a host-only switch.
Turning it off retires the bots already present through the *same* branch as an
empty room, deliberately: it has to be immediate, because the player who just
turned it off is looking at the roster while it happens.

**The lobby is a phase, not a screen.** `PHASE.LOBBY | LIVE | OVER` lives on the
room, and a private room opens in `LOBBY` while a public one opens in `LIVE`.
Players in a lobby are spawned on the map and can move and shoot; the clock is
pinned by pushing `matchEndsAt` forward each tick, and `resetMatch` wipes the
warm-up scoreline when the round begins. The alternative — a "connected but not in
the world" state — would have reached into spawning, snapshots, damage and the
scoreboard, and bought nothing a player would notice.

The state goes out as its own `S_LOBBY` packet at 4 Hz rather than four more fields
on `MatchMsg`: most rooms are public, never leave `LIVE`, and would carry those
bytes forever. It ticks faster than the roster and match packets because it carries
the countdown, and a number counting down in half-second steps reads as a stutter
rather than a clock. Inbound, `C_LOBBY` is an action plus a value, and every
question of *may you* and *does this make sense now* is answered server-side; a
client asking to start a match already in progress is not an error to report, just
nothing.

**Two bugs surfaced on the way.** The scoreboard was reading roster entries against
the *actor* flag table — bot is bit 6 there and bit 0 in the roster — so every test
came back false and bots had silently stopped being labelled and the dead stopped
being dimmed. That is what the named `RF` table and a decode-the-real-packet test
exist to prevent. And a public room's post-match reset restored the scores but not
the phase, so it played on while still reporting `OVER`, disagreeing with its own
`isOver`; the shared reset leaves the phase to its three callers, and one of them
had forgotten to set it. The lobby test suite caught that one on its first run.

**The smoke test now plays the phase rather than skipping it.** It used to join a
room and assume it was already in a match, so `S_LOBBY` would have arrived as an
unknown tag and the bot-free room it now lands in would have failed its
other-players checks. It opens a private room under a generated code and drives the
gathering from the outside: bots off until asked, host on the roster, no countdown
without a Start, the countdown handing over to a live match, movement while
gathering, and the clock pinned then running. Each step waits for the state proving
the last one landed, so the sequence is paced by the server's packets and a step
that never happens is a timeout that names it.

Still zero asset files. The panel is markup, CSS and one inline SVG. It was replaced
by a full screen in M3.6, and the sentence above — *the lobby is a phase, not a
screen* — now holds only on the server side, which is the half of it that mattered.

### What M3.6 delivered

Four reports, one round of work.

**Party rooms were keyed by mode as well as code**, so two friends sharing a code and
picking different modes got two rooms, two maps and no sight of each other. Rooms are
now keyed `party:CODE` alone: the first player in sets the mode and the map, everyone
else adopts them. The client applies `welcome.mode` rather than the mode it asked for,
because a joiner who adopts a room's mode has to render its teams or the tinting is
wrong for exactly the players who reported the bug. Public rooms stay
`pub:MODE:NAME` and are now *scored* rather than first-fit — most humans first, fewest
bots as the tie-break — so quick match prefers real people.

**PLAY was overloaded.** It sent the persisted room code, so once a code existed every
press rejoined that private room forever, which is also how players ended up in a
stale room already live and full of bots. It is now three explicit intents — quick
match, create lobby, join by code — and no path uses the stored code implicitly.

**Consent was advertised and not enforced.** `START` checked only that the sender was
the host, and the room auto-started on its own besides. It now requires the host *and*
every human ready, the auto-start is gone, and an in-flight countdown cancels when
anyone un-readies or a new human joins — otherwise a late arrival is dragged into a
match they never agreed to, which is the same bug in a different coat. `LF.CAN_START`
goes out on the lobby packet so the client can disable the button with a reason
instead of re-deriving authority the server already owns.

**The lobby became a screen.** A full-screen staging room: a procedural platform, one
character rig per roster slot holding that player's own weapon, nameplates and ready
ticks and a host crown drawn as canvas textures. The character build was extracted
from `Actor` into a shared `buildCharacter`, so the body in the lobby and the body in
the match are the same definition rather than two that drift. It owns a scene and a
camera but no renderer — `main.ts` keeps the single `WebGLRenderer`, one shader cache,
one shadow map — and it renders at ~30 fps like the menu. Two consequences of the
server still simulating you behind it are handled explicitly: pointer lock is declined
while it is open (a staging room has buttons, and a locked pointer cannot press them),
and movement input is zeroed (otherwise you spend the lobby walking around blind and
can be standing in a wall when it closes).

**And the maps became places.** The report was blunt — blocks with gaps, small,
unfinished — and it was three separate problems. Size: Dustworks grew from 60 m to
76 m with real content in the new ring, and `refinery` is 92 m, twice the area of
anything else. Detail: a level of nothing but boxes reads as boxes however it is laid
out, which is why the props layer and its four placement rules exist (§5.1) — 2 432 of
them across six maps, none allowed to lie about cover. And finish: baked contact
shading on every vertical face (§5.2), plus coping bands and piers on every perimeter
wall and a skyline beyond it on the outdoor maps, because the thing that reads as
*unfinished* is an edge with no shadow under it and a boundary with nothing past it.

Still zero asset files. Every prop is a three.js primitive, every shade is a vertex
colour, and the staging room's nameplates are drawn into a canvas at runtime.

Outstanding from the same plan: the weapon designations and viewmodel proportions,
bots yielding their slot to an arriving human, adaptive bot skill, and the sprint
feedback pass.

## 9. Verification

- `npm run dev` — server on `:8787`, client on `:5173`.
- Counts, for reference: `npm test` is 1267 assertions (1157 shared, 110 server)
  and `npm run smoke` is 52 against a live server.
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
- Props: all 2 432 of them are walked against the four placement grounds in §5.1.
  A prop is drawn and not collided, so an illegal one is a lie about cover that no
  runtime check can see and no screenshot shows — it surfaces as a player dying
  behind a barrel. Each map is also asserted to carry a floor of props scaled to its
  own size, because the failure this whole layer exists to fix is a level looking
  unfinished, and an empty `props` array passes every other check in the suite.
- Rooms: `npm run test:server` drives team assignment, room selection and the lobby
  headlessly. None of it is reachable from the shared suite, and none of it is
  reachable from one socket — the whole point of a party is the *second* one. The
  lobby checks read the real roster, match and lobby packets back through a fake
  socket where the assertion is about what a player sees, which is how the
  roster-flag bug was caught from the server side.
- End to end: `npm run smoke` opens a private room over a real WebSocket, gathers in
  its lobby, starts the match and plays — the one check that the phase machine, the
  new packets and the transport agree with each other outside a test harness.
