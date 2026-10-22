// Meadowlight — an isometric grassland walking sim.
// three.js r186, WebGLRenderer, everything procedural (no external assets).
//
// Layout: utilities → world geometry → scattering → player → camera →
// vignettes → atmosphere → loop.

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const ISLAND_R = 26;
const WATER_Y = 0.0;
const POND = { x: 7.4, z: -6.2, r: 3.4 };
const SPAWN = { x: -1.5, z: 2.0 };

const reduceMotion =
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const motionScale = reduceMotion ? 0.12 : 1;

const canvas = document.querySelector("#scene");
const captionEl = document.querySelector("#caption");
const hintEl = document.querySelector("#hint");
const qualityEl = document.querySelector("#quality");
const loaderEl = document.querySelector("#loader");

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (edge0, edge1, x) => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------------------
// deterministic value noise + fbm
// ---------------------------------------------------------------------------

function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

function noise2(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

function fbm(x, y, octaves = 4) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(x * freq, y * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

// ---------------------------------------------------------------------------
// terrain height field (single source of truth for mesh, scatter and walking)
// ---------------------------------------------------------------------------

function baseHeight(x, z) {
  const d = Math.hypot(x, z) / ISLAND_R;
  const rim = smoothstep(0.86, 1.0, d);

  const hills = (fbm(x * 0.052 + 11.3, z * 0.052 + 4.7, 4) - 0.5) * 4.2;
  const micro = (fbm(x * 0.21 + 2.1, z * 0.21 + 9.4, 3) - 0.5) * 0.34;
  let h = 0.62 + hills * (1 - rim * 0.5) + micro;

  // pond basin
  const pd = Math.hypot(x - POND.x, z - POND.z);
  const basin = 1 - smoothstep(POND.r * 0.45, POND.r * 1.5, pd);
  h = h * (1 - basin * 0.9) - basin * 1.35;

  // rim falls away
  h -= rim * rim * 6.5;
  return h;
}

const islandGround = (x, z) => baseHeight(x, z);

// ---------------------------------------------------------------------------
// renderer, scene, camera, composer
// ---------------------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xdce8e4, 100, 280);

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 500);
const VIEW_HEIGHT = 33;
let aspect = window.innerWidth / window.innerHeight;
let zoom = 1.08;

function applyCameraFrustum() {
  const halfH = VIEW_HEIGHT / 2;
  const halfW = halfH * aspect;
  camera.left = -halfW;
  camera.right = halfW;
  camera.top = halfH;
  camera.bottom = -halfH;
  camera.zoom = zoom;
  camera.updateProjectionMatrix();
}

const composerTarget = new THREE.WebGLRenderTarget(1, 1, {
  type: THREE.HalfFloatType,
  samples: 4, // MSAA for the composer buffers (renderer antialias does not reach them)
});
const composer = new EffectComposer(renderer, composerTarget);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.3, 0.72, 0.88);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

// ---------------------------------------------------------------------------
// sky dome (gradient + sun glow + stars)
// ---------------------------------------------------------------------------

const skyUniforms = {
  uTop: { value: new THREE.Color(0x8fbfe8) },
  uHorizon: { value: new THREE.Color(0xf7e4c2) },
  uSunDir: { value: new THREE.Vector3(0.5, 0.4, 0.6) },
  uSunColor: { value: new THREE.Color(0xffd2a0) },
  uNight: { value: 0 },
  uGlow: { value: 0.55 },
  uTime: { value: 0 },
};

const sky = new THREE.Mesh(
  new THREE.SphereGeometry(320, 40, 24),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: skyUniforms,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop;
      uniform vec3 uHorizon;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform float uNight;
      uniform float uGlow;
      uniform float uTime;
      varying vec3 vDir;

      float hash13(vec3 p) {
        p = fract(p * 0.1031);
        p += dot(p, p.yzx + 33.33);
        return fract((p.x + p.y) * p.z);
      }

      void main() {
        vec3 dir = normalize(vDir);
        // compress the gradient so the isometric view still sees blue above the horizon
        float h = smoothstep(-0.12, 0.42, dir.y);
        vec3 col = mix(uHorizon, uTop, h);

        // soft painted cloud streaks riding the day palette
        // (precision-safe layered sinusoids instead of cell hashing; slow drift via uTime)
        // NOTE: the ortho camera always looks down at the island, so users only ever
        // see the BELOW-horizon backdrop (dir.y ~ -0.1..-0.7 across orbit/zoom range;
        // px per dir-unit ~1630 at orbit views). Bands are placed there and painted as
        // cool-tinted streaks - additive white lift would clip invisibly on the bright
        // cream horizon, a blue lift reads as distant haze/clouds.
        float clouds = 0.0;
        for (int i = 0; i < 3; i++) {
          float yc = -0.10 - float(i) * 0.17;
          float d = abs(dir.y - yc);
          vec2 q = dir.xz * (42.0 + float(i) * 14.0);
          q.x += uTime * 0.01;
          float n = 0.5 + 0.25 * (sin(q.x * 2.3 + float(i) * 1.7) * sin(q.y * 3.1 - float(i) * 2.3)
                  + 0.85 * sin((q.x + 0.6 * q.y) * 1.7 + float(i) * 4.1));
          clouds = max(clouds, (1.0 - smoothstep(0.006, 0.018, d)) * smoothstep(0.40, 0.75, n));
        }
        vec3 bandCol = col * 0.88 + vec3(0.14, 0.16, 0.26) * (1.0 - 0.55 * uNight);
        float bandA = clouds * (0.20 + 0.10 * (1.0 - uNight));
        col = mix(col, bandCol, bandA);

        float sun = pow(max(dot(dir, normalize(uSunDir)), 0.0), 26.0);
        float halo = pow(max(dot(dir, normalize(uSunDir)), 0.0), 6.0);
        col += uSunColor * (sun + halo * 0.32) * uGlow;

        // stars live high in the sky and only come out at night
        // (2D cells over dir.xz; hash is jittered so integer cell coords don't
        // collapse to a few values; point-in-cell discs instead of whole-cell squares)
        vec2 sc = dir.xz * 1600.0;
        vec2 cell = floor(sc);
        vec3 jit = vec3(cell, 0.0) * 0.173 + vec3(0.11, 0.27, 0.53);
        float h1 = hash13(jit);
        float h2 = hash13(jit + vec3(0.37, 0.61, 0.19));
        float h3 = hash13(jit + vec3(0.71, 0.13, 0.49));
        vec2 starPos = vec2(h1, h2) * 0.5 - 0.25;
        float starD = length(fract(sc) - 0.5 - starPos);
        float star = (1.0 - smoothstep(0.08, 0.30, starD)) * step(0.93, h3);
        col += vec3(0.95, 0.97, 1.0) * star * uNight * smoothstep(0.02, 0.42, dir.y);

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  }),
);
sky.frustumCulled = false;
scene.add(sky);

// ---------------------------------------------------------------------------
// lights
// ---------------------------------------------------------------------------

