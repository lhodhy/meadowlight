# Meadowlight 🌾

A tiny isometric walking sim: a fully procedural grassland island with a pond,
a winding path, standing stones, butterflies, fireflies, a fox that follows you
around (and curls up to sleep at dusk), and a 6-minute day night cycle.
Everything is generated in code — no models, no textures on disk, no build step.

## Requirements

- Any modern browser (Chrome, Edge, Firefox)
- A way to serve the folder over HTTP

> The page must be loaded from `http://localhost`, not `file://`. `main.js` is
> an ES module that imports Three.js, and browsers block module loading from
> `file://` URLs.

## Run it

### Option A — the bundled PowerShell server

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\serve.ps1 -Port 8137
```

Then open <http://localhost:8137/>.

The port is a parameter (`-Port 8137`), and the server sends
`Cache-Control: no-store`, so every reload picks up the latest `main.js`.

### Option B — any static file server

VS Code's Live Server, `npx serve`, `python -m http.server`, etc. — anything
that serves this folder over HTTP on localhost works.

### Without a server (not supported)

Opening `index.html` directly from the filesystem will show a blank page by
design (see note above).

## Controls

**Keyboard / mouse**

| Input        | Action                          |
| ------------ | ------------------------------- |
| `WASD` / arrows | Walk (camera-relative)       |
| Mouse drag   | Orbit the camera                |
| Mouse wheel  | Zoom                            |
| Tab hidden / window blur | Animation pauses    |

**Touch**

| Gesture       | Action                                        |
| ------------- | --------------------------------------------- |
| Left-half screen | Thumb joystick (walks camera-relative)     |
| Two fingers   | Pinch to zoom (same range as the wheel)      |
| Right-half single touch | Reserved (does nothing for now)     |

Walk up to glowing spots to read the vignette captions. The pond is solid;
island rim is the boundary. No jump button — it's a walk in the meadow.

## URL parameters

| Param     | Meaning                                                                |
| --------- | ---------------------------------------------------------------------- |
| `?time=N` | Fast-forward the day cycle by `N` seconds. `58` ≈ dusk, `125` ≈ night. |
| `?v=N`    | Anything else — just a cache-busting suffix.                           |

Examples:

```
http://localhost:8137/            # afternoon start, full cycle below
http://localhost:8137/?time=58    # preview dusk
http://localhost:8137/?time=125   # preview night (stars + fireflies + lantern)
```

The full day loop is 6 minutes, starting mid-afternoon.

## System considerations

- **Reduced motion**: if the OS reports `prefers-reduced-motion`, camera
  easing, grass sway, sky drift, water twinkle and critter motion are dialed
  back; the grass parts less, ripples and fish plops are skipped, and the fox
  never pounces.
- **Performance**: the scene is draw-call friendly (instanced tufts, shrubs,
  rocks, flowers). A watchdog samples FPS after a short warmup and steps
  grass density and pixel ratio down (levels 0–3, amber dot bottom-left when
  scaled) on struggling GPUs.
- **Hidden tabs**: browsers suspend `requestAnimationFrame` for backgrounded
  tabs, so the page idles at zero cost when the tab isn't visible.

## Files

| File            | Purpose                                            |
| --------------- | -------------------------------------------------- |
| `index.html`    | HUD, captions, Vignette/warmth overlays, import map |
| `main.js`       | The whole simulation (terrain, scatter, lighting, player) |
| `serve.ps1`     | Minimal PowerShell static server for localhost     |
| `final.jpg`, `dusk2.jpg`, `night.jpg` | Reference shots of each mood |
