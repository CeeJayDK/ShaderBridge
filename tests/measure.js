const fs = require('fs');
const {analyzeSource, anParseType} = require(require('./sb_dir.js') + '/shadertoy_analyzer.js');
const path = require('path');
const dir = (process.env.FX_DIR || path.join(__dirname, 'ported')) + '/';
if (!fs.existsSync(dir))
{
	console.log('SKIP measure: no ported .fx files in ' + dir + ' (set FX_DIR)');
	process.exit(0);
}
let T = {ctors : 0, args : 0, unknown : 0, parseFail : 0};
const unk = {};
function findCall(n, k)
{
	if (!n || typeof n !== 'object') return null;
	if (n.kind === 'call' && n.from === k) return n;
	for (const key of ['child', 'left', 'right', 'base', 'index', 'cond', 'a', 'b'])
	{
		const r = findCall(n[key], k);
		if (r) return r;
	}
	for (const key of ['args', 'items'])
		if (n[key])
			for (const x of n[key])
			{
				const r = findCall(x, k);
				if (r) return r;
			}
	return null;
}
for (const f of fs.readdirSync(dir).filter(f => /\.fx$/.test(f) && !/Common|Sampler/.test(f)))
{
	const src = fs.readFileSync(dir + f, 'utf8');
	const t0 = Date.now();
	const A = analyzeSource(src);
	const t1 = Date.now();
	let c = 0, a = 0, u = 0, pf = 0;
	for (const name of Object.keys(A.functions))
		for (const fn of A.functions[name])
		{
			if (fn.bodyFrom === undefined) continue;
			for (let k = fn.bodyFrom; k < fn.bodyTo; k++)
			{
				const tk = A.tokens[A.sig[k]];
				if (tk.type === 'ident' && anParseType(tk.text) && A.tokens[A.sig[k + 1]] && A.tokens[A.sig[k + 1]].text === '(' && !(A.tokens[A.sig[k - 1]] && anParseType(A.tokens[A.sig[k - 1]].text)))
				{
					c++;
					const r = A.parseExpr(k);
					if (!r)
					{
						pf++;
						continue;
					}
					const call = findCall(r.node, k);
					if (!call)
					{
						pf++;
						continue;
					}
					for (const arg of call.args)
					{
						a++;
						if (!arg.type)
						{
							u++;
							const s = A.textOf(arg).replace(/\s+/g, ' ');
							unk[s.slice(0, 60)] = (unk[s.slice(0, 60)] || 0) + 1;
						}
					}
				}
			}
		}
	console.log(f.padEnd(40), 'ok=' + A.ok, 'funcs=' + Object.keys(A.functions).length, 'decls=' + A.decls.length, 'ctors=' + c, 'args=' + a, 'untyped=' + u, 'parseFail=' + pf, (t1 - t0) + 'ms');
	T.ctors += c;
	T.args += a;
	T.unknown += u;
	T.parseFail += pf;
}
console.log(T, ((1 - T.unknown / T.args) * 100).toFixed(1) + '% of constructor args typed');
console.log('most common untyped args:');
Object.entries(unk).sort((x, y) => y[1] - x[1]).slice(0, 25).forEach(([ s, n ]) => console.log(String(n).padStart(4), s));
