/**
 * Physically-shaded surfaces for the character.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 * The character used to be three flat materials: two `MeshLambertMaterial` and one
 * low-shine `MeshPhongMaterial`. Lambert has no specular term at all, so cloth,
 * kevlar, rubber and steel all returned exactly the same light and the body read as
 * a painted cardboard cut-out no matter how much geometry was bolted onto it. That
 * is the whole of the "doesn't look realistic" complaint: not polygon count, not
 * texture resolution — *no surface response*.
 *
 * `MeshStandardMaterial` fixes it because it separates the two things the eye
 * actually uses to identify a material:
 *
 *   • **roughness** — how wide the highlight spreads. Ballistic nylon scatters over
 *     the whole panel; a steel buckle returns a pinpoint. One number, and the two
 *     stop looking like the same plastic.
 *   • **normal map** — per-pixel surface tilt. This is what makes a weave look woven
 *     and a tread look raised on geometry that is still perfectly flat. It costs one
 *     texture fetch and buys more apparent detail than any amount of extra boxes.
 *
 * ── Why the maps are generated, not downloaded ───────────────────────────────
 * A tiling PBR set from a CC0 library is 5–9 MB per material at 1K, and a character
 * needs four of them. 20–40 MB of blocking download for surfaces that appear at
 * 40 px on screen is the wrong trade for a browser shooter that has to start
 * instantly. These are drawn into 256² canvases at load, cost nothing to ship, and
 * the normal maps are derived from the albedo's own luminance so the bumps line up
 * with the pattern exactly — which a downloaded set only does if its maps were
 * authored together.
 *
 * ── The one hard rule ────────────────────────────────────────────────────────
 * A normal map must **not** be tagged sRGB. Its texels are a vector, not a colour;
 * putting them through the sRGB→linear decode bends every normal toward +Z and the
 * lighting goes subtly, unfixably wrong. Only albedo gets `SRGBColorSpace` here.
 */

import * as THREE from 'three';

/** Everything a surface class needs, built once and shared by every character. */
export interface SurfaceMaps {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
}

/** Surface classes the character is made of. */
export type SurfaceKind = 'cloth' | 'armour' | 'rubber' | 'steel' | 'skin';

const cache = new Map<string, SurfaceMaps>();

function canvas(size: number): { c: HTMLCanvasElement; x: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return { c, x: c.getContext('2d')! };
}

/** Deterministic value noise — same character every session, no `Math.random()`. */
function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695040) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/**
 * Height field → tangent-space normal map, by central difference.
 *
 * Sampling wraps, so a seamless albedo yields a seamless normal map. `strength`
 * scales the gradient before normalising: low for woven cloth, high for tread.
 */
function normalFromLuma(src: HTMLCanvasElement, strength: number): THREE.Texture {
  const n = src.width;
  const sx = src.getContext('2d')!.getImageData(0, 0, n, n).data;
  // Luminance once, so the two gradient taps below are cheap array reads.
  const h = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) {
    h[i] = (sx[i * 4] * 0.299 + sx[i * 4 + 1] * 0.587 + sx[i * 4 + 2] * 0.114) / 255;
  }

  const { c, x } = canvas(n);
  const out = x.createImageData(n, n);
  const at = (px: number, py: number): number => h[((py + n) % n) * n + ((px + n) % n)];

  for (let py = 0; py < n; py++) {
    for (let px = 0; px < n; px++) {
      const dx = (at(px + 1, py) - at(px - 1, py)) * strength;
      const dy = (at(px, py + 1) - at(px, py - 1)) * strength;
      // The surface normal of a height field is (-dh/dx, -dh/dy, 1), normalised.
      const len = Math.hypot(dx, dy, 1);
      const i = (py * n + px) * 4;
      out.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      out.data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      out.data[i + 2] = (1 / len) * 0.5 * 255 + 127.5;
      out.data[i + 3] = 255;
    }
  }
  x.putImageData(out, 0, 0);

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  // Deliberately NOT SRGBColorSpace — see the file header.
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  return tex;
}

/**
 * Albedo luminance → roughness, remapped into `[lo, hi]`.
 *
 * Inverted on purpose: the bright threads of a weave and the worn edges of a rubber
 * tread are the parts that have been polished by contact, so they are the *smoother*
 * ones. Reading roughness straight off the albedo would make every highlight land on
 * the recesses instead, which looks wet.
 */
