// Scalar broadcast constructors. ReShade rejects float3(x) for a scalar x (X3014) but accepts
// same-size conversions and copies, so only a scalar argument is expanded.
const porter = require('./load_porter.js')();

let bad = 0, total = 0;
function check(label, got, expected)
{
	total++;
	if (got !== expected) { bad++; console.log('FAIL', label, '\n   got      ', got, '\n   expected ', expected); }
}
const pre = '#define PI 3.14159\nfloat s; float2 v2; float3 v3; float4 v4; int n; uint un;\n';
function run(stmt, messages)
{
	const src = pre + 'float4 f()\n{\n\t' + stmt + '\n}\n';
	return porter.rewriteBroadcastConstructors(src, messages || []).slice(pre.length).replace(/^float4 f\(\)\n\{\n\t/, '').replace(/\n\}\n$/, '');
}

// scalars are expanded
check('literal', run('return float4(float3(0.5), 1.0);'), 'return float4(float3(0.5, 0.5, 0.5), 1.0);');
check('scalar variable', run('return float4(float3(s), 1.0);'), 'return float4(float3(s, s, s), 1.0);');
check('scalar expression', run('return float4(float3(s * 2.0 + 1.0), 1.0);'), 'return float4(float3(s * 2.0 + 1.0, s * 2.0 + 1.0, s * 2.0 + 1.0), 1.0);');
check('swizzled scalar', run('return float4(float3(v2.x), 1.0);'), 'return float4(float3(v2.x, v2.x, v2.x), 1.0);');
check('scalar-returning call', run('return float4(float3(length(v3)), 1.0);'), 'return float4(float3(length(v3), length(v3), length(v3)), 1.0);');
check('scalar macro', run('return float4(float3(PI), 1.0);'), 'return float4(float3(PI, PI, PI), 1.0);');
check('float2', run('return float4(float2(s), 0.0, 1.0);'), 'return float4(float2(s, s), 0.0, 1.0);');
check('float4', run('return float4(s);'), 'return float4(s, s, s, s);');
check('int vector from an int literal', run('int3 q = int3(2); return v4;'), 'int3 q = int3(2, 2, 2); return v4;');
check('uint vector from a uint variable', run('uint2 q = uint2(un); return v4;'), 'uint2 q = uint2(un, un); return v4;');
check('bool vector', run('bool2 q = bool2(true); return v4;'), 'bool2 q = bool2(true, true); return v4;');

// vectors are conversions or copies and must NOT be expanded (this was the bug)
check('vector copy', run('return float4(float3(v3), 1.0);'), 'return float4(float3(v3), 1.0);');
check('vector conversion', run('int2 q = int2(v2); return v4;'), 'int2 q = int2(v2); return v4;');
check('swizzle', run('return float4(float3(v4.xyz), 1.0);'), 'return float4(float3(v4.xyz), 1.0);');
check('vector-returning call', run('return float4(float3(normalize(v3)), 1.0);'), 'return float4(float3(normalize(v3)), 1.0);');
check('vector expression', run('return float4(float3(v3 * s + v3), 1.0);'), 'return float4(float3(v3 * s + v3), 1.0);');
check('vector macro-free variable used as an argument', run('return float4(float4(v4));'), 'return float4(float4(v4));');
check('ivec2(fragCoord) shape', run('int2 q = int2(v2); return v4;'), 'int2 q = int2(v2); return v4;');

// constructors with several arguments are not broadcasts
check('several arguments', run('return float4(float2(s, s), float2(s, s));'), 'return float4(float2(s, s), float2(s, s));');

// scoping: a name that is a vector in one function and a scalar in another
const scoped = 'float2 g1(float2 p)\n{\n\treturn float2(p);\n}\nfloat2 g2(float p)\n{\n\treturn float2(p);\n}\nfloat3 g3(float3 c)\n{\n\treturn float3(c);\n}\n';
const scopedOut = porter.rewriteBroadcastConstructors(scoped, []);
check('scoped: vector p is left alone', /float2 g1\(float2 p\)\n\{\n\treturn float2\(p\);/.test(scopedOut), true);
check('scoped: scalar p is expanded', /float2 g2\(float p\)\n\{\n\treturn float2\(p, p\);/.test(scopedOut), true);
check('scoped: vector c is left alone', /return float3\(c\);/.test(scopedOut), true);

// the parameter of mainImage: fragCoord is a float2
const mainSrc = 'void mainImage(out float4 fragColor, in float2 fragCoord)\n{\n\tint2 p = int2(fragCoord);\n\tfragColor = float4(float3(fragCoord.x), 1.0);\n}\n';
const mainOut = porter.rewriteBroadcastConstructors(mainSrc, []);
check('fragCoord conversion is not broadcast', /int2 p = int2\(fragCoord\);/.test(mainOut), true);
check('fragCoord.x is broadcast', /float3\(fragCoord\.x, fragCoord\.x, fragCoord\.x\)/.test(mainOut), true);

// unknown types are left alone and reported
const messages = [];
check('unknown argument left alone', run('return float4(float3(mystery), 1.0);', messages), 'return float4(float3(mystery), 1.0);');
check('unknown argument reported', messages.length === 1 && messages[0].level === 'warn' && /mystery/.test(messages[0].text), true);

// comments next to the argument survive
check('placeholder inside the call', run('return float4(float3(«⁰» s), 1.0);'), 'return float4(float3(s, s, s) «⁰», 1.0);');

// file-scope initialisers are rewritten too, not just function bodies
const globals = 'static float2 res = float2(0);\nstatic const float3 white = float3(1.0);\nstatic float2 keep = float2(v2);\nfloat2 v2;\n';
const globalsOut = porter.rewriteBroadcastConstructors(globals, []);
check('global initialiser: scalar broadcast', /static float2 res = float2\(0, 0\);/.test(globalsOut), true);
check('global initialiser: const scalar broadcast', /static const float3 white = float3\(1\.0, 1\.0, 1\.0\);/.test(globalsOut), true);
check('global initialiser: vector copy untouched', /static float2 keep = float2\(v2\);/.test(globalsOut), true);

// idempotent: the expanded form has several arguments
const once = run('return float4(float3(s), 1.0);');
check('idempotent', run(once.replace(/^return /, 'return ')), once);

console.log((total - bad) + '/' + total + ' broadcast tests OK');
process.exit(bad ? 1 : 0);