const sun = new THREE.DirectionalLight(0xfff1d6, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const shadowCam = sun.shadow.camera;
shadowCam.left = -30;
shadowCam.right = 30;
shadowCam.top = 30;
shadowCam.bottom = -30;
shadowCam.near = 1;
shadowCam.far = 180;
shadowCam.updateProjectionMatrix();
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.05;
sun.shadow.radius = 3;
sun.shadow.intensity = 0.82;
scene.add(sun);
scene.add(sun.target);

const hemi = new THREE.HemisphereLight(0xcfe6ff, 0x70804c, 0.7);
scene.add(hemi);

const lantern = new THREE.PointLight(0xffb46a, 0, 9, 1.7);
lantern.position.set(0, 1.1, 0);
scene.add(lantern);

// ---------------------------------------------------------------------------
// colour helpers
// ---------------------------------------------------------------------------

const tmpColor = new THREE.Color();
const grassA = new THREE.Color(0x4c8a43);
const grassB = new THREE.Color(0x89b862);
const grassC = new THREE.Color(0x33613a);
const dirt = new THREE.Color(0x917453);
const sand = new THREE.Color(0xc7ad7c);
const rock = new THREE.Color(0x6b6657);

// ---------------------------------------------------------------------------
// island mesh (radial grid so the rim is a clean circle)
// ---------------------------------------------------------------------------

const pathCurve = new THREE.CatmullRomCurve3(
  [
    new THREE.Vector3(-16, 0, 9.5),
    new THREE.Vector3(-11, 0, 8.2),
    new THREE.Vector3(-6, 0, 5.0),
    new THREE.Vector3(-2.5, 0, 1.0),
    new THREE.Vector3(-1.0, 0, -3.5),
    new THREE.Vector3(-3.5, 0, -8.5),
    new THREE.Vector3(-2.0, 0, -13.5),
    new THREE.Vector3(3.0, 0, -16.5),
    new THREE.Vector3(9.5, 0, -15.0),
    new THREE.Vector3(13.5, 0, -10.5),
  ],
  false,
  "catmullrom",
  0.4,
);
const pathSamples = pathCurve.getPoints(220);

function pathDistance(x, z) {
  let best = Infinity;
  for (let i = 0; i < pathSamples.length; i++) {
    const p = pathSamples[i];
    const dx = p.x - x;
    const dz = p.z - z;
    const d = dx * dx + dz * dz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

function terrainColorAt(x, z, y, slope) {
  const n = fbm(x * 0.15 + 4.2, z * 0.15 + 8.8, 3);
  const n2 = fbm(x * 0.52 + 1.7, z * 0.52 + 5.1, 2);
  const c = tmpColor.copy(grassA).lerp(grassB, smoothstep(0.35, 0.75, n));
  c.lerp(grassC, smoothstep(0.55, 0.95, 1 - n) * 0.7);

  // sun-warmed high ground and a little large-scale mottling
  c.lerp(new THREE.Color(0x8aa95c), clamp(y / 6, 0, 1) * 0.16 * n);
  c.multiplyScalar(0.94 + n2 * 0.12);

  // steep faces read as dirt
  c.lerp(dirt, smoothstep(0.55, 1.0, slope) * 0.55);

  // the trodden path
  const pd = pathDistance(x, z);
  const path = 1 - smoothstep(0.4, 0.95, pd + (n2 - 0.5) * 0.16);
  c.lerp(dirt, path * 0.76);
  c.multiplyScalar(1 + path * (n2 - 0.5) * 0.12);

  // pond shore
  const distPond = Math.hypot(x - POND.x, z - POND.z);
  c.lerp(sand, (1 - smoothstep(POND.r * 0.95, POND.r * 1.45, distPond)) * 0.75);

  // island rim darkens and shows rock
  const rim = smoothstep(0.8, 0.99, Math.hypot(x, z) / ISLAND_R);
  c.lerp(rock, rim * 0.9);

  return c;
}

function buildIsland() {
  const rings = 70;
  const segs = 150;
  const positions = [];
  const colors = [];
  const indices = [];

  const centerY = baseHeight(0, 0);
  positions.push(0, centerY, 0);
  const cc = terrainColorAt(0, 0, centerY, 0);
  colors.push(cc.r, cc.g, cc.b);

  for (let i = 1; i <= rings; i++) {
    const r = ISLAND_R * Math.pow(i / rings, 0.92);
    for (let j = 0; j < segs; j++) {
      const a = (j / segs) * Math.PI * 2;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = baseHeight(x, z);
      const e = 0.35;
      const slope = Math.hypot(
        (baseHeight(x + e, z) - baseHeight(x - e, z)) / (2 * e),
        (baseHeight(x, z + e) - baseHeight(x, z - e)) / (2 * e),
      );
      const col = terrainColorAt(x, z, y, slope);
      positions.push(x, y, z);
      colors.push(col.r, col.g, col.b);
    }
  }

  for (let j = 0; j < segs; j++) {
    const a = 1 + j;
    const b = 1 + ((j + 1) % segs);
    indices.push(0, b, a);
  }
  for (let i = 2; i <= rings; i++) {
    const prev = 1 + (i - 2) * segs;
    const cur = 1 + (i - 1) * segs;
    for (let j = 0; j < segs; j++) {
      const j2 = (j + 1) % segs;
      const a = prev + j;
      const b = prev + j2;
      const c = cur + j;
      const d = cur + j2;
      indices.push(a, b, c, b, d, c);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.96,
    metalness: 0,
    dithering: true,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

function buildIslandUnderside() {
  // rim ring → two tapering rock rings → apex, so the island reads as a solid
  // chunk of earth from every isometric angle.
  const segs = 96;
  const positions = [];
  const colors = [];
  const indices = [];
  const top = [];
  const mid = [];

  for (let j = 0; j < segs; j++) {
    const a = (j / segs) * Math.PI * 2;
    const x = Math.cos(a) * ISLAND_R * 0.995;
    const z = Math.sin(a) * ISLAND_R * 0.995;
    const y = baseHeight(x, z);
    top.push([x, y, z]);
    const jitter = (hash2(j * 0.7, 3.1) - 0.5) * 1.6;
    mid.push([
      x * 0.8,
      y - 3.6 + jitter,
      z * 0.8,
    ]);
  }

  const darkTop = new THREE.Color(0x3a3529);
  const darkMid = new THREE.Color(0x2a2620);
  const darkBottom = new THREE.Color(0x1c1916);

  const push = (p, c) => {
    positions.push(p[0], p[1], p[2]);
    colors.push(c.r, c.g, c.b);
    return positions.length / 3 - 1;
  };

  const topIdx = [];
  const midIdx = [];
  for (let j = 0; j < segs; j++) {
    const t = tmpColor.copy(darkTop).lerp(darkMid, hash2(j, 1.3) * 0.5);
    topIdx.push(push(top[j], t));
  }
  for (let j = 0; j < segs; j++) {
    const t = tmpColor.copy(darkMid).lerp(darkBottom, hash2(j, 7.7) * 0.6);
    midIdx.push(push(mid[j], t));
  }
  const apex = push([0, -10.5, 0], darkBottom);

  for (let j = 0; j < segs; j++) {
    const j2 = (j + 1) % segs;
    indices.push(topIdx[j], topIdx[j2], midIdx[j]);
    indices.push(topIdx[j2], midIdx[j2], midIdx[j]);
    indices.push(midIdx[j], midIdx[j2], apex);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      metalness: 0,
      flatShading: true,
    }),
  );
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

const island = buildIsland();
buildIslandUnderside();

// ---------------------------------------------------------------------------
// pond
// ---------------------------------------------------------------------------

function makeRippleNormalMap(size = 192) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(size, size);
  const H = (x, y) =>
    Math.sin(x * 0.19) * 0.55 +
    Math.sin(y * 0.16 + 1.7) * 0.5 +
    Math.sin((x + y) * 0.11) * 0.6 +
    Math.sin((x - y) * 0.27 + 0.4) * 0.25;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const hL = H(x - 1, y);
      const hR = H(x + 1, y);
      const hD = H(x, y - 1);
      const hU = H(x, y + 1);
      let nx = hL - hR;
      let ny = hD - hU;
      let nz = 2.2;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      const i = (y * size + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2.2, 2.2);
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function makePondTexture() {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(size / 2, size / 2, 8, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgb(150, 190, 195)");
  g.addColorStop(0.55, "rgb(205, 230, 225)");
  g.addColorStop(0.9, "rgb(255, 255, 255)");
  g.addColorStop(1, "rgb(240, 255, 250)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makePondAlpha() {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(size / 2, size / 2, 8, size / 2, size / 2, size / 2);
  g.addColorStop(0, "#ffffff");
  g.addColorStop(0.82, "#ffffff");
  g.addColorStop(0.94, "#8a8a8a");
  g.addColorStop(1, "#000000");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

const waterNormal = makeRippleNormalMap();
const water = new THREE.Mesh(
  new THREE.CircleGeometry(POND.r * 1.04, 96),
  new THREE.MeshPhysicalMaterial({
    color: 0x6fbfc0,
    map: makePondTexture(),
    alphaMap: makePondAlpha(),
    roughness: 0.14,
    metalness: 0,
    transparent: true,
    opacity: 0.94,
    normalMap: waterNormal,
    normalScale: new THREE.Vector2(0.65, 0.65),
    clearcoat: 0.55,
    clearcoatRoughness: 0.18,
  }),
);
water.rotation.x = -Math.PI / 2;
water.position.set(POND.x, WATER_Y, POND.z);
water.receiveShadow = true;
scene.add(water);

// fake sky reflection + sun glitter: inject sky palette colors into the water shader
let waterUniformsRef = null;
water.material.onBeforeCompile = (shader) => {
  shader.uniforms.uSkyTop = { value: new THREE.Color() };
  shader.uniforms.uSkyHorizon = { value: new THREE.Color() };
  shader.uniforms.uSunColorW = { value: new THREE.Color() };
  shader.uniforms.uNightW = { value: 0 };
  shader.uniforms.worldDaylightW = { value: 1 };
  shader.uniforms.uTimeW = { value: 0 };
  waterUniformsRef = shader.uniforms;
  water.material.userData.shader = shader;

  shader.fragmentShader =
    "uniform vec3 uSkyTop;\nuniform vec3 uSkyHorizon;\nuniform vec3 uSunColorW;\nuniform float uNightW;\nuniform float worldDaylightW;\nuniform float uTimeW;\nfloat hashW(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }\n" +
    shader.fragmentShader;
  shader.fragmentShader = shader.fragmentShader.replace(
    "#include <color_fragment>",
    /* glsl */ `
    #include <color_fragment>
    // grazing faces pick up the sky color, faking a reflection (no render targets)
    vec3 wView = normalize(vViewPosition);
    float fres = pow(1.0 - abs(dot(wView, normalize(vNormal))), 3.0);
    vec3 skyMix = mix(uSkyHorizon, uSkyTop, 0.55) * (0.55 + 0.45 * worldDaylightW);
    diffuseColor.rgb += skyMix * fres * 0.35;
    // sparse twinkling glints (drifting hash field); sun-colored, gone at night
    float sparkleN = hashW(vMapUv * 480.0 + vec2(uTimeW * 0.02, -uTimeW * 0.013));
    diffuseColor.rgb += uSunColorW * pow(sparkleN, 45.0) * 1.6 * (1.0 - uNightW);
    `,
  );
};
water.material.customProgramCacheKey = () => "pond-sky";

// lily pads
const padGeo = new THREE.CircleGeometry(0.3, 12);
const padMat = new THREE.MeshStandardMaterial({ color: 0x4f8a4a, roughness: 0.75 });
for (let i = 0; i < 7; i++) {
  const a = hash2(i, 4.1) * Math.PI * 2;
  const r = 0.8 + hash2(i, 9.2) * (POND.r - 1.3);
  const pad = new THREE.Mesh(padGeo, padMat);
  pad.rotation.x = -Math.PI / 2;
  pad.rotation.z = hash2(i, 2.2) * Math.PI;
  pad.scale.setScalar(0.6 + hash2(i, 6.3) * 0.9);
  pad.position.set(POND.x + Math.cos(a) * r, WATER_Y + 0.02, POND.z + Math.sin(a) * r);
  scene.add(pad);
}

// reeds at the shore, clumped so they read as growth rather than spikes
{
  const reedGeo = new THREE.CylinderGeometry(0.008, 0.016, 0.8, 3);
  reedGeo.translate(0, 0.4, 0);
  const reedMat = new THREE.MeshStandardMaterial({ color: 0x758348, roughness: 0.9 });
  const reeds = new THREE.InstancedMesh(reedGeo, reedMat, 54);
  const dummy = new THREE.Object3D();
  const clumps = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.4;
    clumps.push({ a, r: POND.r * (1.0 + hash2(i, 6.1) * 0.12) });
  }
  let count = 0;
  for (let i = 0; i < 54; i++) {
    const clump = clumps[i % clumps.length];
    const a = clump.a + (Math.random() - 0.5) * 0.34;
    const r = clump.r + (Math.random() - 0.5) * 0.5;
    const x = POND.x + Math.cos(a) * r;
    const z = POND.z + Math.sin(a) * r;
    const y = baseHeight(x, z);
    if (y < WATER_Y - 0.2 || y > WATER_Y + 0.55) continue;
    dummy.position.set(x, y, z);
    dummy.rotation.set((Math.random() - 0.5) * 0.22, Math.random() * Math.PI, (Math.random() - 0.5) * 0.22);
    dummy.scale.setScalar(0.6 + Math.random() * 0.7);
    dummy.updateMatrix();
    reeds.setMatrixAt(count, dummy.matrix);
    count++;
  }
  reeds.count = count;
  reeds.instanceMatrix.needsUpdate = true;
  reeds.castShadow = false;
  reeds.receiveShadow = true;
  scene.add(reeds);
}

// ---------------------------------------------------------------------------
// grass
// ---------------------------------------------------------------------------

function makeTuftGeometry() {
  // three blades fanned out around the root, so a single instance reads as a
  // tuft rather than a lonely spike
  const rows = 5;
  const height = 0.55;
  const positions = [];
  const colors = [];
  const indices = [];
  const blades = [
    { rot: 0.0, ox: 0.0, oz: 0.0, w: 1.0 },
    { rot: 1.05, ox: 0.045, oz: 0.03, w: 0.82 },
    { rot: 2.1, ox: -0.045, oz: -0.025, w: 0.9 },
  ];

  for (const b of blades) {
    const base = positions.length / 3;
    const ca = Math.cos(b.rot);
    const sa = Math.sin(b.rot);
    for (let i = 0; i < rows; i++) {
      const t = i / (rows - 1);
      const y = height * t;
      const w = 0.046 * (1 - t * 0.9) * b.w;
      const bend = t * t * 0.1;
      for (const sgn of [-1, 1]) {
        const lx = sgn * w;
        const lz = bend;
        positions.push(lx * ca + lz * sa + b.ox, y, -lx * sa + lz * ca + b.oz);
        const shade = 0.46 + 0.54 * t;
        colors.push(shade * 0.9, shade, shade * 0.86);
      }
    }
    for (let i = 0; i < rows - 1; i++) {
      const a = base + i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

const grassMaterial = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  vertexColors: true,
  roughness: 0.88,
  metalness: 0,
  side: THREE.DoubleSide,
});
grassMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.uTime = { value: 0 };
  shader.uniforms.uWind = { value: 1 };
  grassMaterial.userData.shader = shader;

  shader.vertexShader = "uniform float uTime;\nuniform float uWind;\n" + shader.vertexShader;
  shader.vertexShader = shader.vertexShader.replace(
    "#include <begin_vertex>",
    /* glsl */ `
    #include <begin_vertex>
    vec3 iPos = instanceMatrix[3].xyz;
    float phase = iPos.x * 0.42 + iPos.z * 0.33;
    float bend = pow(clamp(transformed.y / 0.55, 0.0, 1.0), 2.0);
    float sway = sin(uTime * 1.7 + phase) * 0.09 + sin(uTime * 3.3 + phase * 1.9) * 0.028;
    transformed.x += sway * bend * uWind;
    transformed.z += sway * 0.55 * bend * uWind;
    `,
  );
};
grassMaterial.customProgramCacheKey = () => "grass-wind";

function scatterGrass() {
  const count = 22000;
  const geo = makeTuftGeometry();
  const mesh = new THREE.InstancedMesh(geo, grassMaterial, count);
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();

  let placed = 0;
  let guard = 0;
  while (placed < count && guard < count * 10) {
    guard++;
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * ISLAND_R * 0.97;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const y = baseHeight(x, z);
    if (Math.hypot(x - POND.x, z - POND.z) < POND.r * 1.04) continue;
    if (pathDistance(x, z) < 1.05) continue;

    // clumping: thin out tufts in low-density noise areas, but leave no bald lawn
    const density = fbm(x * 0.12 + 31.7, z * 0.12 + 12.3, 3);
    if (Math.random() > 0.76 + density * 0.4) continue;

    const s = 0.6 + Math.random() * 0.7;
    dummy.position.set(x, y - 0.02, z);
    dummy.rotation.set((Math.random() - 0.5) * 0.16, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.16);
    dummy.scale.set(0.9 + Math.random() * 0.45, s, 0.9 + Math.random() * 0.45);
    dummy.updateMatrix();
    mesh.setMatrixAt(placed, dummy.matrix);

    color.setHSL(0.245 + Math.random() * 0.05, 0.4 + Math.random() * 0.2, 0.41 + Math.random() * 0.14);
    mesh.setColorAt(placed, color);
    placed++;
  }

  mesh.count = placed;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  scene.add(mesh);
  return mesh;
}

const grass = scatterGrass();
const tuftField = grass; // addressable for the quality watchdog

// ---------------------------------------------------------------------------
// wildflowers
// ---------------------------------------------------------------------------

function scatterFlowers() {
  const clusters = [];
  for (let i = 0; i < 20; i++) {
    const a = hash2(i, 5.5) * Math.PI * 2;
    const r = 3 + hash2(i, 8.1) * (ISLAND_R - 6);
    clusters.push({ x: Math.cos(a) * r, z: Math.sin(a) * r });
  }

  const palette = [0xffe9a8, 0xffcf5e, 0xf6a9c2, 0xc7aef2, 0xfff6e0, 0xff9f7d, 0xffe08a];
  const count = 800;
  const geo = new THREE.IcosahedronGeometry(0.06, 0);
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0 });
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();

  let placed = 0;
  let guard = 0;
  while (placed < count && guard < count * 12) {
    guard++;
    const cluster = clusters[Math.floor(Math.random() * clusters.length)];
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * 2.8;
    const x = cluster.x + Math.cos(a) * r;
    const z = cluster.z + Math.sin(a) * r;
    if (Math.hypot(x, z) > ISLAND_R * 0.94) continue;
    const y = baseHeight(x, z);
    if (Math.hypot(x - POND.x, z - POND.z) < POND.r * 1.08) continue;
    if (pathDistance(x, z) < 1.0) continue;

    dummy.position.set(x, y + 0.18 + Math.random() * 0.26, z);
    dummy.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
    dummy.scale.setScalar(0.7 + Math.random() * 0.8);
    dummy.updateMatrix();
    mesh.setMatrixAt(placed, dummy.matrix);
    color.setHex(palette[Math.floor(Math.random() * palette.length)]);
    color.offsetHSL(0, (Math.random() - 0.5) * 0.06, (Math.random() - 0.5) * 0.06);
    mesh.setColorAt(placed, color);
    placed++;
  }
  mesh.count = placed;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false;
  scene.add(mesh);
  return mesh;
}

scatterFlowers();

// ---------------------------------------------------------------------------
// trees
// ---------------------------------------------------------------------------

const treeSway = [];
const treeSpots = [
  { x: -8.5, z: -9.5, s: 1.45 },
  { x: -13.5, z: 3.0, s: 1.05 },
  { x: 3.5, z: 12.5, s: 1.2 },
  { x: 12.5, z: 9.0, s: 0.95 },
  { x: 15.5, z: -2.0, s: 1.15 },
  { x: -5.0, z: 14.5, s: 0.9 },
  { x: 9.5, z: 14.0, s: 1.05 },
  { x: -17.5, z: -5.0, s: 0.85 },
  { x: 1.0, z: -17.5, s: 0.95 },
  { x: 18.5, z: 4.0, s: 0.8 },
];

const trunkGeo = new THREE.CylinderGeometry(0.13, 0.22, 1.55, 6);
trunkGeo.translate(0, 0.775, 0);
const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5f4230, roughness: 0.95, flatShading: true });
const canopyGeo = new THREE.IcosahedronGeometry(0.78, 0);
const canopyMatA = new THREE.MeshStandardMaterial({ color: 0x3a7038, roughness: 0.9, flatShading: true });
const canopyMatB = new THREE.MeshStandardMaterial({ color: 0x5a9444, roughness: 0.9, flatShading: true });
const canopyMatC = new THREE.MeshStandardMaterial({ color: 0x74a84f, roughness: 0.9, flatShading: true });

function addTree({ x, z, s }) {
  const y = baseHeight(x, z);
  if (Math.hypot(x - POND.x, z - POND.z) < POND.r * 1.3) return;

  const group = new THREE.Group();
  group.position.set(x, y - 0.05, z);
  group.rotation.y = hash2(x, z) * Math.PI * 2;
  group.scale.setScalar(s);

  const trunk = new THREE.Mesh(trunkGeo, trunkMat);
  trunk.castShadow = true;
  trunk.receiveShadow = true;
  group.add(trunk);

  const crown = new THREE.Group();
  crown.position.y = 1.4;
  group.add(crown);

  const blobs = [
    { p: [0, 0.38, 0], r: 1.08, m: canopyMatA },
    { p: [0.52, 0.14, 0.26], r: 0.8, m: canopyMatB },
    { p: [-0.44, 0.16, -0.32], r: 0.84, m: canopyMatA },
    { p: [0.04, 0.82, -0.14], r: 0.7, m: canopyMatC },
    { p: [-0.3, 0.55, 0.38], r: 0.58, m: canopyMatB },
  ];
  for (const b of blobs) {
    const mesh = new THREE.Mesh(canopyGeo, b.m);
    mesh.position.set(b.p[0], b.p[1], b.p[2]);
    mesh.scale.set(b.r, b.r * 0.82, b.r);
    mesh.rotation.set(hash2(b.p[0], 1.2) * 3, hash2(b.p[2], 2.4) * 3, 0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    crown.add(mesh);
  }

  scene.add(group);
  treeSway.push({ crown, phase: hash2(x, z) * 6.28, s: s });
}

treeSpots.forEach(addTree);

// ---------------------------------------------------------------------------
// rocks
// ---------------------------------------------------------------------------

{
  const count = 26;
  const geo = new THREE.DodecahedronGeometry(0.4, 0);
  const mat = new THREE.MeshStandardMaterial({ color: 0x8a8577, roughness: 1, flatShading: true });
  const rocks = new THREE.InstancedMesh(geo, mat, count);
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();

  let placed = 0;
  let guard = 0;
  while (placed < count && guard < count * 40) {
    guard++;
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * ISLAND_R * 0.93;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const y = baseHeight(x, z);
    if (Math.hypot(x - POND.x, z - POND.z) < POND.r * 1.12) continue;
    if (Math.hypot(x - SPAWN.x, z - SPAWN.z) < 3) continue;

    dummy.position.set(x, y - 0.05, z);
    dummy.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    dummy.scale.set(0.5 + Math.random() * 1.3, 0.35 + Math.random() * 0.8, 0.5 + Math.random() * 1.2);
    dummy.updateMatrix();
    rocks.setMatrixAt(placed, dummy.matrix);
    color.setHSL(0.1, 0.06, 0.4 + Math.random() * 0.2);
    rocks.setColorAt(placed, color);
    placed++;
  }
  rocks.count = placed;
  rocks.instanceMatrix.needsUpdate = true;
  if (rocks.instanceColor) rocks.instanceColor.needsUpdate = true;
  rocks.castShadow = true;
  rocks.receiveShadow = true;
  rocks.frustumCulled = false;
  scene.add(rocks);
}

// shrubs — low clumps that break up the open meadow
{
  const blobGeo = new THREE.IcosahedronGeometry(0.4, 0);
  const g1 = blobGeo.clone();
  const g2 = blobGeo.clone().translate(0.3, 0.08, 0.12).scale(0.75, 0.7, 0.75);
  const g3 = blobGeo.clone().translate(-0.24, 0.04, -0.16).scale(0.65, 0.6, 0.7);
  const shrubGeo = mergeGeometries([g1, g2, g3]);

  const count = 34;
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.92, flatShading: true });
  const shrubs = new THREE.InstancedMesh(shrubGeo, mat, count);
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();

  let placed = 0;
  let guard = 0;
  while (placed < count && guard < count * 60) {
    guard++;
    let x;
    let z;
    if (Math.random() < 0.6) {
      const t = treeSpots[Math.floor(Math.random() * treeSpots.length)];
      const a = Math.random() * Math.PI * 2;
      const r = 1.4 + Math.random() * 2.6;
      x = t.x + Math.cos(a) * r;
      z = t.z + Math.sin(a) * r;
    } else {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * ISLAND_R * 0.88;
      x = Math.cos(a) * r;
      z = Math.sin(a) * r;
    }
    if (Math.hypot(x, z) > ISLAND_R * 0.92) continue;
    const y = baseHeight(x, z);
    if (Math.hypot(x - POND.x, z - POND.z) < POND.r * 1.15) continue;
    if (pathDistance(x, z) < 1.6) continue;
    if (Math.hypot(x - SPAWN.x, z - SPAWN.z) < 4) continue;

    dummy.position.set(x, y + 0.06, z);
    dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
    dummy.scale.set(0.7 + Math.random() * 0.8, 0.55 + Math.random() * 0.5, 0.7 + Math.random() * 0.8);
    dummy.updateMatrix();
    shrubs.setMatrixAt(placed, dummy.matrix);
    color.setHSL(0.29 + Math.random() * 0.04, 0.34 + Math.random() * 0.16, 0.26 + Math.random() * 0.1);
    shrubs.setColorAt(placed, color);
    placed++;
  }
  shrubs.count = placed;
  shrubs.instanceMatrix.needsUpdate = true;
  if (shrubs.instanceColor) shrubs.instanceColor.needsUpdate = true;
  shrubs.castShadow = true;
  shrubs.receiveShadow = true;
  shrubs.frustumCulled = false;
  scene.add(shrubs);
}

// ---------------------------------------------------------------------------
// a ring of standing stones (a quiet landmark)
// ---------------------------------------------------------------------------

{
  const cx = -12.5;
  const cz = 10.5;
  const stoneGeo = new THREE.BoxGeometry(0.34, 0.95, 0.28);
  const stoneMat = new THREE.MeshStandardMaterial({ color: 0x8d8878, roughness: 1, flatShading: true });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const x = cx + Math.cos(a) * 1.6;
    const z = cz + Math.sin(a) * 1.6;
    const stone = new THREE.Mesh(stoneGeo, stoneMat);
    stone.position.set(x, baseHeight(x, z) + 0.36, z);
    stone.rotation.set((hash2(i, 3.3) - 0.5) * 0.2, a + hash2(i, 1.1), (hash2(i, 8.8) - 0.5) * 0.2);
    stone.scale.y = 0.7 + hash2(i, 4.4) * 0.6;
    stone.castShadow = true;
    stone.receiveShadow = true;
    scene.add(stone);
  }
}

// ---------------------------------------------------------------------------
// player
// ---------------------------------------------------------------------------

function makeGlowTexture(inner = "rgba(255,255,255,1)", outer = "rgba(255,255,255,0)") {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, inner);
  g.addColorStop(0.4, "rgba(255,255,255,0.45)");
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const player = new THREE.Group();
const bodyPivot = new THREE.Group();
player.add(bodyPivot);

const coatMat = new THREE.MeshStandardMaterial({ color: 0xc4553f, roughness: 0.8 });
const skinMat = new THREE.MeshStandardMaterial({ color: 0xe8b28a, roughness: 0.85 });
const hatMat = new THREE.MeshStandardMaterial({ color: 0xe4cf9b, roughness: 0.9 });
const packMat = new THREE.MeshStandardMaterial({ color: 0x3f6f6a, roughness: 0.85 });
const bootMat = new THREE.MeshStandardMaterial({ color: 0x4a3a2e, roughness: 0.9 });

const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.145, 0.16, 4, 10), coatMat);
torso.position.y = 0.36;
torso.castShadow = true;
bodyPivot.add(torso);

