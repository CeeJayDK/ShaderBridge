// Sampler and texture declarations across passes. Names come from the channel index (iChannel0),
// so passes often reuse a name for something different. An exact repeat is dropped; a same-named
// declaration with different content must get its own name, and the pass must use it.
const porter = require('./load_porter.js')();

function makePass(id, channels, names, opts)
{
	opts = opts || {};
	const src = opts.source || 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = texture(iChannel0, fragCoord / iResolution.xy);\n}';
	const messages = [];
	const used = new Set();
	porter.analyzeShader(src, messages);
	porter.detectUniforms(src, used);
	const label = id === 'image' ? 'Image' : id.charAt(0).toUpperCase() + id.slice(1);
	const r = porter.transformGLSL(src, messages, label);
	return { id: id, src: r.src, coordVar: r.coordVar, mainImageName: r.mainImageName, globalInits: r.globalInits, usedUniforms: used,
		channels: channels, channelNames: names, filters: channels.map(() => opts.filter || 'linear'), wraps: channels.map(() => 'clamp'),
		vflips: channels.map(() => false), format: 'RGBA32F', selfRefChannels: [] };
}
function assemble(passes)
{
	const messages = [];
	const out = porter.assembleFxFile(passes, true, messages, null);
	return { out: out, messages: messages };
}
const count = (text, re) => (text.match(re) || []).length;

let bad = 0, total = 0;
function check(label, ok) { total++; if (!ok) { bad++; console.log('FAIL', label); } }

// 1. texture in Buffer A, Buffer A itself in the Image pass (the case that used to silently read the wrong thing)
let r = assemble([makePass('bufA', ['texture'], ['London']), makePass('image', ['bufA'], [])]);
check('clash: Buffer A keeps iChannel0', /sampler2D iChannel0\n\{\n\tTexture   = tex_iChannel0;/.test(r.out));
check('clash: Image pass gets its own sampler bound to the buffer', /sampler2D iChannel0_Image\n\{\n\tTexture   = tex_BufA;/.test(r.out));
check('clash: Image pass source uses the renamed sampler', /tex2D\(iChannel0_Image, /.test(r.out.slice(r.out.indexOf('Shader body — Image'))));
check('clash: Buffer A source still uses iChannel0', /tex2D\(iChannel0, /.test(r.out.slice(r.out.indexOf('Shader body — BufA'), r.out.indexOf('Shader body — Image'))));
check('clash: reported', r.messages.some(m => /iChannel0_Image/.test(m.text)));

// 2. two passes, two different images on channel 0: texture AND sampler both renamed
r = assemble([makePass('bufA', ['texture'], ['London']), makePass('image', ['texture'], ['Blue Noise'])]);
check('two images: second texture renamed', /texture2D tex_iChannel0_Image </.test(r.out));
check('two images: second sampler points at the renamed texture', /sampler2D iChannel0_Image\n\{\n\tTexture   = tex_iChannel0_Image;/.test(r.out));
check('two images: first pass untouched', /Texture   = tex_iChannel0;/.test(r.out) && count(r.out, /texture2D tex_iChannel0 </g) === 1);

// 3. the very same image and settings in both passes: one declaration, nothing renamed
r = assemble([makePass('bufA', ['texture'], ['London']), makePass('image', ['texture'], ['London'])]);
check('identical repeat: declared once', count(r.out, /texture2D tex_iChannel0 </g) === 1 && count(r.out, /sampler2D iChannel0\n/g) === 1);
check('identical repeat: nothing renamed', !/iChannel0_Image/.test(r.out));

// 4. same image, different filtering: the texture is shared, only the sampler differs
r = assemble([makePass('bufA', ['texture'], ['London'], { filter: 'linear' }), makePass('image', ['texture'], ['London'], { filter: 'nearest' })]);
check('same image, different filter: texture declared once', count(r.out, /texture2D tex_iChannel0 </g) === 1);
check('same image, different filter: sampler renamed and bound to the shared texture', /sampler2D iChannel0_Image\n\{\n\tTexture   = tex_iChannel0;/.test(r.out));

// 5. single pass: nothing to clash with
r = assemble([makePass('image', ['texture'], ['London'])]);
check('single pass: names untouched', /sampler2D iChannel0\n/.test(r.out) && !/iChannel0_Image/.test(r.out));

// 6. the identifier rename only touches whole identifiers, never comments or longer names
check('renameIdentifiers: whole identifiers only',
	porter.renameIdentifiers('a = tex_iChannel0 + iChannel0; // iChannel0\n#define X iChannel0', { iChannel0: 'iChannel0_Image' }),
	'a = tex_iChannel0 + iChannel0_Image; // iChannel0\n#define X iChannel0');

// 7. buffer channels no longer carry the old manual V-flip advice
r = assemble([makePass('bufA', [], []), makePass('image', ['bufA'], [])]);
check('buffer sampler: no stale "negate UV.y" advice', !/negate UV\.y/.test(r.out));

const initialized = 'vec4 initial=texture(iChannel0,vec2(0.));\nvoid mainImage(out vec4 c,vec2 p) { c=initial; }';
r = assemble([makePass('bufA',['texture'],['London'],{source:initialized}),makePass('image',['texture'],['Blue Noise'],{source:initialized})]);
check('hoisted texture initializers follow sampler renames', /initial = tex2D\(iChannel0_Image,/.test(r.out));
check('samplers used only by initializers are declared for each pass', /sampler2D iChannel0_Image\b/.test(r.out) && /sampler2D iChannel0\b/.test(r.out));
const aliased = '#define INPUT iChannel0\nvoid mainImage(out vec4 c,vec2 p) { c=texture(INPUT,p); }';
r = assemble([makePass('bufA',['texture'],['London'],{source:aliased}),makePass('image',['texture'],['Blue Noise'],{source:aliased})]);
check('sampler aliases in macro bodies follow sampler renames', /#define INPUT iChannel0_Image/.test(r.out));
const indirect='vec4 read(sampler2D s,vec2 p){return texture(s,p);}\nvoid mainImage(out vec4 c,vec2 p){c=read(iChannel1,p);}';
r=assemble([makePass('image',['none','none'],[],{source:indirect})]);
check('an unconnected sampler passed to a helper has an explicit zero texture', /Texture = ST_EmptyTexture;/.test(r.out) && /sampler2D iChannel1/.test(r.out));
check('the zero texture is initialized before shader passes', r.out.indexOf('pass ST_ClearEmpty')<r.out.indexOf('pass Main') && /RenderTarget = ST_EmptyTexture/.test(r.out));
const mipFeedback=makePass('bufA',['bufA'],[],{filter:'mipmap'});mipFeedback.selfRefChannels=[0];
r=assemble([mipFeedback,makePass('image',['bufA'],[],{filter:'mipmap'})]);
check('mipmap-filtered buffers and their feedback copies allocate a full mip chain', count(r.out,/MipLevels = ST_MIP_LEVELS\(BUFFER_WIDTH, BUFFER_HEIGHT\);/g)===2);

console.log((total - bad) + '/' + total + ' sampler tests OK');
process.exit(bad ? 1 : 0);
