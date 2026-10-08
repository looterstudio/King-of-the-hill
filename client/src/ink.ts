// Ballpoint-on-graph-paper renderer.
// Pass 1 draws every mesh into a buffer: r = lambert shade, g = ink id, ba = view-space normal.
// Pass 2 turns that buffer + depth into a drawing: ink outlines where depth, normal or ink
// change, screen-space hatching in the shadows, graph paper behind everything, and the storm
// drawn as a red hatched wall reconstructed per pixel from depth (no geometry for it at all).
import * as THREE from 'three';

// ink palette, indexed by the ink id written in pass 1 (matches shared/src/world.ts INK)
export const INK_IDS = { BLUE: 0, RED: 1, GRAPHITE: 2, ORANGE: 3, GREEN: 4, PINK: 5, BROWN: 6, PAPER: 7 } as const;

const passOneVert = /* glsl */`
attribute float aInk;
uniform float uInk;
varying vec3 vN;
varying float vInk;
void main() {
  vec3 p = position;
  vec3 n = normal;
  #ifdef USE_INSTANCING
    p = (instanceMatrix * vec4(p, 1.0)).xyz;
    n = mat3(instanceMatrix) * n;
    vInk = aInk;
  #else
    vInk = uInk;
  #endif
  vN = normalize(normalMatrix * n);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  #ifdef FRONT
    // first-person gun: squeeze its depth into the first sliver of the buffer, so it always
    // draws over the world without clearing (and losing) the world's depth
    gl_Position.z = (-1.0 + (gl_Position.z / gl_Position.w + 1.0) * 0.0005) * gl_Position.w;
  #endif
}`;

const passOneFrag = /* glsl */`
precision highp float;
uniform vec3 uLight;
varying vec3 vN;
varying float vInk;
void main() {
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  float shade = clamp(dot(n, uLight) * 0.5 + 0.5, 0.0, 1.0);
  gl_FragColor = vec4(shade, (vInk + 0.5) / 8.0, n.x * 0.5 + 0.5, n.y * 0.5 + 0.5);
}`;