const head = new THREE.Mesh(new THREE.SphereGeometry(0.125, 18, 14), skinMat);
head.position.y = 0.585;
head.castShadow = true;
bodyPivot.add(head);

const hatBrim = new THREE.Mesh(new THREE.CylinderGeometry(0.205, 0.205, 0.018, 16), hatMat);
hatBrim.position.y = 0.655;
bodyPivot.add(hatBrim);
const hatTop = new THREE.Mesh(new THREE.ConeGeometry(0.115, 0.13, 14), hatMat);
hatTop.position.y = 0.725;
hatTop.castShadow = true;
bodyPivot.add(hatTop);

const pack = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.2, 0.105), packMat);
pack.position.set(0, 0.4, -0.15);
pack.castShadow = true;
bodyPivot.add(pack);

const footGeo = new THREE.BoxGeometry(0.075, 0.055, 0.135);
const footL = new THREE.Mesh(footGeo, bootMat);
const footR = new THREE.Mesh(footGeo, bootMat);
footL.position.set(-0.065, 0.03, 0.01);
footR.position.set(0.065, 0.03, 0.01);
footL.castShadow = true;
footR.castShadow = true;
bodyPivot.add(footL, footR);

// contact shadow
const blobShadow = new THREE.Mesh(
  new THREE.CircleGeometry(0.3, 24),
  new THREE.MeshBasicMaterial({
    map: makeGlowTexture("rgba(0,0,0,0.55)", "rgba(0,0,0,0)"),
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
  }),
);
blobShadow.rotation.x = -Math.PI / 2;
blobShadow.position.y = 0.03;
blobShadow.renderOrder = 2;
player.add(blobShadow);