function roughFromLuma(src: HTMLCanvasElement, lo: number, hi: number): THREE.Texture {
  const n = src.width;
  const sx = src.getContext('2d')!.getImageData(0, 0, n, n).data;
  const { c, x } = canvas(n);
  const out = x.createImageData(n, n);
  for (let i = 0; i < n * n; i++) {
    const l = (sx[i * 4] * 0.299 + sx[i * 4 + 1] * 0.587 + sx[i * 4 + 2] * 0.114) / 255;
    const v = (hi - (hi - lo) * l) * 255;
    out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = v;
    out.data[i * 4 + 3] = 255;
  }
  x.putImageData(out, 0, 0);

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  return tex;
}

function albedo(c: HTMLCanvasElement): THREE.Texture {
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  return tex;
}

/**
 * Cordura-style basketweave.
 *
 * Drawn near-white with only the *pattern* in it, because the team colour arrives as
 * `material.color` and multiplies through. A texture that carried its own colour
 * would fight the one surface whose job is telling you whether to shoot.
 */
function weave(): HTMLCanvasElement {
  const n = 256;
  const { c, x } = canvas(n);
  x.fillStyle = '#c9c9c9';
  x.fillRect(0, 0, n, n);

  // Two interleaved thread directions, 8 px pitch — reads as fabric at 40 px on
  // screen and as a flat tone beyond that, which is where mipmaps take over anyway.
  const pitch = 8;
  for (let i = 0; i < n / pitch; i++) {
    for (let j = 0; j < n / pitch; j++) {
      const warp = (i + j) % 2 === 0;
      const t = hash(i, j, 7) * 0.16 + 0.84;
      const v = Math.round((warp ? 232 : 176) * t);
      x.fillStyle = `rgb(${v},${v},${v})`;
      if (warp) x.fillRect(i * pitch, j * pitch + 1, pitch, pitch - 2);
      else x.fillRect(i * pitch + 1, j * pitch, pitch - 2, pitch);
    }
  }

  // Slub: occasional thicker fibres. Without them the weave is too regular and
  // reads as a printed grid rather than as cloth.
  for (let k = 0; k < 420; k++) {
    const px = hash(k, 1, 11) * n;
    const py = hash(k, 2, 13) * n;
    const v = Math.round(150 + hash(k, 3, 17) * 90);
    x.fillStyle = `rgba(${v},${v},${v},0.5)`;
    x.fillRect(px, py, 1 + hash(k, 4, 19) * 3, 1);
  }
  return c;
}

/** Kevlar/composite shell: fine twill with a matte clearcoat and micro-scuffing. */
function shell(): HTMLCanvasElement {
  const n = 256;
  const { c, x } = canvas(n);
  x.fillStyle = '#bcbcbc';
  x.fillRect(0, 0, n, n);

  // Diagonal twill at 45°, tight pitch — composite weave is much finer than nylon.
  x.lineWidth = 1;
  for (let d = -n; d < n * 2; d += 4) {
    const v = Math.round(196 + hash(d, 0, 23) * 34);
    x.strokeStyle = `rgba(${v},${v},${v},0.55)`;
    x.beginPath();
    x.moveTo(d, 0);
    x.lineTo(d + n, n);
    x.stroke();
  }
  for (let d = -n; d < n * 2; d += 9) {
    x.strokeStyle = 'rgba(120,120,120,0.35)';
    x.beginPath();
    x.moveTo(d + n, 0);
    x.lineTo(d, n);
    x.stroke();
  }

  // Scuffs. A helmet that has never been scratched looks like a prop.
  for (let k = 0; k < 90; k++) {
    const px = hash(k, 5, 29) * n;
    const py = hash(k, 6, 31) * n;
    const len = 3 + hash(k, 7, 37) * 14;
    x.strokeStyle = `rgba(240,240,240,${0.10 + hash(k, 8, 41) * 0.16})`;
    x.lineWidth = 0.8;
    x.beginPath();
    x.moveTo(px, py);
    x.lineTo(px + len, py + (hash(k, 9, 43) - 0.5) * 4);
    x.stroke();
  }
  return c;
}

/** Boot rubber: moulded lugs. Coarse and deep — this is the high-`strength` normal. */
function tread(): HTMLCanvasElement {
  const n = 256;
  const { c, x } = canvas(n);
  x.fillStyle = '#5c5c5c';
  x.fillRect(0, 0, n, n);

  const cell = 32;
  for (let i = 0; i < n / cell; i++) {
    for (let j = 0; j < n / cell; j++) {
      // Offset alternate rows so the lugs interlock rather than forming channels.
      const ox = (j % 2) * cell * 0.5;
      const v = Math.round(178 + hash(i, j, 47) * 46);
      x.fillStyle = `rgb(${v},${v},${v})`;
      const px = (i * cell + ox) % n;
      x.beginPath();
      x.roundRect(px + 4, j * cell + 4, cell - 8, cell - 8, 5);
      x.fill();
    }
  }
  // Sipes: thin cuts across each lug.
  x.strokeStyle = 'rgba(48,48,48,0.85)';
  x.lineWidth = 2;
  for (let y = 0; y < n; y += 8) {
    x.beginPath();
    x.moveTo(0, y);
    x.lineTo(n, y);
    x.stroke();
  }
  return c;
}