const postVert = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const postFrag = /* glsl */`
precision highp float;
uniform sampler2D tBuf;
uniform sampler2D tDepth;
uniform vec2 uRes;
uniform float uNear, uFar, uTime, uPx;
uniform mat4 uInvProj, uCamWorld;
uniform vec3 uCamPos;
uniform vec3 uRing;   // x, z, r of the safe circle
uniform vec3 uNext;   // x, z, r of the next circle
varying vec2 vUv;

const vec3 PAPER = vec3(0.965, 0.949, 0.894);
const vec3 GRID = vec3(0.55, 0.68, 0.88);
vec3 inkColor(float id) {
  if (id < 0.5) return vec3(0.11, 0.20, 0.72);  // blue ballpoint
  if (id < 1.5) return vec3(0.83, 0.14, 0.21);  // red pen
  if (id < 2.5) return vec3(0.17, 0.18, 0.23);  // graphite
  if (id < 3.5) return vec3(0.93, 0.55, 0.10);  // orange highlighter
  if (id < 4.5) return vec3(0.15, 0.52, 0.28);  // green
  if (id < 5.5) return vec3(0.88, 0.38, 0.62);  // pink
  if (id < 6.5) return vec3(0.45, 0.30, 0.18);  // brown
  return vec3(0.17, 0.18, 0.23);
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float linDepth(float d) { float z = d * 2.0 - 1.0; return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear)); }
float inkId(vec4 b) { return floor(b.g * 8.0); }

void main() {
  vec2 px = 1.0 / uRes;
  // fixed wobble: the pen line drifts a little, the same every frame, so nothing shimmers
  vec2 wob = (vec2(hash(floor(vUv * uRes / 7.0)), hash(floor(vUv * uRes / 7.0) + 9.1)) - 0.5) * px * 1.2;
  vec2 uv = vUv + wob;
  vec4 b = texture2D(tBuf, uv);
  float rawD = texture2D(tDepth, uv).r;
  bool sky = rawD >= 0.99999;
  float d = linDepth(rawD);
  vec2 frag = vUv * uRes;

  // graph paper
  vec3 col = PAPER;
  float g1 = step(mod(frag.x, 26.0 * uPx), 1.0 * uPx) + step(mod(frag.y, 26.0 * uPx), 1.0 * uPx);
  col = mix(col, GRID, clamp(g1, 0.0, 1.0) * 0.28);
  col -= (hash(floor(frag / 2.0)) - 0.5) * 0.025;

  // world position of this pixel (for the storm and the circles on the ground)
  vec4 ndc = vec4(vUv * 2.0 - 1.0, rawD * 2.0 - 1.0, 1.0);
  vec4 vpos = uInvProj * ndc; vpos /= vpos.w;
  vec3 wpos = (uCamWorld * vpos).xyz;
  vec3 ray = normalize(wpos - uCamPos);
  float dist = sky ? 1e5 : length(wpos - uCamPos);

  if (!sky) {
    float id = inkId(b);
    vec3 ink = inkColor(id);
    float fade = 1.0 - smoothstep(90.0, 260.0, d);   // far things get lighter, like pencil pressure
    // fills: highlighter-ish tints for some inks
    if (id > 2.5 && id < 3.5) col = mix(col, vec3(1.0, 0.82, 0.45), 0.55 * fade);
    if (id > 0.5 && id < 1.5) col = mix(col, vec3(1.0, 0.80, 0.80), 0.6 * fade);
    if (id > 3.5 && id < 4.5) col = mix(col, vec3(0.80, 0.93, 0.78), 0.6 * fade);
    // hatching in the shadows, screen-space, two directions when it gets dark
    if (id < 6.5) {
      float s = b.r;
      float h1 = step(mod(frag.x + frag.y, 6.0 * uPx), 1.3 * uPx) * (1.0 - smoothstep(0.45, 0.62, s));
      float h2 = step(mod(frag.x - frag.y, 6.0 * uPx), 1.3 * uPx) * (1.0 - smoothstep(0.22, 0.36, s));
      col = mix(col, ink, clamp(h1 + h2, 0.0, 1.0) * 0.55 * fade);
    }
    // outlines: depth laplacian (relative), normal break, ink change
    float edge = 0.0;
    vec2 o = px * uPx * 1.25;
    float dl = linDepth(texture2D(tDepth, uv + vec2(o.x, 0.0)).r), dr = linDepth(texture2D(tDepth, uv - vec2(o.x, 0.0)).r);
    float du = linDepth(texture2D(tDepth, uv + vec2(0.0, o.y)).r), dd = linDepth(texture2D(tDepth, uv - vec2(0.0, o.y)).r);
    float lap = abs(dl + dr + du + dd - 4.0 * d) / max(d, 0.5);
    edge = max(edge, smoothstep(0.06, 0.16, lap));
    vec4 bl = texture2D(tBuf, uv + vec2(o.x, 0.0)), bu = texture2D(tBuf, uv + vec2(0.0, o.y));
    vec2 n0 = b.ba * 2.0 - 1.0, n1 = bl.ba * 2.0 - 1.0, n2 = bu.ba * 2.0 - 1.0;
    edge = max(edge, smoothstep(0.25, 0.5, length(n0 - n1) + length(n0 - n2)) * 0.9);
    if (inkId(bl) != id || inkId(bu) != id) edge = max(edge, 0.9);
    if (id > 6.5) edge *= 0.6; // the ground keeps only the contact lines
    col = mix(col, ink, edge * (0.25 + 0.75 * fade));

    // circles drawn on the ground: next safe zone (blue dashes), storm edge (red)
    if (wpos.y < 0.08) {
      float dn = abs(length(wpos.xz - uNext.xy) - uNext.z);
      float ang = atan(wpos.z - uNext.y, wpos.x - uNext.x) * uNext.z;
      if (uNext.z > 0.5 && dn < 0.35 && mod(ang, 3.0) < 1.8) col = mix(col, inkColor(0.0), 0.9 * fade);
      float dc = abs(length(wpos.xz - uRing.xy) - uRing.z);
      if (dc < 0.45) col = mix(col, inkColor(1.0), 0.9);
    }
  }

  // the storm: red hatching on everything beyond the safe circle's wall
  vec2 rc = uCamPos.xz - uRing.xy;
  bool camIn = length(rc) < uRing.z;
  float stormT = 1e9;
  if (camIn) {
    vec2 rd = ray.xz;
    float a = dot(rd, rd), bq = 2.0 * dot(rc, rd), c = dot(rc, rc) - uRing.z * uRing.z;
    float disc = bq * bq - 4.0 * a * c;
    if (a > 1e-6 && disc > 0.0) {
      float t = (-bq + sqrt(disc)) / (2.0 * a);
      float hy = uCamPos.y + ray.y * t;
      if (hy > -1.0 && hy < 140.0) stormT = t;
    }
  } else stormT = 0.0;
  if (stormT < dist) {
    float hatch = step(mod(frag.x + frag.y + uTime * 40.0, 10.0 * uPx), 1.4 * uPx);
    float near = camIn ? 1.0 - smoothstep(60.0, 320.0, stormT) * 0.55 : 1.0; // the far wall reads lighter
    col = mix(col, vec3(0.97, 0.84, 0.84), 0.28 * near);
    col = mix(col, inkColor(1.0), hatch * 0.45 * near);
  }

  gl_FragColor = vec4(col, 1.0);
}`;