player.position.set(SPAWN.x, baseHeight(SPAWN.x, SPAWN.z), SPAWN.z);
player.scale.setScalar(1.12);
scene.add(player);

const lanternGlow = new THREE.Sprite(
  new THREE.SpriteMaterial({
    map: makeGlowTexture("rgba(255,205,140,1)", "rgba(255,170,80,0)"),
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }),
);
lanternGlow.scale.setScalar(1.7);
lanternGlow.position.set(0, 0.75, 0);
player.add(lanternGlow);

// ---------------------------------------------------------------------------
// fireflies
// ---------------------------------------------------------------------------

const FIREFLY_COUNT = 130;
const fireflyGeo = new THREE.BufferGeometry();
const fireflyPos = new Float32Array(FIREFLY_COUNT * 3);
const fireflySeeds = [];
for (let i = 0; i < FIREFLY_COUNT; i++) {
  const a = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random()) * ISLAND_R * 0.9;
  const x = Math.cos(a) * r;
  const z = Math.sin(a) * r;
  fireflySeeds.push({
    x,
    z,
    baseY: Math.max(baseHeight(x, z), WATER_Y) + 0.35 + Math.random() * 1.4,
    phase: Math.random() * Math.PI * 2,
    speed: 0.25 + Math.random() * 0.5,
  });
  fireflyPos[i * 3] = x;
  fireflyPos[i * 3 + 1] = fireflySeeds[i].baseY;
  fireflyPos[i * 3 + 2] = z;
}
fireflyGeo.setAttribute("position", new THREE.BufferAttribute(fireflyPos, 3));
const fireflyMat = new THREE.PointsMaterial({
  size: 0.14,
  map: makeGlowTexture(),
  color: 0xffe6a0,
  transparent: true,
  opacity: 0,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  sizeAttenuation: true,
});
const fireflies = new THREE.Points(fireflyGeo, fireflyMat);
fireflies.frustumCulled = false;
scene.add(fireflies);

