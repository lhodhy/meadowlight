# Meadowlight Round Two Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the meadow react, add the fox Pip, dress the sky and pond, and make it work on phones and weak GPUs — the six features approved in the round-two design.

**Architecture:** All changes stay in `main.js` (single-file codebase per design decision) plus HUD hooks in `index.html`. Shader features ride existing `onBeforeCompile` hooks (grass wind pattern), HUD/quality features ride module-level state exposed through the existing `window.meadowlight` test hook. Six sequential tasks, one commit each, pushed to GitHub Pages after verification.

**Tech Stack:** Three.js r186 via import map (CDN), GLSL injections via `onBeforeCompile`, Web pointer events. No build step, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-22-meadowlight-round-two-design.md` (read together with this plan; the plan pins exact names/values, the spec explains intent).

## Global Constraints

- No audio, no new dependencies, no build step (spec Non-goals/Constraints).
- `main.js` stays one file with section comments (spec Constraints).
- Reduced-motion (`reduceMotion` flag) must survive every feature.
- Hidden tabs suspend rAF: quality watchdog must not measure while `document.hidden` (spec F1).
- Draw-call budget: no feature may add more than ~10 draw calls; no render targets anywhere (spec Anti-goals).
- Verification is runtime-only: no test runner exists on this machine (no Node). Each task's "tests" are `browser.evaluate` assertions against `window.meadowlight`, console-noise checks, and canvas-capture screenshots per the established workaround.
- All math on units: pond center (7.4, −6.2) r 3.5; oldest-tree vignette (−8.5, −9.5); Pip's sleep tree (3.5, 12.5); island radius 26.

## Review Focus

- Hidden-tab return: a tab hidden for 5 minutes returns with a huge timer delta; the watchdog must not see a fake fps collapse and step down. Test: Task 1.
- Mouse orbit after touch: pinch/touch handlers must leave desktop `pointerType "mouse"` drag-orbit working exactly as before. Test: Task 6.
- Fox must never enter the pond or leave the island: it reuses `walkable(x, z)` + slide. Test: Task 5.
- Quality ladder never steps back up mid-session; stepping down only while visible and after warmup. Test: Task 1.
- Grass parting must not displace the player's own blade row into visible gaps when standing still (falloff starts moving only when `uPlayerActive` > 0 and radius is tight). Test: Task 4.

---

### Task 1: Performance watchdog

**Files:**
- Modify: `isometric-grassland/main.js` (module state near top; `frame()`; `window.meadowlight` hook; small helper after `resize()`)
- Modify: `isometric-grassland/index.html` (HUD dot element + CSS)
- Test: runtime, via `browser.evaluate`

**Interfaces:**
- Consumes: existing `frame()` loop, `resize()`, `renderer`/`composer`, grass `InstancedMesh` (returned by `scatterGrass()`), `pollenGeo`, `butterflies` array (F2/F4/F5 build on the `qualityLevel` state and capture-the-frame convention).
- Produces: `let qualityLevel = 0`; `function applyQualityLevel(n)` (mutates grass count, pixel ratio, pollen draw range, butterfly visibility; updates HUD dot); `const tuftField` (grass mesh reference); `pollen.setDrawRange` usage; hook additions `applyQuality(n)` / `quality` getter.

- [ ] **Step 1: Restart the local server** (it was stopped since yesterday)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\lodyv\source\sample-treejs\isometric-grassland\serve.ps1" -Port 8137
```
Run in background shell; verify `browser.evaluate` on the tab returns `{ hook: true }`.

- [ ] **Step 2: Make the scaled meshes addressable**: change `scene.add(mesh)` return usage so module scope holds `const tuftField = scatterGrass();`, `const pollenField = pollen;`, and grass/pollen/butterflies are reachable (they already exist as module consts; capture tuftField only).

- [ ] **Step 3: Add module state + level table** (above `frame()`):

