/**
 * High-performance tactical surface texture generator.
 * Creates crisp, high-luminance tiling surface textures (concrete, metal, sand,
 * wood, tile, camo, carbon) that modulate vertex colors without darkening the scene.
 */

import * as THREE from 'three';
import type { MatKey } from '@oneshot/shared';

const textureCache = new Map<string, THREE.Texture>();

function createBaseCanvas(size = 256): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  return { canvas, ctx };
}

/** Crisp architectural concrete panel texture */
function generateConcrete(dark: boolean): HTMLCanvasElement {
  const size = 256;
  const { canvas, ctx } = createBaseCanvas(size);

  // High luminance base so vertex colors remain bright
  ctx.fillStyle = dark ? '#e0e0e0' : '#f4f4f2';
  ctx.fillRect(0, 0, size, size);

  // Subtle aggregate speckle
  ctx.fillStyle = dark ? '#cccccc' : '#e4e4e0';
  for (let i = 0; i < 400; i++) {
    const x = (Math.sin(i * 99.1) * 0.5 + 0.5) * size;
    const y = (Math.cos(i * 33.7) * 0.5 + 0.5) * size;
    const r = (i % 3) + 1;
    ctx.fillRect(x, y, r, r);
  }

  // Panel borders
  ctx.strokeStyle = dark ? '#999999' : '#b0b0aa';
  ctx.lineWidth = 3;
  ctx.strokeRect(1, 1, size - 2, size - 2);

  // Tie rod holes in the four corners
  ctx.fillStyle = dark ? '#777777' : '#888884';
  for (const [cx, cy] of [[24, 24], [size - 24, 24], [24, size - 24], [size - 24, size - 24]]) {
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  return canvas;
}

/** Desert sand ripple texture */
function generateSand(dark: boolean): HTMLCanvasElement {
  const size = 256;
  const { canvas, ctx } = createBaseCanvas(size);

  ctx.fillStyle = dark ? '#e8e2d4' : '#faf6ee';
  ctx.fillRect(0, 0, size, size);

  // Wind ripple bands
  ctx.strokeStyle = dark ? '#cec4b0' : '#e6decb';
  ctx.lineWidth = 4;
  for (let y = 16; y < size; y += 32) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(size * 0.33, y - 8, size * 0.66, y + 8, size, y);
    ctx.stroke();
  }

  // Fine sand grain
  ctx.fillStyle = dark ? '#c4baa6' : '#e0d8c4';
  for (let i = 0; i < 300; i++) {
    const x = (Math.sin(i * 14.3) * 0.5 + 0.5) * size;
    const y = (Math.cos(i * 71.9) * 0.5 + 0.5) * size;
    ctx.fillRect(x, y, 2, 1);
  }

  return canvas;
}

/** Industrial diamond-tread metal plate */
function generateMetal(dark: boolean): HTMLCanvasElement {
  const size = 256;
  const { canvas, ctx } = createBaseCanvas(size);

  ctx.fillStyle = dark ? '#d8dce0' : '#f0f3f6';
  ctx.fillRect(0, 0, size, size);

  // Diamond tread bars
  ctx.fillStyle = dark ? '#a8b0b8' : '#c8d0d8';
  const step = 32;
  for (let y = 8; y < size; y += step) {
    for (let x = 8; x < size; x += step) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.PI / 4);
      ctx.fillRect(-6, -2, 12, 4);
      ctx.restore();
    }
  }

  // Plate border seam and rivets
  ctx.strokeStyle = dark ? '#889098' : '#a8b0b8';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, size - 2, size - 2);

  ctx.fillStyle = '#ffffff';
  for (let p = 16; p < size; p += 32) {
    ctx.fillRect(p - 1, 2, 3, 3);
    ctx.fillRect(p - 1, size - 5, 3, 3);
    ctx.fillRect(2, p - 1, 3, 3);
    ctx.fillRect(size - 5, p - 1, 3, 3);
  }

  return canvas;
}