// ---------------------------------------------------------------------------
// butterflies + drifting pollen
// ---------------------------------------------------------------------------

const butterflyWingGeo = new THREE.CircleGeometry(0.1, 5);
butterflyWingGeo.translate(0.085, 0, 0);
const butterflyMats = [
  new THREE.MeshStandardMaterial({ color: 0xffcf72, roughness: 0.7, side: THREE.DoubleSide }),
  new THREE.MeshStandardMaterial({ color: 0xf3a3bd, roughness: 0.7, side: THREE.DoubleSide }),
  new THREE.MeshStandardMaterial({ color: 0xd6c2f2, roughness: 0.7, side: THREE.DoubleSide }),
];
const butterflyBodyMat = new THREE.MeshStandardMaterial({ color: 0x40342b, roughness: 0.9 });
const butterflies = [];
const butterflySpots = [
  { x: 9.0, z: 0.5 },
  { x: -6.0, z: 7.5 },
  { x: 12.5, z: 7.0 },
  { x: -10.5, z: -3.0 },
  { x: 2.5, z: -9.5 },
  { x: -1.5, z: 13.5 },
];

for (let i = 0; i < butterflySpots.length; i++) {
  const spot = butterflySpots[i];
  const group = new THREE.Group();
  const mat = butterflyMats[i % butterflyMats.length];

  const leftPivot = new THREE.Group();
  const rightPivot = new THREE.Group();
  const leftWing = new THREE.Mesh(butterflyWingGeo, mat);
  const rightWing = new THREE.Mesh(butterflyWingGeo, mat);
  leftWing.rotation.x = -Math.PI / 2;
  rightWing.rotation.x = -Math.PI / 2;
  leftWing.scale.x = -1;
  leftPivot.add(leftWing);
  rightPivot.add(rightWing);
  group.add(leftPivot, rightPivot);

  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.11, 5), butterflyBodyMat);
  body.rotation.x = Math.PI / 2;
  group.add(body);

  const groundY = Math.max(baseHeight(spot.x, spot.z), WATER_Y);
  group.position.set(spot.x, groundY + 0.8, spot.z);
  scene.add(group);

  butterflies.push({
    group,
    leftPivot,
    rightPivot,
    center: new THREE.Vector3(spot.x, groundY + 0.7, spot.z),
    radius: 1.2 + hash2(i, 3.7) * 1.6,
    speed: 0.24 + hash2(i, 8.2) * 0.18,
    phase: hash2(i, 1.9) * Math.PI * 2,
    flap: 9 + hash2(i, 5.2) * 4,
  });
}

