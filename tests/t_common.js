// A Common tab is included by every pass, so its structs, helpers and globals reach the assembler
// once per pass. Identical repeats of earlier passes must be dropped (the effect has one
// preprocessor and one namespace); real conflicts must be reported, not silently merged.
const porter = require('./load_porter.js')();

function makePass(id, src)
{
	const messages = [];
	const used = new Set();
	porter.analyzeShader(src, messages);
	porter.detectUniforms(src, used);
	const label = id === 'image' ? 'Image' : id.charAt(0).toUpperCase() + id.slice(1);
	const r = porter.transformGLSL(src, messages, label);
	return { id: id, src: r.src, coordVar: r.coordVar, mainImageName: r.mainImageName, globalInits: r.globalInits, usedUniforms: used,
		channels: [], channelNames: [], filters: [], wraps: [], vflips: [], format: 'RGBA32F', selfRefChannels: [] };
}
const main = 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tRay r = Ray(vec3(0.), vec3(1.));\n\tfragColor = vec4(hash(fragCoord.x) * r.d.x, 0., 0., 1.);\n}';
const common = 'struct Ray { vec3 o; vec3 d; };\nvec2 res;\nfloat hash(float x) { return fract(sin(x) * 43758.5453); }\n';
function assemble(passSources)
{
	const messages = [];
	const passes = passSources.map((src, i) => makePass(i === passSources.length - 1 ? 'image' : (i === 0 ? 'bufA' : 'bufB'), src));
	return { out: porter.assembleFxFile(passes, true, messages, null), messages: messages };
}
const count = (text, re) => (text.match(re) || []).length;

let bad = 0, total = 0;
function check(label, ok) { total++; if (!ok) { bad++; console.log('FAIL', label); } }

// the same Common code in two passes
let r = assemble([common + main, common + main]);
check('struct defined once', count(r.out, /struct Ray\b[^;]*;/g) === 1);
check('struct constructor helper defined once', count(r.out, /Ray Ray_ctor\(/g) === 1);
check('shared function defined once', count(r.out, /float hash\(float x\)/g) === 1);
check('shared global declared once', count(r.out, /static float2 res;/g) === 1);
check('both passes still have their own entry point', /mainImage_BufA/.test(r.out) && /mainImage_Image/.test(r.out));
check('the repeat is reported', r.messages.some(m => /struct definition/.test(m.text)));

// three passes
r = assemble([common + main, common + main, common + main]);
check('three passes: struct still defined once', count(r.out, /struct Ray\b[^;]*;/g) === 1);

// the same name defined differently is a real conflict: each pass gets its own name, and it is reported
r = assemble([common + main, common.replace('vec3 o; vec3 d;', 'vec3 o; vec3 d; float t;') + main]);
check('conflicting struct: both kept, under different names', count(r.out, /struct Ray\b[^;]*;/g) === 1 && count(r.out, /struct Ray_IMAGE\b[^;]*;/g) === 1);
check('conflicting struct: reported, with the new name', r.messages.some(m => /struct 'Ray' is declared differently/.test(m.text) && /Ray_IMAGE/.test(m.text)));

// within one pass, repeated definitions are #if / #else alternatives and must all stay
const alt = 'struct Ray { vec3 o; vec3 d; };\n#if 0\nstruct Cam { vec3 p; };\n#else\nstruct Cam { vec3 p; };\n#endif\n' + 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tCam c;\n\tfragColor = vec4(0.);\n}';
r = assemble([alt]);
check('#if/#else alternatives within one pass are both kept', count(r.out, /struct Cam\b[^;]*;/g) === 2);


// ── the layout of a struct does not matter to the comparison
const allman = 'struct Ray\n{\n\tvec3 o;\n\tvec3 d;\n};\n';
const indented = '\tstruct Ray\n\t{\n\t\tvec3 o;\n\t\tvec3 d;\n\t};\n';
r = assemble([allman + 'float hash(float x) { return x; }\n' + main, allman + 'float hash(float x) { return x; }\n' + main]);
check('the same struct with the brace on the next line is defined once', count(r.out, /struct Ray\b/g) === 1);
r = assemble([allman + 'float hash(float x) { return x; }\n' + main, common + main]);
check('Allman in one pass and one line in the other are the same struct', count(r.out, /struct Ray\b/g) === 1);
r = assemble([indented + 'float hash(float x) { return x; }\n' + main, allman + 'float hash(float x) { return x; }\n' + main]);
check('an indented struct is found too', count(r.out, /struct Ray\b/g) === 1);