export class InkRenderer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  viewScene = new THREE.Scene();   // first-person gun (FRONT materials), drawn over the world
  overlay = new THREE.Scene();     // tracers and ropes, drawn on top of the finished drawing
  camera: THREE.PerspectiveCamera;
  viewCamera: THREE.PerspectiveCamera;
  private rt: THREE.WebGLRenderTarget;
  private post: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private postScene = new THREE.Scene();
  private postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private light = new THREE.Vector3(0.45, 0.85, 0.35).normalize();
  private lightView = new THREE.Vector3();
  materials: THREE.ShaderMaterial[] = [];

  constructor(public canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(1.5, devicePixelRatio || 1));
    this.renderer.autoClear = false;
    this.camera = new THREE.PerspectiveCamera(78, 1, 0.08, 700);
    this.viewCamera = new THREE.PerspectiveCamera(62, 1, 0.01, 10);
    this.rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: true });
    this.rt.depthTexture = new THREE.DepthTexture(4, 4, THREE.UnsignedIntType);
    this.post = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      vertexShader: postVert, fragmentShader: postFrag, depthTest: false, depthWrite: false,
      uniforms: {
        tBuf: { value: this.rt.texture }, tDepth: { value: this.rt.depthTexture }, uRes: { value: new THREE.Vector2() },
        uNear: { value: this.camera.near }, uFar: { value: this.camera.far }, uTime: { value: 0 }, uPx: { value: 1 },
        uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() },
        uRing: { value: new THREE.Vector3(0, 0, 1e4) }, uNext: { value: new THREE.Vector3(0, 0, 0) },
      },
    }));
    this.post.frustumCulled = false;
    this.postScene.add(this.post);
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  // one material per ink for plain meshes; instanced meshes carry their ink per instance
  material(ink: number, front = false): THREE.ShaderMaterial {
    const m = new THREE.ShaderMaterial({
      vertexShader: passOneVert, fragmentShader: passOneFrag, side: THREE.DoubleSide, defines: front ? { FRONT: '' } : {},
      uniforms: { uInk: { value: ink }, uLight: { value: this.lightView } },
    });
    this.materials.push(m);
    return m;
  }

  resize() {
    const w = innerWidth, h = innerHeight, pr = this.renderer.getPixelRatio();
    this.renderer.setSize(w, h, false);
    this.rt.setSize(Math.floor(w * pr), Math.floor(h * pr));
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.viewCamera.aspect = w / h; this.viewCamera.updateProjectionMatrix();
    this.post.material.uniforms.uRes.value.set(Math.floor(w * pr), Math.floor(h * pr));
    this.post.material.uniforms.uPx.value = pr;
  }

  setStorm(x: number, z: number, r: number, nx: number, nz: number, nr: number) {
    this.post.material.uniforms.uRing.value.set(x, z, r);
    this.post.material.uniforms.uNext.value.set(nx, nz, nr);
  }

  render(time: number) {
    const r = this.renderer, u = this.post.material.uniforms;
    this.camera.updateMatrixWorld();
    this.lightView.copy(this.light).transformDirection(this.camera.matrixWorldInverse);
    r.setRenderTarget(this.rt);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, true);
    r.render(this.scene, this.camera);
    r.render(this.viewScene, this.viewCamera);
    r.setRenderTarget(null);
    u.uTime.value = time;
    u.uInvProj.value.copy(this.camera.projectionMatrixInverse);
    u.uCamWorld.value.copy(this.camera.matrixWorld);
    u.uCamPos.value.setFromMatrixPosition(this.camera.matrixWorld);
    r.clear(true, true, true);
    r.render(this.postScene, this.postCam);
    r.render(this.overlay, this.camera);
  }
}
