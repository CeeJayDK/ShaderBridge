// Tests the porter's own rewriteInlineMatrixMul (not a prototype copy).
const porter = require('./load_porter.js')();
const pre = 'float2x2 m;\nfloat2x2 rot(float a) { return m; }\nfloat3x3 R;\nfloat2 uv; float3 p; float3 v; float a; float b; float s; float2 q;\nvoid f()\n{\n';
const post = '\n}\n';

// [input statement, expected output]
const cases = [
	// the core rule: matrix operand => mul(right, left)
	['uv = m*uv;', 'uv = mul(uv, m);'],
	['uv = rot(a) * uv;', 'uv = mul(uv, rot(a));'],
	['uv = uv * rot(a);', 'uv = mul(rot(a), uv);'],
	['uv = uv * float2x2(a,b,-b,a);', 'uv = mul(float2x2(a,b,-b,a), uv);'],
	['uv = float2x2(a,b,-b,a) * uv;', 'uv = mul(uv, float2x2(a,b,-b,a));'],
	// chains: precedence comes from the expression tree
	['p = R * v * 2.0;', 'p = mul(v, R) * 2.0;'],
	['p = s * v * R;', 'p = mul(R, s * v);'],
	['p = a / b * R * v;', 'p = mul(v, mul(R, a / b));'],
	['p = R * (R * v);', 'p = mul((mul(v, R)), R);'],
	['p = R * R * v;', 'p = mul(v, mul(R, R));'],
	['p = R * R * R * v;', 'p = mul(v, mul(R, mul(R, R)));'],
	['p = 2.0 * R * v;', 'p = mul(v, mul(R, 2.0));'],
	['p = R * -v;', 'p = mul(-v, R);'],
	['p = -R * v;', 'p = mul(v, -R);'],
	['p = v * R + v * R;', 'p = mul(R, v) + mul(R, v);'],
	['uv = m * (uv + q) * 2.0;', 'uv = mul((uv + q), m) * 2.0;'],
	['float2 w = m * q.yx;', 'float2 w = mul(q.yx, m);'],
	// compound assignment
	['uv *= m;', 'uv = mul(m, uv);'],
	['p *= R;', 'p = mul(R, p);'],
	['uv *= 2.0;', 'uv *= 2.0;'],
	// non-matrix arithmetic must be left alone
	['float x = a * b + s * a;', 'float x = a * b + s * a;'],
	['uv = uv * a * 2.0;', 'uv = uv * a * 2.0;'],
	// unknown operand types are left alone rather than guessed
	['uv = mystery * uv;', 'uv = mystery * uv;'],
	// comments between operands survive (the porter represents them as placeholders)
	['uv = m * «⁰» uv;', 'uv = mul(uv, m) «⁰»;'],
	// matrices inside conditions, returns, loop headers
	['if (m * uv == q) { a = 1.0; }', 'if (mul(uv, m) == q) { a = 1.0; }'],
	['for (int i = 0; i < 2; i++) { uv = m * uv; }', 'for (int i = 0; i < 2; i++) { uv = mul(uv, m); }'],
	['uv = rot(a * 2.0) * uv;', 'uv = mul(uv, rot(a * 2.0));'],
];

let bad = 0;
function check(label, got, expected)
{
	if (got !== expected) { bad++; console.log('FAIL', label, '\n   got      ', got, '\n   expected ', expected); }
}
for (const [input, expected] of cases)
{
	let got;
	try { got = porter.rewriteInlineMatrixMul(pre + input + post, []).slice(pre.length).replace(/\n\}\n$/, ''); }
	catch (e) { got = 'EXCEPTION ' + e.message; }
	check(input, got, expected);
}

// scoping: the same name is a matrix in one function and a float in another
const scoped = 'float2 uv;\nfloat2 a1()\n{\n\tfloat2x2 m;\n\treturn m * uv;\n}\nfloat2 b1()\n{\n\tfloat m = 2.0;\n\treturn m * uv;\n}\n';
const scopedOut = porter.rewriteInlineMatrixMul(scoped, []);
check('scoped: matrix m rewritten', /return mul\(uv, m\);/.test(scopedOut), true);
check('scoped: float m untouched', /float m = 2\.0;\n\treturn m \* uv;/.test(scopedOut), true);

// file-scope initialisers are rewritten too
const globalMat = 'float2x2 gm;\nfloat2 gq;\nstatic float2 gw = gm * gq;\nstatic float2 gz = gq * gm;\n';
const globalMatOut = porter.rewriteInlineMatrixMul(globalMat, []);
check('global initialiser: M * v', /static float2 gw = mul\(gq, gm\);/.test(globalMatOut), true);
check('global initialiser: v * M', /static float2 gz = mul\(gm, gq\);/.test(globalMatOut), true);

// unparseable code is reported, never silently mangled
const messages = [];
const garbage = 'float2x2 m;\nvoid f()\n{\n\tuv = m * ;\n}\n';
porter.rewriteInlineMatrixMul(garbage, messages);
check('parse failure is reported', messages.length > 0 && messages[0].level === 'warn', true);

// idempotent: running twice changes nothing more
const once = porter.rewriteInlineMatrixMul(pre + 'uv = m * uv; p = R * R * v;' + post, []);
check('idempotent', porter.rewriteInlineMatrixMul(once, []), once);

console.log((cases.length + 6 - bad) + '/' + (cases.length + 6) + ' porter matrix tests OK');
process.exit(bad ? 1 : 0);
