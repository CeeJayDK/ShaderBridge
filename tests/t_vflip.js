// rewriteTextureVFlip: V is conditionally mirrored at the sample sites of textures that have a
// Vflip option. The flag is an expression (a preprocessor definition in real output) and travels
// with the sampler through the parameters of user functions.
const porter = require('./load_porter.js')();

const DECLS = 'float2 uv; float4 c; float2 dx; float2 dy; int2 p; int2 off;\n';
function run(body, flags)
{
	const r = porter.rewriteTextureVFlip(DECLS + body + '\n', flags || { iChannel0: 'F0' });
	return { out: r.src.slice(DECLS.length).trim(), r: r };
}
let bad = 0, total = 0;
function check(label, got, expected)
{
	total++;
	if (got !== expected) { bad++; console.log('FAIL', label, '\n   got      ', got, '\n   expected ', expected); }
}
const fnOf = s => 'float4 f()\n{\n\treturn ' + s + ';\n}';

// direct samples
check('tex2D', run(fnOf('tex2D(iChannel0, uv)')).out, fnOf('tex2D(iChannel0, ST_flipV(uv, F0))'));
check('tex2D with expression', run(fnOf('tex2D(iChannel0, uv * 2.0 + 0.5)')).out, fnOf('tex2D(iChannel0, ST_flipV(uv * 2.0 + 0.5, F0))'));
check('sampler without the option is untouched', run(fnOf('tex2D(iChannel1, uv)')).out, fnOf('tex2D(iChannel1, uv)'));
check('tex2Dlod with float4 constructor', run(fnOf('tex2Dlod(iChannel0, float4(uv, 0.0, 2.0))')).out, fnOf('tex2Dlod(iChannel0, float4(ST_flipV(uv, F0), 0.0, 2.0))'));
check('tex2Dlod with opaque float4', run(fnOf('tex2Dlod(iChannel0, c)')).out, fnOf('tex2Dlod(iChannel0, ST_flipV4(c, F0))'));
check('tex2Dgrad flips uv and both gradients', run(fnOf('tex2Dgrad(iChannel0, uv, dx, dy)')).out, fnOf('tex2Dgrad(iChannel0, ST_flipV(uv, F0), ST_flipDir(dx, F0), ST_flipDir(dy, F0))'));
check('swizzle on result kept', run(fnOf('tex2D(iChannel0, uv).xyz')).out, fnOf('tex2D(iChannel0, ST_flipV(uv, F0)).xyz'));
check('nested', run(fnOf('tex2D(iChannel1, tex2D(iChannel0, uv).xy)')).out, fnOf('tex2D(iChannel1, tex2D(iChannel0, ST_flipV(uv, F0)).xy)'));
check('each sampler uses its own flag', run(fnOf('tex2D(iChannel0, uv) + tex2D(iChannel2, uv)'), { iChannel0: 'F0', iChannel2: 'F2' }).out,
	fnOf('tex2D(iChannel0, ST_flipV(uv, F0)) + tex2D(iChannel2, ST_flipV(uv, F2))'));
const none = porter.rewriteTextureVFlip(DECLS + fnOf('tex2D(iChannel0, uv)') + '\n', {});
check('no flags: source returned unchanged', none.src, DECLS + fnOf('tex2D(iChannel0, uv)') + '\n');

// helper bookkeeping
let r = run(fnOf('tex2D(iChannel0, uv)')).r;
check('helper flags: v2 only', JSON.stringify(r.helpers), '{"v2":true,"v4":false,"dir":false,"fetch":false}');
check('count', r.count, 1);
check('nothing flipped: count 0', run(fnOf('tex2D(iChannel1, uv)')).r.count, 0);

// sampler passed to a user function: the flag is passed along as an extra parameter
const blur = 'float4 blur(sampler2D sp, float2 u)\n{\n\treturn tex2D(sp, u);\n}\n';
const blurFlipped = 'float4 blur(sampler2D sp, bool sp_vflip, float2 u)\n{\n\treturn tex2D(sp, ST_flipV(u, sp_vflip));\n}\n';
check('sampler parameter gets a flag parameter, calls pass the flag',
	run(blur + 'float4 f()\n{\n\treturn blur(iChannel0, uv);\n}').out,
	blurFlipped + 'float4 f()\n{\n\treturn blur(iChannel0, F0, uv);\n}');
check('caller passes a sampler without the option: false',
	run(blur + 'float4 f()\n{\n\treturn blur(iChannel1, uv);\n}').out,
	blurFlipped + 'float4 f()\n{\n\treturn blur(iChannel1, false, uv);\n}');
const mixed = run(blur + 'float4 f()\n{\n\treturn blur(iChannel0, uv) + blur(iChannel1, uv);\n}');
check('mixed callers are simply correct, no warning', mixed.out, blurFlipped + 'float4 f()\n{\n\treturn blur(iChannel0, F0, uv) + blur(iChannel1, false, uv);\n}');
check('mixed: no warnings', mixed.r.warnings.length, 0);

// chain: f1(sampler) -> f2(sampler) -> tex2D
const chain = run('float4 f2(sampler2D b, float2 u)\n{\n\treturn tex2D(b, u);\n}\nfloat4 f1(sampler2D a, float2 u)\n{\n\treturn f2(a, u);\n}\nfloat4 g()\n{\n\treturn f1(iChannel0, uv);\n}').out;
check('chain: inner function samples with its own flag', chain.indexOf('tex2D(b, ST_flipV(u, b_vflip))') >= 0, true);
check('chain: flag handed from f1 to f2', chain.indexOf('f2(a, a_vflip, u)') >= 0, true);
check('chain: outermost call passes the definition', chain.indexOf('f1(iChannel0, F0, uv)') >= 0, true);

