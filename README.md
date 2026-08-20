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
(Krunker, Shell Shockers, 1v1.lol): instant play with no download, a public match
you join in one click, bots filling it until humans arrive, a private lobby to
gather a group in first, and a match loop short enough to finish on a break.

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

**Six maps, 976 collision brushes, 2 432 props, twelve spawn points each.**
Every one is generated from a compact declarative description of axis-aligned
boxes, and the renderer and the collision solver read that same array — so the
geometry you can see and the geometry you can walk into cannot drift apart. Each
map is built around one argument about how a fight should go:

| Map | Size | Brushes | Props | In rotation | The idea |
| --- | --- | --- | --- | --- | --- |
| **Dustworks** | 76 m | 267 | 597 | FFA, TDM | Raised centre under a pillar, flanking buildings, catwalks. The all-rounder. |
| **Foundry** | 48 m | 86 | 446 | FFA, TDM | Indoor hall around a furnace that blocks the middle from every side. Distance costs you the centre. |
| **Overpass** | 68 m | 171 | 182 | FFA, TDM | A 44 m road deck on pillars — the long shot, but reachable only from the ends and shootable through a gap in its parapet. |
| **Meridian** | 64 m | 134 | 239 | TDM | Mirror-symmetric, two bases, six spawns behind each. The only map with a direction that means *forward*. |
| **Cistern** | 40 m | 70 | 189 | FFA | A sunken pit inside a raised ring. Built so a fight cannot be declined. |
| **Refinery** | 92 m | 248 | 779 | FFA, TDM | Two process halls facing each other across a yard, joined by a pipe rack you can walk. A place rather than an arena. |

Nothing in the table is loaded from disk, and that constraint is what shapes all
six of them. A brush is a box because the brush array *is* the collision
geometry, and a level of nothing but boxes reads as a pile of boxes however well
it is laid out — there is no curve anywhere in it. So there is a second array of
round decoration: pipes, barrels, vessels, domes, flanges, valve wheels, lamps,
ladder rungs, handrails. It is drawn and almost never collided, which makes it a
lie waiting to happen — a barrel you take cover behind and die anyway. Four rules
keep it honest, and every prop on every map is checked against them by the suite:
it declares its own inscribed collider, or it is flush to a brush, or it is 2.6 m
clear of anything standable, or it is beyond the perimeter and part of the
skyline. Forty props on Refinery failed on the first run, every one of them for a
reason that would have read as a bug in a match.

The other half of not looking like boxes is shading. Vertical faces are split
into horizontal bands, darkened toward their base and given a bright lip along
their top edge, all baked into vertex colours at load. The eye locates an edge by
the shadow under it rather than by the line itself, so this does more for how
finished a level looks than any other change available without a single byte of
texture data.

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
limit either way. Bots keep a *public* lobby at eight until real players fill it —
a private one stays empty until its host asks for them.

**Parties.** A party is a named room. Type the same code as your friends and the
server puts you in the same match on the same side; leave the field blank and you
go wherever there is space. This needed no protocol change to route, because *"I
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

**The pre-match lobby.** A private room opens in a gathering phase rather than a
match, because the people in it arrive one at a time and somebody has to still be
there when the last of them loads. What you see is a staging room: everyone in the
room standing on a platform in 3D, holding their own weapon, with a nameplate, a
ready tick and a crown on the host. Seeing the others *as players* is the point of
it — a list of names does not answer the question anyone asks before a match, which
is who is here. Server-side it is a phase and not a screen, so everyone really is
spawned on the map behind it, with the clock pinned and the scoreline wiped the
moment the round begins; the client just declines pointer lock and zeroes movement
while the room is open, since a screen with buttons on it cannot also be a mouse
look.

The room has a host — whoever arrived first, reassigned the instant they leave,
never a bot, since a bot could not press Start and the lobby would deadlock. Start
requires the host **and** every human ready. Being the host is permission to begin
once the room agrees, not permission to speak for it, and nothing else can begin a
countdown: the old auto-start on a full ready-up is gone, because a match starting
without anyone choosing to start it was the complaint. Pressing Start again cancels
the five-second countdown, so a misclick is not a commitment, and consent is
re-checked every tick rather than only at the press — un-ready with a second left,
or walk in with two seconds left, and the countdown stops. Without that, a late
arrival is dragged into a round they never agreed to, which is the same bug wearing
a different coat. When a party's match ends it returns to its own lobby to pick the
next thing; a public room rolls straight into the next round, because there is
nobody there to make a decision.

