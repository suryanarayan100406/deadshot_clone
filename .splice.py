import io, re, sys

p = 'packages/client/src/actors.ts'
s = io.open(p, encoding='utf-8').read()
orig = s

# 1. NEUTRAL_COLOR moves to characterrig.ts (buildCharacter needs it and importing
#    it back from actors.ts would be a cycle). Re-export so callers are unaffected.
a = "export const NEUTRAL_COLOR = 0xb8b3c4;\n"
assert s.count(a) == 1, 'NEUTRAL_COLOR count %d' % s.count(a)
s = s.replace(a, "")

# 2. Cut the whole character section: from the banner through the end of
#    buildCharacter (the line before poseWeapon's doc comment).
start = s.index("/* ─────")
marker = "/**\n * Pose a weapon in a character's right hand"
end = s.index(marker)
cut = s[start:end]
assert 'export function buildCharacter' in cut, 'buildCharacter not inside cut'
assert 'export const JOINT' in cut, 'JOINT not inside cut'
assert 'export interface CharacterRig' in cut, 'CharacterRig not inside cut'

repl = """/* ─────────────────────────────────────────────────────────────────────────────
   The character
   ─────────────────────────────────────────────────────────────────────── */

/**
 * The body lives in `characterrig.ts`.
 *
 * It moved out when it stopped being sixty boxes: it now carries its own PBR surface
 * set and enough smooth geometry that keeping it here buried the netcode this file is
 * actually about. Re-exported rather than re-imported at each call site, because the
 * lobby's staging room imports all four names from `./actors` and there was no reason
 * to make that churn.
 */
export {
  ENVELOPE,
  JOINT,
  NEUTRAL_COLOR,
  buildCharacter,
  type CharacterRig,
} from './characterrig';

"""
s = s[:start] + repl + s[end:]

# 3. actors.ts still needs these two at runtime for its own poses and disposal.
old_imp = "import * as THREE from 'three';\nimport {\n  AF,"
new_imp = ("import * as THREE from 'three';\n"
           "import { JOINT, NEUTRAL_COLOR, buildCharacter, type CharacterRig } from './characterrig';\n"
           "import {\n  AF,")
assert s.count(old_imp) == 1
s = s.replace(old_imp, new_imp)

# 4. The rig's materials are physically shaded now. Only `.color` is read from them
#    outside this file, so the change is confined to these three annotations.
for name in ('bodyMat', 'trimMat', 'gearMat'):
    for old_ty in ('THREE.MeshLambertMaterial', 'THREE.MeshPhongMaterial'):
        a = '  private %s: %s;' % (name, old_ty)
        if a in s:
            s = s.replace(a, '  private %s: THREE.MeshStandardMaterial;' % name)
            break
    else:
        sys.exit('no private decl for ' + name)

assert s != orig
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('actors.ts spliced ok')