// several sampler parameters; prototype and definition both updated
const two = run('float4 mix2(sampler2D a, sampler2D b, float2 u);\nfloat4 mix2(sampler2D a, sampler2D b, float2 u)\n{\n\treturn tex2D(a, u) + tex2D(b, u);\n}\nfloat4 g()\n{\n\treturn mix2(iChannel0, iChannel1, uv);\n}').out;
check('two sampler parameters', two.indexOf('float4 mix2(sampler2D a, bool a_vflip, sampler2D b, bool b_vflip, float2 u)\n{') >= 0, true);
check('prototype updated too', two.indexOf('float4 mix2(sampler2D a, bool a_vflip, sampler2D b, bool b_vflip, float2 u);') >= 0, true);
check('call passes both flags', two.indexOf('mix2(iChannel0, F0, iChannel1, false, uv)') >= 0, true);

// samplers that cannot be traced are reported, not silently wrong
let t = run(blur + 'float4 f(bool k)\n{\n\treturn blur(k ? iChannel0 : iChannel1, uv);\n}');
check('untraceable sampler argument reported', t.r.warnings.length, 1);

// fetches are flipped by row; projective lookups are not supported and are reported
check('fetch: row mirrored using the texture height', run(fnOf('tex2Dfetch(iChannel0, p)')).out, fnOf('tex2Dfetch(iChannel0, ST_flipFetch(p, tex2Dsize(iChannel0), F0))'));
let u = run(fnOf('tex2Dproj(iChannel0, c)'));
check('tex2Dproj: left alone', u.out, fnOf('tex2Dproj(iChannel0, c)'));
check('tex2Dproj: reported', u.r.warnings.length, 1);

// a parameter named like a flipped sampler in some other function does not confuse global lookup
check('unrelated float parameter with the sampler name', run('float g(float iChannel0) { return iChannel0; }\n' + fnOf('tex2D(iChannel0, uv)')).out,
	'float g(float iChannel0) { return iChannel0; }\n' + fnOf('tex2D(iChannel0, ST_flipV(uv, F0))'));

// dead preprocessor branches: still rewritten, but no warnings about them
const dead = 'float4 f()\n{\n#if 0\n\treturn tex2Dproj(iChannel0, c);\n#else\n\treturn tex2D(iChannel0, uv);\n#endif\n}';
let d = run(dead);
check('#if 0: live branch flipped', d.out.indexOf('tex2D(iChannel0, ST_flipV(uv, F0))') >= 0, true);
check('#if 0: no warning about the dead branch', d.r.warnings.length, 0);
check('#if 1 / #else: no warning about the else branch', run('float4 f()\n{\n#if 1\n\treturn tex2D(iChannel0, uv);\n#else\n\treturn tex2Dproj(iChannel0, c);\n#endif\n}').r.warnings.length, 0);
check('unevaluable condition: still warns', run('float4 f()\n{\n#ifdef FOO\n\treturn tex2Dproj(iChannel0, c);\n#else\n\treturn tex2D(iChannel0, uv);\n#endif\n}').r.warnings.length, 1);
check('#if 0: dead tex2D is still flipped (branch may be enabled by hand)', run('float4 f()\n{\n#if 0\n\treturn tex2D(iChannel0, uv);\n#endif\n\treturn c;\n}').out.indexOf('ST_flipV(uv, F0)') >= 0, true);

// offset overloads: the offset is a constant, so for a texture with a Vflip option it is folded into the coordinate
check('tex2D with an offset: offset folded into the mirrored coordinate', run(fnOf('tex2D(iChannel0, uv, off)')).out,
	fnOf('tex2D(iChannel0, ST_flipV(uv + float2(off) / float2(tex2Dsize(iChannel0)), F0))'));
check('tex2D offset with a compound coordinate', run(fnOf('tex2D(iChannel0, uv * 2.0, off)')).out,
	fnOf('tex2D(iChannel0, ST_flipV((uv * 2.0) + float2(off) / float2(tex2Dsize(iChannel0)), F0))'));
check('tex2Dlod offset uses the size of the sampled level', run(fnOf('tex2Dlod(iChannel0, float4(uv, 0.0, 2.0), off)')).out,
	fnOf('tex2Dlod(iChannel0, float4(ST_flipV(uv + float2(off) / float2(tex2Dsize(iChannel0, int(2.0))), F0), 0.0, 2.0))'));
check('tex2Dlod offset with an opaque coordinate', run(fnOf('tex2Dlod(iChannel0, c, off)')).out,
	fnOf('tex2Dlod(iChannel0, float4(ST_flipV(c.xy + float2(off) / float2(tex2Dsize(iChannel0, int(c.w))), F0), c.zw))'));
check('tex2Dgrad offset: coordinate and both gradients mirrored', run(fnOf('tex2Dgrad(iChannel0, uv, dx, dy, off)')).out,
	fnOf('tex2Dgrad(iChannel0, ST_flipV(uv + float2(off) / float2(tex2Dsize(iChannel0)), F0), ST_flipDir(dx, F0), ST_flipDir(dy, F0))'));
check('an offset on a texture without the option keeps the native overload', run(fnOf('tex2D(iChannel1, uv, off)')).out, fnOf('tex2D(iChannel1, uv, off)'));
check('an offset lookup through a sampler parameter', run('float4 g(sampler2D sp, float2 u)\n{\n\treturn tex2D(sp, u, off);\n}\nfloat4 h()\n{\n\treturn g(iChannel0, uv);\n}').out.indexOf('tex2D(sp, ST_flipV(u + float2(off) / float2(tex2Dsize(sp)), sp_vflip))') >= 0, true);

console.log((total - bad) + '/' + total + ' vflip tests OK');
process.exit(bad ? 1 : 0);
