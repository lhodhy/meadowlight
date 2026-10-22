# Meadowlight — Round Two Design (2026-10-22)

Living the meadow up: the demo sells "a mood", and this round spends its
budget on things that make the island feel watched-back-at and safe to share
widely. **No audio this round — explicitly excluded by the human partner.**

## Intent and why

Meadowlight is a daily-calm toy: a tiny isometric walking sim on a procedural
island, live at https://lhodhy.github.io/meadowlight/. It already looks good;
what it does best is time (day cycle, fireflies) and least is *reaction*: the
meadow doesn't respond to the player, there is no other creature, the sky and
pond read flat, and it only controls with a keyboard. This round:

- makes the world respond to the player,
- adds one other creature worth caring about,
- frames the diorama and gives the pond a reason to be the hero,
- and makes it playable in more places (touch phones, weaker GPUs).

## Goals

1. Cause-and-effect: grass bends away from the player, pond rings ripple and
   fish plop, flowers get brushed.
2. A companion fox with follow / idle / pounce / sleep states.
3. A painted-sky backdrop: blue gradient visible in isometric shots + soft
   cloud bands that follow the day palette.
4. Water that reflects the sky and rooftops of sunlight (glitter).
5. Touch controls: virtual joystick to walk, pinch to zoom; desktop mouse-drag
   orbit stays as-is.
6. Performance watchdog: an FPS monitor that gracefully lowers quality on weak
   GPUs without changing the look on good ones.

## Non-goals

- Audio of any kind (user decision — revisit later on request).
- New collectibles, quests, benches, or content spots beyond what exists.
- Changing the art style (flat-shaded low-poly, warm palette) or the fixed
  isometric camera.
- Repository restructuring; `main.js` stays one file with section comments.

## Anti-goals (failure modes)

