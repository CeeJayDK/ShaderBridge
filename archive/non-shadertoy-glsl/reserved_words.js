// Archived from ShaderBridge_transform.js, RESERVED_IDENTIFIERS (v3.5.14).
// ReShade FX (or HLSL) reserves these, but GLSL ES 3.00 reserves them too: ANGLE reports
// "Illegal use of reserved word", so no Shadertoy shader can name anything this way.
// Desktop GLSL allows some of them as names (e.g. half, sample, shared in older versions).
// See README.md.
//
// Restore by adding them back to the words list. `half` was also the base name of the
// half family loop, which now skips it: `if (family !== 'half') { map[family] = family + '_'; }`
// (half2, half3x3 ... are ordinary names in GLSL ES and are still renamed).
var ARCHIVED_RESERVED_WORDS = ('asm cast class double enum extern external goto half inline interface long namespace '
	+ 'noinline noperspective public restrict sample short sizeof template this typedef union unsigned using volatile').split(' ');

// Checked and kept, because ANGLE treats them as identifiers in GLSL ES 3.00:
//   shared (keyword only from ES 3.10), precise (keyword only in ES 3.20 / with gpu_shader5)
