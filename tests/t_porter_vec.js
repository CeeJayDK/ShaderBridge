// The porter's own rewriteVectorConstructorArgs: GLSL lets the last constructor argument overflow,
// HLSL does not, so an overflowing vector argument is swizzled down and later arguments dropped.
const porter = require('./load_porter.js')();

let bad = 0, total = 0;
function check(label, got, expected)
{
	total++;
	if (got !== expected) { bad++; console.log('FAIL', label, '\n   got      ', got, '\n   expected ', expected); }
}
const pre = 'float2 a2; float3 a3; float4 a4; float s; float t;\n';
function run(stmt, messages)
{
	const src = pre + 'float4 f()\n{\n\t' + stmt + '\n}\n';
	return porter.rewriteVectorConstructorArgs(src, messages || []).slice(pre.length).replace(/^float4 f\(\)\n\{\n\t/, '').replace(/\n\}\n$/, '');
}

// overflow handling
check('float3 into float2', run('return float2(a3);'), 'return float2(a3.xy);');
check('float4 into float3', run('return float3(a4);'), 'return float3(a4.xyz);');
check('scalar then float3 into float3', run('return float3(s, a3);'), 'return float3(s, a3.xy);');
check('float3 first, extra args dropped', run('return float2(a3, s);'), 'return float2(a3.xy);');
check('Z.z, 0, -Z example', run('return float3(a3.z, 0.0, -a3);'), 'return float3(a3.z, 0.0, -a3.x);');
check('overflow of a call result', run('return float2(normalize(a3));'), 'return float2(normalize(a3).xy);');
check('overflow of a swizzle', run('return float2(a4.xyz);'), 'return float2(a4.xyz.xy);');

// compound arguments must be parenthesised before the swizzle (the prototype got this wrong)
check('binary expression', run('return float2(a3 + a3);'), 'return float2((a3 + a3).xy);');
check('ternary expression', run('return float2(s < t ? a3 : a3);'), 'return float2((s < t ? a3 : a3).xy);');
check('scalar times vector', run('return float2(s * a3);'), 'return float2((s * a3).xy);');
check('unary minus on a primary', run('return float2(-a3);'), 'return float2(-a3.xy);');

// things that must NOT change
check('exact fit', run('return float4(a2, a2);'), 'return float4(a2, a2);');
check('scalars', run('return float3(s, t, 1.0);'), 'return float3(s, t, 1.0);');
check('broadcast', run('return float3(s);'), 'return float3(s);');
check('under-specified is left to other passes', run('return float4(a2);'), 'return float4(a2);');
check('matrix constructor ignored', run('float2x2 m = float2x2(s, t, s, t); return a4;'), 'float2x2 m = float2x2(s, t, s, t); return a4;');
check('unknown identifier leaves the call alone', run('return float2(mystery, a3);'), 'return float2(mystery, a3);');
check('int vector', run('int3 q = int3(1, 2, 3); return float2(q);'), 'int3 q = int3(1, 2, 3); return float2(q.xy);');

// nested constructors: inner and outer both handled
check('nested', run('return float2(float3(a4));'), 'return float2(float3(a4.xyz).xy);');

// scoping: the same name is a scalar in one function and a vector in another (the Journey bug)
const scoped = 'float2 g1(float2 x, float2 b)\n{\n\treturn float2(x.x, b.y);\n}\nfloat2 g2(float x, float2 b, float k)\n{\n\treturn float2(x, (b.y < k) ? b.y : b.x);\n}\nfloat3 g3(float3 x)\n{\n\treturn float3(x);\n}\n';
const scopedOut = porter.rewriteVectorConstructorArgs(scoped, []);
check('scoped: scalar x with a ternary is untouched', /return float2\(x, \(b\.y < k\) \? b\.y : b\.x\);/.test(scopedOut), true);
check('scoped: vector x elsewhere is untouched when it fits', /return float3\(x\);/.test(scopedOut), true);

// comments between arguments survive a rewrite (the porter holds comments as placeholders)
check('placeholder between arguments', run('return float2(a3, «⁰» s);'), 'return float2(a3.xy) «⁰»;');

// unparseable code is reported, never silently mangled
const messages = [];
porter.rewriteVectorConstructorArgs('float4 f()\n{\n\treturn float2(a3, ;\n}\n', messages);
check('parse failure is reported', messages.length > 0 && messages[0].level === 'warn', true);

// file-scope initialisers are rewritten too
const globalVec = 'float3 gv;\nstatic float2 gt = float2(gv);\n';
check('global initialiser: overflow cut down', /static float2 gt = float2\(gv\.xy\);/.test(porter.rewriteVectorConstructorArgs(globalVec, [])), true);

// idempotent
const once = run('return float3(s, a3);');
check('idempotent', run(once.replace(/^return /, 'return ')) , once);

console.log((total - bad) + '/' + total + ' porter vector-constructor tests OK');
process.exit(bad ? 1 : 0);
