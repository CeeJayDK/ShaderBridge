// GLSL idioms that ReShade FX handles differently, found by running a corpus of common Shadertoy
// constructs through the real compiler (see corpus/). Each case runs the real transform pipeline.
const porter = require('./load_porter.js')();

let bad = 0, total = 0;
function check(label, ok, detail)
{
	total++;
	if (!ok) { bad++; console.log('FAIL', label, detail ? '\n   ' + detail : ''); }
}
function port(helpers, body)
{
	const src = helpers + 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\t' + body + '\n}\n';
	const messages = [];
	porter.analyzeShader(src, messages);
	const r = porter.transformGLSL(src, messages, 'Image');
	return { out: r.src, messages: messages };
}
const has = (r, text) => r.out.indexOf(text) >= 0;

let r = port('', 'fragColor=vec4(unpackHalf2x16(0xc0003c00u),0.,1.);');
check('packed half floats use the low and high halves in order', has(r, 'return f16tof32(uint2(bits, ST_shiftRight_uint(bits, 16)));'), r.out);
check('half unpack helper is injected once', (r.out.match(/float2 unpackHalf2x16\(/g) || []).length === 1);
r = port('vec2 unpackHalf2x16(uint bits){return vec2(0.);}\n', 'fragColor=vec4(unpackHalf2x16(0u),0.,1.);');
check('shader-defined half unpack function is preserved', !has(r, 'f16tof32('));
r = port('uint counter=0u; uint nextBits(){counter++; return 0x3c003c00u;}\n', 'fragColor=vec4(unpackHalf2x16(nextBits()),0.,1.);');
check('half unpack argument is evaluated once', (r.out.match(/unpackHalf2x16\(nextBits\(\)\)/g) || []).length === 1, r.out);

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

// ── precision statements (3.0.16)
r = port('precision highp float;\nprecision mediump int;\n', 'highp vec2 p = fragCoord; mediump float m = 0.5; fragColor = vec4(p, m, 1.);');
check('precision statements are removed entirely', !/precision/.test(r.out), r.out);
check('precision qualifiers are removed', has(r, 'float2 p = fragCoord;') && has(r, 'float m = 0.5;'));

// ── static globals of struct and array type (3.0.16)
r = port('struct L { vec3 c; float r; };\nL lights[2];\nfloat buf[4];\nL one;\nvec2 plain;\n', 'lights[0] = L(vec3(1.), 2.); buf[0] = 1.; one = lights[0]; plain = fragCoord; fragColor = vec4(one.c, 1.);');
check('struct array global is static', has(r, 'static L lights[2];'), r.out);
check('scalar array global is static', has(r, 'static float buf[4];'));
check('struct global is static', has(r, 'static L one;'));
check('plain vector global is still static', has(r, 'static float2 plain;'));
r = port('struct S { vec2 a; float b; };\nS make(vec2 p) { S s; s.a = p; s.b = p.x; return s; }\n', 'S s = make(fragCoord); fragColor = vec4(s.a, s.b, 1.);');
check('a function returning a struct is not made static', !has(r, 'static S make'), r.out);
check('locals are not made static', !has(r, 'static S s'));

// ── array constructors (3.0.17)
const conditionalArray=porter.transformGLSL('#define PICK 2\n#if PICK==1\nconst float values[]=float[](1.,2.);\n#else\nconst float values[]=float[](1.,2.,3.);\n#endif\nvoid mainImage(out vec4 c,vec2 p){c=vec4(float(values.length()));}',[],'Image').src;
check('conditional array lengths follow the selected declaration', /#define ST_ARRAY_LENGTH_values \(2\)/.test(conditionalArray) && /#define ST_ARRAY_LENGTH_values \(3\)/.test(conditionalArray) && !/\.length\(/.test(conditionalArray),conditionalArray);
check('symbolic array lengths retain expression precedence', porter.rewriteArrayLength('const int N=2; float values[N+1]; float x=1./values.length();',[]).includes('1./(N+1)'));
check('a same-named struct field cannot define a global array length macro', !/ST_ARRAY_LENGTH/.test(porter.rewriteArrayLength('struct Item{float values[3];}; float values[2]; void f(){float x=float(values.length());}',[])));
r = port('const int COUNT=2;\nconst vec2 points[COUNT]=vec2[COUNT](vec2(1.,2.),vec2(3.,4.));\n', 'fragColor=vec4(points[0],points[1]);');
check('array constructors accept named constant sizes', /points\[COUNT\]=\{float2\(1\.,2\.\),float2\(3\.,4\.\)\};/.test(r.out), r.out);
check('type-side array sizes can be constant expressions', porter.rewriteArrayConstructors('float[COUNT + 1] points = float[COUNT + 1](1.,2.,3.);',[]) === 'float points[COUNT + 1] = {1.,2.,3.};');
r = port('const float W[3] = float[3](0.2, 0.5, 0.3);\n', 'fragColor = vec4(W[1]);');
check('explicit-size array constructor', has(r, 'W[3] = {0.2, 0.5, 0.3};'), r.out);
r = port('const vec2 O[2] = vec2[2](vec2(0., 1.), vec2(1., 0.));\n', 'fragColor = vec4(O[0], O[1]);');
check('constructor arguments may contain parentheses', has(r, 'O[2] = {float2(0., 1.), float2(1., 0.)};'), r.out);
r = port('const float W[] = float[](0.2, 0.5, 0.3);\n', 'fragColor = vec4(W[1]);');
check('size left out still works', has(r, 'W[] = {0.2, 0.5, 0.3};'));
r = port('', 'float a[1] = float[1](2.0); fragColor = vec4(a[0]);');
check('single-element array', has(r, 'a[1] = {2.0};') || has(r, 'a[1] = {2.};'), r.out);
r = port('', 'float[3] a = float[3](1., 2., 3.); fragColor = vec4(a[0]);');
check('brackets after the type move to the name', has(r, 'float a[3] = {1., 2., 3.};'), r.out);
r = port('struct L { vec3 c; float r; };\n', 'L ls[2] = L[2](L(vec3(1.), 2.), L(vec3(0.), 3.)); fragColor = vec4(ls[0].c, ls[1].r);');
check('struct array constructor with nested constructors', /ls\[2\] = \{L_ctor\(float3\(1\., 1\., 1\.\), 2\.\), L_ctor\(float3\(0\., 0\., 0\.\), 3\.\)\};/.test(r.out), r.out);
check('an ordinary index expression is not an array constructor', porter.rewriteArrayConstructors('a[2] (x); b[i] = 3;', []) === 'a[2] (x); b[i] = 3;');
check('nested array constructors', porter.rewriteArrayConstructors('float[2][2] x = float[2](float[2](1.,2.), float[2](3.,4.));', []).indexOf('{{1.,2.}, {3.,4.}}') >= 0 || porter.rewriteArrayConstructors('float[2](float[2](1.,2.), float[2](3.,4.))', []) === '{{1.,2.}, {3.,4.}}');

// ── diagonal matrices (3.0.17)
const dm = (t) => porter.rewriteDiagonalMatrices('float4 f(float s)\n{\n\tfloat4 q;\n\t' + t + '\n\treturn q;\n}\n', []).split('\n')[3].trim();
check('float2x2(1.0) is the identity', dm('float2x2 m = float2x2(1.0);') === 'float2x2 m = float2x2(1.0, 0.0, 0.0, 1.0);', dm('float2x2 m = float2x2(1.0);'));
check('float3x3(s) puts s on the diagonal', dm('float3x3 m = float3x3(s);') === 'float3x3 m = float3x3(s, 0.0, 0.0, 0.0, s, 0.0, 0.0, 0.0, s);', dm('float3x3 m = float3x3(s);'));
check('float4x4 has four on the diagonal', (dm('float4x4 m = float4x4(2.0);').match(/2\.0/g) || []).length === 4);
check('a scalar expression is repeated on the diagonal', dm('float2x2 m = float2x2(s * 2.0);') === 'float2x2 m = float2x2(s * 2.0, 0.0, 0.0, s * 2.0);');
check('a non-square matrix is filled by position', dm('float2x3 m = float2x3(s);') === 'float2x3 m = float2x3(s, 0.0, 0.0, 0.0, s, 0.0);');
check('four scalars are left alone', dm('float2x2 m = float2x2(s, s, s, s);') === 'float2x2 m = float2x2(s, s, s, s);');
check('a matrix built from vectors is left alone', dm('float2x2 m = float2x2(float2(s, s), float2(s, s));') === 'float2x2 m = float2x2(float2(s, s), float2(s, s));');
r = port('', 'mat3 m = mat3(1.0); vec3 p = m * vec3(fragCoord, 1.); fragColor = vec4(p, 1.);');
check('through the whole pipeline: identity, then the matrix multiply', has(r, 'float3x3(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)') && has(r, 'mul('), r.out);

// ── comparison functions and renamed built-ins (3.0.18)
const gb = porter.rewriteGlslBuiltins;
check('lessThan', gb('b = lessThan(a, c);') === 'b = (a < c);');
check('lessThanEqual', gb('b = lessThanEqual(a, c);') === 'b = (a <= c);');
check('greaterThan', gb('b = greaterThan(a, c);') === 'b = (a > c);');
check('greaterThanEqual', gb('b = greaterThanEqual(a, c);') === 'b = (a >= c);');
check('equal', gb('b = equal(a, c);') === 'b = (a == c);');
check('notEqual', gb('b = notEqual(a, c);') === 'b = (a != c);');
check('not', gb('b = not(x);') === 'b = (!x);');
check('compound operands are parenthesised', gb('b = lessThan(a + 1.0, floor(c));') === 'b = ((a + 1.0) < (floor(c)));');
check('operands with commas inside calls', gb('b = equal(mod(p, float2(2., 3.)), q);') === 'b = ((mod(p, float2(2., 3.))) == q);');
check('nested comparison functions', gb('b = all(greaterThan(a, vec2(0.)) ) && any(not(lessThan(a, c)));') === 'b = all((a > (vec2(0.))) ) && any((!(a < c)));');
check('not of a nested call', gb('b = not(lessThan(a, c));') === 'b = (!(a < c));');
check('names inside longer identifiers are untouched', gb('x = equalize(a, b) + myNot(a) + notEqualish(a);') === 'x = equalize(a, b) + myNot(a) + notEqualish(a);');
check('a function the shader defines itself is left alone', gb('bool equal(float a, float b) { return a == b; }\nb = equal(x, y);').indexOf('b = equal(x, y);') >= 0);
check('roundEven → round', gb('x = roundEven(y);') === 'x = round(y);');
check('floatBitsToInt → asint', gb('i = floatBitsToInt(f);') === 'i = asint(f);');
check('floatBitsToUint → asuint', gb('u = floatBitsToUint(f);') === 'u = asuint(f);');
check('intBitsToFloat / uintBitsToFloat → asfloat', gb('f = intBitsToFloat(i) + uintBitsToFloat(u);') === 'f = asfloat(i) + asfloat(u);');
r = port('', 'bool b = all(greaterThan(fragCoord, vec2(1.))) && any(lessThanEqual(fragCoord, vec2(5.))); fragColor = vec4(float(b));');
check('through the pipeline', has(r, 'all((fragCoord > (float2(1., 1.))))') && has(r, 'any((fragCoord <= (float2(5., 5.))))'), r.out);

// ── switch (3.0.18)
const sw = (cases) => porter.rewriteSwitchBreaks('void f(int k, out float v)\n{\n\tswitch (k)\n\t{\n' + cases + '\t}\n}\n', []);
let out = sw('\tcase 0: v = 1.; break;\n\tcase 1: v = 2.; break;\n\tdefault: v = 3.;\n');
check('open final default gets a break', out.indexOf('default: v = 3.; break;') >= 0, out);
out = sw('\tcase 0: v = 1.; break;\n\tdefault: v = 3.; break;\n');
check('a group that already breaks is untouched', out.indexOf('break; break;') < 0);
out = sw('\tcase 0: v = 1.; break;\n\tdefault: return;\n');
check('a group that returns is untouched', out.indexOf('return; break;') < 0);
out = sw('\tcase 0:\n\tcase 1: v = 1.; break;\n\tdefault: v = 0.;\n');
check('stacked empty cases are left alone', out.indexOf('case 0:\n\tcase 1:') >= 0 && out.indexOf('default: v = 0.; break;') >= 0);
out = sw('\tcase 0: { v = 1.; break; }\n\tdefault: { v = 0.; }\n');
check('block bodies are left to the author', out.indexOf('break; break;') < 0);
const msgs = [];
out = porter.rewriteSwitchBreaks('void f(int k, out float v)\n{\n\tswitch (k)\n\t{\n\tcase 0: v = 1.;\n\tcase 1: v = 2.; break;\n\t}\n}\n', msgs);
check('fallthrough in the middle is reported, not changed', msgs.length === 1 && msgs[0].level === 'warn' && out.indexOf('v = 1.;\n') >= 0 && out.indexOf('v = 1.; break;') < 0, out);
out = porter.rewriteSwitchBreaks('void f(int k, out float v)\n{\n\tswitch (k)\n\t{\n\tcase 0: v = 1.; break;\n\tcase 1: switch (k) { case 1: v = 2.; break; default: v = 3.; }\n\t}\n}\n', []);
check('nested switch: the inner open default is fixed', out.indexOf('default: v = 3.; break;') >= 0, out);
r = port('', 'int k = int(fragCoord.x) % 3; vec3 c = vec3(0.); switch (k) { case 0: c = vec3(1., 0., 0.); break; case 1: c = vec3(0., 1., 0.); break; default: c = vec3(0., 0., 1.); } fragColor = vec4(c, 1.);');
check('through the pipeline', /default: c = float3\(0\., 0\., 1\.\); break;/.test(r.out), r.out);

// ── function-like macros are typed from their bodies (3.0.19)
const lateMacro = porter.transformGLSL('vec2 MAKE(float x) { return vec2(x,x+1.); }\nvec2 before(float x) { return MAKE(x); }\n#define MAKE(x) vec2(x)\nvoid mainImage(out vec4 c, vec2 p) { c=vec4(before(p.x),MAKE(p.y)); }', [], 'Image').src;
check('a later macro definition does not replace an earlier function call', /return MAKE\(x\);/.test(lateMacro), lateMacro);
check('the same macro expands normally after its definition', /float4\(before\(p.x\),float2\(p.y, p.y\)\)/.test(lateMacro), lateMacro);
const macroCollision = porter.transformGLSL('#define SCALE(x) ((x)*2.)\nvoid mainImage(out vec4 c, vec2 p) { float SCALE=1.; c=vec4(SCALE + SCALE(p.x)); }', [], 'Image').src;
check('variables sharing function-macro names are renamed without changing macro calls', /ST_var_SCALE/.test(macroCollision) && /SCALE\(p.x\)/.test(macroCollision), macroCollision);
const indentedGlobal = porter.transformGLSL('  vec2 value;\nvoid mainImage(out vec4 c, vec2 p) // header note\n{ value=p; c=vec4(value,0.,1.); }', [], 'Image').src;
check('indented globals remain writable', /static float2 value;/.test(indentedGlobal), indentedGlobal);
check('comments between the entry signature and its brace do not hide its body', /c = float4\(0.0, 0.0, 0.0, 1.0\)/.test(indentedGlobal), indentedGlobal);
const repeatedMacro = porter.transformGLSL('#define MAKE(v) vec2(v)\n#define MAKE(v) vec2(v)\nvoid mainImage(out vec4 c, vec2 p) { c=vec4(MAKE(p.x),0.,1.); }', [], 'Image').src;
check('identical repeated macro definitions can still be expanded safely', /float2\(p.x, p.x\)/.test(repeatedMacro), repeatedMacro);
const rectangularMatrix = porter.transformGLSL('void mainImage(out vec4 c, vec2 p) { mat3x2 m=mat3x2(1.,2.,3.,4.,5.,6.); c=vec4(p*m,1.); }', [], 'Image').src;
check('rectangular matrices preserve transposed storage and product dimensions', /float3x2 m/.test(rectangularMatrix) && /mul\(m, p\)/.test(rectangularMatrix), rectangularMatrix);
const sampleUniforms = new Set(); porter.detectUniforms('float s=iSampleRate;', sampleUniforms);
const sampleMessages = []; porter.analyzeShader('void mainImage(out vec4 c,vec2 p){c=vec4(iSampleRate);}', sampleMessages);
check('iSampleRate is declared for visual shaders without rejecting them as sound programs', /iSampleRate = 44100.0/.test(porter.buildUniformBlock(sampleUniforms)) && !sampleMessages.some(m=>m.level==='error'));
const entryMacro = porter.transformGLSL('vec2 size; int frame;\n#define ENTRY void mainImage(out vec4 c, vec2 p) { size=iResolution.xy; frame=iFrame;\nfloat gain (float x) { return x * 0.5; }\nENTRY c=vec4(gain(p.x)); }', [], 'Image').src;
check('a macro can open the mainImage definition', /void mainImage_Image\(float2 p/.test(entryMacro) && /c = float4\(0.0, 0.0, 0.0, 1.0\)/.test(entryMacro), entryMacro);
check('spaced function headers are not made static', !/static float gain/.test(entryMacro), entryMacro);
check('same-line globals separated by spaces are made static', /static float2 size;\s*static int frame;/.test(entryMacro), entryMacro);
check('entry macro definitions stay intact on one preprocessor line', /#define ENTRY void mainImage\(out float4 c, float2 p\) \{/.test(entryMacro), entryMacro);
const statementMacro = porter.transformGLSL('#define ROTATE(v,a) { float c=cos(a), s=sin(a); v *= mat2(c,-s,s,c); }\nvoid mainImage(out vec4 c, vec2 p) { ROTATE(p, 0.5); c = vec4(p, 0., 1.); }', [], 'Image').src;
check('statement macros expose matrix assignments to the typed rewriter', /p = mul\(float2x2\(c,-s,s,c\), p\)/.test(statementMacro), statementMacro);
const highUint = porter.transformGLSL('#define LIMIT float(0xffffffffU)\nvoid mainImage(out vec4 c, vec2 p) { c = vec4(float(0x80000000U) / LIMIT); }', [], 'Image').src;
check('high unsigned constants become floating-point literals in casts and macros', /float\(4294967295.0\)/.test(highUint) && /float\(2147483648.0\)/.test(highUint), highUint);
const untouchedUint = {src:'uint value=0xffffffffU; float signedValue=float(-1); string text="float(0xffffffffU)";'};
porter.stepUnsignedFloatConstants(untouchedUint);
check('integer literals, signed casts and quoted text stay unchanged', untouchedUint.src === 'uint value=0xffffffffU; float signedValue=float(-1); string text="float(0xffffffffU)";');
let compatMacro = porter.transformGLSL('#define SIZE int2(iResolution)\nvoid mainImage(out vec4 c, vec2 p) { c = vec4(vec2(SIZE), 0., 1.); }', [], 'Image').src;
check('constructors inside object macros reach vector truncation', /int2\(iResolution.xy\)/.test(compatMacro), compatMacro);
compatMacro = porter.transformGLSL('#define READ(p) texelFetch(iChannel0, ivec2(p), 0)\n#define ACTIVE(k) (READ(vec2(k,0)).x > 0.5)\nvoid mainImage(out vec4 c, vec2 p) { if ACTIVE(2) c = vec4(1.); else c = vec4(0.); }', [], 'Image', {emptySamplers:['iChannel0']}).src;
check('nested lookup macros expose unconnected channels and unbraced conditions', !/if ACTIVE/.test(compatMacro) && /if \(float4\(0.0, 0.0, 0.0, 0.0\).x/.test(compatMacro), compatMacro);
compatMacro = porter.transformGLSL('void mainImage(out vec4 c, vec2 p) { vec2 q; float d = (q = vec2(iResolution), dot(q,q)); c = vec4(d); }', [], 'Image').src;
check('parenthesized comma expressions expose constructors to typed rewrites', /q = float2\(iResolution.xy\)/.test(compatMacro), compatMacro);
const ambiguousMacro = {src:'#if OPTION\n#define SIZE int2(iResolution)\n#else\n#define SIZE int2(1,2)\n#endif\nvoid f(){int2 q=SIZE;}'};
porter.stepCompatibilityMacros(ambiguousMacro);
check('conditional macro definitions remain with the preprocessor', /q=SIZE/.test(ambiguousMacro.src));
const matrixMacro = 'mat2 BASIS = mat2(1., 2., 3., 4.);\n#define APPLY(v) (BASIS * (v))\n';
r = port(matrixMacro, 'fragColor = vec4(APPLY(fragCoord), 0., 1.);');
check('matrix products inside macros reach the mul rewrite', /mul\(/.test(r.out) && !/APPLY\(fragCoord\)/.test(r.out), r.out);
r = port(matrixMacro + '#define WRAP(v) APPLY(v)\n', 'fragColor = vec4(WRAP(fragCoord), 0., 1.);');
check('nested matrix macros are expanded at their call sites', !/WRAP\(fragCoord\)/.test(r.out) && /mul\(/.test(r.out), r.out);
r = port('#define APPLY(m,v) ((m) * (v))\n', 'mat2 basis = mat2(1.); fragColor = vec4(APPLY(basis, fragCoord), 0., 1.);');
check('a matrix passed as a macro argument is rewritten', !/APPLY\(basis, fragCoord\)/.test(r.out) && /mul\(/.test(r.out), r.out);
r = port('#define SCALE(v) ((v) * 2.0)\n', 'fragColor = vec4(SCALE(fragCoord), 0., 1.);');
check('scalar-only arithmetic macros stay macros', /SCALE\(fragCoord\)/.test(r.out), r.out);
r = port(matrixMacro + '#undef APPLY\n#define APPLY(v) ((v) * 2.0)\n', 'fragColor = vec4(APPLY(fragCoord), 0., 1.);');
check('redefined macros stay under the preprocessor rather than choosing one definition', /APPLY\(fragCoord\)/.test(r.out), r.out);
r = port(matrixMacro, 'vec2 q = APPLY(fragCoord.xy + vec2(1.)); fragColor = vec4(q, 0., 1.);');
check('expanded macro arguments keep their expression grouping', /mul\(\(\(fragCoord.xy \+ float2\(1\., 1\.\)\)\)\), BASIS\)/.test(r.out) || /mul\([^;]*fragCoord.xy \+ float2\(1\., 1\.\)/.test(r.out), r.out);
const MACROS = '#define SQ(x) ((x) * (x))\n#define LEN2(v) dot(v, v)\n#define TWICE(x) (2.0 * SQ(x))\n#define PICK(a, b, t) lerp(a, b, t)\n'
	+ '#define STR(x) #x\n#define CAT(a, b) a ## b\n#define LONG(x) \\\n\t(x + 1.0)\n#define NOARGS() 3.0\n';
function macroType(expr)
{
	const prog = MACROS + 'float2 uv; float3 c; float s;\nvoid f()\n{\n\tfloat __t = ' + expr + ';\n}\n';
	const A = porter.analyzeSource(prog);
	const f = A.functions['f'][0];
	for (let k = f.bodyFrom; k < f.bodyTo; k++)
	{
		if (A.tokens[A.sig[k]].text === '__t')
		{
			const r = A.parseExpr(k + 2);
			return r && A.tokens[A.sig[r.next]].text === ';' ? r.node.type : 'PARSEFAIL';
		}
	}
	return 'NOTFOUND';
}
check('macro on a scalar', macroType('SQ(s)') === 'float', macroType('SQ(s)'));
check('the same macro on a vector is typed per call', macroType('SQ(uv)') === 'float2', macroType('SQ(uv)'));
check('macro returning a scalar from vectors', macroType('LEN2(c)') === 'float', macroType('LEN2(c)'));
check('a macro that uses another macro', macroType('TWICE(c)') === 'float3', macroType('TWICE(c)'));
check('macro with several parameters', macroType('PICK(c, c, s)') === 'float3', macroType('PICK(c, c, s)'));
check('macro defined over several lines', macroType('LONG(uv)') === 'float2', macroType('LONG(uv)'));
check('macro without parameters', macroType('NOARGS()') === 'float', macroType('NOARGS()'));
check('unknown argument type gives no answer', macroType('SQ(mystery)') === null, String(macroType('SQ(mystery)')));
check('wrong argument count gives no answer', macroType('SQ(s, s)') === null);
check('stringizing and token pasting give no answer', macroType('STR(s)') === null && macroType('CAT(s, s)') === null);
check('macro result used in an expression', macroType('SQ(s) + LEN2(c)') === 'float', macroType('SQ(s) + LEN2(c)'));
r = port('#define SQ(x) ((x) * (x))\n#define LEN2(v) dot(v, v)\n', 'fragColor = vec4(SQ(fragCoord.x) + LEN2(fragCoord));');
check('a scalar macro result is broadcast into a vector', has(r, 'float4(SQ(fragCoord.x) + LEN2(fragCoord), SQ(fragCoord.x) + LEN2(fragCoord), SQ(fragCoord.x) + LEN2(fragCoord), SQ(fragCoord.x) + LEN2(fragCoord))'), r.out);
r = port('#define V2(x) vec2(x, x)\n', 'vec3 c = vec3(V2(fragCoord.x), 1.0); fragColor = vec4(c, 1.0);');
check('a macro that builds a vector is not broadcast', !has(r, 'float3(V2(fragCoord.x), V2(fragCoord.x)'), r.out);

// pathological macros must not hang or crash the analyzer
function macroTypeWith(defs, expr)
{
	const prog = defs + 'float s;\nvoid f()\n{\n\tfloat __t = ' + expr + ';\n}\n';
	try
	{
		const A = porter.analyzeSource(prog);
		const f = A.functions['f'][0];
		for (let k = f.bodyFrom; k < f.bodyTo; k++)
		{
			if (A.tokens[A.sig[k]].text === '__t') { const r = A.parseExpr(k + 2); return r ? r.node.type : 'PARSEFAIL'; }
		}
	}
	catch (e) { return 'CRASH ' + e.message; }
	return 'NOTFOUND';
}
check('a self-referential macro gives no answer and does not crash', macroTypeWith('#define LOOP(x) LOOP(x)\n', 'LOOP(s)') === null, String(macroTypeWith('#define LOOP(x) LOOP(x)\n', 'LOOP(s)')));
check('mutually recursive macros give no answer and do not crash', macroTypeWith('#define PING(x) PONG(x)\n#define PONG(x) PING(x)\n', 'PING(s)') === null, String(macroTypeWith('#define PING(x) PONG(x)\n#define PONG(x) PING(x)\n', 'PING(s)')));
check('a chain of macros within the depth limit is typed', macroTypeWith('#define A1(x) (x)\n#define A2(x) A1(x)\n#define A3(x) A2(x)\n', 'A3(s)') === 'float', String(macroTypeWith('#define A1(x) (x)\n#define A2(x) A1(x)\n#define A3(x) A2(x)\n', 'A3(s)')));

// ── helpers for built-ins ReShade lacks (3.0.20)
// the generated inverse is checked numerically: evaluate its element expressions on random matrices
function numericInverse(M)
{
	const n = M.length;
	const A = M.map((row, i) => row.concat(Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))));
	for (let c = 0; c < n; c++)
	{
		let p = c;
		for (let r = c + 1; r < n; r++) { if (Math.abs(A[r][c]) > Math.abs(A[p][c])) { p = r; } }
		[A[c], A[p]] = [A[p], A[c]];
		const d = A[c][c];
		for (let j = 0; j < 2 * n; j++) { A[c][j] /= d; }
		for (let r = 0; r < n; r++) { if (r !== c) { const f = A[r][c]; for (let j = 0; j < 2 * n; j++) { A[r][j] -= f * A[c][j]; } } }
	}
	return A.map(row => row.slice(n));
}
function numericDet(M)
{
	const n = M.length;
	if (n === 1) { return M[0][0]; }
	let d = 0;
	for (let c = 0; c < n; c++) { d += (c % 2 ? -1 : 1) * M[0][c] * numericDet(M.slice(1).map(row => row.filter((_, j) => j !== c))); }
	return d;
}
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 4 - 2; };
[2, 3, 4].forEach(function (n)
{
	let worst = 0;
	for (let trial = 0; trial < 20; trial++)
	{
		const M = Array.from({ length: n }, () => Array.from({ length: n }, rnd));
		const det = numericDet(M);
		if (Math.abs(det) < 0.05) { continue; }
		const inv = numericInverse(M);
		const exprs = porter.inverseElementExpressions(n);
		for (let i = 0; i < n; i++)
		{
			for (let j = 0; j < n; j++)
			{
				const got = new Function('m', 'return ' + exprs[i * n + j])(M) / det;
				worst = Math.max(worst, Math.abs(got - inv[i][j]));
			}
		}
	}
	check('inverse ' + n + 'x' + n + ' matches a numeric inverse (worst error ' + worst.toExponential(1) + ')', worst < 1e-9);
});
check('the inverse helper uses the determinant intrinsic and a multiply', /float3x3 inverse\(float3x3 m\)\n\{\n\tfloat id = 1\.0 \/ determinant\(m\);/.test(porter.glslHelperSource('inverse', 3)));
check('outerProduct builds columns first', porter.glslHelperSource('outerProduct', 2).indexOf('float2x2(c.x * r.x, c.y * r.x, c.x * r.y, c.y * r.y)') >= 0, porter.glslHelperSource('outerProduct', 2));
check('outerProduct 3x3 element order', porter.glslHelperSource('outerProduct', 3).indexOf('float3x3(c.x * r.x, c.y * r.x, c.z * r.x, c.x * r.y, c.y * r.y, c.z * r.y, c.x * r.z, c.y * r.z, c.z * r.z)') >= 0);
check('matrixCompMult multiplies rows, not matrices', porter.glslHelperSource('matrixCompMult', 2).indexOf('float2x2(a[0] * b[0], a[1] * b[1])') >= 0);
check('no call, no helper', porter.injectGlslHelpers('float2x2 m;\nfloat f() { return 1.; }\n') === 'float2x2 m;\nfloat f() { return 1.; }\n');
let inj = porter.injectGlslHelpers('float3x3 m;\nfloat3x3 g() { return inverse(m); }\n');
check('only the matrix size in use is added', inj.indexOf('float3x3 inverse(float3x3 m)') >= 0 && inj.indexOf('float2x2 inverse') < 0 && inj.indexOf('float4x4 inverse') < 0);
check('helpers go in front of the code that uses them', inj.indexOf('inverse(float3x3 m)') < inj.indexOf('g()'));
inj = porter.injectGlslHelpers('float2x2 inverse(float2x2 m) { return m; }\nfloat2x2 q;\nfloat2x2 g() { return inverse(q); }\n');
check('a shader that defines its own inverse is left alone', inj.indexOf('float id = 1.0') < 0);
r = port('', 'mat3 m = mat3(1.0); mat3 i = inverse(m); fragColor = vec4(i[0], 1.);');
check('through the pipeline: the 3x3 helper is added once and called', (r.out.match(/float3x3 inverse\(float3x3 m\)/g) || []).length === 1 && has(r, 'inverse(m)'), r.out.slice(0, 400));
r = port('', 'mat2 o = outerProduct(vec2(1., 2.), vec2(3., 4.)); mat2 c = matrixCompMult(o, o); fragColor = vec4(c[0], c[1]);');
check('outerProduct and matrixCompMult helpers added', has(r, 'float2x2 outerProduct(float2 c, float2 r)') && has(r, 'float2x2 matrixCompMult(float2x2 a, float2x2 b)'));
check('a matrixCompMult result is not turned into a matrix product', !/matrixCompMult\([^)]*\)\s*\*/.test(r.out));

// textureOffset / textureProj
const tv = (body) => porter.rewriteTextureVariants('float2 uv; float3 p3; float4 p4; int2 off; int2 ip;\nvoid f()\n{\n\t' + body + '\n}\n', []).split('\n')[3].trim();
check('textureOffset maps onto the tex2D offset overload', tv('float4 c = textureOffset(iChannel0, uv, off);') === 'float4 c = tex2D(iChannel0, uv, off);', tv('float4 c = textureOffset(iChannel0, uv, off);'));
check('textureOffset with a constant offset and a compound coordinate', tv('float4 c = textureOffset(iChannel0, uv * 2.0, int2(1, 0));') === 'float4 c = tex2D(iChannel0, uv * 2.0, int2(1, 0));');
check('textureLodOffset maps onto the tex2Dlod offset overload', tv('float4 c = textureLodOffset(iChannel0, uv, 2.0, off);') === 'float4 c = tex2Dlod(iChannel0, float4(uv, 0.0, 2.0), off);', tv('float4 c = textureLodOffset(iChannel0, uv, 2.0, off);'));
check('textureGradOffset maps onto the tex2Dgrad offset overload', tv('float4 c = textureGradOffset(iChannel0, uv, uv, uv, off);') === 'float4 c = tex2Dgrad(iChannel0, uv, uv, uv, off);');
check('texelFetchOffset adds the offset to the texel position', tv('float4 c = texelFetchOffset(iChannel0, ip, 1, off);') === 'float4 c = tex2Dfetch(iChannel0, ip + off, 1);', tv('float4 c = texelFetchOffset(iChannel0, ip, 1, off);'));
check('texelFetchOffset drops a lod of 0', tv('float4 c = texelFetchOffset(iChannel0, ip, 0, off);') === 'float4 c = tex2Dfetch(iChannel0, ip + off);');
check('texelFetchOffset parenthesises a compound position', tv('float4 c = texelFetchOffset(iChannel0, ip * 2, 0, off);') === 'float4 c = tex2Dfetch(iChannel0, (ip * 2) + off);');
check('textureProj with a float3 divides by z', tv('float4 c = textureProj(iChannel0, p3);') === 'float4 c = tex2D(iChannel0, p3.xy / p3.z);');
check('textureProj with a float4 divides by w', tv('float4 c = textureProj(iChannel0, p4);') === 'float4 c = tex2D(iChannel0, p4.xy / p4.w);');
check('textureProj with an expression parenthesises it', tv('float4 c = textureProj(iChannel0, float3(uv, 1.0));') === 'float4 c = tex2D(iChannel0, (float3(uv, 1.0)).xy / (float3(uv, 1.0)).z);');
check('textureProj with a float2 is left alone', tv('float4 c = textureProj(iChannel0, uv);') === 'float4 c = textureProj(iChannel0, uv);');
check('no such call: source returned untouched', porter.rewriteTextureVariants('void f() { }\n', []) === 'void f() { }\n');

// ── gl_FragCoord is a global (3.0.22)
r = port('#define F gl_FragCoord\nvec2 helper() { return F.xy / iResolution.xy; }\n', 'fragColor = vec4(helper(), 0., 1.);');
check('gl_FragCoord becomes the ST_FragCoord global, also through a macro', has(r, '#define F ST_FragCoord') && has(r, 'float2 helper()'), r.out);
check('the global is declared once, ahead of the code that uses it', has(r, 'static float4 ST_FragCoord;') && r.out.indexOf('static float4 ST_FragCoord;') < r.out.indexOf('float2 helper()'));
check('no stray reference to a fragCoord that only exists inside mainImage', !/\bF\.xy\b.*\bfragCoord\b/.test(r.out));
let q = porter.analyzeShader ? null : null;
const src2 = 'void mainImage(out vec4 O, in vec2 U)\n{\n\tO = vec4(gl_FragCoord.xy / iResolution.xy, 0., 1.);\n}\n';
const m2 = [];
porter.analyzeShader(src2, m2);
const out2 = porter.transformGLSL(src2, m2, 'Image').src;
check('a mainImage whose parameter is not called fragCoord still works', /ST_FragCoord\.xy/.test(out2) && !/\bfragCoord\b/.test(out2), out2);
r = port('', 'fragColor = vec4(1.);');
check('a shader that does not use gl_FragCoord gets no declaration', !has(r, 'ST_FragCoord'));

// ── cubemap lookups made with texture() (3.0.23)
const cube = (helpers, body, samplers) =>
{
	const src = helpers + 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\t' + body + '\n}\n';
	const messages = [];
	porter.analyzeShader(src, messages);
	return porter.transformGLSL(src, messages, 'Image', { cubemapSamplers: samplers || [] }).src;
};
let c = cube('', 'vec3 d = normalize(vec3(fragCoord, 1.)); fragColor = vec4(texture(iChannel0, d).rgb, 1.);', ['iChannel0']);
check('texture(cubemap, dir) goes through ST_cubemap_uv', /tex2D\(iChannel0, ST_cubemap_uv\(d\)\)/.test(c), c);
check('the helper is defined once, in front of the code', (c.match(/float2 ST_cubemap_uv\(/g) || []).length === 1 && c.indexOf('float2 ST_cubemap_uv(') < c.indexOf('mainImage'));
c = cube('', 'vec3 d = normalize(vec3(fragCoord, 1.)); fragColor = vec4(texture(iChannel0, d).rgb, 1.);', []);
check('with no channel information a float3 coordinate is still recognised', /tex2D\(iChannel0, ST_cubemap_uv\(d\)\)/.test(c), c);
c = cube('', 'fragColor = vec4(texture(iChannel0, vec3(fragCoord, 1.)).rgb, 1.);', ['iChannel0']);
check('an inline vec3 direction', /ST_cubemap_uv\(float3\(fragCoord, 1\.0?\)\)/.test(c), c);
c = cube('', 'vec3 d = vec3(1.); fragColor = vec4(textureLod(iChannel0, d, 2.0).rgb, 1.);', ['iChannel0']);
check('textureLod on a cubemap', /tex2Dlod\(iChannel0, float4\(ST_cubemap_uv\(d\), 0\.0, 2\.0\)\)/.test(c), c);
c = cube('vec3 env(samplerCube s, vec3 d) { return texture(s, d).rgb; }\n', 'fragColor = vec4(env(iChannel0, vec3(1.)), 1.);', ['iChannel0']);
check('a samplerCube parameter becomes a sampler2D and its lookups are rewritten', /float3 env\(sampler2D s, float3 d\)/.test(c) && /tex2D\(s, ST_cubemap_uv\(d\)\)/.test(c), c);
c = cube('', 'fragColor = texture(iChannel0, fragCoord / iResolution.xy);', []);
check('an ordinary 2D lookup is not touched', !/ST_cubemap_uv/.test(c), c);
c = cube('', 'fragColor = textureLod(iChannel0, fragCoord / iResolution.xy, 1.0);', []);
check('an ordinary 2D textureLod is not touched', !/ST_cubemap_uv/.test(c), c);
c = cube('', 'vec3 d = vec3(1.); fragColor = textureCube(iChannel0, d);', ['iChannel0']);
check('the older textureCube name is not wrapped twice', (c.match(/ST_cubemap_uv\(d\)/g) || []).length === 1 && !/ST_cubemap_uv\(ST_cubemap_uv/.test(c), c);
const cm = [];
porter.rewriteCubemapLookups('float4 f(float3 d)\n{\n\treturn tex2D(iChannel0, d);\n}\n', ['iChannel0'], cm);
check('a rewrite is reported', cm.some(m => /cubemap lookup/.test(m.text)));

// ── == and != on vectors (3.0.30)
const ve = (body) => porter.rewriteVectorEquality('float3 v; float3 w; float2 a; float2 b; float2x2 m; float2x2 n; float f; int i;\nvoid g()\n{\n\t' + body + '\n}\n', []).split('\n')[3].trim();
check('== on two vectors is one boolean', ve('if (v == w) f = 1.0;') === 'if (all(v == w)) f = 1.0;', ve('if (v == w) f = 1.0;'));
check('!= on two vectors is one boolean', ve('if (v != w) f = 1.0;') === 'if (any(v != w)) f = 1.0;', ve('if (v != w) f = 1.0;'));
check('matrices are left alone, and that is reported', ve('if (m == n) f = 1.0;') === 'if (m == n) f = 1.0;' && (function () { const msgs = []; porter.rewriteVectorEquality('float2x2 m; float2x2 n; float f;\nvoid g()\n{\n\tif (m != n) f = 1.0;\n}\n', msgs); return msgs.some(x => x.level === 'warn' && /matrices/.test(x.text)); }()));
check('a swizzle against a vector', ve('if (v.xy == a) f = 1.0;') === 'if (all(v.xy == a)) f = 1.0;', ve('if (v.xy == a) f = 1.0;'));
check('a constructor against a vector', ve('if (float3(1.0, 2.0, 3.0) == v) f = 1.0;') === 'if (all(float3(1.0, 2.0, 3.0) == v)) f = 1.0;', ve('if (float3(1.0, 2.0, 3.0) == v) f = 1.0;'));
check('both operators in one condition', ve('if (v == w && a != b) f = 1.0;') === 'if (all(v == w) && any(a != b)) f = 1.0;', ve('if (v == w && a != b) f = 1.0;'));
check('in an initialiser', ve('bool t = v == w;') === 'bool t = all(v == w);', ve('bool t = v == w;'));
check('as an argument', ve('f = float(v == w);') === 'f = float(all(v == w));', ve('f = float(v == w);'));
check('as a ternary condition', ve('f = v == w ? 1.0 : 0.0;') === 'f = all(v == w) ? 1.0 : 0.0;', ve('f = v == w ? 1.0 : 0.0;'));
check('scalars are left alone', ve('if (f == 1.0) i = 2;') === 'if (f == 1.0) i = 2;' && ve('if (i != 2) f = 0.0;') === 'if (i != 2) f = 0.0;');
check('without == or != the source comes back untouched', porter.rewriteVectorEquality('float f;\nvoid g() { f = 1.0; }\n', []) === 'float f;\nvoid g() { f = 1.0; }\n');
r = port('', 'vec3 v = vec3(fragCoord, 1.); if (v == vec3(0.)) { fragColor = vec4(1.); } else { fragColor = vec4(0.); }');
check('through the pipeline: a shader\'s own == on vectors becomes all()', has(r, 'all(v == float3(0., 0., 0.))'), r.out);
r = port('', 'vec3 v = vec3(fragCoord, 1.); vec3 w = vec3(1.); fragColor = vec4(vec3(equal(v, w)), 1.);');
check('through the pipeline: equal() stays component-wise', has(r, '(v == w)') && !has(r, 'all(v == w)') && !has(r, 'any(v == w)'), r.out);
r = port('', 'vec3 v = vec3(fragCoord, 1.); vec3 w = vec3(1.); bool same = v == w; bool allSame = all(equal(v, w)); fragColor = vec4(float(same), float(allSame), 0., 1.);');
check('through the pipeline: both kinds in one shader keep their own meaning', has(r, 'bool same = all(v == w);') && has(r, 'all((v == w))') && !has(r, 'all(all('), r.out);

// ── object-like macros are typed in the context of the file (3.0.30)
check('an object-like macro that uses another macro', macroTypeWith('#define PI 3.141592654\n#define TAU (2.0*PI)\n', 'TAU') === 'float', String(macroTypeWith('#define PI 3.141592654\n#define TAU (2.0*PI)\n', 'TAU')));
check('and it types what uses it', macroTypeWith('#define PI 3.141592654\n#define TAU (2.0*PI)\n', 'TAU * s + 0.5') === 'float');
check('a macro that uses a global', macroTypeWith('float g;\n#define HALF (g * 0.5)\n', 'HALF') === 'float');
check('a macro that uses a vector global gives a vector', macroTypeWith('float3 c;\n#define TWICE (c * 2.0)\n', 'TWICE') === 'float3', String(macroTypeWith('float3 c;\n#define TWICE (c * 2.0)\n', 'TWICE')));
check('a global declared after the macro still counts', macroTypeWith('#define LATE (late * 2.0)\nfloat2 late;\n', 'LATE') === 'float2', String(macroTypeWith('#define LATE (late * 2.0)\nfloat2 late;\n', 'LATE')));
check('a macro that calls a function', macroTypeWith('float2 mk(float x);\n#define FROM_ONE mk(1.0)\n', 'FROM_ONE') === 'float2', String(macroTypeWith('float2 mk(float x);\n#define FROM_ONE mk(1.0)\n', 'FROM_ONE')));
check('a macro in a macro in a macro', macroTypeWith('#define A1 1.0\n#define A2 (A1)\n#define A3 (A2 * 2.0)\n', 'A3') === 'float');
check('a macro that uses a function-like macro', macroTypeWith('#define SQ(x) ((x) * (x))\n#define AREA SQ(2.0)\n', 'AREA') === 'float', String(macroTypeWith('#define SQ(x) ((x) * (x))\n#define AREA SQ(2.0)\n', 'AREA')));
check('a macro that uses itself gives no answer and does not crash', macroTypeWith('#define LOOP (LOOP + 1.0)\n', 'LOOP') === null, String(macroTypeWith('#define LOOP (LOOP + 1.0)\n', 'LOOP')));
check('two object-like macros that use each other give no answer and do not crash', macroTypeWith('#define PING (PONG + 1.0)\n#define PONG (PING + 1.0)\n', 'PING') === null, String(macroTypeWith('#define PING (PONG + 1.0)\n#define PONG (PING + 1.0)\n', 'PING')));
check('a macro that is not an expression gives no answer', macroTypeWith('#define BLOCK { 1.0 }\n', 'BLOCK') === null || macroTypeWith('#define BLOCK { 1.0 }\n', 'BLOCK') === 'PARSEFAIL', String(macroTypeWith('#define BLOCK { 1.0 }\n', 'BLOCK')));
check('a chain far deeper than the limit gives no answer instead of running away', (function () { let d = '#define M0 1.0\n'; for (let k = 1; k <= 12; k++) { d += '#define M' + k + ' (M' + (k - 1) + ')\n'; } const t = macroTypeWith(d, 'M12'); return t === null || t === 'float'; }()));
r = port('#define PI 3.141592654\n#define TAU (2.0*PI)\n#define ROT(a) mat2(cos(a), sin(a), -sin(a), cos(a))\n', 'vec2 p = fragCoord; float h = 1.0; p *= ROT(TAU*h + 0.5); fragColor = vec4(p, 0., 1.);');
check('through the pipeline: a matrix multiply whose argument uses a macro of a macro', has(r, 'p = mul(ROT(TAU*h + 0.5), p);'), r.out);

// ── an initialiser that uses a hoisted global is hoisted too (3.0.32)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function hoist(globals)
{
	const g = globals + 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = vec4(0.);\n}\n';
	const m = [];
	porter.analyzeShader(g, m);
	return porter.transformGLSL(g, m, 'Image');
}
let hz = hoist('const float base = sin(1.0);\nfloat scaled = base * 2.0;\nvec2 pair = vec2(scaled, base);\n');
check('a chain of globals is hoisted in declaration order', same(hz.globalInits, ['base = sin(1.0);', 'scaled = base * 2.0;', 'pair = float2(scaled, base);']), JSON.stringify(hz.globalInits));
check('and the declarations are left without initialisers', /static float base;/.test(hz.src) && /static float scaled;/.test(hz.src) && /static float2 pair;/.test(hz.src), hz.src);
hz = hoist('const float K = 2.0;\nfloat L = K * 3.0;\n');
check('an initialiser that only uses constants stays where it is', hz.globalInits.length === 0 && /static float L = K \* 3\.0;/.test(hz.src), JSON.stringify(hz.globalInits) + hz.src);
hz = hoist('float a = sin(1.0);\nfloat ab = 2.0;\nfloat c = ab * 2.0;\n');
check('a name that is the start of another name does not count', same(hz.globalInits, ['a = sin(1.0);']), JSON.stringify(hz.globalInits));
hz = hoist('float x = sin(1.0);\nvec2 v = vec2(1.0, 2.0);\nfloat y = v.x;\n');
check('a member name is not a use of a global of that name', same(hz.globalInits, ['x = sin(1.0);']), JSON.stringify(hz.globalInits));
hz = hoist('#define ROT(a) mat2(cos(a), sin(a), -sin(a), cos(a))\nconst mat2 rot0 = ROT(0.0);\nmat2 g_rot0 = rot0;\nmat2 g_rot1 = rot0;\n');
check('the Appolloian pattern: a matrix, and two more built from it', same(hz.globalInits, ['rot0 = ROT(0.0);', 'g_rot0 = rot0;', 'g_rot1 = rot0;']), JSON.stringify(hz.globalInits));
hz = hoist('float one = 1.0;\nfloat s0 = sin(one);\nfloat two = 2.0;\nfloat t = s0 + two;\n');
check('unrelated globals in between stay, and the order is kept', same(hz.globalInits, ['s0 = sin(one);', 't = s0 + two;']) && /static float two = 2\.0;/.test(hz.src), JSON.stringify(hz.globalInits));

// ── several variables in one global declaration (3.0.33)
const bits = porter.transformGLSL('void mainImage(out vec4 c, vec2 p) { int k = int(p.x); c = vec4(float((k >> 1) & 1)); }', [], 'Image').src;
check('constant right shifts and low-bit masks use DX9-compatible helpers', /ST_lowBits\([^;]*ST_shiftRight\(k, 1\)/.test(bits), bits);
check('modern APIs retain native bitwise operations', /return value >> amount;/.test(bits) && /return value & amount;/.test(bits), bits);
check('DX9 helpers are guarded and round signed shifts down', /#if __RENDERER__ == 0x9000/.test(bits) && /floor\(float\(value\) \* exp2\(-float\(amount\)\)\)/.test(bits));
const oddMask = porter.transformGLSL('void mainImage(out vec4 c, vec2 p) { int k = int(p.x); c = vec4(float(k & 5)); }', [], 'Image').src;
check('unsupported masks are left as native operations', /k & 5/.test(oddMask) && !/ST_lowBits/.test(oddMask));
const dynamicShift = porter.transformGLSL('void mainImage(out vec4 c, vec2 p) { int k = int(p.x); c = vec4(float(k >> int(p.y))); }', [], 'Image').src;
check('dynamic shift amounts are not approximated', /k >> int\(p.y\)/.test(dynamicShift) && !/ST_shiftRight/.test(dynamicShift));
const localScopeSrc = 'vec2 shade(vec2 q)\n{\nvec2 local = sin(q), other = cos(q);\nconst float gain = 0.25;\nreturn (local + other) * gain;\n}\nvoid mainImage(out vec4 color, vec2 pixel) { color = vec4(shade(pixel), 0., 1.); }';
const localScopeResult = porter.transformGLSL(localScopeSrc, [], 'Image');
check('unindented function locals are not made static', !/static (?:const )?(?:float2 local|float gain)/.test(localScopeResult.src), localScopeResult.src);
check('unindented local initializers are not hoisted', localScopeResult.globalInits.length === 0 && /local = sin\(q\), other = cos\(q\)/.test(localScopeResult.src), JSON.stringify(localScopeResult.globalInits));
const localSameLine = { src: 'float shade(float q){float x=q;float y=sin(q);return x+y;}' };
porter.stepStaticGlobals(localSameLine);
check('same-line local declarations are not made static', !/static/.test(localSameLine.src), localSameLine.src);
const localStaticInit = { src: 'float shade(float q)\n{\nstatic float value = sin(q);\nreturn value;\n}' };
porter.stepHoistGlobalInits(localStaticInit);
check('even explicitly static locals are not hoisted out of their function', localStaticInit.globalInits.length === 0 && /value = sin\(q\)/.test(localStaticInit.src));
const memberSrc = 'struct Sample\n{\nfloat weight;\n};\n';
const memberCtx = { src: memberSrc };
porter.stepStaticGlobals(memberCtx);
check('unindented struct members are not made static', memberCtx.src === memberSrc, memberCtx.src);
const sp = (text) => porter.splitGlobalDeclarators(text, []);
check('a declaration with two variables becomes two', sp('float a = 1.0, b = 2.0;\n') === 'float a = 1.0;\nfloat b = 2.0;\n', JSON.stringify(sp('float a = 1.0, b = 2.0;\n')));
check('a variable without an initialiser', sp('float a, b = 2.0, c;\n') === 'float a;\nfloat b = 2.0;\nfloat c;\n', JSON.stringify(sp('float a, b = 2.0, c;\n')));
check('the style with the commas first', sp('const float\n  pi = acos(-1.)\n, tau = 2.*pi\n, k = .5\n;\n') === 'const float pi = acos(-1.);\nconst float tau = 2.*pi;\nconst float k = .5;\n', JSON.stringify(sp('const float\n  pi = acos(-1.)\n, tau = 2.*pi\n, k = .5\n;\n')));
check('a comma inside parentheses separates nothing', sp('vec2 p = vec2(1., 2.), q = vec2(3., 4.);\n') === 'vec2 p = vec2(1., 2.);\nvec2 q = vec2(3., 4.);\n');
check('arrays', sp('float a[2], b[3];\n') === 'float a[2];\nfloat b[3];\n');
check('a user type', sp('struct S { float a; };\nS s1, s2;\n') === 'struct S { float a; };\nS s1;\nS s2;\n', JSON.stringify(sp('struct S { float a; };\nS s1, s2;\n')));
check('the qualifiers are kept on every variable', sp('static const float a = 1.0, b = 2.0;\n') === 'static const float a = 1.0;\nstatic const float b = 2.0;\n');
check('a comment at the end of a variable stays and the semicolon goes before it', sp('float a = 1.0\n, b = 2.0 «0»\n;\n') === 'float a = 1.0;\nfloat b = 2.0; «0»\n', JSON.stringify(sp('float a = 1.0\n, b = 2.0 «0»\n;\n')));
check('indentation is kept for the new lines', sp('\tfloat a = 1.0, b = 2.0;\n') === '\tfloat a = 1.0;\n\tfloat b = 2.0;\n', JSON.stringify(sp('\tfloat a = 1.0, b = 2.0;\n')));
check('local declarations are not touched', sp('void f()\n{\n\tfloat x = 1.0, y = 2.0;\n}\n') === 'void f()\n{\n\tfloat x = 1.0, y = 2.0;\n}\n');
check('struct members are not touched', sp('struct S { float a, b; };\n') === 'struct S { float a, b; };\n');
check('a function with several parameters is not touched', sp('float f(float a, float b);\nfloat f(float a, float b)\n{\n\treturn a + b;\n}\n') === 'float f(float a, float b);\nfloat f(float a, float b)\n{\n\treturn a + b;\n}\n');
check('a loop with a comma is not touched', sp('void f()\n{\n\tfor (int i = 0, j = 1; i < 2; i++, j++) { }\n}\n') === 'void f()\n{\n\tfor (int i = 0, j = 1; i < 2; i++, j++) { }\n}\n');
check('a preprocessor line in between does not matter', sp('#define X 1\nfloat a = 1.0, b = 2.0;\n#define Y 2\nfloat c = 3.0;\n') === '#define X 1\nfloat a = 1.0;\nfloat b = 2.0;\n#define Y 2\nfloat c = 3.0;\n');
check('two declarations in a row', sp('float a = 1.0, b = 2.0;\nfloat c = 3.0, d = 4.0;\n') === 'float a = 1.0;\nfloat b = 2.0;\nfloat c = 3.0;\nfloat d = 4.0;\n');
check('with nothing to split the text is returned as it was', sp('float a = 1.0;\nvoid f() { }\n') === 'float a = 1.0;\nvoid f() { }\n');
check('a statement that never ends does not crash and is not touched', sp('float a = 1.0, b = 2.0') === 'float a = 1.0, b = 2.0');
check('a comment after a comma on the same line stays with the variable before it (the gaussian blur pattern)', sp('const int samples = 35,\n\t\t  LOD = 2,         «0»\n\t\t  sLOD = 1 << LOD; «1»\n') === 'const int samples = 35;\nconst int LOD = 2;         «0»\nconst int sLOD = 1 << LOD; «1»\n', JSON.stringify(sp('const int samples = 35,\n\t\t  LOD = 2,         «0»\n\t\t  sLOD = 1 << LOD; «1»\n')));
check('a comment on a line of its own stands before the declaration it belongs to', sp('float a = 1.0,\n«1»\nb = 2.0;\n') === 'float a = 1.0;\n«1»\nfloat b = 2.0;\n', JSON.stringify(sp('float a = 1.0,\n«1»\nb = 2.0;\n')));
check('both kinds of comment, and indentation kept', sp('\tfloat a = 1.0, «0»\n\t«1»\n\tb = 2.0;\n') === '\tfloat a = 1.0; «0»\n\t«1»\n\tfloat b = 2.0;\n', JSON.stringify(sp('\tfloat a = 1.0, «0»\n\t«1»\n\tb = 2.0;\n')));
check('a comment before the comma stays with its variable', sp('float a = 1.0 «0»,\nb = 2.0;\n') === 'float a = 1.0; «0»\nfloat b = 2.0;\n', JSON.stringify(sp('float a = 1.0 «0»,\nb = 2.0;\n')));
const smsgs = [];
porter.splitGlobalDeclarators('float a = 1.0, b = 2.0;\nfloat c = 1.0, d = 2.0;\n', smsgs);
check('the number of declarations split is reported', smsgs.length === 1 && /2 global declaration/.test(smsgs[0].text), JSON.stringify(smsgs));
hz = hoist('const float\n  base = sin(1.0)\n, scaled = base * 2.0\n, plain = 3.0\n;\n');
check('through the pipeline: each variable is hoisted or kept on its own merits', same(hz.globalInits, ['base = sin(1.0);', 'scaled = base * 2.0;']) && /static float plain = 3\.0;|static const float plain = 3\.0;/.test(hz.src), JSON.stringify(hz.globalInits) + hz.src);

// ── array.length() (3.0.34)
const al = (text) => porter.rewriteArrayLength(text, []);
check('the size in the brackets', al('float a[3];\nint n = a.length();\n') === 'float a[3];\nint n = 3;\n', al('float a[3];\nint n = a.length();\n'));
check('an unsized array counts its initialiser', al('static const float a[] = {0.9, 0.25};\nint n = a.length();\n') === 'static const float a[] = {0.9, 0.25};\nint n = 2;\n', al('static const float a[] = {0.9, 0.25};\nint n = a.length();\n'));
check('commas inside parentheses are not elements', al('float2 p[] = {float2(1., 2.), float2(3., 4.), float2(5., 6.)};\nint n = p.length();\n').endsWith('int n = 3;\n'));
check('a trailing comma is not an element', al('float a[] = {1.0, 2.0,};\nint n = a.length();\n').endsWith('int n = 2;\n'));
check('an empty list has no elements', al('float a[] = {};\nint n = a.length();\n').endsWith('int n = 0;\n'));
check('a parameter that is an array', al('int f(float v[4])\n{\n\treturn v.length();\n}\n').indexOf('return 4;') >= 0, al('int f(float v[4])\n{\n\treturn v.length();\n}\n'));
check('in a loop condition', al('float a[5];\nvoid g() { for (int i = 0; i < a.length(); i++) { } }\n').indexOf('i < 5;') >= 0);
check('a return of an element is not read as a declaration', al('float a[3];\nfloat g() { return a[0]; }\nint n = a.length();\n').endsWith('int n = 3;\n'));
check('a member of a struct is not touched', al('float a[3];\nint n = s.a.length();\n') === 'float a[3];\nint n = s.a.length();\n');
check('the same name with the same size twice', al('void f() { float a[2]; }\nvoid g() { float a[2]; int n = a.length(); }\n').indexOf('int n = 2;') >= 0);
const lmsgs = [];
const same2 = porter.rewriteArrayLength('void f() { float a[2]; }\nvoid g() { float a[3]; int n = a.length(); }\n', lmsgs);
check('the same name with different sizes is left and reported', same2.indexOf('a.length()') >= 0 && lmsgs.some(m => m.level === 'warn' && /could not be replaced/.test(m.text)), JSON.stringify(lmsgs));
const vmsgs = [];
check('a vector has no array to read, so it is left and reported', porter.rewriteArrayLength('float3 v;\nint n = v.length();\n', vmsgs).indexOf('v.length()') >= 0 && vmsgs.some(m => m.level === 'warn'), JSON.stringify(vmsgs));
check('without length() the text comes back as it was', al('float a[3];\nint n = 3;\n') === 'float a[3];\nint n = 3;\n');
check('the number of calls replaced is reported', (function () { const mm = []; porter.rewriteArrayLength('float a[2];\nint n = a.length() + a.length();\n', mm); return mm.length === 1 && /2 array length/.test(mm[0].text); }()));
r = port('const float steps[] = float[](0.9, 0.25, 0.5);\n', 'float s = 0.; for (int i = 0; i < steps.length(); i++) { s += steps[i]; } fragColor = vec4(s);');
check('through the pipeline: the GLSL array constructor is counted', has(r, 'i < 3;'), r.out);

// ── a channel that is not connected reads zero (3.0.36)
const ecBody = (expr, names) => porter.rewriteEmptyChannels('float2 uv; float4 c;\nvoid g()\n{\n\tfloat k = ' + expr + ';\n}\n', names, []).split('\n')[3].trim();
check('a tex2Dlod lookup becomes zero', ecBody('tex2Dlod(iChannel3, float4(uv, 0.0, 0.0)).x', ['iChannel3']) === 'float k = float4(0.0, 0.0, 0.0, 0.0).x;', ecBody('tex2Dlod(iChannel3, float4(uv, 0.0, 0.0)).x', ['iChannel3']));
check('so do tex2D, tex2Dfetch, tex2Dgrad and tex2Dbias', ['tex2D(iChannel3, uv)', 'tex2Dfetch(iChannel3, int2(1, 2))', 'tex2Dgrad(iChannel3, uv, uv, uv)', 'tex2Dbias(iChannel3, float4(uv, 0.0, 1.0))'].every(e => ecBody(e + '.x', ['iChannel3']) === 'float k = float4(0.0, 0.0, 0.0, 0.0).x;'));
check('another sampler is left alone', ecBody('tex2D(iChannel0, uv).x', ['iChannel3']) === 'float k = tex2D(iChannel0, uv).x;');
check('only the first argument is the sampler', ecBody('tex2D(iChannel0, uv + float2(tex2D(iChannel3, uv).x, 0.0)).x', ['iChannel3']) === 'float k = tex2D(iChannel0, uv + float2(float4(0.0, 0.0, 0.0, 0.0).x, 0.0)).x;', ecBody('tex2D(iChannel0, uv + float2(tex2D(iChannel3, uv).x, 0.0)).x', ['iChannel3']));
check('several samplers at once', ecBody('tex2D(iChannel1, uv).x + tex2D(iChannel2, uv).x + tex2D(iChannel0, uv).x', ['iChannel1', 'iChannel2']) === 'float k = float4(0.0, 0.0, 0.0, 0.0).x + float4(0.0, 0.0, 0.0, 0.0).x + tex2D(iChannel0, uv).x;');
check('no empty channels: the text comes back as it was', porter.rewriteEmptyChannels('void g() { tex2D(iChannel3, uv); }\n', [], []) === 'void g() { tex2D(iChannel3, uv); }\n');
check('no lookups: the text comes back as it was', porter.rewriteEmptyChannels('float f;\n', ['iChannel3'], []) === 'float f;\n');
const emsgs = [];
porter.rewriteEmptyChannels('float2 uv;\nvoid g()\n{\n\tfloat a = tex2D(iChannel3, uv).x + tex2D(iChannel3, uv).y;\n}\n', ['iChannel3'], emsgs);
check('the number of lookups replaced is reported', emsgs.length === 1 && /2 lookup/.test(emsgs[0].text), JSON.stringify(emsgs));
const withOptions = (helpers, body, empty) =>
{
	const g = helpers + 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\t' + body + '\n}\n';
	const mm = [];
	porter.analyzeShader(g, mm);
	return porter.transformGLSL(g, mm, 'Image', { emptySamplers: empty }).src;
};
let keyOut = withOptions('bool ReadKey(int key, bool toggle)\n{\n\tfloat keyVal = textureLod(iChannel3, vec2((float(key) + .5) / 256., toggle ? .75 : .25), .0).x;\n\treturn keyVal > .5 ? true : false;\n}\n', 'fragColor = vec4(float(ReadKey(65, true)));', ['iChannel3']);
check('through the pipeline: the keyboard reads zero', /float4\(0\.0, 0\.0, 0\.0, 0\.0\)\.x/.test(keyOut) && keyOut.indexOf('iChannel3') < 0, keyOut);
keyOut = withOptions('', 'vec4 c = vec4(0.); for (int i = 0; i < 4; i++) { c += texture(iChannel3, fragCoord / iResolution.xy); } fragColor = c;', ['iChannel3']);
check('through the pipeline: also inside a loop', keyOut.indexOf('iChannel3') < 0 && /float4\(0\.0, 0\.0, 0\.0, 0\.0\)/.test(keyOut), keyOut);
keyOut = withOptions('', 'fragColor = texture(iChannel0, fragCoord / iResolution.xy);', ['iChannel3']);
check('through the pipeline: a connected channel is not touched', /tex2D\(iChannel0/.test(keyOut), keyOut);
keyOut = withOptions('', 'fragColor = texture(iChannel3, fragCoord / iResolution.xy);', undefined);
check('through the pipeline: without the option nothing is replaced', /tex2D\(iChannel3/.test(keyOut), keyOut);

// ── code after a return in the same block (3.0.36)
const fallback = 'float choose(float x)\n{\n\tif (x < 0.)\n\t\treturn 0.;\n\n\treturn x * 0.75;\n}\n';
r = port(fallback, 'fragColor = vec4(choose(fragCoord.x));');
check('a fallback return after an unbraced if survives the pipeline', has(r, 'return x * 0.75;'), r.out);
r = port('float choose(float x)\n{\n\tif (x > 2.) x = 2.;\n\telse return 0.;\n\treturn x;\n}\n', 'fragColor = vec4(choose(fragCoord.x));');
check('a return after an unbraced else survives the pipeline', has(r, 'return x;'), r.out);
r = port('float choose(float x)\n{\n\twhile (x > 2.)\n\t\treturn 1.;\n\treturn x;\n}\n', 'fragColor = vec4(choose(fragCoord.x));');
check('a fallback return after an unbraced loop survives the pipeline', has(r, 'return x;'), r.out);
r = port('float choose(float x)\n{\n\treturn x\n\t;return 1.;\n}\n', 'fragColor = vec4(choose(fragCoord.x));');
check('unreachable prefix-semicolon returns are still removed', !has(r, 'return 1.;') && has(r, 'return x'), r.out);
const ra = (text) => porter.removeCodeAfterReturn(text);
check('two returns on one line', ra('float f(){return 1.0;return 2.0;}') === 'float f(){return 1.0;}', ra('float f(){return 1.0;return 2.0;}'));
check('every statement after the return, to the end of the block', ra('float f(){ return a; b = 1.0; if (x) { c = 2.0; } }') === 'float f(){ return a; }', ra('float f(){ return a; b = 1.0; if (x) { c = 2.0; } }'));
check('a return with no value', ra('void f(){ return; x = 1.0; }') === 'void f(){ return; }');
check('a lone semicolon after a return', ra('float f(){ return x;; }') === 'float f(){ return x; }', ra('float f(){ return x;; }'));
check('a return that is the body of an if is not unconditional', ra('float f(){ if (c) return 1.0; return 2.0; }') === 'float f(){ if (c) return 1.0; return 2.0; }');
check('nor is the body of an else', ra('float f(){ if (c) x = 1.0; else return 1.0; return 2.0; }') === 'float f(){ if (c) x = 1.0; else return 1.0; return 2.0; }');
check('nor the body of a loop', ra('float f(){ for (;;) return 1.0; return 2.0; }') === 'float f(){ for (;;) return 1.0; return 2.0; }');
check('inside an if block only that block is cut', ra('float f(){ if (c) { return 1.0; x = 2.0; } y = 3.0; return y; }') === 'float f(){ if (c) { return 1.0; } y = 3.0; return y; }', ra('float f(){ if (c) { return 1.0; x = 2.0; } y = 3.0; return y; }'));
check('in a switch the next case is reachable', ra('void g(int x){ switch (x) { case 1: foo(); return; bar(); case 2: baz(); break; default: qux(); } }') === 'void g(int x){ switch (x) { case 1: foo(); return; case 2: baz(); break; default: qux(); } }', ra('void g(int x){ switch (x) { case 1: foo(); return; bar(); case 2: baz(); break; default: qux(); } }'));
check('and so is default', ra('void g(int x){ switch (x) { case 1: foo(); return; default: qux(); } }') === 'void g(int x){ switch (x) { case 1: foo(); return; default: qux(); } }');
check('a comment stays and is followed by a line break', ra('float f(){ return 1.0; «0»\n\tx = 2.0; }') === 'float f(){ return 1.0;\n «0»\n }', JSON.stringify(ra('float f(){ return 1.0; «0»\n\tx = 2.0; }')));
check('a comment line cannot swallow the closing brace', !/«\d+»\s*\}/.test(ra('float f(){ return 1.0; x = 2.0; «0» }').replace(/\n/g, ' ')) || /«\d+»\n/.test(ra('float f(){ return 1.0; x = 2.0; «0» }')));
check('a preprocessor line in the way stops it', ra('float f(){\n\treturn 1.0;\n\t#if A\n\tx = 2.0;\n\t#endif\n}') === 'float f(){\n\treturn 1.0;\n\t#if A\n\tx = 2.0;\n\t#endif\n}');
check('a return right after a case label is unconditional', ra('float f(int i){ switch (i) { case 0: return 1.0; i = 5; case 1: return 2.0; default: return 3.0; } }') === 'float f(int i){ switch (i) { case 0: return 1.0; case 1: return 2.0; default: return 3.0; } }', ra('float f(int i){ switch (i) { case 0: return 1.0; i = 5; case 1: return 2.0; default: return 3.0; } }'));
check('and so is one right after default', ra('float f(int i){ switch (i) { default: return 3.0; i = 1; } }') === 'float f(int i){ switch (i) { default: return 3.0; } }', ra('float f(int i){ switch (i) { default: return 3.0; i = 1; } }'));
check('a return with commas and parentheses in its value', ra('float2 f(){ return float2(1., 2.); return x; }') === 'float2 f(){ return float2(1., 2.); }', ra('float2 f(){ return float2(1., 2.); return x; }'));
check('two functions, each cut on its own', ra('float f(){ return 1.0; x = 2.0; }\nfloat g(){ return 3.0; y = 4.0; }\n') === 'float f(){ return 1.0; }\nfloat g(){ return 3.0; }\n', ra('float f(){ return 1.0; x = 2.0; }\nfloat g(){ return 3.0; y = 4.0; }\n'));
check('nothing to cut: the text comes back as it was', ra('float f(){ return 1.0; }\n') === 'float f(){ return 1.0; }\n');
check('no return at all: the text comes back as it was', ra('float f;\n') === 'float f;\n');
check('a function whose last statement is the return is not touched', ra('float f(){ float a = 1.0; return a; }') === 'float f(){ float a = 1.0; return a; }');
r = port('vec2 Noise(in vec3 x){return x.xy;return mix(x.yx, x.xz, x.y);}\n', 'fragColor = vec4(Noise(vec3(fragCoord, 1.)), 0., 1.);');
check('through the pipeline: the Wax pattern (mix has become lerp by then)', !/return lerp/.test(r.out) && /return x\.xy;/.test(r.out), r.out);

// ── a macro that stands for a type (3.0.37)
r = port('#define vec1 float\nvec1 half1(vec4 a) { return dot(vec4(1), a); }\n', 'fragColor = vec4(half1(vec4(1., 2., 3., 4.)));');
check('through the pipeline: a scalar broadcast inside a function whose type is a macro', has(r, 'dot(float4(1, 1, 1, 1), a)'), r.out);
r = port('#define vec1 float\n#define sat(x) clamp(x, 0., 1.)\nvec1 f(vec1 a) { vec3 c = vec3(a); return c.x; }\n', 'vec1 k = f(fragCoord.x); fragColor = vec4(k);');
check('through the pipeline: broadcast of a variable typed by a macro', has(r, 'float3(a, a, a)'), r.out);

r = port('#define V2 vec2\n#define V3 vec3\n', 'V2 a = V2(fragCoord.x); V3 b = V3(a.x); fragColor = vec4(a, b.xy);');
check('through the pipeline: a vector alias used as a constructor is expanded', has(r, 'V2(fragCoord.x, fragCoord.x)') && has(r, 'V3(a.x, a.x, a.x)'), r.out);
r = port('#define V4 vec4\n', 'vec3 c = vec3(1., 2., 3.); V4 w = V4(c, 1.); vec3 d = vec3(w); fragColor = vec4(d, 1.);');
check('through the pipeline: an alias of a larger vector is cut down where a smaller one is built', has(r, 'float3(w.xyz)'), r.out);
a2=porter.analyzeSource('#define V2 float2\nvoid f() { float2 p = V2(1.0); }\n');
let ctorNode = null; a2.eachExpression(n => { if (n.kind === 'call' && n.name === 'V2') { ctorNode = n; } });
check('the call node of an alias constructor says which type it builds', ctorNode && ctorNode.ctor === 'float2' && ctorNode.type === 'float2', JSON.stringify(ctorNode && { name: ctorNode.name, ctor: ctorNode.ctor, type: ctorNode.type }));
let plain = null; porter.analyzeSource('void f() { float2 p = float2(1.0); }\n').eachExpression(n => { if (n.kind === 'call' && n.name === 'float2') { plain = n; } });
check('an ordinary constructor has no ctor field', plain && plain.ctor === undefined);

// ── a constructor with one literal number inside a #define (3.0.38)
const mc = (text) => porter.expandLiteralConstructorsInMacros(text, []);
check('a vector of one literal in an object-like macro', mc('#define camTarget float3(0)\n') === '#define camTarget float3(0, 0, 0)\n', mc('#define camTarget float3(0)\n'));
check('a float literal', mc('#define H float2(.5)\n') === '#define H float2(.5, .5)\n');
check('an exponent, a sign and a suffix', mc('#define A float3(1e-3)\n#define B float2(-1)\n#define C float4(2.0f)\n') === '#define A float3(1e-3, 1e-3, 1e-3)\n#define B float2(-1, -1)\n#define C float4(2.0f, 2.0f, 2.0f, 2.0f)\n', mc('#define A float3(1e-3)\n#define B float2(-1)\n#define C float4(2.0f)\n'));
check('integer vectors and bool vectors', mc('#define I int2(2)\n#define U uint3(1)\n#define B bool2(1)\n') === '#define I int2(2, 2)\n#define U uint3(1, 1, 1)\n#define B bool2(1, 1)\n');
check('also in a function-like macro', mc('#define F(x) float4(1.0) * x\n') === '#define F(x) float4(1.0, 1.0, 1.0, 1.0) * x\n');
check('several in one macro', mc('#define X float3(0) + float3(1.0)\n') === '#define X float3(0, 0, 0) + float3(1.0, 1.0, 1.0)\n');
check('a macro that continues on the next line', mc('#define X \\\n\tfloat2(0.5)\n') === '#define X \\\n\tfloat2(0.5, 0.5)\n', JSON.stringify(mc('#define X \\\n\tfloat2(0.5)\n')));
check('a name inside the constructor is left alone (it may be a vector)', mc('#define M float4(a)\n') === '#define M float4(a)\n');
check('an expression inside the constructor is left alone', mc('#define M float3(a + 1.0)\n') === '#define M float3(a + 1.0)\n');
check('more than one argument is left alone', mc('#define P float3(0, 4, -4)\n') === '#define P float3(0, 4, -4)\n');
check('a constructor outside a macro is left to the expression pass', mc('float3 z = float3(0);\n') === 'float3 z = float3(0);\n');
check('other directives are not touched', mc('#if X == float3(0)\n#endif\n') === '#if X == float3(0)\n#endif\n');
check('a scalar type is not a vector constructor', mc('#define S float(1)\n') === '#define S float(1)\n');
check('without a # the text comes back as it was', mc('float f;\n') === 'float f;\n');
const mcm = [];
porter.expandLiteralConstructorsInMacros('#define A float3(0)\n#define B float2(1)\n', mcm);
check('the number written out is reported', mcm.length === 1 && /2 scalar constructor/.test(mcm[0].text), JSON.stringify(mcm));
r = port('#define ZERO vec3(0)\n#define HALF vec2(.5)\n#define ONE4(x) (vec4(1.0) * (x))\n', 'vec3 a = ZERO + vec3(fragCoord, 1.); fragColor = ONE4(vec4(a, 1.)) + vec4(HALF, 0., 0.);');
check('through the pipeline: macros with a literal constructor', has(r, '#define ZERO float3(0, 0, 0)') && has(r, '#define HALF float2(.5, .5)') && has(r, 'float4(1.0, 1.0, 1.0, 1.0)'), r.out);

console.log((total - bad) + '/' + total + ' glsl-compat tests OK');
process.exit(bad ? 1 : 0);
