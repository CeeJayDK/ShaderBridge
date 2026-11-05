// Archived tests for archive/non-shadertoy-glsl (see README.md). Not run by tests/run_all.js.
// Restore with the code they test: corpus entries go back in tests/corpus/snippets.js, unit checks
// in tests/t_glsl_compat.js (they use its port(), has() and check() helpers), the type case in tests/t_types.js.

// ── corpus snippets removed with the GLSL 4.x / ES 3.10+ helpers (v3.5.14)
var ARCHIVED_CORPUS = [
	['bit_count_functions', '', 'uint u=uint(fragCoord.x); int i=int(fragCoord.y)-50; ivec2 v=ivec2(fragCoord); int a=bitCount(u)+bitCount(i)+findLSB(u)+findMSB(i); ivec2 b=bitCount(v)+findMSB(uvec2(v)); fragColor=vec4(float(a),vec2(b),float(findMSB(0)<0));'],
	['bitfield_reverse', '', 'uint u=uint(fragCoord.x); int i=int(fragCoord.y); fragColor=vec4(float(bitfieldReverse(u)>>28u),float(bitfieldReverse(i)&1),0.,1.);'],
	['bitfield_extract_insert', '', 'int x=int(fragCoord.x)-64; uint u=uint(fragCoord.y); ivec2 v=ivec2(fragCoord); int a=bitfieldExtract(x,2,5)+bitfieldExtract(x,0,0); uint b=bitfieldExtract(u,1,31); ivec2 c=bitfieldExtract(v,1,3); uint d=bitfieldInsert(u,7u,4,3)+bitfieldInsert(u,u,0,32); ivec3 e=bitfieldInsert(ivec3(x),ivec3(1),2,2); fragColor=vec4(float(a),float(b>>24u),vec2(c))+float(d&255u)+vec3(e).xyzz;'],
	['uadd_carry', '', 'uint carry; uint s=uaddCarry(uint(fragCoord.x)*0x10000000u,0xF0000000u,carry); uvec2 carries; uvec2 t=uaddCarry(uvec2(fragCoord),uvec2(0xFFFFFFF0u),carries); fragColor=vec4(float(s>>28u),float(carry),vec2(carries)+vec2(t&15u));'],
	['vector_matrix_length', 'float count(vec3 q){return float(q.length());}\n', 'vec4 v=vec4(1); mat3x2 m=mat3x2(1.); fragColor=vec4(float(v.length()),float(m.length()),count(v.xyz),1.);'],
	['fma_fine_coarse_derivatives', '', 'fragColor=vec4(fma(fragCoord.x,2.,1.),dFdxFine(fragCoord.x),dFdyCoarse(fragCoord.y),dFdxCoarse(fragCoord.x)+dFdyFine(fragCoord.y));'],
	['pack_unpack', '', 'vec2 uv=fragCoord/iResolution.xy; uint a=packUnorm4x8(vec4(uv,.5,1)), b=packSnorm4x8(vec4(uv,-.5,-1)), c=packHalf2x16(uv), d=packUnorm2x16(uv), e=packSnorm2x16(-uv); fragColor=unpackUnorm4x8(a)+unpackSnorm4x8(b)+vec4(unpackHalf2x16(c),unpackUnorm2x16(d))+vec4(unpackSnorm2x16(e),0.,0.);'],
];

// ── corpus snippets as they were before the GLSL ES 3.00 cleanup; the current corpus keeps
// each one without its reserved words (name_half was removed), and fn_min_max_mixed with max(vector, scalar)
var ARCHIVED_CORPUS_ORIGINALS = [
	['fn_min_max_mixed', '', 'vec3 a = min(vec3(1., 2., 3.), 1.5); vec3 b = max(0.5, vec3(1., 2., 3.)); fragColor = vec4(a + b, 1.);'],
	['name_half', '', 'float half = 0.5; fragColor = vec4(half);'],
	['name_linear_sample', '', 'float linear = 1.; vec3 sample = vec3(0.5); fragColor = vec4(sample * linear, 1.);'],
	['name_misc_reserved', '', 'float export = 1.; float shared = 2.; float register = 3.; float interface = 4.; float precise = 5.; float inline = 6.; float fixed = 7.; fragColor = vec4(export + shared + register + interface + precise + inline + fixed);'],
	['name_dword_unorm', '', 'float dword = 1.; float unorm = 2.; float snorm = 3.; float decl = 4.; float extern = 5.; fragColor = vec4(dword + unorm + snorm + decl + extern);'],
	['name_fn_named_reserved', 'float line(vec2 p) { return p.x; }\nfloat sample(vec2 p) { return p.y; }\n', 'fragColor = vec4(line(fragCoord), sample(fragCoord), 0., 1.);'],
];