- Visible visual degradation on a mid-range GPU (auto-scaling must feel
  invisible until it isn't needed).
- Chin-high geometry budgets: draw-call count and triangle count must not
  balloon; refl. no WebGL render targets for the pond.
- The fox must not feel like a bug report ("why is it walking into me?").

## Constraints

- No build step, no new runtime dependencies beyond `three/addons`.
- Must keep working on GitHub Pages and via `serve.ps1`.
- Reduced-motion support must survive every feature (fox still follows, but
  flatter animation; sky bands drift slower).
- Hidden-tab rAF suspension must be respected: watchdog only measures while
  the tab is actually getting frames.

## Feature specs

### F1 — Performance watchdog

- Measure with a manual rolling timer (not `renderer.info`, which proved
  unreliable behind the composer): after a 2s warmup, compute avg fps over
  ~60 frames; if the average is below 40fps for 3 consecutive seconds, step
  down one quality level; never step back up in a single session (no
  oscillation).
- Levels:
  - L0 full: 22000 grass tufts, pixelRatio min(dpr, 2).
  - L1: 14000 tufts (just `InstancedMesh.count` — matrices are all pre-set),
    pixelRatio min(dpr, 1.5).
  - L2: 9000 tufts, pixelRatio 1, pollen halved (drawn via `geo.setDrawRange`
    ... check: points geometry can use setDrawRange).
  - L3: 5000 tufts, worldDaylight-independent extras off (butterflies, pollen).
- Skip downsteps while `document.hidden`; `reduceMotion` users follow the
  same ladder — tuft triangles are a GPU cost regardless of motion damping,
  so pixel-ratio and count steps still apply (butterfly/pollen-off steps are
  simply less visible in RM mode since their motion is already damped).
- One unobtrusive HUD dot, `aria-live="off"`, shows "‑" only when scaled down.

### F2 — Sky backdrop

- Extend the sky fragment shader: steeper gradient so the band visible from
  the isometric camera shows blue above the island (tune smoothstep so the
  horizon haze stays warm).
- Add 3–4 soft horizontal cloud bands, procedurally faded with a hash-noise
  function; they tint via existing day/night uniforms (no new textures) and
  drift very slowly with `uTime`; reduced-motion pins the drift.
- Night: bands go inky blue with a faint moon halo on the side of the moon
  light... note: no moonlight lamp exists; use sky `uSunDir` as the only
  directional source and keep bands subtle at night.

### F3 — Pond reflection + glitter

- No planar render targets (cost/complexity). Instead extend the water
  material via `onBeforeCompile`: reflect the eye vector off the ripple
  normal, then look up a cheap duplicate of the sky gradient + cloud-band
  function in the pond shader — the pond inherits the sky's daytime/nighttime
  colors for free and stays consistent with F2.
- Sun glitter: a second specular lobe that is very tight (pow ~700) plus a
  hash sparkle jitter on the ripple normal; pushes a few pixels above the
  bloom threshold so highlights twinkle.

### F4 — Interactions

- **Grass parting**: extend the existing grass wind `onBeforeCompile` with a
  `uPlayerPos` uniform: within r=1.1 of the player, bend blades outward
  (xz direction away, falloff smoothstep) with a small idle-echo so it settles;
  color ignition leaves... no color change. All in the vertex shader, so the
  22k instances stay one draw call and zero instance data is updated per frame.
- **Brushed flowers**: same technique on the flower material (they currently
  have no wind shader) with a stiffer "stiffness" so they spring back.
- **Pond life**: a small pool (8) of expanding-and-fading ring meshes:
  - fish plop events on a 6–14s timer during daylight (dash silhouette +
    splash ring),
  - ripples spawned at the nearest pond-edge point when the player walks close
    to the waterline.

### F5 — Companion fox

- Built from primitives (capsule body, cone ears and tail-tip, tiny leg
  capsules), ~0.5 units tall, matches the flat-shaded style; one material set,
  sits near ~15 triangles... reuse existing primitives, no new geometry format.
  (Reference: Vehicle-colored; name/call: fox over ground-bird, called "Pip".)
- States and rules:
  - **follow**: steering (accelerate to player, stop radius 1.2u), uses the
    same `walkable()` checks and wall-slide as the player; no pathfinding.
  - **idle** (player still for 4s+): sits, sniffs, occasional head-tilt at
    hash-random choice; yaw turns toward the player.
  - **pounce**: every 20–40s while following through dense-grass spots:
    crouch (0.6s), hop (0.35s), land, upward tail wag; never near water edge.
  - **night sleep**: after full darkness, curls near the big mid-tree at
  (3.5, 12.5) — deliberately *away* from the oldest-tree vignette at
  (−8.5, −9.5), so sleeping Pip doesn't step on that caption moment —
  and breathes (scale y 0.98–1.0); wakes if the player comes within 3u, then
  follows, then returns to that tree at the next full darkness.
- Reduced-motion: keep follow + sleep, drop pounce and head-tilt amplitude.
- Camera focus stays on the player only.

### F6 — Touch controls

- All on the existing canvas pointer handlers; `touch-action: none`.
- **Left-half touches become a joystick**: on touchstart, record origin, show
  a CSS ring + nub; drag maps direction through the camera azimuth (same
  mapping WASD uses), magnitude scales speed (walk only, capped at WALK_SPEED).
- **Right-half touches are ignored** except for **two-finger pinch**, which
  maps to the same zoom clamp the wheel uses (0.65–2.1).
- Multi-touch bookkeeping via `pointerId` tracking; desktop mouse pointer type
  keeps the existing orbit-drag behavior untouched.
- HUD hint line switches to "use the left thumb to walk · pinch to zoom" when
  a touch capability is detected (`navigator.maxTouchPoints > 0`).

## Rollout order and shipping

1. F1 watchdog (foundation — everything after adds geometry)
2. F2 sky backdrop
3. F3 pond reflection
4. F4 interactions (grass parting → flowers → pond life)
5. F5 companion fox
6. F6 touch

Each feature is its own commit, pushed to the live repo when verified (the
Pages site updates), with a browser-tab smoke check for console errors and the
in-page canvas capture trick for visual review (the desktop screenshot API is
known-broken for hidden tabs in this session).

The repository is this folder (`isometric-grassland/`), remote
`origin = https://github.com/lhodhy/meadowlight.git`; the implementing agent
does the commit/push/verify loop itself.

## Calls already made by the agent (reviewer: challenge if wrong)

- Fox > bird; name "Pip"; no petting/patting interaction this round.
- No planar reflection; onBeforeCompile sky-duplicate instead.
- Watchdog never re-upgrades mid-session; no settings UI beyond the one dot.
- Joystick on left half, pinch wherever two touches appear.
- Grass parting bends *away* from the player rather than flattening towards.

## Open verifications needed while building

- Actual frame-time cost of the reflection shader on the water at L0.
- That `InstancedMesh.count` reduction is stable for grass (should be — all
  matrices pre-computed at placement).
- Pinch-gesture handling doesn't fight the single-pointer orbit-drag.