const POLLEN_COUNT = 240;
const pollenGeo = new THREE.BufferGeometry();
const pollenPos = new Float32Array(POLLEN_COUNT * 3);
const pollenSeeds = [];
for (let i = 0; i < POLLEN_COUNT; i++) {
  const a = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random()) * ISLAND_R * 0.95;
  const x = Math.cos(a) * r;
  const z = Math.sin(a) * r;
  const y = baseHeight(x, z) + 0.3 + Math.random() * 2.4;
  pollenSeeds.push({ x, z, y, phase: Math.random() * Math.PI * 2 });
  pollenPos[i * 3] = x;
  pollenPos[i * 3 + 1] = y;
  pollenPos[i * 3 + 2] = z;
}
pollenGeo.setAttribute("position", new THREE.BufferAttribute(pollenPos, 3));
const pollenMat = new THREE.PointsMaterial({
  size: 0.05,
  map: makeGlowTexture(),
  color: 0xfff0c4,
  transparent: true,
  opacity: 0.5,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  sizeAttenuation: true,
});
const pollen = new THREE.Points(pollenGeo, pollenMat);
pollen.frustumCulled = false;
scene.add(pollen);

function updateCritters(t, elapsed) {
  const showButterflies = worldDaylight > 0.22 && qualityLevel < 3;
  for (const b of butterflies) {
    b.group.visible = showButterflies;
    if (!showButterflies) continue;
    const a = t * b.speed + b.phase;
    b.group.position.set(
      b.center.x + Math.cos(a) * b.radius,
      b.center.y + Math.sin(a * 1.7) * 0.35 + Math.sin(t * 0.9 + b.phase) * 0.15,
      b.center.z + Math.sin(a * 1.13) * b.radius,
    );
    b.group.rotation.y = -a + Math.PI / 2;
    const flap = Math.sin(t * b.flap + b.phase) * (0.25 + 0.65 * motionScale);
    b.leftPivot.rotation.z = -flap;
    b.rightPivot.rotation.z = flap;
  }

  const pos = pollenGeo.attributes.position.array;
  for (let i = 0; i < POLLEN_COUNT; i++) {
    const s = pollenSeeds[i];
    pos[i * 3] = s.x + Math.sin(t * 0.25 + s.phase) * 0.7;
    pos[i * 3 + 1] = s.y + Math.sin(t * 0.4 + s.phase * 1.7) * 0.35;
    pos[i * 3 + 2] = s.z + Math.cos(t * 0.21 + s.phase) * 0.7;
  }
  pollenGeo.attributes.position.needsUpdate = true;
  pollenMat.opacity = 0.12 + 0.4 * worldDaylight;
}

// ---------------------------------------------------------------------------
// cloud shadows
// ---------------------------------------------------------------------------

function makeSoftBlob() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(128, 128, 10, 128, 128, 126);
  g.addColorStop(0, "rgba(255,255,255,0.85)");
  g.addColorStop(0.55, "rgba(255,255,255,0.35)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const cloudTexture = makeSoftBlob();
const clouds = [];
for (let i = 0; i < 4; i++) {
  const mat = new THREE.MeshBasicMaterial({
    map: cloudTexture,
    color: 0x0b141c,
    transparent: true,
    opacity: 0.14,
    depthWrite: false,
  });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(26, 20), mat);
  plane.rotation.x = -Math.PI / 2;
  plane.rotation.z = Math.random() * Math.PI;
  plane.position.set((Math.random() - 0.5) * 50, 4.2, (Math.random() - 0.5) * 50);
  plane.renderOrder = 1;
  scene.add(plane);
  clouds.push({ mesh: plane, speed: 0.35 + Math.random() * 0.35, drift: Math.random() * 10 });
}

// ---------------------------------------------------------------------------
// vignette spots
// ---------------------------------------------------------------------------

const spots = [
  {
    x: -8.5,
    z: -9.5,
    r: 3.0,
    text: "The oldest tree on the island leans a little to the west, as if listening for something.",
    seen: -999,
  },
  {
    x: POND.x - 2.6,
    z: POND.z + 2.6,
    r: 2.6,
    text: "The water is warm. Something small turns over under the surface, then thinks better of it.",
    seen: -999,
  },
  {
    x: -12.5,
    z: 10.5,
    r: 2.8,
    text: "Six stones, standing in a ring. Nobody remembers stacking them. Nobody moved them either.",
    seen: -999,
  },
  {
    x: 12.0,
    z: 8.5,
    r: 2.8,
    text: "A whole field of flowers, all facing the same way. You feel oddly rude walking through.",
    seen: -999,
  },
  {
    x: 2.0,
    z: 11.0,
    r: 2.6,
    text: "From up here the island looks small enough to fold up and put in your pocket.",
    seen: -999,
  },
];

let captionTimer = 0;
function showCaption(text) {
  captionEl.textContent = text;
  captionEl.classList.add("visible");
  clearTimeout(captionTimer);
  captionTimer = window.setTimeout(() => captionEl.classList.remove("visible"), 8200);
}

// ---------------------------------------------------------------------------
// input
// ---------------------------------------------------------------------------

const keys = new Set();
const KEYMAP = {
  KeyW: "up",
  ArrowUp: "up",
  KeyS: "down",
  ArrowDown: "down",
  KeyA: "left",
  ArrowLeft: "left",
  KeyD: "right",
  ArrowRight: "right",
};

window.addEventListener("keydown", (e) => {
  const dir = KEYMAP[e.code];
  if (dir) {
    keys.add(dir);
    e.preventDefault();
    hintEl.classList.add("hidden");
  }
});
window.addEventListener("keyup", (e) => {
  const dir = KEYMAP[e.code];
  if (dir) keys.delete(dir);
});
window.addEventListener("blur", () => keys.clear());

let azimuth = Math.PI * 0.25;
let polar = 0.955;
let dragging = false;
let lastPointer = { x: 0, y: 0 };
let interacting = 0;