```js
let qualityLevel = 0;
let lowFpsTime = 0;   // consecutive seconds under 40 fps
let fpsSample = 0;    // accumulates dt
let fpsFrames = 0;
const QUALITY_LEVELS = [
  { tufts: 22000, pixelRatio: Math.min(devicePixelRatio || 1, 2), pollen: 240 },
  { tufts: 14000, pixelRatio: Math.min(devicePixelRatio || 1, 1.5), pollen: 240 },
  { tufts: 9000,  pixelRatio: 1, pollen: 120 },
  { tufts: 5000,  pixelRatio: 1, pollen: 0 },
];

function applyQualityLevel(n) {
  qualityLevel = Math.max(0, Math.min(3, n));
  const lvl = QUALITY_LEVELS[qualityLevel];
  tuftField.count = lvl.tufts;
  renderer.setPixelRatio(lvl.pixelRatio);
  composer.setPixelRatio(lvl.pixelRatio);
  resize();
  pollenGeo.setDrawRange(0, lvl.pollen);
  qualityEl.classList.toggle("scaled", qualityLevel > 0);
  console.info(`meadowlight: quality level ${qualityLevel}`);
}
```

Also in `applyQualityLevel`: butterflies retire at L3 via `showButterflies = worldDaylight > 0.22 && qualityLevel < 3` in `updateCritters` (edit that line in this task).

- [ ] **Step 4: Add monitor to `frame()`** (after the `composer.render(dt)` call): guard `if (!document.hidden && elapsed > 2)`; accumulate `fpsSample += dt; fpsFrames++`; when `fpsSample >= 1` compute `const fps = fpsFrames / fpsSample`, reset counters, `lowFpsTime = fps < 40 ? lowFpsTime + 1 : 0`; when `lowFpsTime >= 3 && qualityLevel < 3` call `applyQualityLevel(qualityLevel + 1)` and reset `lowFpsTime`. Guard the hidden-tab return: a `visibilitychange` listener resets `fpsSample = 0; fpsFrames = 0; lowFpsTime = 0` when the tab becomes visible again, so a huge resume delta can't fake a collapse.

- [ ] **Step 5: HUD dot** in `index.html` next to the hint element: `<div id="quality" aria-hidden="true"></div>` styled as a 6px circle, `.scaled` variant colored amber; grab `const qualityEl = document.querySelector("#quality")` in `main.js` helper section.

- [ ] **Step 6: Hook exposure**: add `applyQuality: applyQualityLevel` and `qualityLevel: () => qualityLevel` to `window.meadowlight`.

- [ ] **Step 7: Verify** (tab `?v=21`, assert no console errors, then):

```js
(() => {
  const m = window.meadowlight;
  m.applyQuality(2);
  const grass = m.scene.children.find(o => o.isInstancedMesh && o.material === m.grassMaterial);
  const before = { tufts: grass.count, pr: m.renderer.getPixelRatio() };
  const drawRange = m.scene.children.find(o => o.isPoints)?.geometry.drawRange.count;
  m.applyQuality(0);
  const after = { tufts: grass.count, pr: m.renderer.getPixelRatio() };
  return { before, drawRange, after };
})()
```
Assert: `before.tufts === 9000`, `before.pr === 1`, `drawRange === 60`; `after.tufts === 22000`, `after.pr === devicePixelRatio-capped`. No console errors.

- [ ] **Step 8: Commit + push**

```bash
git add main.js index.html
git commit -m "perf: quality watchdog steps tufts/pixel-ratio down on weak GPUs"
git push
```

### Task 2: Sky backdrop

**Files:**
- Modify: `main.js` (sky ShaderMaterial fragment + `skyUniforms`)

**Interfaces:**
- Consumes: sky fragment shader block (hash13 already present), `skyUniforms`, `frame()` passes `t` to `skyUniforms.uTime`.
- Produces: sky visual bands; `skyUniforms.uTime` (Task 3 reuses the same look for the pond); no new uniforms beyond `uTime`.

