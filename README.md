# ONESHOT.io

A browser multiplayer first-person shooter. Three.js client, authoritative Node
server, one shared simulation compiled into both.

No asset files ship with this project. Every model, texture, icon, wordmark and
sound is generated at runtime from code — buildings from box geometry, the
wordmark from inline SVG, gunfire from oscillators and noise buffers through the
Web Audio graph. The whole game is source.

```
npm install
npm run dev        # server on :8787, client on :5173 — open the client
```

Node 20 or newer. Nothing else to install, no database, no build step for
development.

---

## What this is

An original game built to the design conventions of the browser-FPS cohort
(Krunker, Shell Shockers, 1v1.lol): instant play with no download, a lobby you
join in one click, bots filling the server until humans arrive, and a match loop
short enough to finish on a break.

The research behind those conventions is in [`docs/RESEARCH.md`](docs/RESEARCH.md),
which separates what was **[VERIFIED]** by observation from what is **[DESIGNED]**
here to fit. The build specification — every constant, the netcode contract, the
map layout, the milestone plan — is in [`docs/SPEC.md`](docs/SPEC.md).

The name, wordmark, palette and all content are this project's own. See
[§9 of the research document](docs/RESEARCH.md) for the position on that. Branding
lives in one file, `packages/shared/src/brand.ts`; change four strings and the
game re-brands everywhere.

---

## Architecture

```
packages/shared     the simulation — imported by BOTH client and server
packages/server     authoritative game loop, WebSocket transport, bots
packages/client     rendering, prediction, input, UI, procedural art and audio
```

`shared` is the important one. Movement, collision, weapon ballistics, hitscan
tracing and the wire codec live there and are compiled into both halves from the
same source — not duplicated, not ported. That is what makes client-side
prediction possible: the client runs the server's physics, not an approximation
of it.

| Module | Responsibility |
| --- | --- |
| `constants.ts` | Every tunable number, defined exactly once |
| `math.ts` | Vectors, angle wrapping, the yaw/pitch convention |
| `collision.ts` | Axis-separated collide-and-slide, step-up, ray/AABB |
| `movement.ts` | Ground and air acceleration, friction, jump, crouch |
| `weapons.ts` | Weapon table, damage falloff, spread and recoil models |
| `combat.ts` | Hitbox construction and hitscan tracing |
| `maps.ts` | Map definition → collision brushes and spawn points |
| `bitio.ts` | Byte reader/writer with quantised angle and float helpers |
| `protocol.ts` | Every message, encode and decode side by side |

---

## Netcode

The server owns the truth. The client never tells the server where it is — only
which buttons were held and where it was looking.

| | |
| --- | --- |
| Simulation | 60 Hz, fixed timestep, server-authoritative |
| Snapshots | 20 Hz, binary, only what changed matters |
| Interpolation delay | 100 ms for remote players |
| Prediction | Client simulates locally, replays unacknowledged inputs |
| Lag compensation | Server rewinds to `now − rtt/2 − interp` to judge shots |
| Position history | 1 s ring buffer per player, 500 ms maximum rewind |

**Prediction and reconciliation.** Each input command carries a sequence number.
The client simulates it immediately and keeps it. Snapshots carry the last
sequence the server processed; on arrival the client rewinds to the server's
authoritative state and replays every input newer than that ack. If the replayed
result disagrees with what it had shown, the difference is absorbed as a decaying
*visual* offset rather than a teleport — the player sees a smooth correction over
a few frames instead of a snap. Only an error large enough to be a genuine
desync snaps.

This only works if the two simulations agree exactly. The client replicates the
server's aim-down-sights integrator, its spread model, and the *order* of
operations within a tick. A test asserts determinism bit-for-bit, because a
divergence of any size shows up to the player as rubber-banding.

**Lag compensation.** A hitscan shot is judged against where the target *was*
from the shooter's point of view, reconstructed from the position history using
their measured round-trip time and the interpolation delay they render at. So
leading a target is not required, and a player who is hiding behind cover on
their own screen cannot be shot there.

**Wire format.** Hand-rolled binary, no JSON on the hot path. Angles quantise to
16 bits, timers to milliseconds, impact normals to signed bytes, buttons to a
6-bit mask. Input batches are sent redundantly — the newest eight commands each
tick — so a dropped packet costs nothing. A full snapshot of a busy server fits
comfortably under 700 bytes.

---

## Content

