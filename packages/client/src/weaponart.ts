/**
 * Weapon silhouettes as inline SVG, generated from `WeaponDef.viz`.
 *
 * The killfeed needs a 14 px icon, the menu needs a 34 px button glyph and a
 * large loadout illustration. All three are the same shape at three scales, and
 * all three are derived from the exact proportions the 3D view model uses — so
 * the icon in the killfeed is recognisably the gun in your hands.
 *
 * Generating them means no sprite sheet, no icon font, and a new weapon needs
 * nothing but its entry in the weapon table.
 */

import { weaponById, type WeaponDef } from '@oneshot/shared';

/** Everything is laid out in a 100 × 40 box and scaled by the consumer. */
const VW = 100;
const VH = 40;

function hex(c: number): string {
  return `#${c.toString(16).padStart(6, '0')}`;
}

function rect(x: number, y: number, w: number, h: number, fill: string, r = 1): string {
  // Guard against a zero-size rect — a weapon with no magazine, for instance.
  if (w <= 0 || h <= 0) return '';
  return `<rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(
    h,
  )}" rx="${r}" fill="${fill}"/>`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Builds the body of the SVG (no wrapper), pointing left-to-right with the
 * muzzle at the right edge.
 *
 * `mono` collapses the whole weapon to one colour, which is what the killfeed
 * wants — a coloured icon at 14 px is noise, a silhouette reads instantly.
 */
function shape(w: WeaponDef, mono: string | null): string {
  const v = w.viz;
  const body = mono ?? hex(v.color);
  const accent = mono ?? hex(v.accent);
  const dark = mono ?? '#1b1e22';

  if (w.fireMode === 'melee') {
    // Knife: angled blade, short handle, a guard between them.
    const bladeLen = 52;
    return [
      rect(14, 20, 22, 7, dark, 2),
      rect(35, 17, 4, 13, accent, 1),
      `<path d="M39 19 L${39 + bladeLen} 21.5 L${39 + bladeLen} 24 L39 26 Z" fill="${accent}"/>`,
      rect(16, 27, 16, 3, accent, 1),
    ].join('');
  }

  // Total length in metres → pixels, so a pistol really is stubbier than a rifle.
  const metres = v.bodyLen + v.barrelLen;
  const scale = 86 / Math.max(0.3, metres);
  const bodyLen = v.bodyLen * scale;
  const barrelLen = v.barrelLen * scale;
  const bodyH = Math.max(6, v.bodyH * scale * 0.62);
  const stockLen = v.stock ? 18 : 0;

  // Right edge is the muzzle; walk leftward from there.
  const muzzleX = VW - 6;
  const bodyRight = muzzleX - barrelLen;
  const bodyLeft = bodyRight - bodyLen;
  const midY = 19;
  const bodyTop = midY - bodyH / 2;
  const barrelR = Math.max(1.6, v.barrelR * scale * 0.7);

  const out: string[] = [];

  // Stock behind the receiver.
  if (v.stock) {
    out.push(rect(bodyLeft - stockLen, bodyTop + 1, stockLen + 3, bodyH * 0.72, body, 1.5));
    out.push(rect(bodyLeft - stockLen - 3, bodyTop - 1, 4, bodyH * 1.15, body, 1.5));
  }

  // Receiver.
  out.push(rect(bodyLeft, bodyTop, bodyLen, bodyH, body, 1.5));
  // Upper rail.
  out.push(rect(bodyLeft + bodyLen * 0.18, bodyTop - 2.2, bodyLen * 0.6, 2.4, accent, 0.8));
  // Barrel.
  out.push(rect(bodyRight, midY - barrelR, barrelLen, barrelR * 2, dark, 1));
  // Muzzle device.
  out.push(rect(muzzleX - 5, midY - barrelR * 1.7, 5.5, barrelR * 3.4, accent, 1));

  // Sights, or a scope tube for the scoped weapons.
  if (w.scoped) {
    const scopeY = bodyTop - 7.6;
    out.push(rect(bodyLeft + bodyLen * 0.2, scopeY, bodyLen * 0.62, 5, dark, 2));
    // Objective bell forward, eyepiece back, two rings clamping it to the rail —
    // the same four parts the view model builds, so the icon stays the weapon.
    out.push(rect(bodyLeft + bodyLen * 0.78, scopeY - 1, 4.5, 7, dark, 1.4));
    out.push(rect(bodyLeft + bodyLen * 0.13, scopeY - 0.8, 4.5, 6.6, dark, 1.4));
    out.push(rect(bodyLeft + bodyLen * 0.3, scopeY + 4.6, 3, 2.8, accent, 0.6));
    out.push(rect(bodyLeft + bodyLen * 0.64, scopeY + 4.6, 3, 2.8, accent, 0.6));
  } else {
    out.push(rect(bodyRight - 4, bodyTop - 4.4, 2.4, 4.4, dark, 0.6));
    out.push(rect(bodyLeft + bodyLen * 0.12, bodyTop - 4, 3.6, 4, dark, 0.6));
  }

  // Magazine, raked forward, with a floor plate on the bottom.
  if (v.magLen > 0) {
    const magH = Math.max(6, v.magLen * scale * 0.62);
    const magX = bodyLeft + bodyLen * 0.36;
    const magW = Math.max(5, bodyLen * 0.2);
    out.push(
      `<g transform="rotate(-8 ${round(magX)} ${round(bodyTop + bodyH)})">${rect(
        magX,
        bodyTop + bodyH - 0.5,
        magW,
        magH,
        dark,
        1.2,
      )}${rect(magX - 0.6, bodyTop + bodyH - 0.5 + magH, magW + 1.2, 1.6, accent, 0.5)}</g>`,
    );
  }

  // Grip and trigger guard.
  const gripX = bodyLeft + bodyLen * (v.stock ? 0.06 : 0.14);
  out.push(
    `<g transform="rotate(11 ${round(gripX)} ${round(bodyTop + bodyH)})">${rect(
      gripX,
      bodyTop + bodyH - 0.5,
      Math.max(5.5, bodyLen * 0.17),
      11,
      dark,
      1.5,
    )}</g>`,
  );
  out.push(rect(gripX + 5, bodyTop + bodyH, bodyLen * 0.2, 1.6, dark, 0.6));

  // Under the barrel: a pump and tube for a pump gun, otherwise a vented
  // fore-end for anything long enough to need a second hand. Drawn as one choice
  // rather than stacked, so the two never overlap into a smear at 14 px.
  if (w.fireMode === 'pump') {
    out.push(rect(bodyRight + 1, midY + barrelR + 2.6, barrelLen * 0.86, 2.6, dark, 1));
    out.push(rect(bodyRight + barrelLen * 0.24, midY + barrelR - 0.4, barrelLen * 0.3, 5.2, dark, 1.4));
  } else if (barrelLen > 18) {
    const feLen = barrelLen * 0.5;
    out.push(rect(bodyRight + 1, midY + barrelR, feLen, 3.4, body, 1));
    // Vent slots. The same trick as the view model's handguard: dark cuts on a
    // lighter body are what stop it reading as a plain extruded block.
    for (let i = 0; i < 3; i++) {
      out.push(
        rect(bodyRight + 2.5 + i * (feLen / 3.2), midY + barrelR + 0.9, feLen * 0.13, 1.7, dark, 0.4),
      );
    }
  }

  // The part that names the action, on the receiver. A bolt knob out to the side
  // and a charging handle are small marks, but they are the ones that separate
  // the three self-loading silhouettes from each other in a killfeed line.
  if (w.fireMode === 'bolt') {
    const bx = bodyLeft + bodyLen * 0.6;
    out.push(rect(bx, bodyTop + 0.8, 8.5, 2.2, accent, 1));
    out.push(
      `<circle cx="${round(bx + 9.4)}" cy="${round(bodyTop + 1.9)}" r="2.1" fill="${accent}"/>`,
    );
  } else if (w.fireMode !== 'pump') {
    out.push(rect(bodyLeft + bodyLen * 0.66, bodyTop + 0.9, 5.5, 2, accent, 0.8));
  }

  return out.join('');
}

/** Full-colour SVG, sized by CSS. */
export function weaponSvg(id: number): string {
  const w = weaponById(id);
  return `<svg viewBox="0 0 ${VW} ${VH}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${shape(
    w,
    null,
  )}</svg>`;
}

/** Single-colour silhouette for the killfeed, inheriting the text colour. */
export function weaponIcon(id: number): string {
  const w = weaponById(id);
  return `<svg viewBox="0 0 ${VW} ${VH}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${shape(
    w,
    'currentColor',
  )}</svg>`;
}

/** A skull, used in the killfeed when a player died without a killer. */
export function suicideIcon(): string {
  return (
    `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
    `<path d="M20 4c-7.2 0-12 4.9-12 11.8 0 4 1.7 6.4 3.4 8.1V29c0 1.7 1.4 3 3.1 3h11c1.7 0 3.1-1.3 3.1-3v-5.1c1.7-1.7 3.4-4.1 3.4-8.1C32 8.9 27.2 4 20 4Z" fill="currentColor"/>` +
    `<circle cx="15.4" cy="16.6" r="3.1" fill="#0d0c11"/><circle cx="24.6" cy="16.6" r="3.1" fill="#0d0c11"/>` +
    `<rect x="18.6" y="21" width="2.8" height="4" rx="1" fill="#0d0c11"/></svg>`
  );
}
