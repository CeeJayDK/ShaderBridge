// Flip options in the generated effect.
//  - ST_FLIP_Y: only the pass that renders to the screen converts SV_Position to Shadertoy's
//    bottom-up fragCoord. Buffer passes keep Shadertoy's row order, so data stored by row (or fed
//    back into the same buffer) is read at the coordinates it was written to.
//  - ST_VFLIP_*: one option per texture channel, default taken from the channel's Vflip setting.
//  - Both are written the way REFERENCE.md says ReShade turns into UI options.
const porter = require('./load_porter.js')();

function makePass(id, src, channels, names, vflips)
{
	const messages = [];
	const used = new Set();
	porter.analyzeShader(src, messages);
	porter.detectUniforms(src, used);
	const label = id === 'image' ? 'Image' : id.charAt(0).toUpperCase() + id.slice(1); // same label the UI passes
	const r = porter.transformGLSL(src, messages, label);
	return { id: id, src: r.src, coordVar: r.coordVar, mainImageName: r.mainImageName, globalInits: r.globalInits, usedUniforms: used,
		channels: channels || [], channelNames: names || [], filters: (channels || []).map(() => 'linear'), wraps: (channels || []).map(() => 'clamp'),
		vflips: vflips || [], format: 'RGBA32F', selfRefChannels: [] };
}
const bufSrc = 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = vec4(fragCoord.y);\n}';
const imgSrc = 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = texture(iChannel0, fragCoord / iResolution.xy);\n}';

function build(flipY, multipass, vflip)
{
	const passes = [];
	if (multipass) { passes.push(makePass('bufA', bufSrc)); }
	if (multipass) { passes.push(makePass('image', imgSrc, ['bufA'])); }
	else { passes.push(makePass('image', imgSrc, ['texture'], ['London'], [vflip])); }
	return porter.assembleFxFile(passes, flipY, [], null);
}
function wrapper(out, name)
{
	const m = new RegExp('void ' + name + '\\([^)]*\\)\\s*\\{[^}]*\\}').exec(out);
	return m ? m[0] : '';
}
const FLIP_EXPR = /ST_FLIP_Y \? BUFFER_HEIGHT - vpos\.y : vpos\.y/;
const option = (name, value) => new RegExp('#ifndef ' + name + '\\n\\t#define ' + name + ' ' + value + '\\n#endif').test(out);

let bad = 0, total = 0, out;
function check(label, ok) { total++; if (!ok) { bad++; console.log('FAIL', label); } }

// Y flip, multipass: the buffer pass is never flipped, the screen pass reads ST_FLIP_Y
out = build(true, true);
let bufW = wrapper(out, 'PS_ShadertoyBufA'), imgW = wrapper(out, 'PS_ShadertoyMain');
check('wrappers found', bufW !== '' && imgW !== '');
check('buffer pass is NOT flipped and does not mention ST_FLIP_Y', !/ST_FLIP_Y/.test(bufW) && /mainImage_BufA\(vpos\.xy, output\)/.test(bufW));
check('screen pass flips through ST_FLIP_Y', FLIP_EXPR.test(imgW));
check('ST_FLIP_Y defaults to 1 when Flip Y is on', option('ST_FLIP_Y', 1));
out = build(false, true);
check('ST_FLIP_Y defaults to 0 when Flip Y is off', option('ST_FLIP_Y', 0));
check('Flip Y off: screen pass still reads the option, buffer pass untouched', FLIP_EXPR.test(wrapper(out, 'PS_ShadertoyMain')) && !/ST_FLIP_Y/.test(wrapper(out, 'PS_ShadertoyBufA')));

// single pass
out = build(true, false, true);
check('single pass: flipped through ST_FLIP_Y, default 1', FLIP_EXPR.test(wrapper(out, 'PS_ShadertoyMain')) && option('ST_FLIP_Y', 1));

// V flip options follow the channel's Vflip setting
out = build(true, false, true);
check('Vflip on: ST_VFLIP_CH0 defaults to 1', option('ST_VFLIP_CH0', 1));
check('Vflip on: sample site uses the option', /tex2D\(iChannel0, ST_flipV\(.*, ST_VFLIP_CH0\)\)/.test(out));
out = build(true, false, false);
check('Vflip off: ST_VFLIP_CH0 defaults to 0 (still switchable)', option('ST_VFLIP_CH0', 0));
check('Vflip off: sample site still goes through the option', /ST_VFLIP_CH0\)/.test(out));

// a buffer channel has no Vflip option
out = build(true, true);
check('buffer channel: no ST_VFLIP option', !/ST_VFLIP/.test(out));