canvas.addEventListener("pointerdown", (e) => {
  dragging = true;
  interacting = 1;
  lastPointer = { x: e.clientX, y: e.clientY };
  canvas.classList.add("dragging");
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const dx = e.clientX - lastPointer.x;
  const dy = e.clientY - lastPointer.y;
  lastPointer = { x: e.clientX, y: e.clientY };
  azimuth -= dx * 0.005;
  polar = clamp(polar - dy * 0.004, 0.72, 1.22);
});
const endDrag = (e) => {
  dragging = false;
  canvas.classList.remove("dragging");
  if (e && e.pointerId !== undefined && canvas.hasPointerCapture(e.pointerId)) {
    canvas.releasePointerCapture(e.pointerId);
  }
};
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    zoom = clamp(zoom * (1 - e.deltaY * 0.0012), 0.65, 2.1);
    applyCameraFrustum();
    hintEl.classList.add("hidden");
  },
  { passive: false },
);

// ---------------------------------------------------------------------------
// atmosphere / day cycle
// ---------------------------------------------------------------------------

const dayPalette = {
  skyTopDay: new THREE.Color(0x6fa8dc),
  skyTopNight: new THREE.Color(0x0a1126),
  horizonDay: new THREE.Color(0xf7e2bd),
  horizonNight: new THREE.Color(0x28304f),
  sunHigh: new THREE.Color(0xfff2d6),
  sunLow: new THREE.Color(0xff8f4c),
  hemiSkyDay: new THREE.Color(0xd2e7ff),
  hemiSkyNight: new THREE.Color(0x35406c),
  hemiGroundDay: new THREE.Color(0x6f7d49),
  hemiGroundNight: new THREE.Color(0x191f16),
  fogDay: new THREE.Color(0xd9e5de),
  fogNight: new THREE.Color(0x1c2334),
  waterDay: new THREE.Color(0x6fbfc0),
  waterNight: new THREE.Color(0x2a4a52),
};

const sunDir = new THREE.Vector3();
let worldDaylight = 1;

function updateAtmosphere(dt, elapsed) {
  // 6 minute loop, starting in the afternoon: sunset arrives after ~2 minutes
  const cycle = (elapsed / 360 + 0.42) % 1;
  const day = 0.5 + 0.5 * Math.sin(cycle * Math.PI * 2);
  const daylight = smoothstep(0.08, 0.58, day);
  const night = 1 - daylight;
  worldDaylight = daylight;

  const elevation = THREE.MathUtils.degToRad(13 + 27 * daylight);
  const sunAz = 2.25 + elapsed * 0.004;
  // ambMix keeps dusk golden instead of snapping to night colors
  const ambMix = Math.pow(daylight, 0.55);
  sunDir.set(
    Math.cos(sunAz) * Math.cos(elevation),
    Math.sin(elevation),
    Math.sin(sunAz) * Math.cos(elevation),
  );
  sun.position.copy(sunDir).multiplyScalar(90);
  sun.target.position.set(0, 0, 0);

  sun.color.lerpColors(dayPalette.sunLow, dayPalette.sunHigh, daylight * daylight);
  sun.intensity = 0.5 + 2.9 * daylight;
  sun.shadow.intensity = 0.5 + 0.3 * daylight;

  hemi.color.lerpColors(dayPalette.hemiSkyNight, dayPalette.hemiSkyDay, ambMix);
  hemi.groundColor.lerpColors(dayPalette.hemiGroundNight, dayPalette.hemiGroundDay, ambMix);
  hemi.intensity = 0.68 + 0.37 * daylight;

  scene.fog.color.lerpColors(dayPalette.fogNight, dayPalette.fogDay, ambMix);
  scene.fog.near = 105 - 25 * night;
  scene.fog.far = 300 - 60 * night;

  skyUniforms.uTop.value.lerpColors(dayPalette.skyTopNight, dayPalette.skyTopDay, ambMix);
  skyUniforms.uHorizon.value.lerpColors(dayPalette.horizonNight, dayPalette.horizonDay, ambMix);
  skyUniforms.uSunColor.value.lerpColors(dayPalette.sunLow, dayPalette.sunHigh, daylight);
  skyUniforms.uSunDir.value.copy(sunDir);
  skyUniforms.uNight.value = night * night;
  skyUniforms.uGlow.value = 0.5 + 0.55 * (1 - daylight);

  water.material.color.lerpColors(dayPalette.waterNight, dayPalette.waterDay, ambMix);
  water.material.opacity = 0.94;

  if (waterUniformsRef) {
    waterUniformsRef.uSkyTop.value.copy(skyUniforms.uTop.value);
    waterUniformsRef.uSkyHorizon.value.copy(skyUniforms.uHorizon.value);
    waterUniformsRef.uSunColorW.value.copy(skyUniforms.uSunColor.value);
    waterUniformsRef.uNightW.value = skyUniforms.uNight.value;
    waterUniformsRef.worldDaylightW.value = worldDaylight;
    waterUniformsRef.uTimeW.value = skyUniforms.uTime.value;
  }

  const firefly = smoothstep(0.45, 0.05, daylight);
  fireflyMat.opacity = firefly * (reduceMotion ? 0.5 : 0.95);
  lantern.intensity = firefly * 7;
  lanternGlow.material.opacity = firefly * 0.4;
  renderer.toneMappingExposure = 0.94 + 0.08 * daylight;

  // fireflies drift
  const t = elapsed * motionScale;
  const pos = fireflyGeo.attributes.position.array;
  for (let i = 0; i < FIREFLY_COUNT; i++) {
    const s = fireflySeeds[i];
    const ft = t * s.speed + s.phase;
    pos[i * 3] = s.x + Math.sin(ft * 0.7) * 0.9;
    pos[i * 3 + 1] = s.baseY + Math.sin(ft * 1.3 + 1.2) * 0.4;
    pos[i * 3 + 2] = s.z + Math.cos(ft * 0.55 + 2.1) * 0.9;
  }
  fireflyGeo.attributes.position.needsUpdate = true;

  // cloud shadows drift
  for (const c of clouds) {
    const m = c.mesh;
    m.position.x += c.speed * motionScale * dt;
    m.position.z += c.speed * 0.4 * motionScale * dt;
    if (m.position.x > 34) m.position.x = -34;
    if (m.position.z > 34) m.position.z = -34;
    m.material.opacity = 0.05 + 0.12 * daylight;
  }
}

// ---------------------------------------------------------------------------
// walking
// ---------------------------------------------------------------------------

const velocity = new THREE.Vector3();
const desiredVelocity = new THREE.Vector3();
const forwardVec = new THREE.Vector3();
const rightVec = new THREE.Vector3();
const moveDir = new THREE.Vector3();
const camTarget = new THREE.Vector3();
const camDesired = new THREE.Vector3();

let yaw = Math.PI;
let walkPhase = 0;
let playerY = baseHeight(SPAWN.x, SPAWN.z);
let idleTime = 0;
let captionCooldown = 0;

const WALK_SPEED = 2.4;

function walkable(x, z) {
  const r = Math.hypot(x, z);
  if (r > ISLAND_R * 0.9) return false;
  // only the pond itself blocks walking — low valleys are open meadow
  return Math.hypot(x - POND.x, z - POND.z) > POND.r * 1.02;
}

