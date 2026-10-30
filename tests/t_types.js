const {analyzeSource} = require(require('./sb_dir.js') + '/ShaderBridge_analyzer.js');
const pre = `
struct Ray { float3 o; float3 d; };
float2x2 M;
float3x3 R;
static float2 res;
#define SCALE 2.0
#define COL float3(1.0, 0.5, 0.1)
float2 rot(float2 p, float a) { return p; }
float2x2 rotm(float a) { return M; }
float f(float2 x, float y)
{
	float3 q = float3(1.0, 2.0, 3.0);
	int i = 3;
	uint u = 2u;
	Ray ray;
	float arr[4];
	for (int k = 0; k < 3; k++) { float inner = 1.0; }
	{ float2 x2 = x; }
	return 0.0;
}
float g(float3 x) { float v = x.y; return v; }
`;
// [expression, scope marker function, expected type]
const cases = [
	[ '1.0', 'float' ],
	[ '1', 'int' ],
	[ '2u', 'uint' ],
	[ '.5', 'float' ],
	[ '1e8', 'float' ],
	[ 'true', 'bool' ],
	[ 'q', 'float3' ],
	[ 'q.xy', 'float2' ],
	[ 'q.z', 'float' ],
	[ 'q.zyx', 'float3' ],
	[ 'x', 'float2' ],
	[ 'y', 'float' ],
	[ 'i', 'int' ],
	[ 'u', 'uint' ],
	[ 'q * 2.0', 'float3' ],
	[ '2.0 * q', 'float3' ],
	[ 'i * 2', 'int' ],
	[ 'i * 2.0', 'float' ],
	[ 'q + q', 'float3' ],
	[ 'M * x', 'float2' ],
	[ 'x * M', 'float2' ],
	[ 'M * M', 'float2x2' ],
	[ 'rotm(1.0) * x', 'float2' ],
	[ 'x * rotm(a)', 'float2' ],
	[ 'ray.o', 'float3' ],
	[ 'ray.d.y', 'float' ],
	[ 'arr[2]', 'float' ],
	[ 'M[0]', 'float2' ],
	[ 'q[1]', 'float' ],
	[ 'dot(q,q)', 'float' ],
	[ 'length(q)', 'float' ],
	[ 'normalize(q)', 'float3' ],
	[ 'cross(q,q)', 'float3' ],
	[ 'mix(q, q, 0.5)', 'float3' ],
	[ 'max(q, 0.0)', 'float3' ],
	[ 'max(0.0, q)', 'float3' ],
	[ 'clamp(q,0.0,1.0)', 'float3' ],
	[ 'smoothstep(0.0,1.0,q)', 'float3' ],
	[ 'rot(x, 1.0)', 'float2' ],
	[ 'float2(1.0, 2.0)', 'float2' ],
	[ 'float3(x, 1.0)', 'float3' ],
	[ '(h < c) ? q : q', 'float3' ],
	[ 'i < 3', 'bool' ],
	[ 'i < 3 && true', 'bool' ],
	[ 'SCALE', 'float' ],
	[ 'COL', 'float3' ],
	[ 'COL * SCALE', 'float3' ],
	[ 'res', 'float2' ],
	[ 'iResolution.xy', 'float2' ],
	[ 'iTime', 'float' ],
	[ 'tex2D(s, x)', 'float4' ],
	[ 'tex2D(s, x).rgb', 'float3' ],
	[ 'mul(q, R)', 'float3' ],
	[ 'mul(R, q)', 'float3' ],
	[ 'x.x + y * 2.0 - 1.0', 'float' ],
	[ '-q', 'float3' ],
	[ '!true', 'bool' ],
	[ '(q)', 'float3' ],
	[ 'float(i)', 'float' ],
	[ 'int(y)', 'int' ],
	[ 'u << 2u', 'uint' ],
	[ 'u & 3u', 'uint' ],
	[ 'i % 2', 'int' ],
	[ 'q.x < 0.0 ? 1.0 : 2.0', 'float' ],
];
// types in scope: test inside f() body (position at 'return 0.0;')
let A = analyzeSource(pre);
const fn = A.functions['f'][0];
let bad = 0;
for (const [e, exp] of cases)
{
	// place expression inside f's body by building a program
	const prog = pre.replace('return 0.0;', 'float __t = ' + e + '; return 0.0;');
	const B = analyzeSource(prog);
	const f = B.functions['f'][0];
	// find sig index of '__t' decl then '=' then parse
	let at = -1;
	for (let k = f.bodyFrom; k < f.bodyTo; k++)
	{
		if (B.tokens[B.sig[k]].text === '__t')
		{
			at = k;
			break;
		}
	}
	const r = B.parseExpr(at + 2);
	const ok = r && B.tokens[B.sig[r.next]].text === ';';
	const got = ok ? r.node.type : 'PARSEFAIL';
	const pass = got === exp;
	if (!pass)
	{
		bad++;
		console.log('FAIL', e.padEnd(28), 'got', got, 'expected', exp);
	}
}
// scoping checks
const B = analyzeSource(pre);
const g = B.functions['g'][0], f = B.functions['f'][0];
let xg = null;
for (let k = g.bodyFrom; k < g.bodyTo; k++)
{
	if (B.tokens[B.sig[k]].text === 'x')
	{
		xg = k;
		break;
	}
}
console.log('x inside g() =', B.lookup('x', xg), '(expect float3);  x inside f() =', B.lookup('x', f.bodyFrom + 2), '(expect float2)');
console.log(cases.length - bad + '/' + cases.length + ' type cases OK');
process.exit(bad ? 1 : 0);