/** Weathered timber wood planks */
function generateWood(): HTMLCanvasElement {
  const size = 256;
  const { canvas, ctx } = createBaseCanvas(size);

  ctx.fillStyle = '#f6ede0';
  ctx.fillRect(0, 0, size, size);

  // Vertical planks
  const plankW = 64;
  for (let x = 0; x < size; x += plankW) {
    ctx.strokeStyle = '#a68c70';
    ctx.lineWidth = 3;
    ctx.strokeRect(x, 0, plankW, size);

    // Wood grain lines
    ctx.strokeStyle = '#d6c0a4';
    ctx.lineWidth = 1.5;
    for (let g = 8; g < plankW; g += 14) {
      ctx.beginPath();
      ctx.moveTo(x + g, 0);
      ctx.bezierCurveTo(x + g + 4, size * 0.4, x + g - 4, size * 0.7, x + g, size);
      ctx.stroke();
    }

    // Iron nails at top and bottom
    ctx.fillStyle = '#685440';
    ctx.beginPath();
    ctx.arc(x + plankW * 0.5, 12, 3, 0, Math.PI * 2);
    ctx.arc(x + plankW * 0.5, size - 12, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  return canvas;
}

/** Rusted corrugated metal */
function generateRust(): HTMLCanvasElement {
  const size = 256;
  const { canvas, ctx } = createBaseCanvas(size);

  ctx.fillStyle = '#eddcd0';
  ctx.fillRect(0, 0, size, size);

  // Rust patches
  ctx.fillStyle = '#b87c5a';
  for (let i = 0; i < 8; i++) {
    const cx = (Math.sin(i * 44.1) * 0.5 + 0.5) * size;
    const cy = (Math.cos(i * 88.3) * 0.5 + 0.5) * size;
    const rw = 25 + (i % 4) * 15;
    const rh = 18 + (i % 3) * 12;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rw, rh, i * 0.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Dark corrosion pitting
  ctx.fillStyle = '#7a4228';
  for (let i = 0; i < 40; i++) {
    const x = (Math.sin(i * 12.7) * 0.5 + 0.5) * size;
    const y = (Math.cos(i * 53.1) * 0.5 + 0.5) * size;
    ctx.fillRect(x, y, 3, 3);
  }

  return canvas;
}

/** Tactical painted accent panel */
function generateAccent(): HTMLCanvasElement {
  const size = 256;
  const { canvas, ctx } = createBaseCanvas(size);

  ctx.fillStyle = '#f0f5fa';
  ctx.fillRect(0, 0, size, size);

  ctx.strokeStyle = '#90b4d4';
  ctx.lineWidth = 4;
  ctx.strokeRect(4, 4, size - 8, size - 8);

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(size * 0.5 - 20, size * 0.5 - 3, 40, 6);

  return canvas;
}

/** Generates tactical multi-cam camouflage pattern */
export function getCamoTexture(): THREE.Texture {
  const hit = textureCache.get('tactical_camo');
  if (hit) return hit;

  const size = 256;
  const { canvas, ctx } = createBaseCanvas(size);

  ctx.fillStyle = '#6a7266'; // Olive drab
  ctx.fillRect(0, 0, size, size);

  // Khaki patches
  ctx.fillStyle = '#8f8876';
  for (let i = 0; i < 12; i++) {
    const x = (Math.sin(i * 31.7) * 0.5 + 0.5) * size;
    const y = (Math.cos(i * 61.3) * 0.5 + 0.5) * size;
    ctx.beginPath();
    ctx.ellipse(x, y, 35, 22, i * 0.8, 0, Math.PI * 2);
    ctx.fill();
  }

  // Charcoal shadow spots
  ctx.fillStyle = '#3a3e38';
  for (let i = 0; i < 8; i++) {
    const x = (Math.cos(i * 47.9) * 0.5 + 0.5) * size;
    const y = (Math.sin(i * 83.1) * 0.5 + 0.5) * size;
    ctx.beginPath();
    ctx.ellipse(x, y, 24, 16, i * 1.2, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  textureCache.set('tactical_camo', tex);
  return tex;
}

/** Generates ballistic carbon fiber weave texture */
export function getCarbonTexture(): THREE.Texture {
  const hit = textureCache.get('tactical_carbon');
  if (hit) return hit;

  const size = 128;
  const { canvas, ctx } = createBaseCanvas(size);

  ctx.fillStyle = '#60646c';
  ctx.fillRect(0, 0, size, size);

  ctx.fillStyle = '#8a909c';
  for (let y = 0; y < size; y += 8) {
    for (let x = 0; x < size; x += 8) {
      if (((x + y) / 8) % 2 === 0) {
        ctx.fillRect(x, y, 8, 8);
      }
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  textureCache.set('tactical_carbon', tex);
  return tex;
}

/** Generates brushed gunmetal receiver texture */
export function getGunMetalTexture(): THREE.Texture {
  const hit = textureCache.get('tactical_gunmetal');
  if (hit) return hit;

  const size = 256;
  const { canvas, ctx } = createBaseCanvas(size);

  ctx.fillStyle = '#8a9098';
  ctx.fillRect(0, 0, size, size);

  // Fine brushed horizontal grain
  ctx.strokeStyle = '#b0b8c4';
  ctx.lineWidth = 1;
  for (let y = 0; y < size; y += 2) {
    const alpha = (Math.sin(y * 14.3) * 0.5 + 0.5) * 0.45;
    ctx.strokeStyle = `rgba(230, 240, 255, ${alpha.toFixed(2)})`;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  textureCache.set('tactical_gunmetal', tex);
  return tex;
}

/** Generates tactical Damascus steel wave pattern */
export function getDamascusTexture(): THREE.Texture {
  const hit = textureCache.get('tactical_damascus');
  if (hit) return hit;

  const size = 256;
  const { canvas, ctx } = createBaseCanvas(size);

  ctx.fillStyle = '#4a5058';
  ctx.fillRect(0, 0, size, size);

  ctx.lineWidth = 2.5;
  for (let i = 0; i < 30; i++) {
    const y = i * 9;
    ctx.strokeStyle = i % 2 === 0 ? '#9aa4b2' : '#2b3036';
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= size; x += 16) {
      const dy = Math.sin(x * 0.06 + i * 0.4) * 8 + Math.cos(x * 0.03) * 4;
      ctx.lineTo(x, y + dy);
    }
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  textureCache.set('tactical_damascus', tex);
  return tex;
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