function updatePlayer(dt, elapsed) {
  const xin = (keys.has("right") ? 1 : 0) - (keys.has("left") ? 1 : 0);
  const zin = (keys.has("up") ? 1 : 0) - (keys.has("down") ? 1 : 0);
  const moving = xin !== 0 || zin !== 0;

  if (moving) {
    interacting = 1;
    idleTime = 0;
    hintEl.classList.add("hidden");
  } else {
    idleTime += dt;
  }

  forwardVec.set(-Math.sin(azimuth), 0, -Math.cos(azimuth));
  rightVec.set(Math.cos(azimuth), 0, -Math.sin(azimuth));

  moveDir
    .copy(forwardVec)
    .multiplyScalar(zin)
    .addScaledVector(rightVec, xin);

  if (moveDir.lengthSq() > 0) moveDir.normalize();
  desiredVelocity.copy(moveDir).multiplyScalar(WALK_SPEED);

  const accel = 1 - Math.exp(-9 * dt);
  velocity.lerp(desiredVelocity, accel);
  if (velocity.lengthSq() < 1e-4) velocity.set(0, 0, 0);

  const step = velocity.clone().multiplyScalar(dt);
  let nx = player.position.x + step.x;
  let nz = player.position.z + step.z;

  if (!walkable(nx, nz)) {
    // slide along whichever axis still works, so pond and rim edges feel solid
    if (walkable(nx, player.position.z)) {
      nz = player.position.z;
    } else if (walkable(player.position.x, nz)) {
      nx = player.position.x;
    } else {
      nx = player.position.x;
      nz = player.position.z;
      velocity.multiplyScalar(0.2);
    }
  }

  player.position.x = nx;
  player.position.z = nz;
  const groundY = baseHeight(nx, nz);
  playerY = lerp(playerY, groundY, 1 - Math.exp(-14 * dt));
  player.position.y = playerY;

  const speed = velocity.length();
  if (speed > 0.05) {
    yaw = angleLerp(yaw, Math.atan2(velocity.x, velocity.z), 1 - Math.exp(-12 * dt));
  }
  player.rotation.y = yaw;

  // stride
  walkPhase += speed * dt * 5.2;
  const stride = reduceMotion ? 0 : Math.sin(walkPhase);
  const bob = reduceMotion ? 0 : Math.abs(Math.sin(walkPhase)) * 0.035 * clamp(speed / WALK_SPEED, 0, 1);

  bodyPivot.position.y = bob;
  bodyPivot.rotation.z = (reduceMotion ? 0 : Math.sin(walkPhase * 0.5) * 0.02) * clamp(speed, 0, 1);
  bodyPivot.rotation.x = (reduceMotion ? 0 : clamp(speed / WALK_SPEED, 0, 1) * 0.06);

  footL.position.z = 0.01 + stride * 0.075 * clamp(speed, 0, 1);
  footR.position.z = 0.01 - stride * 0.075 * clamp(speed, 0, 1);
  footL.position.y = 0.03 + Math.max(0, stride) * 0.035;
  footR.position.y = 0.03 + Math.max(0, -stride) * 0.035;

  // idle breathing
  if (speed < 0.05 && !reduceMotion) {
    const breath = Math.sin(elapsed * 1.5) * 0.006;
    torso.scale.y = 1 + breath;
    head.position.y = 0.585 + breath * 0.5;
  }

  // blob shadow hugs the ground
  blobShadow.position.y = 0.03 + (playerY - groundY) * -1;

  lantern.position.set(nx, playerY + 1.0, nz);

  // vignettes
  captionCooldown = Math.max(0, captionCooldown - dt);
  if (captionCooldown === 0) {
    for (const spot of spots) {
      const d = Math.hypot(nx - spot.x, nz - spot.z);
      if (d < spot.r && elapsed - spot.seen > 24) {
        spot.seen = elapsed;
        captionCooldown = 12;
        showCaption(spot.text);
        break;
      }
    }
  }
}

function angleLerp(a, b, t) {
  let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

// ---------------------------------------------------------------------------
// camera
// ---------------------------------------------------------------------------

const CAM_DISTANCE = 70;

function updateCamera(dt, elapsed) {
  camTarget.set(player.position.x, player.position.y + 0.45, player.position.z);

  // gentle idle drift, never while dragging
  let az = azimuth;
  if (!reduceMotion && !dragging && idleTime > 2.5) {
    az += Math.sin(elapsed * 0.11) * 0.02;
  }

  camDesired.setFromSphericalCoords(CAM_DISTANCE, polar, az).add(camTarget);
  const k = 1 - Math.exp(-5 * dt);
  camera.position.lerp(camDesired, k);
  camera.lookAt(camTarget);
}

// ---------------------------------------------------------------------------
// loop
// ---------------------------------------------------------------------------

// `?time=140` fast-forwards the day cycle (seconds) — handy for previewing dusk/night
const startTime = Number(new URLSearchParams(location.search).get("time")) || 0;
// ---------------------------------------------------------------------------
// quality watchdog — steps detailed features down on weak GPUs
// ---------------------------------------------------------------------------

let qualityLevel = 0;
let lowFpsTime = 0; // consecutive sampled seconds under 40 fps
let fpsSample = 0; // dt accumulator
let fpsFrames = 0;

const QUALITY_LEVELS = [
  { tufts: 22000, pixelRatio: Math.min(devicePixelRatio || 1, 2), pollen: 240 },
  { tufts: 14000, pixelRatio: Math.min(devicePixelRatio || 1, 1.5), pollen: 240 },
  { tufts: 9000, pixelRatio: 1, pollen: 120 },
  { tufts: 5000, pixelRatio: 1, pollen: 0 },
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

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    fpsSample = 0;
    fpsFrames = 0;
    lowFpsTime = 0;
  }
});

const timer = new THREE.Timer();
timer.connect(document);

let started = false;
let firstFrame = true;

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  aspect = w / h;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
  composer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  composer.setSize(w, h);
  applyCameraFrustum();
}

const observer = new ResizeObserver(resize);
observer.observe(canvas);
resize();
camera.position.setFromSphericalCoords(CAM_DISTANCE, polar, azimuth).add(
  new THREE.Vector3(SPAWN.x, baseHeight(SPAWN.x, SPAWN.z) + 0.45, SPAWN.z),
);
camera.lookAt(SPAWN.x, baseHeight(SPAWN.x, SPAWN.z) + 0.45, SPAWN.z);

function frame() {
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.05);
  const elapsed = timer.getElapsed() + startTime;
  const t = elapsed * motionScale;

  updatePlayer(dt, elapsed);
  updateCamera(dt, elapsed);
  updateAtmosphere(dt, elapsed);
  updateCritters(t, elapsed);

  if (grassMaterial.userData.shader) {
    grassMaterial.userData.shader.uniforms.uTime.value = t;
    grassMaterial.userData.shader.uniforms.uWind.value = motionScale;
  }
  skyUniforms.uTime.value = t;

  waterNormal.offset.x = t * 0.014;
  waterNormal.offset.y = t * 0.009;

  for (const s of treeSway) {
    s.crown.rotation.z = Math.sin(t * 0.9 + s.phase) * 0.02 * s.s;
    s.crown.rotation.x = Math.cos(t * 0.7 + s.phase * 1.3) * 0.012 * s.s;
  }

  composer.render(dt);

  // quality watchdog
  if (!document.hidden && elapsed > 2) {
    fpsSample += dt;
    fpsFrames++;
    if (fpsSample >= 1) {
      const fps = fpsFrames / fpsSample;
      fpsSample = 0;
      fpsFrames = 0;
      lowFpsTime = fps < 40 ? lowFpsTime + 1 : 0;
      if (lowFpsTime >= 3 && qualityLevel < 3) {
        applyQualityLevel(qualityLevel + 1);
        lowFpsTime = 0;
      }
    }
  }

  if (firstFrame) {
    firstFrame = false;
    started = true;
    window.setTimeout(() => loaderEl.classList.add("done"), 250);
  }
}

renderer.setAnimationLoop(frame);

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

function disposeScene() {
  renderer.setAnimationLoop(null);
  observer.disconnect();
  timer.dispose();
  composer.dispose();
  scene.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
    for (const mat of mats) {
      for (const value of Object.values(mat)) {
        if (value && value.isTexture) value.dispose();
      }
      mat.dispose();
    }
  });
  renderer.dispose();
  renderer.forceContextLoss();
}

window.addEventListener("beforeunload", disposeScene);
canvas.addEventListener("webglcontextlost", (e) => {
  e.preventDefault();
  renderer.setAnimationLoop(null);
  loaderEl.textContent = "the meadow lost its light — reload to return";
  loaderEl.classList.remove("done");
});

// small dev hook so the scene can be poked at from the console
window.meadowlight = {
  scene,
  camera,
  renderer,
  composer,
  player,
  spots,
  grassMaterial,
  skyUniforms,
  water,
  sun,
  hemi,
  updateAtmosphere,
  updatePlayer,
  updateCamera,
  disposeScene,
  // test-only helpers (no effect on gameplay unless called)
  testKey: (dir, down) => (down ? keys.add(dir) : keys.delete(dir)),
  testWalkable: walkable,
  applyQuality: applyQualityLevel,
  qualityLevel: () => qualityLevel,
};