**Five maps, 520 collision brushes, twelve spawn points each.** Every one is
generated from a compact declarative description of axis-aligned boxes, and the
renderer and the collision solver read that same array — so the geometry you can
see and the geometry you can walk into cannot drift apart. Each map is built
around one argument about how a fight should go:

| Map | Size | Brushes | In rotation | The idea |
| --- | --- | --- | --- | --- |
| **Dustworks** | 60 m | 171 | FFA, TDM | Raised centre under a pillar, flanking buildings, catwalks. The all-rounder. |
| **Foundry** | 48 m | 86 | FFA, TDM | Indoor hall around a furnace that blocks the middle from every side. Distance costs you the centre. |
| **Overpass** | 68 m | 125 | FFA, TDM | A 44 m road deck on pillars — the long shot, but reachable only from the ends and shootable through a gap in its parapet. |
| **Meridian** | 64 m | 88 | TDM | Mirror-symmetric, two bases, six spawns behind each. The only map with a direction that means *forward*. |
| **Cistern** | 40 m | 50 | FFA | A sunken pit inside a raised ring. Built so a fight cannot be declined. |

The rotation is per mode, because the difference is not cosmetic. Meridian puts
all six of a side's spawns behind that side's own base — correct for teams, and
actively wrong for a free-for-all, where twelve players with no teams would
appear in two piles facing each other. So it appears in the team rotation only,
and the suite enforces the boundary with a measurable rule rather than a comment:
an FFA map keeps its two closest spawns more than 8 m apart, and Meridian's are
5.5 m.

A room picks its map when it opens, not mid-match, because `MatchMsg` carries no
map id and a running match therefore has no way to tell connected clients the
level changed. Public lobbies walk the rotation in order; a party derives its map
from a hash of its code, so *"meet me on FXTRT"* names a level as well as a room.

| Weapon | Slot | Damage | RPM | Head | Full damage to | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Ranger | Primary | 28 | 640 | ×1.7 | 34 m | Assault rifle, the all-rounder |
| Vector | Primary | 18 | 900 | ×1.6 | 18 m | Fast, falls off early |
| Breacher | Primary | 14 ×9 | 75 | ×1.25 | 9 m | Shotgun, nine pellets |
| Longshot | Primary | 100 | 45 | ×1.5 | 200 m | One shot, one kill to the body |
| Sidearm | Secondary | 26 | 400 | ×1.8 | 16 m | Always available |
| Blade | Melee | 55 | 120 | — | 3 m | Two hits from the front, one from behind |

Damage holds at full to `falloffStart`, ramps down linearly to a floor at
`falloffEnd`, and never reaches zero.

**Modes.** Free-for-all to 30 kills, team deathmatch to 75, ten-minute time
limit either way. Bots keep the lobby at eight until real players fill it.

**Parties.** A party is a named room and nothing else — no lobby screen, no
invite list, no state to synchronise. Type the same code as your friends and the
server puts you in the same match on the same side; leave the field blank and you
go wherever there is space. This needed no protocol change at all, because *"I
typed a code"* versus *"put me anywhere"* was already expressible as a non-empty
versus empty `room` field in the join message.

Codes are drawn from a 32-symbol alphabet with `I`, `O`, `0` and `1` removed,
because a code's whole job is to survive being read aloud and typed by somebody
else. Both ends canonicalise with the same shared function — lower case folds up,
so a caps-lock key cannot split a group in half.

Friends stack onto one side rather than balancing, which is the opposite of what a
public lobby wants and the entire point of a party. The stacking stops at half the
lobby, so a large private group self-balances into a real match instead of a
firing squad; and because bots keep using plain balance, two friends in a
six-player match get a bot teammate and an even 3v3 rather than a 2v4.


---

## Scripts

| | |
| --- | --- |
| `npm run dev` | Server and client together, both watching for changes |
| `npm test` | Both suites below |
| `npm run test:shared` | Simulation, protocol, maps and weapon tables |
| `npm run test:server` | Team assignment and room selection, headless |
| `npm run smoke` | Plays a few seconds against a running server, headless |
| `npm run typecheck` | All three workspaces, strict, no emit |
| `npm run build` | Production client bundle into `packages/client/dist` |
| `npm start` | Server alone — also serves `dist`, so one process is the game |

`PORT` and `HOST` are read from the environment; the defaults are `8787` and
`0.0.0.0`. In development the client talks to a same-origin `/ws` that Vite
proxies to the server, so the client code has no notion of which environment it
is in.

