// ReShade FX has no forward declarations: a declaration without its body is an error even when the body
// follows directly (X3510), and calling a function defined later is undeclared. reorderFunctions removes
// the declarations and moves a function that calls a later one to follow it.
const porter = require('./load_porter.js')();

let bad = 0, total = 0;
function check(label, ok, detail)
{
	total++;
	if (!ok) { bad++; console.log('FAIL', label, detail ? '\n' + detail : ''); }
}
const order = (src, names) => names.map(n => src.indexOf(n + '(')).every((v, i, a) => v >= 0 && (i === 0 || v > a[i - 1]));
const count = (text, re) => (text.match(re) || []).length;
const run = (src, messages) => porter.reorderFunctions(src, messages || []);

// the shader that failed in ReShade: a declaration at the top, the caller in the middle, the body at the bottom
let src = 'float3 Post(float2 uv, float3 c);\nvoid mainImage(out float4 o, float2 p)\n{\n\to = float4(Post(p, float3(1.0, 1.0, 1.0)), 1.0);\n}\nfloat3 Post(float2 uv, float3 c)\n{\n\treturn c * uv.x;\n}\n';
let out = run(src);
check('the declaration is removed', count(out, /Post\([^)]*\)\s*;/g) === 0, out);
check('the callee now comes first', order(out, ['float3 Post', 'void mainImage']), out);
check('every function is still there exactly once', count(out, /float3 Post\(/g) === 1 && count(out, /void mainImage\(/g) === 1);
check('the call itself is untouched', out.indexOf('Post(p, float3(1.0, 1.0, 1.0))') >= 0);

// a declaration directly above its own body: only the declaration goes
src = 'float f(float x);\nfloat f(float x)\n{\n\treturn x;\n}\nfloat g(float x)\n{\n\treturn f(x);\n}\n';
out = run(src);
check('declaration above its own definition: removed, order kept', count(out, /float f\(float x\);/g) === 0 && order(out, ['float f', 'float g']), out);

// no declarations: the source comes back byte for byte
src = 'float f(float x)\n{\n\treturn x;\n}\nfloat g(float x)\n{\n\treturn f(x);\n}\n';
check('without declarations the source is returned unchanged', run(src) === src);

// a chain: A calls B, B calls C, C is defined last
src = 'float B(float x);\nfloat C(float x);\nfloat A(float x)\n{\n\treturn B(x);\n}\nfloat B(float x)\n{\n\treturn C(x);\n}\nfloat C(float x)\n{\n\treturn x;\n}\n';
out = run(src);
check('a chain ends up callee first', order(out, ['float C', 'float B', 'float A']), out);
check('the chain has no declarations left', count(out, /\)\s*;/g) === 0 || !/float [ABC]\(float x\)\s*;/.test(out), out);

// overloads
src = 'float h(float x);\nfloat2 h(float2 x);\nfloat k(float x)\n{\n\treturn h(x) + h(float2(x, x)).x;\n}\nfloat h(float x)\n{\n\treturn x;\n}\nfloat2 h(float2 x)\n{\n\treturn x;\n}\n';
out = run(src);
check('overloads: both declarations removed, both bodies before the caller', count(out, /float2? h\([^)]*\)\s*;/g) === 0 && out.indexOf('float k(') > out.lastIndexOf('float2 h('), out);

// the parameter style of the failing shader
src = 'float3 Fx( const in float2 vUV, const in float3 vInput );\nvoid mainImage(out float4 o, float2 p)\n{\n\to = float4(Fx(p, float3(0.0, 0.0, 0.0)), 1.0);\n}\nfloat3 Fx( const in float2 vUV, const in float3 vInput )\n{\n\treturn vInput;\n}\n';
check('const in parameters', order(run(src), ['float3 Fx', 'void mainImage']) && count(run(src), /Fx\([^)]*\)\s*;/g) === 0);

// globals, structs and macros never move
src = 'float V(float x);\nstatic float early = 1.0;\nvoid mainImage(out float4 o, float2 p)\n{\n\to = float4(V(late), early, 0.0, 1.0);\n}\nstatic float late = 2.0;\n#define SCALE 3.0\nfloat V(float x)\n{\n\treturn x * SCALE + late;\n}\n';
out = run(src);
check('a global declared before the moved function stays before it', out.indexOf('static float early') < out.indexOf('void mainImage'), out);
check('a global and a macro declared before the callee stay before it', out.indexOf('static float late') < out.indexOf('float V(') && out.indexOf('#define SCALE') < out.indexOf('float V('), out);
check('the moved function is placed after the callee it needed', out.indexOf('float V(') < out.indexOf('void mainImage('), out);

// a function inside #if is not moved, and that is reported
src = 'float W(float x);\n#if 1\nvoid mainImage(out float4 o, float2 p)\n{\n\to = float4(W(p.x));\n}\n#endif\nfloat W(float x)\n{\n\treturn x;\n}\n';
let msgs = [];
out = run(src, msgs);
check('a caller inside #if stays where it is', out.indexOf('#if 1') < out.indexOf('void mainImage') && out.indexOf('void mainImage') < out.indexOf('float W('), out);
check('and it is reported', msgs.some(m => m.level === 'warn' && /#if/.test(m.text)), JSON.stringify(msgs));

// a declaration that nothing defines is kept and reported
msgs = [];
out = run('float Z(float x);\nfloat q(float x)\n{\n\treturn x;\n}\n', msgs);
check('a declaration without any definition is kept', out.indexOf('float Z(float x);') >= 0);
check('and reported', msgs.some(m => m.level === 'warn' && /never defined/.test(m.text)), JSON.stringify(msgs));

// running it twice changes nothing more
src = 'float3 Post(float2 uv, float3 c);\nvoid mainImage(out float4 o, float2 p)\n{\n\to = float4(Post(p, float3(1.0, 1.0, 1.0)), 1.0);\n}\nfloat3 Post(float2 uv, float3 c)\n{\n\treturn c * uv.x;\n}\n';
out = run(src);
check('idempotent', run(out) === out);

// the whole pipeline, from GLSL as Shadertoy has it
src = 'vec3 grade(vec2 uv, vec3 c);\nvoid mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = vec4(grade(fragCoord, vec3(0.5)), 1.0);\n}\nvec3 grade(vec2 uv, vec3 c)\n{\n\treturn c * uv.x;\n}\n';
const m3 = [];
porter.analyzeShader(src, m3);
out = porter.transformGLSL(src, m3, 'Image').src;
check('through the pipeline: grade is defined before mainImage', out.indexOf('float3 grade(float2 uv, float3 c)\n') >= 0 && out.indexOf('float3 grade(float2 uv, float3 c)\n') < out.indexOf('void mainImage_Image'), out);
check('through the pipeline: no declaration left', !/float3 grade\([^)]*\)\s*;/.test(out), out);
check('through the pipeline: the move is reported', m3.some(m => /forward declarations/.test(m.text)));

console.log((total - bad) + '/' + total + ' function-order tests OK');
process.exit(bad ? 1 : 0);