Bots are the host's switch and default to off, which is the fix for a specific
complaint: a private room used to fill to eight with bots the moment the first
friend connected, and there was no way to decline. Turning them off retires the
ones already there through the same path as an empty room, so it happens while the
player who asked for it is still looking. Public rooms are untouched — pressing
PLAY there means *"a game, now"*, and a waiting room would be a worse answer than
the match already in progress.

Authority for all of it is server-side. `C_LOBBY` carries an action and a value,
and the room decides whether the sender is allowed to and whether it makes sense
in the current phase; a client asking to start a match that is already running is
not an error to report, just nothing. State comes back as its own `S_LOBBY`
packet rather than four more bytes on the match packet, since most rooms are
public, never leave the live phase, and would carry them forever.


---

## Scripts

| | |
| --- | --- |
| `npm run dev` | Server and client together, both watching for changes |
| `npm test` | Both suites below |
| `npm run test:shared` | Simulation, protocol, maps and weapon tables |
| `npm run test:server` | Rooms, teams, hosts and the lobby, headless |
| `npm run smoke` | Gathers in a lobby, starts the match and plays, against a running server |
| `npm run typecheck` | All three workspaces, strict, no emit |
| `npm run build` | Production client bundle into `packages/client/dist` |
| `npm start` | Server alone — also serves `dist`, so one process is the game |

`PORT` and `HOST` are read from the environment; the defaults are `8787` and
`0.0.0.0`. In development the client talks to a same-origin `/ws` that Vite
proxies to the server, so the client code has no notion of which environment it
is in.

---

## Tests

`npm test` runs 1267 assertions with no test framework — a `check` function, a
seeded RNG, and one file per package. It covers the things that fail *silently*:

**The collision solver.** A 10 000-tick fuzz drives a player through the map on
seeded pseudo-random input and asserts after every single tick that the player
box does not overlap any of the 267 brushes and has not escaped the arena. A
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

**Every prop on every map, all 2 432 of them.** Props are round decoration and are
not collision geometry, which makes each one a potential lie: a barrel you take
cover behind and get shot through, a crate you try to climb and walk into. So each
one has to pass on one of four grounds — it carries its own inscribed collider, it
is flush against a brush that backs it, it is at least 2.6 m clear of the nearest
surface anyone can stand on, or it is beyond the perimeter wall and part of the
skyline. The check reports which ground failed and by how much, because that is
the difference between a two-second fix and an afternoon. Refinery arrived with
forty violations: pipes overhanging a bund wall by 30 cm, a lamp hung 2.59 m over
a stair tread when the rule asks 2.60, a ladder standing in open air with nothing
behind it. Every one of those would have read as a bug in a match and none of them
is visible in a screenshot.

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

Three server decisions a player feels directly, none of which the shared suite can
reach. The smoke test now sees the first socket's half of the lobby, but not these
— it connects one socket, and the entire point of a party is what happens to the
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

**Who is in your lobby, and who decided.** That a private room is empty of bots
until its host asks, that a public one still fills itself, that a guest asking for
either is ignored, and that turning bots off actually clears the ones already
there. That the host role is never vacant and never held by a bot. That the
countdown cancels, that the warm-up scoreline is wiped when the round begins, that
a full ready-up starts the match but a single player readying alone does not, and
that the ten minutes are still ahead after four spent waiting.

Two of those read the real packets back through a fake socket rather than
inspecting the room, which is what caught the roster-flag bug: the scoreboard was
testing roster entries against the *actor* flag table, where bot is bit 6 instead
of bit 0, so every test came back false and bots silently stopped being labelled.
Nothing throws when two flag tables drift apart; the only symptom is a label that
never appears. The lobby suite also caught a public room that played on while
still reporting `OVER`, because the shared reset deliberately leaves the phase to
its three callers and one of them had forgotten it.