// ── t_types.js: the scalar-first overload (see scalar_first_min_max.js)
//	[ 'max(0.0, q)', 'float3' ],

// ── t_glsl_compat.js: helper and length() checks
const bitPort = port('', 'uint u = uint(fragCoord.x); int i = int(fragCoord.y); fragColor = vec4(float(bitCount(u) + findLSB(i) + findMSB(u)), float(bitfieldReverse(i)), fma(1., 2., 3.), dFdxFine(fragCoord.x) + dFdyCoarse(fragCoord.y));');
check('bit-counting helpers return int for int and uint arguments', has(bitPort, 'int bitCount(uint x)') && has(bitPort, 'int2 bitCount(int2 x)') && has(bitPort, 'return int(firstbitlow(uint(x)));') && has(bitPort, 'int findMSB(int x)\n{\n\treturn int(firstbithigh(x));'), bitPort.out);
check('bitfieldReverse keeps the argument type', has(bitPort, 'uint3 bitfieldReverse(uint3 x)') && has(bitPort, 'int bitfieldReverse(int x)'), bitPort.out);
check('fma and the fine and coarse derivatives are renamed', has(bitPort, 'mad(1., 2., 3.)') && has(bitPort, 'ddx_fine(fragCoord.x)') && has(bitPort, 'ddy_coarse(fragCoord.y)'), bitPort.out);
check('a shader that defines bitCount itself keeps it', porter.injectGlslHelpers('float bitCount(int x){return 1.;}\nfloat y=bitCount(2);') === 'float bitCount(int x){return 1.;}\nfloat y=bitCount(2);');
const fields = porter.injectGlslHelpers('int a = bitfieldExtract(x, 1, 2); uint b = bitfieldInsert(u, v, 3, 4); uint c = uaddCarry(u, v, k);');
check('bitfieldExtract has int and uint overloads that shift the field to the top and back', fields.includes('int bitfieldExtract(int value, int offset, int bits)') && fields.includes('uint4 bitfieldExtract(uint4 value, int offset, int bits)') && fields.includes('return (value << uint(32 - offset - bits)) >> uint(32 - bits);') && fields.includes('return (int2)0;'), fields);
check('bitfieldInsert masks the field, and the int overload goes through uint', fields.includes('uint3 bitfieldInsert(uint3 base, uint3 insert, int offset, int bits)') && fields.includes('return int2(bitfieldInsert(uint2(base), uint2(insert), offset, bits));') && fields.includes('bits >= 32 ? 0xFFFFFFFFu'), fields);
check('uaddCarry returns the sum and writes the carry', fields.includes('uint2 uaddCarry(uint2 x, uint2 y, out uint2 carry)') && fields.includes('carry = uint2(sum < x);'), fields);
const packing = porter.injectGlslHelpers('uint a = packUnorm4x8(v); float2 b = unpackSnorm2x16(a); uint c = packHalf2x16(b);');
check('packing helpers are added only for the functions that are called', packing.includes('uint packUnorm4x8(float4 v)') && packing.includes('float2 unpackSnorm2x16(uint p)') && packing.includes('uint packHalf2x16(float2 v)') && !packing.includes('unpackUnorm4x8'), packing);
// ── length() of vectors and matrices (3.5.13)
r = port('float count(vec3 q){return float(q.length());}\n', 'vec4 v = vec4(1.); mat3x2 m = mat3x2(1.); float a[2]; fragColor = vec4(float(v.length()), float(m.length()), float(a.length()), count(v.xyz));');
check('a vector has as many as its components, a matrix as its columns', has(r, 'float(4), float(3), float(2)') && has(r, 'return float(3);'), r.out);
check('a name declared with different sizes is left for review', porter.rewriteArrayLength('float f(float2 v){return float(v.length());}\nfloat g(float3 v){return float(v.length());}\n', []).includes('v.length()'));