- [ ] **Step 1: Add `uTime: { value: 0 }` to `skyUniforms`; update it in `frame()`** with `skyUniforms.uTime.value = t;`

- [ ] **Step 2: Steeper gradient**: change the existing line to `float h = smoothstep(-0.12, 0.42, dir.y);` (melón: verify the visible band above the island turns blue while the horizon stays warm).

- [ ] **Step 3: Cloud bands** (inside `main()`, before stars block):

```glsl
vec3 bandCol = mix(uHorizon, uTop, 0.65);
float clouds = 0.0;
for (int i = 0; i < 3; i++) {
  float yc = 0.10 + float(i) * 0.13;
  float d = abs(dir.y - yc);
  float n = hash13(vec3(floor(dir.xz * (6.0 + float(i) * 2.0)), float(i)))
          + 0.5 * hash13(vec3(floor(dir.xz * 13.0) + 3.0, float(i)));
  n = 0.5 + 0.5 * sin(uTime * 0.02 + n * 40.0);
  clouds = max(clouds, smoothstep(0.09, 0.02, d) * smoothstep(0.35, 0.75, n));
}
float bandA = clouds * (0.20 + 0.10 * (1.0 - uNight));
col = mix(col, bandCol, bandA);
```

(Cellular blockiness is fine at 0.2 opacity; if it reads too banded, widen the smoothstep edges to `0.12 / 0.03`.)

- [ ] **Step 4: Verify**: reload `?v=22`, console clean; capture day + `updateAtmosphere(0.016, 125)` night frames via canvas-capture; check bands visible in day, muted inky at night; look unchanged at L2 zoom.

- [ ] **Step 5: Commit + push**: `git commit -m "art: sky gradient + procedural cloud bands"`.

### Task 3: Pond reflection + glitter

**Files:**
- Modify: `main.js` (water material construction, `updateAtmosphere`, `frame` uniforms wiring)

**Interfaces:**
- Consumes: skyUniforms values (already lerped per-frame), `waterNormal`, existing ripple normal map.
- Produces: `water.material.userData.shader.uniforms.uSkyTop/uSkyHorizon/uSunColorW/uNightW` updated each frame in `updateAtmosphere`; visual only (no later task consumes).

- [ ] **Step 1: Add uniforms at water creation** via `material.onBeforeCompile = (shader) => { shader.uniforms.uSkyTop = { value: new THREE.Color() }; shader.uniforms.uSkyHorizon = { value: new THREE.Color() }; shader.uniforms.uSunColorW = { value: new THREE.Color() }; shader.uniforms.uNightW = { value: 0 }; waterUniformsRef = shader.uniforms; }` with `waterUniformsRef` a module-level `let`; also `material.customProgramCacheKey = () => "pond-sky"`.

- [ ] **Step 1: Declare fragment uniforms + hash helper** — inside `onBeforeCompile`, prepend to the fragment shader source:

```glsl
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uSunColorW;
uniform float uNightW;
uniform float worldDaylightW;
float hashW(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
```

- [ ] **Step 2: Fragment injection** replacing `#include <color_fragment>` (after map application):

```glsl
#include <color_fragment>
vec3 wView = normalize(vViewPosition);
float fres = pow(1.0 - abs(dot(wView, normalize(vNormal))), 3.0);
vec3 skyMix = mix(uSkyHorizon, uSkyTop, 0.55) * (0.55 + 0.45 * worldDaylightW);
diffuseColor.rgb += skyMix * fres * 0.35;
float sparkle = pow(abs(dot(wView, normalize(vNormal) + 0.15 * vec3(hashW(vUv * 900.0)) )), 90.0);
diffuseColor.rgb += uSunColorW * sparkle * (1.0 - uNightW) * 1.4;
```
(equal-hash `hashW(vec2)` helper added near the top of the fragment shader; `worldDaylightW` is a uniform `{ value: 1 }` also set per frame — pin these three additions to the shader.)