// multipass: each pass gets its own option name, so two passes reading a texture on channel 0 do not collide
const multiTex = porter.assembleFxFile([
	makePass('bufA', imgSrc, ['texture'], ['London'], [true]),
	makePass('image', imgSrc, ['texture'], ['London'], [false])
], true, [], null);
out = multiTex;
check('multipass: buffer pass option is tagged with the pass', option('ST_VFLIP_BUFA_CH0', 1));
check('multipass: image pass option is tagged with the pass and has its own default', option('ST_VFLIP_IMAGE_CH0', 0));
check('multipass: sample sites use their own pass option', /ST_VFLIP_BUFA_CH0\)/.test(out) && /ST_VFLIP_IMAGE_CH0\)/.test(out));

// the mouse follows ST_FLIP_Y: ReShade reports it from the top-left, the shader works bottom-up
const mouseSrc = 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = vec4(iMouse.xy / iResolution.xy, iMouse.z, 1.0);\n}';
out = porter.assembleFxFile([makePass('image', mouseSrc)], true, [], null);
check('iMouse: Y flips with ST_FLIP_Y', /#define iMousePosST float2\(iMousePos\.x, ST_FLIP_Y \? BUFFER_HEIGHT - iMousePos\.y : iMousePos\.y\)/.test(out));
check('iMouse: click position uses the same flipped Y', /#define iMouse float4\(iMousePosST, iMouseBtn0 \? iMousePosST : float2\(0\.0, 0\.0\)\)/.test(out));
check('iMouse: defined after ST_FLIP_Y exists in the file, used by the pass', out.indexOf('#ifndef ST_FLIP_Y') >= 0);

// the wrapper must not depend on iResolution, which is only declared when the shader itself uses it
out = porter.assembleFxFile([makePass('image', bufSrc)], true, [], null);
check('wrapper does not need iResolution (a shader that never mentions it must still compile)', !/iResolution/.test(out));
out = porter.assembleFxFile([makePass('bufA', bufSrc), makePass('image', bufSrc)], false, [], null);
check('same with Flip Y off, multipass', !/iResolution/.test(out));

// gl_FragCoord: each entry point fills the global in, from the same coordinates it hands to mainImage
const fcSrc = 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = vec4(gl_FragCoord.xy / 100., 0., 1.);\n}';
out = porter.assembleFxFile([makePass('bufA', fcSrc), makePass('image', fcSrc)], true, [], null);
check('buffer pass sets ST_FragCoord from vpos', /ST_FragCoord = float4\(vpos\.xy, 0\.0, 1\.0\);\n\tmainImage_BufA\(vpos\.xy/.test(out), out.slice(out.indexOf('PS_ShadertoyBufA')));
check('screen pass sets ST_FragCoord from the (possibly flipped) coordinate', /float2 fragCoord = [^\n]*\n\tST_FragCoord = float4\(fragCoord, 0\.0, 1\.0\);/.test(out));
check('the global is declared once across passes', (out.match(/static float4 ST_FragCoord;/g) || []).length === 1);
out = porter.assembleFxFile([makePass('image', bufSrc)], true, [], null);
check('a pass that never uses gl_FragCoord has no assignment', !/ST_FragCoord/.test(out));

// iChannelTime is stubbed to iTime, so using only iChannelTime must still declare iTime
const ub = (names) => porter.buildUniformBlock(new Set(names));
let block = ub(['iChannelTime']);
check('iChannelTime alone also declares the timer behind iTime', /uniform float iTimeMS < source = "timer"; >;/.test(block) && /#define iTime \(iTimeMS \* 0\.001\)/.test(block), block);
check('and iTime comes before the stub that uses it', block.indexOf('#define iTime ') >= 0 && block.indexOf('#define iTime ') < block.indexOf('#define iChannelTime'), block);
block = ub(['iChannelTime', 'iTime']);
check('with both, iTime is declared once', (block.match(/uniform float iTimeMS/g) || []).length === 1);
check('with neither there is no timer and no stub', ub(['iResolution']).indexOf('iTimeMS') < 0 && ub(['iResolution']).indexOf('iChannelTime') < 0);
check('iTime alone has no iChannelTime stub', ub(['iTime']).indexOf('iChannelTime') < 0);
const given = new Set(['iChannelTime']);
porter.buildUniformBlock(given);
check('the set the caller gave is not changed', given.size === 1 && !given.has('iTime'));

// options come before the first pass so ReShade lists them, and follow REFERENCE.md's UI rule:
// a name of 8+ characters that does not start with an underscore
out = build(true, false, true);
const names = [...out.matchAll(/#ifndef (\w+)/g)].map(m => m[1]).filter(n => n.startsWith('ST_'));
check('options found', names.length === 2);
check('every option name is UI-visible (8+ chars, no leading underscore)', names.every(n => n.length >= 8 && n[0] !== '_'));
check('options precede the shader body', out.indexOf('#ifndef ST_FLIP_Y') < out.indexOf('// ── Shader body'));

console.log((total - bad) + '/' + total + ' flip option tests OK');
process.exit(bad ? 1 : 0);