// ── t_glsl_compat.js: the reserved-identifier block as it was, with the GLSL ES reserved words
// ── reserved identifiers (3.0.16)
r = port('', 'float half = 0.5; fragColor = vec4(half);');
check('half is renamed', has(r, 'float half_ = 0.5;') && has(r, 'float4(half_'), r.out);
r = port('', 'vec3 matrix = vec3(2.); float vector = 1.; float string = 3.; fragColor = vec4(matrix * vector, string);');
check('matrix / vector / string are renamed', has(r, 'matrix_') && has(r, 'vector_') && has(r, 'string_'));
r = port('', 'float shared = 1.; float register = 2.; float interface = 3.; float inline = 4.; float precise = 5.; float fixed = 7.; fragColor = vec4(shared + register + inline + precise + fixed);');
check('shared / register / inline / precise renamed', has(r, 'shared_') && has(r, 'register_') && has(r, 'inline_') && has(r, 'precise_'));
r = port('', 'float triangle = 1.; float sampler = 2.; float technique = 3.; float compile = 4.; fragColor = vec4(sampler + technique + compile);');
check('sampler / technique / compile renamed', has(r, 'sampler_ ') && has(r, 'technique_') && has(r, 'compile_'));
r = port('', 'float dword = 1.; float unorm = 2.; float snorm = 3.; fragColor = vec4(dword + unorm + snorm);');
check('dword / unorm / snorm renamed', has(r, 'dword_') && has(r, 'unorm_') && has(r, 'snorm_'));
r = port('', 'float decl = 4.; fragColor = vec4(decl);');
check('decl is renamed for the Direct3D compiler', has(r, 'float decl_ = 4.;') && !/\bdecl\b/.test(r.out), r.out);
r = port('', 'float point = 1.; float line = 2.; float linear = 3.; float sample = 4.; int pass = 5; fragColor = vec4(point + line + linear + sample + float(pass));');
check('the original five still renamed', has(r, 'point_') && has(r, 'line_') && has(r, 'linear_') && has(r, 'sample_') && has(r, 'pass_'));
r = port('float line(vec2 p) { return p.x; }\nfloat sample(vec2 p) { return p.y; }\n', 'fragColor = vec4(line(fragCoord), sample(fragCoord), 0., 1.);');
check('functions named with reserved words: definition and calls', has(r, 'float line_(float2 p)') && has(r, 'line_(fragCoord)') && has(r, 'sample_(fragCoord)'));
r = port('struct S { vec2 vector; float half; };\n', 'S s; s.vector = fragCoord; s.half = 1.; fragColor = vec4(s.vector, s.half, 1.);');
check('struct fields renamed at declaration and use', has(r, 'float2 vector_;') && has(r, 's.vector_') && has(r, 's.half_'));
r = port('#define half 0.5\n', 'fragColor = vec4(half);');
check('macro names renamed in #define and uses', has(r, '#define half_ 0.5') && has(r, 'float4(half_'));
r = port('', 'vec4 t = texture(iChannel0, fragCoord);  fragColor = t;');
check('texture() as a function call is untouched (it is converted to tex2D)', has(r, 'tex2D(iChannel0') && !has(r, 'texture_'));
r = port('', 'vec4 t = texture2D(iChannel0, fragCoord);  fragColor = t;');
check('legacy texture2D() call is untouched', has(r, 'tex2D(iChannel0') && !has(r, 'texture2D_'));
r = port('', 'float texture = 1.; fragColor = vec4(texture);');
check('a variable named texture is renamed', has(r, 'float texture_ = 1.0;') || has(r, 'float texture_ = 1.;'), r.out);
check('HLSL type names are not touched by the rename', porter.renameReservedIdentifiers('float2 a; float3x3 m; int4 i; uint u; bool2 b; sampler2D s;', []) === 'float2 a; float3x3 m; int4 i; uint u; bool2 b; sampler2D s;');
check('half and min16 families are renamed', porter.renameReservedIdentifiers('float half3 = 1.; float min16float4 = 2.;', []) === 'float half3_ = 1.; float min16float4_ = 2.;');
check('directive names are never renamed', porter.renameReservedIdentifiers('#define X 1\n#ifdef X\n#endif\n#undef X\n#include "a.fxh"\n', []) === '#define X 1\n#ifdef X\n#endif\n#undef X\n#include "a.fxh"\n');
check('a rename is reported', port('', 'float half = 1.; fragColor = vec4(half);').messages.some(m => /half → half_/.test(m.text)));
check('identifiers merely containing a reserved word are untouched', porter.renameReservedIdentifiers('float halfway = 1.; float my_line = 2.; float pointer = 3.;', []) === 'float halfway = 1.; float my_line = 2.; float pointer = 3.;');

r = port('', 'float interface = 1.; float foreach = 2.; float triangle = 3.; float export = 4.; float cbuffer = 5.; fragColor = vec4(interface + foreach + triangle + export + cbuffer);');
check('interface / foreach / triangle / export / cbuffer renamed', ['interface_', 'foreach_', 'triangle_', 'export_', 'cbuffer_'].every(w => has(r, w)));
check('HLSL-only reserved words are covered (a local named triangle reaches the Direct3D compiler)', ['triangle', 'triangleadj', 'lineadj', 'NULL', 'Buffer', 'cbuffer'].every(w => porter.RESERVED_IDENTIFIERS[w] === w + '_'));

// ── t_pipeline.js: the reservedIdentifiers example used `float half = 1.0;` (now `linear`)
