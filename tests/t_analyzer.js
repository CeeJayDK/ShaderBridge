// What the analyzer returns, phase by phase: the tokens, the dead #if branches, the macros, the structs,
// the function signatures, the declarations and their scopes, the lookup and the expression walk. The
// analysis is a list of phases (anTokenize ... anAddHelpers) that each add to a context; these tests pin
// what each one adds, and that the phases need each other in the order analyzeSource calls them.
const porter = require('./load_porter.js')();

let bad = 0, total = 0;
function check(label, ok, detail)
{
	total++;
	if (!ok) { bad++; console.log('FAIL', label, detail ? '\n' + detail : ''); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const SRC = [
	'#define K 2.0',
	'#define SQ(x) ((x) * (x))   // squares',
	'#define LONG(a, b) \\',
	'\t((a) + (b))',
	'#if 0',
	'float dead;',
	'#else',
	'float live;',
	'#endif',
	'struct S { float a; float2 b; };',
	'static float G = 1.0;',
	'float t = 1.0;',
	'float f(float x);',
	'float f(float x)',
	'{',
	'\tfloat y = x * G;',
	'\tint t = 3;',
	'\tfor (int i = 0; i < 2; i++)',
	'\t{',
	'\t\ty += float(i);',
	'\t}',
	'\treturn y;',
	'}',
	'float2 f(float2 v)',
	'{',
	'\treturn v;',
	'}',
	''
].join('\n');
const A = porter.analyzeSource(SRC);
const find = (text, from) => A.sig.findIndex((i, k) => (from === undefined || k >= from) && A.tokens[i].text === text);

// tokens
check('the tokens put the source back together exactly', A.tokens.map(t => t.text).join('') === SRC);
check('the significant tokens leave out white space and comments', A.sig.every(i => A.tokens[i].type !== 'ws' && A.tokens[i].type !== 'comment'));

// dead branches
const deadOf = (name) => !!A.tokens[A.sig[find(name)]].dead;
check('a declaration in #if 0 is dead', deadOf('dead') === true);
check('a declaration in the #else of #if 0 is live', deadOf('live') === false);
const A2 = porter.analyzeSource('#if 1\nfloat a;\n#else\nfloat b;\n#endif\n#if SOMETHING\nfloat c;\n#endif\n');
const dead2 = (name) => !!A2.tokens[A2.sig[A2.sig.findIndex(i => A2.tokens[i].text === name)]].dead;
check('in #if 1 the #else is dead', dead2('a') === false && dead2('b') === true);
check('a condition the analyzer cannot evaluate counts as live', dead2('c') === false);

// macros
check('an object-like macro keeps its body', A.macros.K && A.macros.K.body === '2.0' && !A.macros.K.fn, JSON.stringify(A.macros.K));
check('a function-like macro has parameters and body, and a trailing comment is dropped', A.macros.SQ && A.macros.SQ.fn === true && same(A.macros.SQ.params, ['x']) && A.macros.SQ.body === '((x) * (x))', JSON.stringify(A.macros.SQ));
check('a macro over several lines is joined', A.macros.LONG && same(A.macros.LONG.params, ['a', 'b']) && /^\(\(a\) \+ \(b\)\)$/.test(A.macros.LONG.body.replace(/\s+/g, ' ').trim()), JSON.stringify(A.macros.LONG));

// structs
check('a struct has its fields and their types', same(A.structs.S, { fields: { a: 'float', b: 'float2' } }), JSON.stringify(A.structs));

// functions
const fs = A.functions.f;
check('every declaration and definition of a name is kept, three for f', fs.length === 3, String(fs.length));
check('a declaration has an end and no body', fs[0].protoTo !== undefined && fs[0].bodyFrom === undefined);
check('a definition has a body and no declaration end', fs[1].bodyFrom !== undefined && fs[1].bodyTo > fs[1].bodyFrom && fs[1].protoTo === undefined);
check('overloads are separate entries with their own types', fs[2].ret === 'float2' && same(fs[2].params.map(p => p.type + ' ' + p.name), ['float2 v']));
check('return type and parameters', fs[1].ret === 'float' && same(fs[1].params.map(p => p.type + ' ' + p.name), ['float x']));

// declarations and lookup
const global = (n) => A.decls.find(d => d.name === n && d.global);
check('globals are declared with their type', global('G') && global('G').type === 'float' && global('t').type === 'float' && global('live') && global('dead'));
const inBody = fs[1].bodyFrom + 6;
check('a local is visible inside its function', A.lookup('y', inBody) === 'float', String(A.lookup('y', inBody)));
check('and not outside it', A.lookup('y', 2) === null);
check('a parameter is visible in its function and not in the next one', A.lookup('x', inBody) === 'float' && A.lookup('x', fs[2].bodyFrom + 1) === null);
check('a global is visible inside a function', A.lookup('G', inBody) === 'float');
check('a local hides a global of the same name', A.lookup('t', fs[1].bodyTo - 2) === 'int' && A.lookup('t', fs[2].bodyFrom + 1) === 'float', A.lookup('t', fs[1].bodyTo - 2) + ' ' + A.lookup('t', fs[2].bodyFrom + 1));
const iAt = find('i', fs[1].bodyFrom + 10);
check('a loop variable is visible inside the loop and not after it', A.lookup('i', iAt + 8) === 'int' && A.lookup('i', fs[1].bodyTo - 1) === null);
check('a scope lies inside its function', A.decls.filter(d => !d.global).every(d => d.scopeFrom <= d.declAt && d.declAt <= d.scopeTo));

// the expression walk and the helpers
const texts = [];
A.eachExpression(node => texts.push(A.textOf(node)));
check('every initialiser, condition, statement and return value is visited', same(texts, ['1.0', '1.0', 'x * G', '3', '0', 'i < 2', 'i++', 'y += float(i)', 'y', 'v']), JSON.stringify(texts));
check('nothing failed to parse', A.parseFailures === 0);
let first = null;
A.eachExpression(node => { if (!first && A.textOf(node) === 'x * G') { first = node; } });
check('a visited expression has a type', first && first.type === 'float', first && first.type);
check('character positions and text agree', SRC.slice(A.charStart(first), A.charEnd(first)) === 'x * G' && A.textOf(first) === 'x * G');
check('a node in a dead branch is told apart', (function ()
{
	const B = porter.analyzeSource('#if 0\nfloat q = 1.0;\n#endif\nfloat r = 2.0;\n');
	const flags = {};
	B.eachExpression(node => { flags[B.textOf(node)] = B.isDead(node); });
	return flags['1.0'] === true && flags['2.0'] === false;
}()), 'dead flags');
const parsed = A.parseExpr(find('x', fs[1].bodyFrom), {});
check('parseExpr gives a node and where the expression ends', parsed && parsed.node.type === 'float' && parsed.next > find('x', fs[1].bodyFrom));

// separate analyses share nothing
const C = porter.analyzeSource('#define ONLY_HERE 1\nfloat z;\n');
check('two analyses do not share macros, declarations or structs', !C.macros.K && !A.macros.ONLY_HERE && !C.structs.S && C.decls.length === 1);
check('the same source gives the same result twice', same(porter.analyzeSource(SRC).decls, A.decls) && same(porter.analyzeSource(SRC).macros, A.macros));

// the phases and their order
const phases = ['anTokenize', 'anScanMacros', 'anMakeHelpers', 'anScanTopLevel', 'anScanLocals', 'anAddLookup', 'anAddMacroTyping', 'anAddParser', 'anAddWalker', 'anAddHelpers'];
const body = porter.analyzeSource.toString();
check('every phase exists and takes the context', phases.every(p => typeof porter[p] === 'function' && porter[p].length === 1));
check('analyzeSource calls the phases in this order', phases.map(p => body.indexOf(p + '(an)')).every((v, i, a) => v >= 0 && (i === 0 || v > a[i - 1])), body);
check('run by hand, the phases give the same analysis', (function ()
{
	const an = { src: SRC };
	phases.forEach(p => porter[p](an));
	return same(an.A.decls, A.decls) && same(an.A.functions, A.functions) && same(an.A.structs, A.structs) && same(an.A.macros, A.macros);
}()));
function failsWithout(skipped)
{
	const an = { src: SRC };
	try { phases.forEach(p => { if (p !== skipped) { porter[p](an); } }); }
	catch (e) { return true; }
	return false;
}
check('a phase run without the one before it fails loudly (macros, helpers)', ['anScanMacros', 'anMakeHelpers'].every(failsWithout));
check('the parser needs the macro typing as soon as it meets a macro call', (function ()
{
	const an = { src: '#define SQ(x) x\nfloat a = SQ(1.0);\n' };
	phases.forEach(p => { if (p !== 'anAddMacroTyping') { porter[p](an); } });
	try { an.A.eachExpression(() => {}); return false; } catch (e) { return true; }
}()));

// a macro that stands for a type (3.0.37)
const AL = porter.analyzeSource('#define vec1 float\n#define V4 float4\n#define V4B V4\n#define NUM 1.0\n#define EXPR (1.0 + 2.0)\n#define NAME iTime\nvec1 suv(float4 a) { return dot(float4(1), a); }\nvec1 suv(float3 a) { return dot(float3(1), a); }\nvec1 g;\nV4B w;\nstruct S { vec1 a; V4 b; };\nvoid f(vec1 p, V4 q)\n{\n\tvec1 x = 1.0;\n\tfor (vec1 i = 0.0; i < 2.0; i++) { x += i; }\n\tfloat z = vec1(2.0);\n}\n');
check('a function whose return type is an alias is a function, and both overloads are seen', AL.functions.suv && AL.functions.suv.length === 2 && AL.functions.suv[0].ret === 'float', JSON.stringify(AL.functions.suv && AL.functions.suv.map(f => f.ret)));
check('the body of such a function is analysed', (function () { const seen = []; AL.eachExpression(n => seen.push(AL.textOf(n))); return seen.indexOf('dot(float4(1), a)') >= 0; }()));
check('a global declared with an alias has the real type', AL.decls.find(d => d.name === 'g' && d.global).type === 'float');
check('an alias of an alias is followed', AL.decls.find(d => d.name === 'w' && d.global).type === 'float4', String(AL.decls.find(d => d.name === 'w' && d.global).type));
check('struct members with an alias type', AL.structs.S && AL.structs.S.fields.a === 'float' && AL.structs.S.fields.b === 'float4', JSON.stringify(AL.structs.S));
check('parameters with an alias type', (function () { const f = AL.functions.f[0]; return f.params[0].type === 'float' && f.params[1].type === 'float4'; }()));
check('a local and a loop variable with an alias type', AL.decls.find(d => d.name === 'x').type === 'float' && AL.decls.find(d => d.name === 'i').type === 'float');
check('an alias used as a constructor is typed', (function () { let t = null; AL.eachExpression(n => { if (AL.textOf(n) === 'vec1(2.0)') { t = n.type; } }); return t === 'float'; }()));
check('a number macro is not a type', (function () { const A2 = porter.analyzeSource('#define NUM 1.0\nNUM x;\n'); return A2.decls.length === 0; }()));
check('a macro that is an expression is not a type', (function () { const A2 = porter.analyzeSource('#define EXPR (1.0 + 2.0)\nEXPR x;\n'); return A2.decls.length === 0; }()));
check('a macro for a name that is not a type is not a type', (function () { const A2 = porter.analyzeSource('#define NAME iTime\nNAME x;\n'); return A2.decls.length === 0; }()));
check('a function-like macro is not an alias', (function () { const A2 = porter.analyzeSource('#define T(x) float\nT(1) y;\n'); return A2.decls.filter(d => d.global).length === 0; }()));
check('a loop of aliases does not hang', (function () { const A2 = porter.analyzeSource('#define A B\n#define B A\nA x;\nfloat ok;\n'); return A2.decls.some(d => d.name === 'ok'); }()));
check('a self-referring alias does not hang', (function () { const A2 = porter.analyzeSource('#define float float\nfloat y;\n'); return A2.decls.some(d => d.name === 'y'); }()));
check('an alias for a user struct', (function () { const A2 = porter.analyzeSource('struct P { float a; };\n#define Q P\nQ pp;\n'); const d = A2.decls.find(x => x.name === 'pp'); return d && d.type === 'P'; }()));

console.log((total - bad) + '/' + total + ' analyzer tests OK');
process.exit(bad ? 1 : 0);