// ── a global that the passes declare differently is two variables
const gMain = 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = vec4(camRot, 0., 0., 1.);\n}';
r = assemble(['float camRot = 1.5;\n' + gMain, 'float camRot = 1.4;\n' + gMain]);
check('two different values: each declared once, the second under its own name', count(r.out, /static float camRot\s*=\s*1\.5;/g) === 1 && count(r.out, /static float camRot_IMAGE\s*=\s*1\.4;/g) === 1, r.out);
check('and the second pass reads its own', /fragColor = float4\(camRot_IMAGE, /.test(r.out) && /fragColor = float4\(camRot, /.test(r.out), r.out);
check('the rename is reported', r.messages.some(m => /global 'camRot' is declared differently/.test(m.text) && /camRot_IMAGE/.test(m.text)));
r = assemble(['float camRot = 1.5;\n' + gMain, 'float camRot = 1.5;\n' + gMain]);
check('the same value is still one variable', count(r.out, /static float camRot\b/g) === 1 && r.out.indexOf('camRot_IMAGE') < 0);
r = assemble(['float camRot = 1.5;\n' + gMain, 'int camRot = 2;\n' + gMain.replace('camRot, 0.', 'float(camRot), 0.')]);
check('a different type is a different variable', /static int camRot_IMAGE\s*=\s*2;/.test(r.out) && /float\(camRot_IMAGE\)/.test(r.out), r.out);
r = assemble(['float camRot = 1.5;\n#define SPIN (camRot * 2.0)\n' + gMain.replace('camRot,', 'SPIN,'), 'float camRot = 1.4;\n#define SPIN (camRot * 2.0)\n' + gMain.replace('camRot,', 'SPIN,')]);
check('a macro body in the renamed pass follows', /#define SPIN \(camRot_IMAGE \* 2\.0\)/.test(r.out) && /#define SPIN \(camRot \* 2\.0\)/.test(r.out), r.out);
r = assemble(['float g = 1.0;\n' + gMain.replace('camRot', 'g'), 'float g = sin(2.0);\n' + gMain.replace('camRot', 'g')]);
check('the assignment hoisted to the entry point of the renamed pass follows', /g_IMAGE = sin\(2\.0\);/.test(r.out) && /static float g_IMAGE;/.test(r.out), r.out);
r = assemble(['float camRot = sin(1.0);\n' + gMain, 'float camRot = sin(2.0);\n' + gMain]);
check('equal declarations with different hoisted values need no rename', r.out.indexOf('camRot_IMAGE') < 0 && /camRot = sin\(1\.0\);/.test(r.out) && /camRot = sin\(2\.0\);/.test(r.out), r.out);
r = assemble(['float camRot = 1.5;\n' + gMain]);
check('one pass: nothing is renamed', r.out.indexOf('camRot_') < 0);

// ── a struct that the passes define differently is two types
const sMain = 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tHit h = march(vec3(0.), vec3(1.));\n\tfragColor = vec4(h.dist, 0., 0., 1.);\n}';
const sA = 'struct Hit\n{\n\tfloat dist;\n\tfloat id;\n};\nHit march(vec3 o, vec3 d) { Hit h; h.dist = o.x; h.id = d.x; return h; }\n';
const sB = 'struct Hit\n{\n\tfloat dist;\n\tfloat depth;\n\tfloat steps;\n};\nHit march(vec3 o, vec3 d) { Hit h; h.dist = o.x; h.depth = d.x; h.steps = 1.0; return h; }\n';
r = assemble([sA + sMain, sB + sMain]);
check('two structs of the same name: each defined once', count(r.out, /struct Hit\b/g) === 1 && count(r.out, /struct Hit_IMAGE\b/g) === 1, r.out);
check('the second pass uses its own type everywhere', /Hit_IMAGE march_IMAGE\(/.test(r.out) && /Hit_IMAGE h;/.test(r.out) && /Hit_IMAGE h = march_IMAGE\(/.test(r.out), r.out);
check('the first pass keeps its function, the second has its own body under a new name', /Hit march\(float3 o, float3 d\) \{ Hit h; h\.dist = o\.x; h\.id = d\.x;/.test(r.out) && /Hit_IMAGE march_IMAGE\(float3 o, float3 d\) \{ Hit_IMAGE h; h\.dist = o\.x; h\.depth = d\.x; h\.steps = 1\.0;/.test(r.out), r.out);
check('the struct rename is reported', r.messages.some(m => /struct 'Hit' is declared differently/.test(m.text)));
const sC = 'struct Hit { float a; float b; };\nHit mk(float x) { return Hit(x, x); }\n';
const sD = 'struct Hit { float c; float d; };\nHit mk(float x) { return Hit(x, x); }\n';
const mMain = 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tHit h = mk(fragCoord.x);\n\tfragColor = vec4(1.);\n}';
r = assemble([sC + mMain, sD + mMain]);
check('structs with the same field types but different names: the constructor helpers do not clash', (r.out.match(/Hit(?:_IMAGE)? Hit_ctor(?:_IMAGE)?\(/g) || []).length === 2 && count(r.out, /Hit Hit_ctor\(float a, float b\)/g) + count(r.out, /Hit_IMAGE Hit_ctor(?:_IMAGE)?\(float c, float d\)/g) === 2 && !/Hit_IMAGE Hit_ctor\(float a/.test(r.out), r.out);


// ── a function that the passes define differently is two functions (3.0.40)
const fMain = 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = vec4(df(vec3(fragCoord, 0.)), 0., 0., 1.);\n}';
r = assemble(['float df(vec3 p) { return length(p) - 1.0; }\n' + fMain, 'float df(vec3 p) { return length(p) - 2.0; }\n' + fMain]);
check('the same signature with another body: both kept, the second under its own name', /float df\(float3 p\) \{ return length\(p\) - 1\.0; \}/.test(r.out) && /float df_IMAGE\(float3 p\) \{ return length\(p\) - 2\.0; \}/.test(r.out), r.out);
check('the second pass calls its own', /fragColor = float4\(df_IMAGE\(/.test(r.out) && /fragColor = float4\(df\(/.test(r.out), r.out);
check('the rename is reported', r.messages.some(m => /function 'df' is not the same as the one in an earlier pass/.test(m.text) && /df_IMAGE/.test(m.text)));
r = assemble(['float df(vec3 p) { return length(p) - 1.0; }\n' + fMain, 'float df(vec3 p) {\n\treturn length(p) - 1.0;   // the same, laid out differently\n}\n' + fMain]);
check('the same body laid out differently, with other comments, is the same function', count(r.out, /float df\(/g) === 1 && r.out.indexOf('df_IMAGE') < 0, r.out);
r = assemble(['float a(float x) { return x; }\nfloat b(float x) { return a(x) * 2.0; }\n' + fMain.replace('df(vec3(fragCoord, 0.))', 'b(1.0)'),
	'float a(float x) { return -x; }\nfloat b(float x) { return a(x) * 2.0; }\n' + fMain.replace('df(vec3(fragCoord, 0.))', 'b(1.0)')]);
check('a function that calls a renamed one is renamed too, though its own text is the same', /float b_IMAGE\(float x\) \{ return a_IMAGE\(x\) \* 2\.0; \}/.test(r.out) && /float b\(float x\) \{ return a\(x\) \* 2\.0; \}/.test(r.out), r.out);
check('and the entry point calls the renamed one', /fragColor = float4\(b_IMAGE\(1\.0\)/.test(r.out), r.out);
r = assemble(['float a(float x) { return x; }\nfloat b(float x) { return a(x) * 2.0; }\n' + fMain.replace('df(vec3(fragCoord, 0.))', 'b(1.0)'),
	'float a(float x) { return x; }\nfloat b(float x) { return a(x) * 2.0; }\n' + fMain.replace('df(vec3(fragCoord, 0.))', 'b(1.0)')]);
check('functions that are the same in both passes are defined once', count(r.out, /float a\(/g) === 1 && count(r.out, /float b\(/g) === 1 && r.out.indexOf('_IMAGE') < 0, r.out);
r = assemble(['float2 f(float x) { return float2(x); }\nfloat f(float2 x) { return x.x; }\n' + fMain.replace('df(vec3(fragCoord, 0.))', 'f(1.0).x + f(vec2(1.))'),
	'float2 f(float x) { return float2(x); }\nfloat f(float2 x) { return x.y; }\n' + fMain.replace('df(vec3(fragCoord, 0.))', 'f(1.0).x + f(vec2(1.))')]);
check('with overloads, a clash in one renames the name and so all overloads of the pass stay together', /f_IMAGE\(float x\)/.test(r.out) && /f_IMAGE\(float2 x\)/.test(r.out), r.out);
r = assemble(['#define SCALE df(vec3(1.))\nfloat df(vec3 p) { return length(p) - 1.0; }\n' + fMain.replace('df(vec3(fragCoord, 0.))', 'SCALE'),
	'#define SCALE df(vec3(1.))\nfloat df(vec3 p) { return length(p) - 2.0; }\n' + fMain.replace('df(vec3(fragCoord, 0.))', 'SCALE')]);
check('a macro that calls a renamed function follows', /#define SCALE df_IMAGE\(float3\(1\., 1\., 1\.\)\)/.test(r.out) && /#define SCALE df\(float3\(1\., 1\., 1\.\)\)/.test(r.out), r.out);
r = assemble(['float k = 1.0;\nfloat df(vec3 p) { return length(p) - k; }\n' + fMain, 'float k = 2.0;\nfloat df(vec3 p) { return length(p) - k; }\n' + fMain]);
check('a function that reads a global renamed in its pass is a different function', /float df_IMAGE\(float3 p\) \{ return length\(p\) - k_IMAGE; \}/.test(r.out) && /static float k_IMAGE/.test(r.out), r.out);
r = assemble(['float df(vec3 p) { return length(p) - 1.0; }\n' + fMain]);
check('one pass: nothing is renamed', r.out.indexOf('_IMAGE') < 0 && r.out.indexOf('_BUFA') < 0);
r = assemble(['float df(vec3 p) { return length(p) - 1.0; }\n' + fMain, 'float df(vec3 p) { return length(p) - 2.0; }\n' + fMain, 'float df(vec3 p) { return length(p) - 3.0; }\n' + fMain]);
check('three passes, three bodies: each pass has its own', /float df\(float3 p\) \{ return length\(p\) - 1\.0; \}/.test(r.out) && /length\(p\) - 2\.0/.test(r.out) && /length\(p\) - 3\.0/.test(r.out) && (r.out.match(/float df\w*\(float3 p\)/g) || []).length === 3, r.out);

const macroFetchSrc = '#define READ(p) texelFetch(iChannel0, ivec2(p), 0)\nvec4 readState(vec2 p) { return READ(p); }\nvoid mainImage(out vec4 c, vec2 p) { c = readState(p); }';
const feedbackPass = makePass('bufA', macroFetchSrc);
feedbackPass.channels = ['bufA']; feedbackPass.selfRefChannels = [0];
const displayPass = makePass('image', macroFetchSrc);
displayPass.channels = ['bufA'];
const macroFetchOut = porter.assembleFxFile([feedbackPass, displayPass], true, [], null);
check('macro-hidden buffer reads get different samplers for feedback and display', /iChannel0_Image/.test(macroFetchOut) && /tex_BufA_Prev/.test(macroFetchOut), macroFetchOut);
check('helpers whose macro-hidden samplers differ are not merged across passes', /readState_IMAGE\(/.test(macroFetchOut) && count(macroFetchOut, /float4 readState\w*\(/g) === 2, macroFetchOut);

console.log((total - bad) + '/' + total + ' common-tab tests OK');
process.exit(bad ? 1 : 0);
