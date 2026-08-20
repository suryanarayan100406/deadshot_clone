/**
 * High-resolution procedural PBR texture generator for world materials.
 * Generates seamless tiling textures with rich surface detailing, grunge,
 * panel seams, woodgrain, diamond treadplate, and concrete aggregate.
 */

import * as THREE from 'three';
import type { MatKey } from '@oneshot/shared';

const textureCache = new Map<string, THREE.Texture>();

function noise(x: number, y: number, seed = 0): number {
  const n = Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453;
  return n - Math.floor(n);
}

function smoothNoise(x: number, y: number, seed = 0): number {
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = x - i;
  const fy = y - j;
  const s = fx * fx * (3 - 2 * fx);
  const t = fy * fy * (3 - 2 * fy);

  const n00 = noise(i, j, seed);
  const n10 = noise(i + 1, j, seed);
  const n01 = noise(i, j + 1, seed);
  const n11 = noise(i + 1, j + 1, seed);

  const nx0 = n00 * (1 - s) + n10 * s;
  const nx1 = n01 * (1 - s) + n11 * s;
  return nx0 * (1 - t) + nx1 * t;
}

function fbm(x: number, y: number, octaves = 4, seed = 0): number {
  let val = 0;
  let amp = 0.5;
  let freq = 1;
  for (let o = 0; o < octaves; o++) {
    val += smoothNoise(x * freq, y * freq, seed + o * 17) * amp;
    amp *= 0.5;
    freq *= 2;
  }
  return val;
}