- [ ] **Step 3: Per-frame uniform sync** in `updateAtmosphere`, guarded `if (waterUniformsRef)`:

```js
waterUniformsRef.uSkyTop.value.copy(skyUniforms.uTop.value);
waterUniformsRef.uSkyHorizon.value.copy(skyUniforms.uHorizon.value);
waterUniformsRef.uSunColorW.value.copy(skyUniforms.uSunColor.value);
waterUniformsRef.uNightW.value = skyUniforms.uNight.value;
waterUniformsRef.worldDaylightW.value = worldDaylight;
```
(These copies only take effect after `water.material.userData.shader` is set — add `waterUniformsRef = shader.uniforms; water.material.userData.shader = shader;` inside `onBeforeCompile` matching the existing grass pattern.)

- [ ] **Step 4: Verify**: console clean; canvas-capture at day shows a sky-tinted grazing edge + drifting sparkle at the sun-facing side; night capture shows dark glass, no glitter blowout (sparkle multiplied by (1-night)); frame-time sanity (Task 1's monitor must stay at level 0 in this same session).

- [ ] **Step 5: Commit + push**: `git commit -m "art: water fakes a sky reflection + sun glitter"`.

### Task 4: Interactions (grass parting, brushed flowers, pond life)

**Files:**
- Modify: `main.js` (grass `onBeforeCompile`, flower material hoist + `onBeforeCompile`, ripple pool, fish-plop timer, `frame`/`updatePlayer` wiring, hook additions)

**Interfaces:**
- Consumes: `grassMaterial.userData.shader` pattern, `POND`, `baseHeight`, `hash2`, `worldDaylight`, `qualityLevel`.
- Produces: uniform `uPlayerPos: Vector3` / `uPlayerActive: float` on both grass and flower shaders (updated in `frame()` from `player.position`); `function spawnRipple(x, z, strength)`; ripple pool array `ripples` (8, recycled); fish-plop timer state `fishTimer`; hook addition `spawnRipple`.

- [ ] **Step 1: Grass parting shader**: in the existing grass `onBeforeCompile` injection, after the sway block, add:

```glsl
vec2 away = iPos.xz - uPlayerPos.xz;
float pdist = length(away);
float push = (1.0 - smoothstep(0.0, 1.1, pdist)) * uPlayerActive;
if (push > 0.001) {
  vec2 dir = away / max(pdist, 0.001);
  float bendH = pow(clamp(transformed.y / 0.55, 0.0, 1.0), 2.0);
  transformed.x += dir.x * push * 0.35 * bendH;
  transformed.z += dir.y * push * 0.35 * bendH;
}
```
with `uniform vec3 uPlayerPos; uniform float uPlayerActive;` declared.

- [ ] **Step 2: Flowers**: hoist the flower `mat` to module scope as `flowerMaterial`; give it the same injection with `uPlayerPos`/`uPlayerActive` but radius `0.7` and push `0.22`; both shaders' uniforms updated in `frame()`:

```js
const pw = grassMaterial.userData.shader;
if (pw) { pw.uniforms.uPlayerPos.value.copy(player.position); pw.uniforms.uPlayerActive.value = playerActive; }
```
`let playerActive` eased in `updatePlayer`: target `speed > 0.05 ? 1 : 0`, lerp `1 - exp(-6 * dt)`.

- [ ] **Step 3: Ripple pool**: 

```js
const ripples = []; // 8 pool entries { mesh, age, life, strength }
function spawnRipple(x, z, strength) { /* recycle oldest if needed; position, age=0, life=1.4 */ }
function updateRipples(dt) { /* ring radius grows 0.9u/s, opacity fades; mesh.visible off when done */ }
```
Ring mesh: `RingGeometry(0.9, 1.0, 40)`, `MeshBasicMaterial({ color: 0xdff4ef, transparent: true, depthWrite: false })`, rotated flat at `y = WATER_Y + 0.02`, `renderOrder = 3`. Called in `frame()` with `dt`.

- [ ] **Step 4: Fish plops**: `let fishTimer = 4;` in `frame()`: while `worldDaylight > 0.3 && qualityLevel < 3`: decrement, on zero pick random point `POND.x/z + r*(0.75*random)` and (a) show fish flash: reuse one shared dark `CircleGeometry(0.2)` ellipse scaled flat, visible for 0.45s (track `fishFlashT`), (b) `spawnRipple(x, z, 0.9)`; reset `fishTimer = 6 + random*8`.

- [ ] **Step 5: Shore ripples**: in `updatePlayer`, when moving (`speed > 0.2`) and `pondDist < POND.r * 1.7` and a `shoreRippleCd` countdown hits 0: `spawnRipple` at nearest edge point, `shoreRippleCd = 0.8`.

- [ ] **Step 6: Verify**: console clean; canvas-capture walking next to pond (use `testKey("right", true)` stepping as in prior session) shows rings; walking through a dense tuft patch shows blades parting (compare two captures paused/unpaused via `playerActive` assert = 1); fish flash appears within ~20s daylight observation or forced via hook (`m.spawnRipple(...)`).

- [ ] **Step 7: Commit + push**: `git commit -m "feat: the meadow reacts — parting grass, brushed flowers, pond life"`.

### Task 5: Companion fox "Pip"

**Files:**
- Modify: `main.js` (fox builder + state machine + `frame` wiring; hook exposure)
- Modify: `index.html` (nothing beyond existing HUD; no new elements)

**Interfaces:**
- Consumes: `walkable()`, `worldDaylight`, `qualityLevel` (no pounce at L3), `fbm` for grass density, `motionScale`/`reduceMotion`.
- Produces: module `const fox = { group, state, velocity }`; `function foxUpdate(dt, t, elapsed)` called from `frame()` after `updatePlayer`; hook addition `fox` (read state + group).

- [ ] **Step 1: Build `addFox()`** with primitives; materials `foxRust 0xb3623d` / `foxCream 0xf2e3cf` / `foxDark 0x35281e` (flatShading, roughness 0.95): body capsule (0.16, 0.3) lying along z, head sphere 0.14 with two cone ears, snout cone cream, tail cone (0.08 r, 0.42 long) angled up, 4 leg capsules (0.03, 0.14); whole group scaled 0.9; spawn near sleep tree `(4.2, 11.8)`; cast/receive shadow.

- [ ] **Step 2: State machine** `foxUpdate(dt, t, elapsed)`:

- follow: if `dist(player, fox) > 1.4`, steer velocity toward player (target speed 2.2, accel `1 - exp(-7*dt)`), yaw toward velocity, stride phase like player's; else velocity decays.
- idle: when player `idleTime > 4 && dist < 1.4`: sit (body pitch 0.35, y −0.05), sniff bob `sin(t*3)*0.04` on head, head-tilt toward hash-random end; exits when player moves.
- pounce: in follow/idle, when `pounceTimer` (20+random*20 s) elapses AND `fbm(x*0.12 + 31.7, z*0.12 + 12.3, 3) > 0.5` AND `pondDist > POND.r + 1.5` AND daylight > 0.15 AND not reduced-motion AND qualityLevel < 3: crouch 0.6s (scale y 0.82), hop 0.35s (y arc +0.45 toward random implant), land, tail wag 1.2s, reset timer.
- sleep: when `worldDaylight < 0.05` and not within 3 of player: travel to sleep spot `(4.2, 11.8)`; when there, curl (group scale 0.92, y −0.03, breath `0.99 + sin(t*1.1)*0.012` on body y-scale); wake when `playerDist < 3` → follow.

- Movement clamped by `walkable(nx, nz)` with the same axis-slide as the player (`walkable` reused verbatim).

- [ ] **Step 3: Wire + expose**: call from `frame()` after `updateCritters`; add `fox: fox` to the hook.

- [ ] **Step 4: Verify**: console clean; daylight capture shows Pip near the path; `evaluate` assert: `m.fox.group.position` stays outside pond radius after simulating 120 steps of `foxUpdate(0.05, ...)` with the player parked at the pond edge (teleport player via `m.player.position.set(...)` then step `m.updatePlayer(0.05, ...)` + `m.updateCritters` / `foxUpdate`... note: `foxUpdate` must be exposed in the hook for determinism — add `foxUpdate: foxUpdate`); night capture shows Pip curled at (4.2, 11.8).

- [ ] **Step 5: Commit + push**: `git commit -m "feat: Pip the fox — follows, pounces, sleeps at night"`.

### Task 6: Touch controls

**Files:**
- Modify: `main.js` (pointer handler rework in the input section, `updatePlayer` input merge, hint text)
- Modify: `index.html` (joystick CSS/elements)

**Interfaces:**
- Consumes: existing canvas pointer handlers, `zoom`/wheel clamp range (0.65–2.1), `hintEl`.
- Produces: module `let touchInput = { xin: 0, zin: 0, active: false }` merged into `updatePlayer`'s `xin/zin` computation; joystick DOM `#joy`/`#joyNub` shown during a live touch; pinch Zoom via the existing `zoom` variable.

- [ ] **Step 1: Rework pointer bookkeeping**: track `activePointers = new Map()` of `{x, y, type}` in pointerdown/move/up/cancel. Mouse pointers keep the existing orbit path untouched; touch pointers go through the new logic:

- first touch with `clientX < innerWidth / 2` AND only one touch total → joystick pointer: store origin; show `#joy` at origin; on move: `v = clamp((cur − origin) / 48, length ≤ 1)`; `touchInput.xin = v.x; touchInput.zin = −v.y;` nub follows.
- when a second touch exists anywhere: pinch — track previous two-pointer distance; `zoom = clamp(zoom * (1 + (prevDist − dist) * 0.004), 0.65, 2.1)` (same clamp as wheel); joystick ignored while pinching; on release back to one touch, re-seed origin.
- pointerup/cancel: remove entry; empty joystick hides `#joy`, zeros `touchInput`.

- [ ] **Step 2: Feed walk input**: `updatePlayer`'s `xin/zin` become `(keys.has(...) ? 1 : 0) ± touchInput.xin/zin`, clamped to unit length via existing `moveDir.normalize()`; camera-relative mapping unchanged (forwardVec/rightVec already applied).

- [ ] **Step 3: Platform niceties**: `canvas.style.touchAction = "none"`; JS hint switch when `navigator.maxTouchPoints > 0`: `hintEl.textContent = "left thumb walks · pinch zooms"` (matches existing hint copy style in `index.html`).

- [ ] **Step 4: Verify** (synthetic PointerEvents via evaluate):

```js
const L = (x, y) => canvas.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 7, pointerType: "touch", clientX: x, clientY: y, isPrimary: true, bubbles: true }));
L(120, 400); L(160, 400);  // down, right-drag
```
After ~4 `updatePlayer(0.16, …)` steps the player moved in screen-right direction; `document.querySelector("#joy")` visible during hold, hidden after `pointerup`; then two-touch pinch changes `m.camera.zoom`; then mouse `pointerdown/pointermove/pointerup` still orbits (camera azimuth changes then returns... azimuth unaffected by pinch-only test: assert a mouse-drag changes the same orbit variable used pre-change). No console errors.

- [ ] **Step 5: Commit + push**: `git commit -m "feat: touch — thumb joystick + pinch zoom, desktop orbit intact"`.

---

## Final task: wrap-up

- [ ] Update `README.md` controls table (touch rows), `docs` unchanged; commit `docs: touch controls and quality notes`; push; final daylight/night captures; report live URLs.
