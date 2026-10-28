// texelFetch / textureSize: GLSL fetches by integer texel position; ReShade has the same intrinsics.
// Textures with a Vflip option need the fetched row mirrored; buffers keep Shadertoy's row order.
const porter = require('./load_porter.js')();

let bad = 0, total = 0;
function check(label, got, expected)
{
	total++;
	if (got !== expected) { bad++; console.log('FAIL', label, '\n   got      ', got, '\n   expected ', expected); }
}

// transform level
const rf = porter.rewriteTexelFetch;
check('lod 0 is the default and is dropped', rf('texelFetch(iChannel0, ivec2(x, y), 0)'), 'tex2Dfetch(iChannel0, ivec2(x, y))');
check('a real lod is kept', rf('texelFetch(iChannel0, p, 2)'), 'tex2Dfetch(iChannel0, p, 2)');
check('no lod argument', rf('texelFetch(iChannel0, p)'), 'tex2Dfetch(iChannel0, p)');
check('nested commas and parentheses', rf('texelFetch(iChannel0, ivec2(mod(f, vec2(a, b)), g(1, 2)), 0).xy'), 'tex2Dfetch(iChannel0, ivec2(mod(f, vec2(a, b)), g(1, 2))).xy');
check('two fetches in one expression', rf('texelFetch(a, p, 0) + texelFetch(b, q, 0)'), 'tex2Dfetch(a, p) + tex2Dfetch(b, q)');
check('a fetch inside a fetch coordinate', rf('texelFetch(a, ivec2(texelFetch(b, p, 0).xy), 0)'), 'tex2Dfetch(a, ivec2(texelFetch(b, p, 0).xy))'.replace('texelFetch(b, p, 0)', 'texelFetch(b, p, 0)'));
check('textureSize', rf('textureSize(iChannel0, 0)'), 'tex2Dsize(iChannel0, 0)');
check('unrelated identifiers untouched', rf('myTexelFetch(a) + texelFetching'), 'myTexelFetch(a) + texelFetching');

// through the whole pipeline, from GLSL
function glsl(body)
{
	const src = 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\t' + body + '\n}';
	const messages = [];
	porter.analyzeShader(src, messages);
	return porter.transformGLSL(src, messages, 'Image').src;
}
check('pipeline: GLSL types become HLSL types', /tex2Dfetch\(iChannel0, int2\(fragCoord\)\)/.test(glsl('fragColor = texelFetch(iChannel0, ivec2(fragCoord), 0);')), true);
check('pipeline: textureSize', /tex2Dsize\(iChannel0, 0\)/.test(glsl('ivec2 s = textureSize(iChannel0, 0); fragColor = vec4(s, 0, 1);')), true);

// type inference knows a size is an int2
const A = porter.analyzeSource('int2 f(sampler2D s) { return tex2Dsize(s, 0); }\nvoid g(sampler2D s)\n{\n\tint2 z = tex2Dsize(s, 0) + int2(1, 1);\n}\n');
let root = null;
A.eachExpression(function (n) { if (n.kind === 'assign' || n.kind === 'binary') { root = root || n; } });
check('analyzer: tex2Dsize + int2 is int2', root && root.type, 'int2');

// V flip of fetches
const DECLS = 'int2 p; int2 q;\n';
function vflip(body, flags)
{
	const r = porter.rewriteTextureVFlip(DECLS + body + '\n', flags || { iChannel0: 'F0' });
	return { out: r.src.slice(DECLS.length).trim(), r: r };
}
const fnOf = s => 'float4 f()\n{\n\treturn ' + s + ';\n}';
check('fetch from a Vflip texture mirrors the row using its height', vflip(fnOf('tex2Dfetch(iChannel0, p)')).out, fnOf('tex2Dfetch(iChannel0, ST_flipFetch(p, tex2Dsize(iChannel0), F0))'));
check('fetch with a lod uses that level\'s size', vflip(fnOf('tex2Dfetch(iChannel0, p, 1)')).out, fnOf('tex2Dfetch(iChannel0, ST_flipFetch(p, tex2Dsize(iChannel0, 1), F0), 1)'));
check('fetch from a texture without the option is untouched', vflip(fnOf('tex2Dfetch(iChannel1, p)')).out, fnOf('tex2Dfetch(iChannel1, p)'));
check('fetch helper flagged', vflip(fnOf('tex2Dfetch(iChannel0, p)')).r.helpers.fetch, true);
check('fetch through a sampler parameter', vflip('float4 g(sampler2D sp, int2 c)\n{\n\treturn tex2Dfetch(sp, c);\n}\nfloat4 h()\n{\n\treturn g(iChannel0, p);\n}').out.indexOf('tex2Dfetch(sp, ST_flipFetch(c, tex2Dsize(sp), sp_vflip))') >= 0, true);
check('tex2Dproj is still reported as unsupported', vflip(fnOf('tex2Dproj(iChannel0, p)')).r.warnings.length, 1);

// assembled effect: helper emitted once, buffer fetches are not flipped
function makePass(id, src, channels, names, vflips)
{
	const messages = [];
	const used = new Set();
	porter.analyzeShader(src, messages);
	porter.detectUniforms(src, used);
	const label = id === 'image' ? 'Image' : id.charAt(0).toUpperCase() + id.slice(1);
	const r = porter.transformGLSL(src, messages, label);
	return { id: id, src: r.src, coordVar: r.coordVar, mainImageName: r.mainImageName, globalInits: r.globalInits, usedUniforms: used,
		channels: channels, channelNames: names, filters: channels.map(() => 'nearest'), wraps: channels.map(() => 'clamp'),
		vflips: vflips, format: 'RGBA32F', selfRefChannels: [] };
}
const fetchSrc = 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = texelFetch(iChannel0, ivec2(fragCoord), 0);\n}';
let out = porter.assembleFxFile([makePass('image', fetchSrc, ['texture'], ['London'], [true])], true, [], null);
check('assembled: texture fetch goes through ST_flipFetch with the channel option', /tex2Dfetch\(iChannel0, ST_flipFetch\(int2\(fragCoord\), tex2Dsize\(iChannel0\), ST_VFLIP_CH0\)\)/.test(out), true);
check('assembled: helper defined exactly once', (out.match(/int2 ST_flipFetch\(/g) || []).length, 1);
out = porter.assembleFxFile([makePass('bufA', fetchSrc, [], [], []), makePass('image', fetchSrc, ['bufA'], [], [false])], true, [], null);
check('assembled: buffer fetches are not flipped', !/ST_flipFetch/.test(out) && (out.match(/tex2Dfetch\(/g) || []).length === 2, true);

console.log((total - bad) + '/' + total + ' texelFetch tests OK');
process.exit(bad ? 1 : 0);