/** Creates realistic concrete texture with panel seams and aggregate grain */
function generateConcrete(dark: boolean): HTMLCanvasElement {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const data = img.data;

  const baseR = dark ? 105 : 155;
  const baseG = dark ? 104 : 153;
  const baseB = dark ? 98 : 145;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const n1 = fbm(x / 32, y / 32, 4, 1);
      const n2 = fbm(x / 8, y / 8, 3, 2);
      const grit = (noise(x, y, 3) - 0.5) * 22;

      // Architectural panel seams every 256px
      const seamX = Math.min(x % 256, 256 - (x % 256));
      const seamY = Math.min(y % 256, 256 - (y % 256));
      let seamShade = 1.0;
      if (seamX <= 2 || seamY <= 2) {
        seamShade = 0.65 + Math.min(seamX, seamY) * 0.15;
      }

      // Tie rod holes at panel intersections
      const isTieX = Math.abs((x % 256) - 24) < 5 || Math.abs((x % 256) - 232) < 5;
      const isTieY = Math.abs((y % 256) - 24) < 5 || Math.abs((y % 256) - 232) < 5;
      if (isTieX && isTieY) {
        seamShade *= 0.55;
      }

      const val = (n1 * 0.7 + n2 * 0.3 - 0.5) * 45 + grit;
      data[idx] = Math.max(0, Math.min(255, (baseR + val) * seamShade));
      data[idx + 1] = Math.max(0, Math.min(255, (baseG + val) * seamShade));
      data[idx + 2] = Math.max(0, Math.min(255, (baseB + val) * seamShade));
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Creates desert sand with wind ripples */
function generateSand(dark: boolean): HTMLCanvasElement {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const data = img.data;

  const baseR = dark ? 165 : 200;
  const baseG = dark ? 132 : 168;
  const baseB = dark ? 90 : 122;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      // Wavy ripple dunes
      const ripple = Math.sin((x * 0.08) + Math.sin(y * 0.04) * 4 + (y * 0.02)) * 18;
      const n = (fbm(x / 24, y / 24, 3, 5) - 0.5) * 30;
      const speck = (noise(x, y, 7) - 0.5) * 14;

      const v = ripple + n + speck;
      data[idx] = Math.max(0, Math.min(255, baseR + v));
      data[idx + 1] = Math.max(0, Math.min(255, baseG + v * 0.85));
      data[idx + 2] = Math.max(0, Math.min(255, baseB + v * 0.6));
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Creates industrial steel diamond-plate & riveted panels */
function generateMetal(dark: boolean): HTMLCanvasElement {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const data = img.data;

  const base = dark ? 75 : 110;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;

      // Treadplate pattern: rotated diamond bars
      const px = x % 32;
      const py = y % 32;
      const d1 = Math.abs(px - py);
      const d2 = Math.abs(px + py - 32);
      let tread = 0;
      if ((d1 < 4 && py > 6 && py < 26) || (d2 < 4 && px > 6 && px < 26)) {
        tread = 38;
      }

      // Panel border seam every 128px
      const edge = (x % 128 <= 2 || y % 128 <= 2) ? -28 : 0;
      // Rivets along panel edges
      const isRivet = ((x % 128 < 8 || x % 128 > 120) && (y % 16 < 4)) ||
                      ((y % 128 < 8 || y % 128 > 120) && (x % 16 < 4));
      const rivet = isRivet ? 45 : 0;

      const scratch = (noise(x, y, 9) - 0.5) * 12;
      const v = tread + edge + rivet + scratch;

      data[idx] = Math.max(0, Math.min(255, base + v));
      data[idx + 1] = Math.max(0, Math.min(255, base + v + 3));
      data[idx + 2] = Math.max(0, Math.min(255, base + v + 7));
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Creates weathered timber wood planks */
function generateWood(): HTMLCanvasElement {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const data = img.data;

  const baseR = 138;
  const baseG = 104;
  const baseB = 68;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      // Vertical plank seam every 64px
      const seam = (x % 64 <= 2) ? -55 : 0;

      // Wood grain lines
      const grain = Math.sin(x * 0.4 + fbm(x / 16, y / 64, 3, 11) * 12) * 24;
      const fine = (noise(x, y, 13) - 0.5) * 14;

      const v = seam + grain + fine;
      data[idx] = Math.max(0, Math.min(255, baseR + v));
      data[idx + 1] = Math.max(0, Math.min(255, baseG + v * 0.8));
      data[idx + 2] = Math.max(0, Math.min(255, baseB + v * 0.55));
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Creates rusted oxidized iron with flaking patches */
function generateRust(): HTMLCanvasElement {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const data = img.data;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const n = fbm(x / 20, y / 20, 4, 15);
      const isRust = n > 0.42;

      if (isRust) {
        const patch = (n - 0.42) * 180;
        data[idx] = Math.min(255, 145 + patch * 0.4);
        data[idx + 1] = Math.min(255, 88 + patch * 0.2);
        data[idx + 2] = Math.min(255, 55 + patch * 0.1);
      } else {
        const metal = 80 + (noise(x, y, 17) - 0.5) * 20;
        data[idx] = metal;
        data[idx + 1] = metal + 2;
        data[idx + 2] = metal + 5;
      }
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Creates tactical painted panel with edge chips */
function generateAccent(): HTMLCanvasElement {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const data = img.data;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const edge = (x % 128 <= 2 || y % 128 <= 2) ? -35 : 0;
      const n = (fbm(x / 16, y / 16, 3, 21) - 0.5) * 25;
      const chip = noise(x, y, 23) > 0.96 ? -50 : 0;

      const v = edge + n + chip;
      data[idx] = Math.max(0, Math.min(255, 60 + v));
      data[idx + 1] = Math.max(0, Math.min(255, 118 + v));
      data[idx + 2] = Math.max(0, Math.min(255, 180 + v));
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Returns cached high-res seamless tiling texture for a given material key */
export function getTextureForMaterial(key: MatKey): THREE.Texture {
  const hit = textureCache.get(key);
  if (hit) return hit;

  let canvas: HTMLCanvasElement;
  switch (key) {
    case 'sand':
      canvas = generateSand(false);
      break;
    case 'sandDark':
      canvas = generateSand(true);
      break;
    case 'metal':
      canvas = generateMetal(false);
      break;
    case 'metalDark':
      canvas = generateMetal(true);
      break;
    case 'wood':
      canvas = generateWood();
      break;
    case 'rust':
      canvas = generateRust();
      break;
    case 'accent':
    case 'paint':
      canvas = generateAccent();
      break;
    case 'concreteDark':
      canvas = generateConcrete(true);
      break;
    case 'concrete':
    default:
      canvas = generateConcrete(false);
      break;
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;

  textureCache.set(key, tex);
  return tex;
}

/** Generates tactical multi-cam camouflage pattern */
export function getCamoTexture(): THREE.Texture {
  const hit = textureCache.get('tactical_camo');
  if (hit) return hit;

  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const data = img.data;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const n = fbm(x / 18, y / 18, 3, 44);

      if (n > 0.65) {
        // Dark slate
        data[idx] = 45;
        data[idx + 1] = 52;
        data[idx + 2] = 58;
      } else if (n > 0.48) {
        // Olive drab
        data[idx] = 78;
        data[idx + 1] = 88;
        data[idx + 2] = 74;
      } else if (n > 0.32) {
        // Khaki coyote
        data[idx] = 115;
        data[idx + 1] = 108;
        data[idx + 2] = 92;
      } else {
        // Charcoal base
        data[idx] = 60;
        data[idx + 1] = 64;
        data[idx + 2] = 68;
      }
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  textureCache.set('tactical_camo', tex);
  return tex;
}

/** Generates ballistic carbon fiber / cordura weave texture */
export function getCarbonTexture(): THREE.Texture {
  const hit = textureCache.get('tactical_carbon');
  if (hit) return hit;

  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const data = img.data;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const weave = ((Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0) ? 22 : -22;
      const fine = (noise(x, y, 77) - 0.5) * 10;
      const v = Math.max(0, Math.min(255, 38 + weave + fine));

      data[idx] = v;
      data[idx + 1] = v + 2;
      data[idx + 2] = v + 4;
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  textureCache.set('tactical_carbon', tex);
  return tex;
}
