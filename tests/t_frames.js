const porter = require('./load_porter.js')();
let bad = 0, total = 0;
function check(label, ok) { total++; if (!ok) { bad++; console.log('FAIL ' + label); } }
function assemble(usesFrame)
{
	const src = 'void mainImage(out vec4 c, vec2 p) { c = vec4(' + (usesFrame ? 'float(iFrame)' : '1.') + '); }';
	const used = new Set(); porter.detectUniforms(src, used);
	const r = porter.transformGLSL(src, [], null);
	return porter.assembleFxFile([{id:'image',src:r.src,coordVar:r.coordVar,mainImageName:r.mainImageName,globalInits:r.globalInits,usedUniforms:used,channels:[],channelNames:[],filters:[],wraps:[],vflips:[],format:'RGBA32F',selfRefChannels:[]}], true, [], null);
}
const fx = assemble(true);
check('iFrame reads effect state rather than application uptime', /#define iFrame int\(tex2Dfetch\(ST_FrameSampler/.test(fx) && !/source = "framecount"/.test(fx));
check('new effect state produces frame zero', /previous.w > 0.5 \? previous.x \+ 1.0 : 0.0/.test(fx));
check('the counter reads and writes distinct textures', /Texture = ST_FramePrevious/.test(fx) && /RenderTarget = ST_FrameState/.test(fx));
check('frame copy and update precede all shader passes', fx.indexOf('pass ST_CopyFrame') < fx.indexOf('pass ST_UpdateFrame') && fx.indexOf('pass ST_UpdateFrame') < fx.indexOf('pass Main'));
check('effects that do not use iFrame incur no frame-counter passes', !/ST_FrameState|ST_UpdateFrame/.test(assemble(false)));
console.log((total-bad) + '/' + total + ' frame-counter tests OK');
process.exit(bad ? 1 : 0);
