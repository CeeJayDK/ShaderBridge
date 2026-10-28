// The generated .fx includes nothing, so it works wherever it is put. It declares what it uses of what
// ReShade.fxh would have given it: the fullscreen vertex shader and, when a channel reads the screen, the
// back buffer texture. There is no separate helper file either: the GLSL helpers are written into the .fx.
const porter = require('./load_porter.js')();

let bad = 0, total = 0;
function check(label, ok, detail)
{
	total++;
	if (!ok) { bad++; console.log('FAIL', label, detail ? '\n' + detail : ''); }
}
const count = (text, re) => (text.match(re) || []).length;

const SRC = 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = texture(iChannel0, fragCoord / iResolution.xy);\n}\n';
function pass(id, channel)
{
	const messages = [];
	porter.analyzeShader(SRC, messages);
	const r = porter.transformGLSL(SRC, messages, id);
	return { id: id, src: r.src, coordVar: r.coordVar, mainImageName: r.mainImageName, globalInits: r.globalInits, usedUniforms: new Set(['iResolution']),
		channels: channel ? [channel] : [], channelNames: [''], filters: ['linear'], wraps: ['clamp'], vflips: [false], format: 'RGBA32F', selfRefChannels: [] };
}
const build = (passes) => porter.assembleFxFile(passes, true, [], { id: 'x', name: 'x', username: 'u', description: '' });

// single file, no screen channel
let out = build([pass('image', null)]);
check('single file: no include of ReShade.fxh', !/#include\s+"ReShade\.fxh"/.test(out));
check('single file: the vertex shader is defined once', count(out, /void PostProcessVS\(/g) === 1, out.slice(0, 900));
check('single file: the technique uses it', /VertexShader\s*=\s*PostProcessVS;/.test(out));
check('single file: it is the same vertex shader as in ReShade.fxh', out.indexOf('texcoord.x = (id == 2) ? 2.0 : 0.0;') >= 0 && out.indexOf('texcoord.y = (id == 1) ? 2.0 : 0.0;') >= 0 && out.indexOf('position = float4(texcoord * float2(2.0, -2.0) + float2(-1.0, 1.0), 0.0, 1.0);') >= 0);
check('single file: no back buffer texture when nothing reads the screen', !/ST_BackBufferTex/.test(out) && !/ReShade::/.test(out));
check('single file: no leftover marker', !/@ST_BACKBUFFER@/.test(out));
check('single file: the vertex shader comes before the first technique', out.indexOf('void PostProcessVS(') < out.indexOf('technique '));

// single file, a channel that reads the screen
out = build([pass('image', 'backbuffer')]);
check('screen channel: the texture is declared once', count(out, /texture ST_BackBufferTex : COLOR;/g) === 1, out.slice(0, 1400));
check('screen channel: the sampler reads that texture', /Texture\s+=\s+ST_BackBufferTex;/.test(out));
check('screen channel: nothing refers to the ReShade namespace', !/ReShade::/.test(out) && !/#include\s+"ReShade\.fxh"/.test(out));
check('screen channel: the texture is declared before it is used', out.indexOf('texture ST_BackBufferTex') < out.indexOf('Texture   = ST_BackBufferTex'));
check('screen channel: no leftover marker', !/@ST_BACKBUFFER@/.test(out));

// several passes: still one vertex shader
out = build([pass('bufA', null), pass('image', null)]);
check('several passes: one vertex shader', count(out, /void PostProcessVS\(/g) === 1);

// nothing is included, whatever the shader reads
out = build([pass('bufA', 'backbuffer'), pass('image', 'texture')]);
check('no #include of any kind', !/^\s*#include\b/m.test(out), out.slice(0, 400));
check('the GLSL helpers are written into the file', /\/\/ ── Intrinsic remaps ──/.test(out));
check('no helper file is mentioned', !/\.fxh/i.test(out.replace(/ReShade\.fxh/g, '')), out.slice(0, 600));

console.log((total - bad) + '/' + total + ' standalone tests OK');
process.exit(bad ? 1 : 0);