/** Machined steel: brushed grain plus a few deeper drags. */
function steel(): HTMLCanvasElement {
  const n = 256;
  const { c, x } = canvas(n);
  x.fillStyle = '#b4b4b4';
  x.fillRect(0, 0, n, n);
  for (let y = 0; y < n; y++) {
    const v = Math.round(168 + hash(0, y, 53) * 78);
    x.fillStyle = `rgba(${v},${v},${v},0.6)`;
    x.fillRect(0, y, n, 1);
  }
  for (let k = 0; k < 160; k++) {
    const py = hash(k, 10, 59) * n;
    x.strokeStyle = `rgba(255,255,255,${0.06 + hash(k, 11, 61) * 0.14})`;
    x.lineWidth = 0.7;
    x.beginPath();
    x.moveTo(hash(k, 12, 67) * n, py);
    x.lineTo(hash(k, 12, 67) * n + 20 + hash(k, 13, 71) * 90, py);
    x.stroke();
  }
  return c;
}

/** Skin: fine pore noise. Only the hands and jaw use it, so it stays cheap. */
function pores(): HTMLCanvasElement {
  const n = 128;
  const { c, x } = canvas(n);
  x.fillStyle = '#d8d8d8';
  x.fillRect(0, 0, n, n);
  for (let k = 0; k < 2600; k++) {
    const px = hash(k, 14, 73) * n;
    const py = hash(k, 15, 79) * n;
    const v = Math.round(198 + hash(k, 16, 83) * 52);
    x.fillStyle = `rgba(${v},${v},${v},0.35)`;
    x.fillRect(px, py, 1, 1);
  }
  return c;
}

/**
 * Normal strength and roughness range per surface class.
 *
 * The roughness *ranges* are the important column. Keeping every class inside a
 * narrow band around 0.5 was the old Phong look in new clothes; spreading them from
 * 0.24 (steel) to 0.94 (cloth) is what makes four materials read as four materials.
 */
const RECIPE: Record<SurfaceKind, { draw: () => HTMLCanvasElement; bump: number; lo: number; hi: number }> = {
  cloth: { draw: weave, bump: 1.6, lo: 0.72, hi: 0.94 },
  armour: { draw: shell, bump: 1.1, lo: 0.34, hi: 0.62 },
  rubber: { draw: tread, bump: 4.2, lo: 0.66, hi: 0.9 },
  steel: { draw: steel, bump: 0.9, lo: 0.24, hi: 0.46 },
  skin: { draw: pores, bump: 0.7, lo: 0.5, hi: 0.72 },
};

/** Cached maps for one surface class. Every character shares one set. */
export function surfaceMaps(kind: SurfaceKind): SurfaceMaps {
  const hit = cache.get(kind);
  if (hit) return hit;
  const r = RECIPE[kind];
  const src = r.draw();
  const maps: SurfaceMaps = {
    map: albedo(src),
    normalMap: normalFromLuma(src, r.bump),
    roughnessMap: roughFromLuma(src, r.lo, r.hi),
  };
  cache.set(kind, maps);
  return maps;
}

/**
 * A character material.
 *
 * `repeat` is in texture tiles per metre of surface, applied to all three maps so
 * the weave, its bumps and its roughness stay registered with each other. Gear is
 * tiled tighter than the body because a pouch is small and a chest panel is not.
 *
 * `metalness` is the other half of the story: 0 for anything woven or moulded, near
 * 1 for buckles and rails. A dielectric with `metalness: 0.5` is not "a bit shiny",
 * it is physically nothing, and it is what makes hobby PBR look like wet plastic.
 */
export function characterMaterial(
  kind: SurfaceKind,
  color: number,
  repeat = 4,
  metalness = 0,
): THREE.MeshStandardMaterial {
  const base = surfaceMaps(kind);
  // Textures are shared but `repeat` is per-material, so each material gets its own
  // cheap clone of the shared image rather than its own copy of the pixels.
  const clone = (t: THREE.Texture): THREE.Texture => {
    const c = t.clone();
    c.needsUpdate = true;
    c.repeat.set(repeat, repeat);
    return c;
  };
  return new THREE.MeshStandardMaterial({
    color,
    map: clone(base.map),
    normalMap: clone(base.normalMap),
    roughnessMap: clone(base.roughnessMap),
    normalScale: new THREE.Vector2(1, 1),
    roughness: 1, // multiplied by roughnessMap; the map carries the variation
    metalness,
  });
}