Room selection was moved out of `index.ts` to make this possible at all — that
file opens a socket and starts the tick as import-time side effects, so every
decision in it was unreachable from a test as long as it stayed there.

### `npm run smoke`

Unit tests cannot see integration failures: every piece can be individually
correct while the transport, the room loop or the tick order is wrong. So with a
server running, `npm run smoke` connects over a real WebSocket and plays a room
from arrival to firefight — 52 assertions read entirely off the stream.

It opens a private room under a freshly generated code, so a second run of the day
cannot inherit the first run's match, and then walks the lobby: that the room opens
in `LOBBY` and knows it is a party, that bot fill is *off* and stays off until asked,
that the first one in is host and is marked as such on the roster, that asking for
bots fills the room with actors flagged as bots, and that no countdown starts on its
own. Then it works the consent gate from both sides rather than tiptoeing around it:
it presses Start while unready and confirms nothing happens — and confirms the press
was really sent, so the refusal is not vacuous — then readies up, watches
`LF.CAN_START` appear only *after* that, and presses Start again to get a countdown
that hands over to a live match. It also proves the two things that make the lobby a
phase on the server and not only a screen on the client: held input moves the player
while gathering, and the match clock stands still until the round begins, then runs.

Each step waits for the state that proves the previous one landed, rather than for a
number of milliseconds someone guessed — so the run is driven by the server's own
lobby packets, and a step that never lands is a timeout naming the step instead of a
hang. Once the match is live it re-takes its baselines and plays: that snapshots
arrive near 20 Hz, that the input acknowledgement advances (without it, prediction
would replay every input ever sent), that held input moved it, that the round began
on a full clock, that other actors are alive and moving, and that firing consumed
ammunition.

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

**M3.5 — the lobby.** A private room now gathers before it plays, with a roster,
an invite link, a host who starts it and a cancellable countdown, and bots off
unless the host wants them. That last part is the fix for a plain complaint —
random bots joining a game nobody invited them to — and it was a missing idea
rather than a broken one: the room filled itself to eight whenever a human was
present and had no notion of anybody's consent. Public rooms are untouched, since
pressing PLAY there means *"a game, now"*.

The lobby is a full-screen staging room: a procedural platform, one character rig
per roster slot standing on it holding that player's own gun, nameplates and ready
ticks and a host crown overhead. Behind it the server is still simulating the room
in its lobby phase, which is what avoided inventing a "connected but not in the
world" state — that would have reached into spawning, snapshots and damage. The
client simply declines pointer lock and zeroes movement input while the screen is
up, because a staging room has buttons on it and a locked pointer cannot press
them.

**M3.6 — the maps as places.** Six maps, 976 brushes and 2 432 props, against a
plain complaint: blocks with gaps, small, unfinished. Refinery is the answer to
the "big map of a place" half — 92 m across, two process halls facing each other
over a yard, a walkable pipe rack crossing it, a tank farm inside a bund and a
loading dock under a gantry. The other half was that a level made only of boxes
reads as boxes however it is laid out, which is a rendering problem rather than a
layout one, so brushes now get baked contact shading and every map got a layer of
round props on top — with four rules and a suite to stop that layer from lying
about cover.

Typecheck is clean on all three workspaces, both suites are green at 1267
assertions, and the smoke test passes 52 checks against a live server. Those confirm
the code is coherent and self-consistent — they cannot confirm it sounds or looks
right. The audio rewrite in particular is a claim about what a human ear will hear, and it
has not been heard: the diagnosis (a 128 ms pitched sweep on a 94 ms cycle,
stacking into a chord) is specific and testable, but whether the replacement
actually reads as a gunshot needs someone at a keyboard with the sound on. Same
for the models, the firing visuals and the game feel — and now for all six maps,
whose layouts are argued in their own doc comments and measured against the
movement constants, but which nobody has actually walked. That gap is widest for
the props and the contact shading, which exist entirely to change how the place
looks: the suite can prove no prop lies about cover and the vertex counts are
exact, and neither fact says whether a refinery now reads as a refinery. The
lobby's server half is covered by the new suites and, over a real socket, by the
smoke test; its staging room has been compiled but not clicked.
Remaining milestones (M4 meta, M5 polish) are in
[`docs/SPEC.md`](docs/SPEC.md) §8.