---

## Tests

`npm test` runs 1115 assertions with no test framework — a `check` function, a
seeded RNG, and one file per package. It covers the things that fail *silently*:

**The collision solver.** A 10 000-tick fuzz drives a player through the map on
seeded pseudo-random input and asserts after every single tick that the player
box does not overlap any of the 171 brushes and has not escaped the arena. A
collision escape has no symptom until someone falls out of the world or shoots
from inside a wall. Intent changes in bursts rather than per tick, because fresh
random input at 60 Hz averages out to standing still — and the run asserts its
own coverage (a minimum share of grounded ticks, a minimum of airborne ticks) so
it cannot pass by never having moved.

**The wire codec.** Every message is encoded, decoded, and then *re-encoded*, and
the two byte strings are compared. That is deliberate: comparing decoded fields
against expectations misses the failure mode a hand-rolled codec actually has —
a field added to the encoder and forgotten in the decoder. A re-encode catches
it, because the bytes stop matching.

Also covered: hitscan against cover, hitboxes and range limits; the angle
convention; crouch not releasing into a ceiling; weapon-table coherence and
monotone damage falloff; and the determinism that prediction depends on.

**Every map's spawn points, on every map.** Each one is checked for room to stand,
for resting on solid ground rather than floating over the pit it overlooks, and
for *facing the right way* — the dot of its forward vector against the direction
to the centre has to be positive. That last one exists because a backwards spawn
is perfectly legal geometry: nothing at runtime complains, the level looks correct
from above, and the only symptom is players dying a second after they appear. Two
of the four new maps had exactly that bug before the check went in, which is why
the yaw convention now lives in one `faceCentre` helper instead of being
re-derived per map.

The rotation is asserted too, since a map can be fully authored, tested and
completely unreachable if nothing names it: every map has to appear in a rotation
or it does not exist as far as a player is concerned.

The melee numbers get their own assertions, because they are a *coupling* that
nothing at runtime would complain about: the knife's damage, the backstab damage
and the maximum health live in different places, and the design contract — two
hits from the front, one from behind — only holds while all three agree. Were
that to drift, the knife would quietly stop killing and no error anywhere would
say why.

Two more couplings of the same kind are asserted for the same reason. **The ammo
economy:** a kill returns `AMMO_REFILL_MAGS_PER_KILL` magazines of reserve, and
that only works inside a window — too little and the reserve is still a one-way
countdown that strands whoever is winning with a knife, enough to refill it
outright and ammunition stops being a resource. **The sound model:** each
weapon's percussive length must finish inside its own cycle time. A shot longer
than the gap between shots stops being a thump and becomes a pitched note, and
consecutive notes stack into a chord — which is exactly what made sustained fire
buzz before the table was voiced. Both failures are inaudible to any runtime
check and obvious within one second of play.

The suite deliberately asserts that the byte writer's `take()` returns an
independent copy rather than a view. If it returned a view, every re-encode
comparison in the file would be a buffer compared with itself, and the whole
protocol section would pass while testing nothing.

### `npm run test:server`

Two server decisions a player feels directly, neither of which the shared suite
can reach and neither of which the smoke test can see — because the smoke test
connects one socket, and the entire point of a party is what happens to the
*second* one.

**Which side of a team match you land on.** This used to send friends to opposite
teams every single time. Balancing an empty room puts the first player on a
coin-flip side and the second on whichever side is emptier — which is always the
other one. Playing with a friend was impossible by construction, and it cost
nothing at runtime to be that broken: no error, no dropped packet, just the wrong
match. The checks now pin both halves of the fix — a party stacks onto one side,
and stops at half the lobby so a large group still gets an opposition.

**Which room you land in.** That a party room is never handed to a stranger who
pressed Play; that the same code returns to the same room and the same map; that a
full public lobby overflows into a new one rather than refusing the connection;
and that the empty-room sweep never deletes a room somebody is playing in.

Room selection was moved out of `index.ts` to make this possible at all — that
file opens a socket and starts the tick as import-time side effects, so every
decision in it was unreachable from a test as long as it stayed there.

### `npm run smoke`

Unit tests cannot see integration failures: every piece can be individually
correct while the transport, the room loop or the tick order is wrong. So with a
server running, `npm run smoke` connects over a real WebSocket and plays for a
few seconds — joins, holds forward, fires, and asserts from the stream that the
welcome names it, that snapshots arrive near 20 Hz, that the input acknowledgement
advances (without it, prediction would replay every input ever sent), that held
input actually moved it, that other actors are alive and moving, and that firing
consumed ammunition.

It also fires hostile requests at the HTTP surface. That handler runs
synchronously inside Node's parser, so anything it throws is an uncaught
exception that ends the process — every room, every player. `GET /%zz` did
exactly that, from one unauthenticated request, until it was fixed; the smoke
test now asserts a 400 and that the server is still answering afterwards.

`SMOKE_URL` points the socket somewhere else, and `SMOKE_HTTP` points the HTTP
checks independently — useful for driving the game through the Vite dev proxy
while still testing the game server's own HTTP surface directly.

---

## Status

**M1 — the core loop.** Complete: authoritative movement and shooting, client
prediction and reconciliation, lag-compensated hitscan, bots, both modes, the
menu, the HUD, procedural art and audio.

**M2 — combat.** Complete in scope: the full six-weapon roster, per-weapon
recoil, spread and aim-down-sights models shared by both simulations, melee with
the backstab, distance falloff, hitmarkers, and floating damage numbers.

Damage numbers are anchored to a point in the world rather than to the crosshair,
so the number appears over the body it belongs to — which is the difference
between knowing *something* took damage and knowing *which* target did. Repeated
hits on one victim merge into a single number that counts up: the shotgun fires
nine pellets at once and the Vector fires fifteen rounds a second, and one number
per hit would be nine numbers on a single pixel, or fifteen a second that each
fade before they can be read.

**M2.5 — feel.** The first playtest came back with one clear verdict: the gunfire
sounded bad. That moved audio from last in the plan to first. Gunshots are now
built as five layered elements per shot rather than a tone with an envelope, each
weapon is voiced from a physical description of itself rather than four mixer
values, reserve ammunition refills on a kill instead of only on respawn, and both
the weapon and character models gained per-class detail.

Firing then got the same treatment. Tracers are camera-facing quads rather than
lines, because `LineBasicMaterial.linewidth` is silently ignored by every WebGL
driver and a one-pixel hairline was never going to read at 1080p. The muzzle
flash is sized and timed per weapon from the bore and the charge behind the shot,
with a hot core, a cone of gas down the bore and a decay that finishes inside the
weapon's own cycle time. Cases eject from a port that moves with the gun. Enemy
fire now flashes at its own muzzle, which is what tells you where a shooter is
standing — a tracer only tells you where a bullet went. World particles were a
hundred times too large, having been quoted in centimetres and consumed as
metres, and they now scale with the FOV so a scope magnifies distant hits instead
of shrinking them. The sniper scope was rebuilt from a hard vignette and two
hairlines into a duplex reticle on a soft-edged lens. See
[`docs/SPEC.md`](docs/SPEC.md) §8 for what changed and why.

**M3 — content.** Four more maps and parties. Foundry, Overpass, Meridian and
Cistern take the map count from one to five, with a per-mode rotation and a
creation-time choice per room; parties are a shared code that puts friends in the
same match on the same side.

Two of the new maps had inverted spawn yaws — legal geometry, correct from above,
and fatal a second after appearing — which is why the convention now lives in one
helper and why every spawn on every map is checked for facing the right way. The
teammates work turned out to be two bugs rather than a missing feature: team
assignment sent friends to opposite sides every time, and the client sent a
hardcoded room name, so every player in the world shared one twelve-slot lobby,
the overflow path never ran, and the thirteenth connection was refused. Both are
now pinned by `npm run test:server`.

Typecheck is clean on all three workspaces, both suites are green at 1115
assertions, and the smoke test passes against a live server. Those confirm the code
is coherent and self-consistent — they cannot confirm it sounds or looks right. The
audio rewrite in particular is a claim about what a human ear will hear, and it
has not been heard: the diagnosis (a 128 ms pitched sweep on a 94 ms cycle,
stacking into a chord) is specific and testable, but whether the replacement
actually reads as a gunshot needs someone at a keyboard with the sound on. Same
for the models, the firing visuals and the game feel — and now for the four new
maps, whose layouts are argued in their own doc comments and measured against the
movement constants, but which nobody has actually walked. Remaining milestones
(M4 meta, M5 polish) are in [`docs/SPEC.md`](docs/SPEC.md) §8.
