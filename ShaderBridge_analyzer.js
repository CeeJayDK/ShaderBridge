// ShaderBridge prototype analyzer: scopes + expression parser + type inference.
// Works on the token stream from lexer.js. Never modifies text; it only answers questions
// ("what is the type of the expression at tokens a..b?") so rewriters can stop guessing.

var AN = (typeof module !== 'undefined') ? require('./ShaderBridge_lexer.js') : { tokenizeSource: tokenizeSource, replaceSourceComments: replaceSourceComments };

var AN_SCALARS = { float: 1, int: 1, uint: 1, bool: 1 };

function anParseType(name)
{
	var m;
	if (AN_SCALARS[name]) { return { base: name, rows: 1, cols: 1, kind: 'scalar' }; }
	if ((m = /^(float|int|uint|bool)([234])$/.exec(name))) { return { base: m[1], rows: +m[2], cols: 1, kind: 'vec' }; }
	if ((m = /^float([234])x([234])$/.exec(name))) { return { base: 'float', rows: +m[1], cols: +m[2], kind: 'mat' }; }
	return null;
}
function anVec(base, n) { return n === 1 ? base : base + n; }
function anPromote(a, b)
{
	if (a === 'float' || b === 'float') { return 'float'; }
	if (a === 'uint' || b === 'uint') { return 'uint'; }
	if (a === 'int' || b === 'int') { return 'int'; }
	return 'bool';
}

// ── builtin function result types ───────────────────────────────────────────
var AN_SAME_AS_ARG0 = 'abs sign floor ceil fract frac sin cos tan asin acos atan sinh cosh tanh exp exp2 log log2 sqrt inversesqrt rsqrt normalize saturate radians degrees trunc round ddx ddy dFdx dFdy fwidth ddx_fine ddy_fine ddx_coarse ddy_coarse min max clamp pow mod fmod atan2 reflect refract mix lerp step smoothstep rcp'.split(' ');
var AN_SCALAR_FLOAT = 'dot length distance determinant'.split(' ');
var AN_BOOL_RESULT = 'any all isnan isinf'.split(' ');
var AN_FLOAT4_RESULT = 'tex2D tex2Dlod tex2Dgrad tex2Dbias tex2Dfetch tex2Dproj tex3D tex3Dlod tex3Dfetch tex3Dgrad texCUBE texCUBElod texture texture2D textureLod textureGrad texelFetch textureCube textureCubeLod'.split(' ');

function anBuiltinType(name, args)
{
	var t0 = args[0] || null, t1 = args[1] || null, t2 = args[2] || null;
	if (AN_SAME_AS_ARG0.indexOf(name) !== -1)
	{
		if (name === 'step') { return t1; }
		if (name === 'smoothstep') { return t2; }
		if (name === 'clamp' || name === 'min' || name === 'max' || name === 'pow' || name === 'mod' || name === 'fmod' || name === 'atan2')
		{
			// scalar op vector → vector
			var p0 = t0 && anParseType(t0), p1 = t1 && anParseType(t1);
			if (p0 && p1 && p0.kind === 'scalar' && p1.kind === 'vec') { return t1; }
		}
		if (name === 'mix' || name === 'lerp') { return t0; }
		return t0;
	}
	if (AN_SCALAR_FLOAT.indexOf(name) !== -1) { return 'float'; }
	if (AN_BOOL_RESULT.indexOf(name) !== -1) { return 'bool'; }
	if (AN_FLOAT4_RESULT.indexOf(name) !== -1) { return 'float4'; }
	if (name === 'cross') { return 'float3'; }
	if (name === 'tex3Dsize' || (name === 'textureSize' && t0 === 'sampler3D')) { return 'int3'; }
	if (name === 'tex2Dsize' || name === 'textureSize') { return 'int2'; }
	if (name === 'textureOffset' || name === 'textureLodOffset' || name === 'textureGradOffset' || name === 'texelFetchOffset' || name === 'textureProj') { return 'float4'; }
	if (name === 'matrixCompMult') { return t0; }
	if (name === 'outerProduct')
	{
		var oc = t0 && anParseType(t0), orr = t1 && anParseType(t1);
		return oc && orr && oc.kind === 'vec' && orr.kind === 'vec' && oc.rows === orr.rows ? 'float' + oc.rows + 'x' + oc.rows : null;
	}
	if (name === 'transpose' || name === 'inverse') { return t0; }
	if (name === 'mul') { return anMulType(t0, t1); }
	if (name === 'float' || name === 'int' || name === 'uint' || name === 'bool') { return name; }
	return null;
}

// HLSL mul(a, b)
function anMulType(a, b)
{
	var pa = a && anParseType(a), pb = b && anParseType(b);
	if (!pa || !pb) { return null; }
	var base = anPromote(pa.base, pb.base);
	if (pa.kind === 'scalar') { return b; }
	if (pb.kind === 'scalar') { return a; }
	if (pa.kind === 'vec' && pb.kind === 'mat') { return anVec(base, pb.cols); }   // row vector * matrix
	if (pa.kind === 'mat' && pb.kind === 'vec') { return anVec(base, pa.rows); }   // matrix * column vector
	if (pa.kind === 'mat' && pb.kind === 'mat') { return 'float' + pa.rows + 'x' + pb.cols; }
	if (pa.kind === 'vec' && pb.kind === 'vec') { return 'float'; }
	return null;
}

// GLSL operator '*' on GLSL-origin types (matrix dimensions retain transposed storage).
function anBinaryType(op, lt, rt)
{
	if (op === '&&' || op === '||') { return 'bool'; }
	var pl = lt && anParseType(lt), pr = rt && anParseType(rt);
	if (op === '==' || op === '!=' || op === '<' || op === '>' || op === '<=' || op === '>=')
	{
		return 'bool';
	}
	if (!pl || !pr) { return null; }
	if (op === '<<' || op === '>>') { return lt; }
	if (op === '&' || op === '|' || op === '^')
	{
		if (pl.kind === 'scalar' && pr.kind === 'vec') { return rt; }
		return lt;
	}
	// arithmetic
	if (pl.kind === 'mat' || pr.kind === 'mat')
	{
		if (op === '*')
		{
			if (pl.kind === 'mat' && pr.kind === 'vec') { return anVec('float', pl.cols); }
			if (pl.kind === 'vec' && pr.kind === 'mat') { return anVec('float', pr.rows); }
			if (pl.kind === 'mat' && pr.kind === 'mat') { return 'float' + pr.rows + 'x' + pl.cols; }
		}
		if (pl.kind === 'mat') { return lt; }
		return rt;
	}
	var base = anPromote(pl.base, pr.base);
	if (pl.kind === 'scalar' && pr.kind === 'scalar') { return base; }
	if (pl.kind === 'vec' && pr.kind === 'scalar') { return anVec(base, pl.rows); }
	if (pl.kind === 'scalar' && pr.kind === 'vec') { return anVec(base, pr.rows); }
	if (pl.rows === pr.rows) { return anVec(base, pl.rows); }
	return null;
}

var AN_KNOWN_GLOBALS = {
	iResolution: 'float3', iTime: 'float', iTimeDelta: 'float', iFrame: 'int', iMouse: 'float4',
	iDate: 'float4', iSampleRate: 'float', iChannelResolution: 'float3[]', iChannelTime: 'float[]'
};

// ── analyzer ────────────────────────────────────────────────────────────────
var AN_MACRO_DEPTH = 0;

// Macro call types found so far, shared between analyses. The tree rewrites each analyse the
// source again, and they re-type the same macro calls. A key holds the macro name, its body, the
// argument types and a hash of the declarations the body is read against, so another shader that
// reuses a macro name cannot be given this shader's answer.
var AN_MACRO_CACHE = {};
var AN_MACRO_CACHE_SIZE = 0;

function anHashText(text)
{
	var h = 5381;
	for (var i = 0; i < text.length; i++) { h = ((h << 5) + h + text.charCodeAt(i)) | 0; }
	return h + ':' + text.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// The analysis, in phases. Each phase reads what the earlier ones left in the context  an  and
// adds to it; what the caller gets back is an.A. The phases share only read-only values (the
// tokens, the significant tokens, A and a few small helpers); the only state a phase changes is its own.
// ─────────────────────────────────────────────────────────────────────────────

// the tokens, the significant ones, and which of them sit in a dead #if branch
function anTokenize(an)
{
	var src = an.src;
	var tokens = AN.tokenizeSource(src);
	var sigIdx = [];

	// Mark tokens that sit in a literally dead branch (#if 0 ... , or the #else of #if 1).
	// Conditions the analyzer cannot evaluate count as live. Dead tokens are still analysed, and
	// still rewritten, because the .fx may be edited to enable that branch; the flag only lets
	// callers keep their warnings quiet about code that does not compile in.
	var branchStack = [];
	tokens.forEach(function (t, i)
	{
		if (t.type === 'preproc')
		{
			var pm = /^#\s*(ifdef|ifndef|if|elif|else|endif)\b([^\n]*)/.exec(t.text);
			if (pm)
			{
				var kind = pm[1];
				var cond = pm[2].replace(/\/\/.*$|\/\*.*?\*\//g, '').trim();
				var top = branchStack[branchStack.length - 1];
				if (kind === 'if' || kind === 'ifdef' || kind === 'ifndef')
				{
					var literal = (kind === 'if' && (cond === '0' || cond === '1')) ? (cond === '1') : null;
					branchStack.push({ literal: literal, live: literal === null ? true : literal });
				}
				else if (kind === 'else' && top && top.literal !== null) { top.live = !top.literal; }
				else if (kind === 'elif' && top) { top.literal = null; top.live = true; }
				else if (kind === 'endif') { branchStack.pop(); }
			}
		}
		t.dead = !branchStack.every(function (b) { return b.live; });
		if (t.type !== 'ws' && t.type !== 'comment' && t.type !== 'placeholder' && t.type !== 'preproc') { sigIdx.push(i); }
	});

	an.tokens = tokens;
	an.sig = sigIdx;
	an.nSig = sigIdx.length;
}

// the object-like and function-like #define macros → A.macros
function anScanMacros(an)
{
	var tokens = an.tokens;
	var sigIdx = an.sig;
	var A = {
		tokens: tokens, sig: sigIdx, structs: {}, functions: {}, macros: {}, decls: [],
		unknownTypes: 0, typedExprs: 0, ok: true, globalInits: []
	};

	// object-like macros: #define NAME body
	tokens.forEach(function (t, i)
	{
		if (t.type !== 'preproc') { return; }
		// a backslash-continued #define is one token; join its lines and drop comments
		var text = AN.replaceSourceComments(t.text.replace(/\\\r?\n/g, ' '), function () { return ' '; });
		var m = /^#\s*define\s+([A-Za-z_]\w*)(\()?([^\n]*)/.exec(text);
		if (m && !m[2]) { A.macros[m[1]] = { body: m[3].trim(), type: undefined }; }
		else if (m)
		{
			// function-like: NAME(params) body
			var fm = /^([^)]*)\)\s*(.*)$/.exec(m[3]);
			var params = fm ? fm[1].split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x.length > 0; }) : null;
			A.macros[m[1]] = { fn: true, params: params, body: fm ? fm[2].trim() : '', types: {} };
		}
	});

	an.A = A;
}

// small helpers over the significant tokens: T, txt, matchClose, isTypeName
function anMakeHelpers(an)
{
	var A = an.A;
	var nSig = an.nSig;
	var sigIdx = an.sig;
	var tokens = an.tokens;
	// A macro whose body is a single name stands for that name:  #define vec1 float  makes vec1 a type.
	// Followed through a few steps; anything else (a number, an expression) is not an alias.
	function resolveType(name)
	{
		for (var step = 0; step < 6; step++)
		{
			var macro = A.macros[name];
			if (!macro || macro.fn || !macro.body || !/^[A-Za-z_]\w*$/.test(macro.body.trim())) { break; }
			name = macro.body.trim();
		}
		return name;
	}

	function isTypeName(name)
	{
		name = resolveType(name);
		return !!anParseType(name) || !!A.structs[name] || /^sampler(2D|3D|Cube)$/.test(name) || name === 'void';
	}
	var QUALS = { static: 1, const: 1, uniform: 1, in: 1, out: 1, inout: 1, highp: 1, mediump: 1, lowp: 1, precision: 1, flat: 1, varying: 1, attribute: 1 };

	// ── pass 1: top-level structure (structs, function signatures, globals) ──
	var nSig = sigIdx.length;
	function T(k) { return k >= 0 && k < nSig ? tokens[sigIdx[k]] : null; }
	function txt(k) { var t = T(k); return t ? t.text : ''; }

	function matchClose(k, open, close)
	{
		var d = 0;
		for (var j = k; j < nSig; j++)
		{
			var s = txt(j);
			if (s === open) { d++; }
			else if (s === close) { d--; if (d === 0) { return j; } }
		}
		return -1;
	}
	an.T = T;
	an.txt = txt;
	an.matchClose = matchClose;
	an.isTypeName = isTypeName;
	an.resolveType = resolveType;
	an.QUALS = QUALS;
}

// pass 1: structs, function signatures and globals → A.structs, A.functions, A.decls
function anScanTopLevel(an)
{
	var A = an.A;
	var resolveType = an.resolveType;
	var nSig = an.nSig;
	var txt = an.txt;
	var T = an.T;
	var matchClose = an.matchClose;
	var isTypeName = an.isTypeName;
	var QUALS = an.QUALS;
	var k = 0;
	var topDecls = [];
	while (k < nSig)
	{
		var s = txt(k);
		if (s === 'struct' && T(k + 1) && T(k + 1).type === 'ident' && txt(k + 2) === '{')
		{
			var close = matchClose(k + 2, '{', '}');
			if (close < 0) { A.ok = false; break; }
			var fields = {};
			var j = k + 3;
			while (j < close)
			{
				var ft = resolveType(txt(j));
				if (isTypeName(ft))
				{
					var fnames = [];
					j++;
					while (j < close && txt(j) !== ';')
					{
						if (T(j).type === 'ident' && txt(j - 1) !== '[') { fields[txt(j)] = ft; }
						j++;
					}
				}
				j++;
			}
			A.structs[txt(k + 1)] = { fields: fields };
			k = close + 1;
			if (txt(k) === ';') { k++; }
			continue;
		}
		// skip qualifiers
		var q = k;
		while (QUALS[txt(q)]) { q++; }
		if (isTypeName(txt(q)) && T(q + 1) && T(q + 1).type === 'ident' && txt(q + 2) === '(')
		{
			// function definition or prototype
			var pclose = matchClose(q + 2, '(', ')');
			if (pclose < 0) { A.ok = false; break; }
			var params = [];
			var pj = q + 3;
			while (pj < pclose)
			{
				var pk = pj;
				while (QUALS[txt(pk)]) { pk++; }
				var ptype = resolveType(txt(pk));
				var pname = txt(pk + 1);
				if (isTypeName(ptype) && T(pk + 1) && T(pk + 1).type === 'ident') { params.push({ type: ptype + (txt(pk + 2) === '[' ? '[]' : ''), name: pname, tok: pk + 1 }); }
				// advance to next top-level comma
				var pd = 0;
				while (pj < pclose)
				{
					var ps = txt(pj);
					if (ps === '(' || ps === '[') { pd++; }
					else if (ps === ')' || ps === ']') { pd--; }
					else if (ps === ',' && pd === 0) { pj++; break; }
					pj++;
				}
			}
			var fn = { name: txt(q + 1), ret: resolveType(txt(q)), params: params, from: k, nameTok: q + 1 };
			if (txt(pclose + 1) === '{')
			{
				var bclose = matchClose(pclose + 1, '{', '}');
				if (bclose < 0) { A.ok = false; break; }
				fn.bodyFrom = pclose + 1; fn.bodyTo = bclose;
				k = bclose + 1;
			}
			else { k = pclose + 1; if (txt(k) === ';') { k++; } fn.protoTo = k - 1; }
			A.functions[fn.name] = A.functions[fn.name] || [];
			A.functions[fn.name].push(fn);
			continue;
		}
		// global declaration: [quals] Type name [= init] [, name ...] ;
		if (isTypeName(txt(q)) && T(q + 1) && T(q + 1).type === 'ident')
		{
			var gtype = resolveType(txt(q));
			var isConst = false;
			var e = q + 1;
			var gd = 0;
			var expectName = true;
			while (e < nSig)
			{
				var gs = txt(e);
				if (gs === '(' || gs === '[' || gs === '{') { gd++; }
				else if (gs === ')' || gs === ']' || gs === '}') { gd--; }
				else if (gd === 0 && gs === ';') { break; }
				if (gd === 0 && expectName && T(e).type === 'ident') { A.decls.push({ name: gs, type: gtype + (txt(e + 1) === '[' ? '[]' : ''), scopeFrom: 0, scopeTo: nSig, declAt: e, global: true }); expectName = false; }
				else if (gd === 0 && gs === ',') { expectName = true; }
				else if (gd === 0 && gs === '=') { A.globalInits.push(e + 1); }
				e++;
			}
			k = e + 1;
			continue;
		}
		// anything else at top level: skip one token (stray ';', etc.)
		if (txt(k) === '{') { var c2 = matchClose(k, '{', '}'); k = c2 < 0 ? nSig : c2 + 1; continue; }
		k++;
	}

}

// pass 2: the local declarations inside each function body → A.decls
function anScanLocals(an)
{
	var A = an.A;
	var resolveType = an.resolveType;
	var txt = an.txt;
	var T = an.T;
	var matchClose = an.matchClose;
	var isTypeName = an.isTypeName;
	var QUALS = an.QUALS;
	// ── pass 2: local declarations inside each function body ──
	Object.keys(A.functions).forEach(function (name)
	{
		A.functions[name].forEach(function (fn)
		{
			if (fn.bodyFrom === undefined) { return; }
			fn.params.forEach(function (p) { A.decls.push({ name: p.name, type: p.type, scopeFrom: fn.from, scopeTo: fn.bodyTo, declAt: p.tok }); });
			var scopes = []; // stack of { from, pendingFor }
			scopes.push({ from: fn.bodyFrom });
			var forStack = []; // for-header scopes awaiting their body
			var j = fn.bodyFrom + 1;
			var stmtStart = true;
			var parenDepth = 0;
			var pendingFor = null; // { from, headerClosed, singleStmt }
			function popScopeTo(end) { var sc = scopes.pop(); sc.to = end; sc.names.forEach(function (d) { d.scopeTo = end; }); }
			scopes[0].names = [];
			while (j < fn.bodyTo)
			{
				var s2 = txt(j);
				if (s2 === '{')
				{
					scopes.push({ from: j, names: [] });
					stmtStart = true; j++; continue;
				}
				if (s2 === '}')
				{
					popScopeTo(j);
					while (forStack.length && forStack[forStack.length - 1].bodyBlockDepth === scopes.length) { forStack.pop(); popScopeTo(j); }
					stmtStart = true; j++; continue;
				}
				if (s2 === 'for' && txt(j + 1) === '(')
				{
					var hc = matchClose(j + 1, '(', ')');
					scopes.push({ from: j, names: [] });
					var rec = { bodyBlockDepth: scopes.length, single: txt(hc + 1) !== '{' };
					// declarations inside the header go into the for scope
					scanDeclRange(j + 2, hc);
					if (rec.single)
					{
						// single statement body: scope ends at its terminating ';'
						var se = hc + 1, sd = 0;
						while (se < fn.bodyTo) { var ss = txt(se); if (ss === '(' || ss === '[' || ss === '{') { sd++; } else if (ss === ')' || ss === ']' || ss === '}') { sd--; } else if (ss === ';' && sd === 0) { break; } se++; }
						// header scope covers header + single statement; closed after we pass it
						scopes[scopes.length - 1].names.forEach(function (d) { d.scopeTo = se; });
						scopes.pop();
					}
					else { forStack.push(rec); }
					j = hc + 1; stmtStart = true; continue;
				}
				if (stmtStart || s2 === ';')
				{
					if (s2 === ';') { stmtStart = true; j++; continue; }
					var qq = j;
					while (QUALS[txt(qq)]) { qq++; }
					if (isTypeName(txt(qq)) && T(qq + 1) && T(qq + 1).type === 'ident' && txt(qq + 2) !== '(')
					{
						// local declaration statement; scan to ';'
						var de = qq + 1, dd = 0;
						while (de < fn.bodyTo) { var ds = txt(de); if (ds === '(' || ds === '[' || ds === '{') { dd++; } else if (ds === ')' || ds === ']' || ds === '}') { dd--; } else if (dd === 0 && ds === ';') { break; } de++; }
						scanDeclRange(qq, de);
						stmtStart = false; j = de; continue;
					}
					stmtStart = false;
				}
				j++;
			}
			function scanDeclRange(from, to)
			{
				var qq2 = from;
				while (QUALS[txt(qq2)]) { qq2++; }
				var tn = resolveType(txt(qq2));
				if (!isTypeName(tn)) { return; }
				var gd2 = 0, expect = true;
				for (var e2 = qq2 + 1; e2 < to; e2++)
				{
					var gs2 = txt(e2);
					if (gs2 === '(' || gs2 === '[' || gs2 === '{') { gd2++; }
					else if (gs2 === ')' || gs2 === ']' || gs2 === '}') { gd2--; }
					if (gd2 === 0 && expect && T(e2).type === 'ident')
					{
						var d = { name: gs2, type: tn + (txt(e2 + 1) === '[' ? '[]' : ''), scopeFrom: e2, scopeTo: fn.bodyTo, declAt: e2 };
						A.decls.push(d);
						scopes[scopes.length - 1].names.push(d);
						expect = false;
					}
					else if (gd2 === 0 && gs2 === ',') { expect = true; }
				}
			}
		});
	});

}

// A.lookup(name, atSig): the type of a name at a position
function anAddLookup(an)
{
	var A = an.A;
	// ── lookup ──
	A.lookup = function (name, atSig)
	{
		var best = null;
		for (var i = 0; i < A.decls.length; i++)
		{
			var d = A.decls[i];
			if (d.name !== name) { continue; }
			if (!d.global && !(atSig >= d.scopeFrom && atSig <= d.scopeTo && d.declAt <= atSig)) { continue; }
			if (d.global && d.declAt > atSig && !d.global) { continue; }
			if (!best || (d.global ? 0 : 1) > (best.global ? 0 : 1) || ((!!d.global === !!best.global) && d.declAt > best.declAt)) { best = d; }
		}
		return best ? best.type : null;
	};

}

// the type of a call to a function-like macro (an.macroCallType)
function anAddMacroTyping(an)
{
	var A = an.A;
	var tokens = an.tokens;
	var sigIdx = an.sig;
	var src = an.src;
	// The source with every function body cut out: macros, structs, globals and function
	// signatures remain. A macro probe needs only these to type a body, and they are a fraction
	// of the source. Built once per analysis.
	var declarationsSource = null;
	function declarationsOnly()
	{
		if (declarationsSource !== null) { return declarationsSource; }
		var cuts = [];
		Object.keys(A.functions).forEach(function (name)
		{
			A.functions[name].forEach(function (fn)
			{
				if (fn.bodyFrom !== undefined) { cuts.push({ from: tokens[sigIdx[fn.bodyFrom]].start, to: tokens[sigIdx[fn.bodyTo]].end }); }
			});
		});
		cuts.sort(function (a, b) { return b.from - a.from; });
		var text = src;
		cuts.forEach(function (c) { text = text.slice(0, c.from) + ';' + text.slice(c.to); });
		declarationsSource = text;
		return text;
	}

	// What a macro probe is read against, as a hash: the global names and their types, the function
	// signatures, the struct fields and every macro body. A rewrite that only changes expressions
	// leaves it as it was, which is why it is not simply a hash of the declaration text.
	var fingerprint = null;
	function contextFingerprint()
	{
		if (fingerprint !== null) { return fingerprint; }
		var parts = [];
		A.decls.forEach(function (d) { if (d.global) { parts.push(d.name + ':' + d.type); } });
		Object.keys(A.functions).sort().forEach(function (n)
		{
			A.functions[n].forEach(function (fn) { parts.push(n + '>' + fn.ret + '(' + fn.params.map(function (p) { return p.type; }).join(',') + ')'); });
		});
		Object.keys(A.structs).sort().forEach(function (n) { parts.push(n + '{' + Object.keys(A.structs[n].fields).map(function (f) { return f + ':' + A.structs[n].fields[f]; }).join(',') + '}'); });
		Object.keys(A.macros).sort().forEach(function (n) { parts.push(n + '#' + (A.macros[n].params ? A.macros[n].params.join(',') : '') + '#' + (A.macros[n].body || '')); });
		fingerprint = anHashText(parts.join(';'));
		return fingerprint;
	}

	// The type of a macro body read as an expression against the declarations of the file. A function-like
	// macro passes its parameters and the types of the actual arguments; they become locals of the probe.
	// Each nesting level gets its own probe name, and the depth is held until the result has been read,
	// because reading it is what types any macro the body uses in turn.
	function probeType(body, params, argTypes)
	{
		var level = ++AN_MACRO_DEPTH;
		var probeName = '__st_probe' + level + '__';
		var resultName = '__st_result' + level + '__';
		var found = null;
		try
		{
			var probe = declarationsOnly() + '\nvoid ' + probeName + '()\n{\n'
				+ (params || []).map(function (p, i) { return '\t' + argTypes[i] + ' ' + p + ';\n'; }).join('')
				+ '\tfloat ' + resultName + ' = ' + body + ';\n}\n';
			var sub = analyzeSource(probe);
			var probeFn = sub.functions[probeName];
			if (probeFn && probeFn[0].bodyFrom !== undefined)
			{
				for (var i = probeFn[0].bodyFrom; i < probeFn[0].bodyTo; i++)
				{
					if (sub.tokens[sub.sig[i]].text === resultName && sub.tokens[sub.sig[i + 1]].text === '=')
					{
						var r = sub.parseExpr(i + 2);
						if (r && sub.tokens[sub.sig[r.next]].text === ';') { found = r.node.type; }
						break;
					}
				}
			}
		}
		finally
		{
			AN_MACRO_DEPTH--;
		}
		return found;
	}

	// The type of a call to a function-like macro. The macro is not expanded: its body is analysed
	// as an expression in a throwaway function whose locals are the macro's parameters, declared
	// with the types of the actual arguments. Unknown argument types, stringizing and token pasting
	// give no answer, and a depth limit keeps macros that use other macros from running away.
	function macroCallType(name, argTypes)
	{
		var macro = A.macros[name];
		if (!macro || !macro.params || macro.params.length !== argTypes.length || AN_MACRO_DEPTH > 4) { return null; }
		if (argTypes.some(function (t) { return !t || /\[\]$/.test(t); })) { return null; }
		if (/#|\.\.\./.test(macro.body) || macro.params.some(function (p) { return !/^[A-Za-z_]\w*$/.test(p); })) { return null; }
		var key = argTypes.join(',');
		if (Object.prototype.hasOwnProperty.call(macro.types, key)) { return macro.types[key]; }
		var sharedKey = name + '|' + macro.body + '|' + key + '|' + contextFingerprint();
		if (Object.prototype.hasOwnProperty.call(AN_MACRO_CACHE, sharedKey))
		{
			macro.types[key] = AN_MACRO_CACHE[sharedKey];
			return macro.types[key];
		}
		macro.types[key] = null;

		var found = probeType(macro.body, macro.params, argTypes);
		macro.types[key] = found;
		if (AN_MACRO_CACHE_SIZE > 2000) { AN_MACRO_CACHE = {}; AN_MACRO_CACHE_SIZE = 0; }
		AN_MACRO_CACHE[sharedKey] = found;
		AN_MACRO_CACHE_SIZE++;
		return found;
	}

	// The type of an object-like macro, such as  #define TAU (2.0*PI) . Its body is read in the context of
	// the whole file, so it may use other macros and globals; a macro that uses itself gives no answer.
	function objectMacroType(name)
	{
		var macro = A.macros[name];
		if (!macro || macro.fn || !macro.body || /#/.test(macro.body) || AN_MACRO_DEPTH > 4) { return null; }
		var sharedKey = 'object|' + name + '|' + macro.body + '|' + contextFingerprint();
		if (Object.prototype.hasOwnProperty.call(AN_MACRO_CACHE, sharedKey)) { return AN_MACRO_CACHE[sharedKey]; }
		var found = probeType(macro.body, null, null);
		if (AN_MACRO_CACHE_SIZE > 2000) { AN_MACRO_CACHE = {}; AN_MACRO_CACHE_SIZE = 0; }
		AN_MACRO_CACHE[sharedKey] = found;
		AN_MACRO_CACHE_SIZE++;
		return found;
	}
	an.macroCallType = macroCallType;
	an.objectMacroType = objectMacroType;
}

// A.parseExpr: the expression parser and typer
function anAddParser(an)
{
	var A = an.A;
	var resolveType = an.resolveType;
	var T = an.T;
	var txt = an.txt;
	var nSig = an.nSig;
	var macroCallType = an.macroCallType;
	var objectMacroType = an.objectMacroType;
	var BIN = { '||': 3, '&&': 4, '|': 5, '^': 6, '&': 7, '==': 8, '!=': 8, '<': 9, '>': 9, '<=': 9, '>=': 9, '<<': 10, '>>': 10, '+': 11, '-': 11, '*': 12, '/': 12, '%': 12 };
	var ASSIGN = { '=': 1, '+=': 1, '-=': 1, '*=': 1, '/=': 1, '%=': 1, '&=': 1, '|=': 1, '^=': 1, '<<=': 1, '>>=': 1 };

	// Parse an expression starting at sig index p. Returns { node, next } where next is the sig
	// index after the expression, or null on failure. node = { kind, from, to, type, ... }.
	A.parseExpr = function (p)
	{
		var noComma = true;

		function primary(p)
		{
			var t = T(p);
			if (!t) { return null; }
			if (t.type === 'number')
			{
				var ty = /^0[xX]/.test(t.text) ? (/[uU]$/.test(t.text) ? 'uint' : 'int')
					: (/[.eE]/.test(t.text) || /[fF]$/.test(t.text)) ? 'float' : (/[uU]$/.test(t.text) ? 'uint' : 'int');
				return { node: { kind: 'num', from: p, to: p, type: ty }, next: p + 1 };
			}
			if (t.type === 'punct' && t.text === '(')
			{
				var inner = parseAssign(p + 1);
				if (inner && txt(inner.next) === ',')
				{
					var items = [inner.node];
					while (txt(inner.next) === ',')
					{
						inner = parseAssign(inner.next + 1);
						if (!inner) { return null; }
						items.push(inner.node);
					}
					inner.node = { kind: 'sequence', from: items[0].from, to: inner.node.to, type: inner.node.type, items: items };
				}
				if (!inner || txt(inner.next) !== ')') { return null; }
				return { node: { kind: 'paren', from: p, to: inner.next, type: inner.node.type, child: inner.node }, next: inner.next + 1 };
			}
			if (t.type === 'punct' && t.text === '{')
			{
				// initializer list
				var q = p + 1, items = [];
				while (txt(q) !== '}' && q < nSig)
				{
					var it = parseAssign(q);
					if (!it) { return null; }
					items.push(it.node);
					q = it.next;
					if (txt(q) === ',') { q++; }
				}
				return { node: { kind: 'initlist', from: p, to: q, type: null, items: items }, next: q + 1 };
			}
			if (t.type === 'ident')
			{
				var name = t.text;
				if (name === 'true' || name === 'false') { return { node: { kind: 'num', from: p, to: p, type: 'bool' }, next: p + 1 }; }
				if (txt(p + 1) === '(')
				{
					var args = [], q2 = p + 2;
					while (txt(q2) !== ')')
					{
						if (q2 >= nSig) { return null; }
						var a = parseAssign(q2);
						if (!a) { return null; }
						args.push(a.node);
						q2 = a.next;
						if (txt(q2) === ',') { q2++; }
						else if (txt(q2) !== ')') { return null; }
					}
					var argTypes = args.map(function (n) { return n.type; });
					var rt = null;
					var resolved = resolveType(name);
					if (anParseType(resolved) || A.structs[resolved]) { rt = resolved; }
					else if (A.functions[name]) { rt = A.functions[name][0].ret; }
					else if (A.macros[name] && A.macros[name].fn) { rt = macroCallType(name, argTypes); }
					else { rt = anBuiltinType(name, argTypes); }
					var call = { kind: 'call', name: name, from: p, to: q2, type: rt, args: args, open: p + 1 };
					// a constructor written with a macro that stands for a type says which type it builds
					if (resolved !== name && rt === resolved) { call.ctor = resolved; }
					return { node: call, next: q2 + 1 };
				}
				// identifier
				var vt = A.lookup(name, p);
				if (vt === null && AN_KNOWN_GLOBALS[name]) { vt = AN_KNOWN_GLOBALS[name]; }
				if (vt === null && A.macros[name] && !A.macros[name].fn)
				{
					var mm = A.macros[name];
					if (mm.type === undefined)
					{
						mm.type = null;                          // a macro that uses itself gives no answer
						mm.type = objectMacroType(name);
					}
					vt = mm.type;
				}
				return { node: { kind: 'ident', name: name, from: p, to: p, type: vt }, next: p + 1 };
			}
			return null;
		}

		function postfix(p)
		{
			var r = primary(p);
			if (!r) { return null; }
			while (true)
			{
				var s = txt(r.next);
				if (s === '.')
				{
					var f = T(r.next + 1);
					if (!f || f.type !== 'ident') { return null; }
					var bt = r.node.type, rt = null;
					var pt = bt && anParseType(bt);
					if (pt && /^[xyzwrgba]+$/.test(f.text) && f.text.length <= 4) { rt = anVec(pt.base, f.text.length); }
					else if (bt && A.structs[bt]) { rt = A.structs[bt].fields[f.text] || null; }
					r = { node: { kind: 'member', from: r.node.from, to: r.next + 1, type: rt, base: r.node, field: f.text }, next: r.next + 2 };
				}
				else if (s === '[')
				{
					var ix = parseAssign(r.next + 1);
					if (!ix || txt(ix.next) !== ']') { return null; }
					var bt2 = r.node.type, rt2 = null;
					if (bt2 && /\[\]$/.test(bt2)) { rt2 = bt2.replace(/\[\]$/, ''); }
					else { var pt2 = bt2 && anParseType(bt2); if (pt2 && pt2.kind === 'mat') { rt2 = anVec('float', pt2.cols); } else if (pt2 && pt2.kind === 'vec') { rt2 = pt2.base; } }
					r = { node: { kind: 'index', from: r.node.from, to: ix.next, type: rt2, base: r.node, index: ix.node }, next: ix.next + 1 };
				}
				else if (s === '++' || s === '--')
				{
					r = { node: { kind: 'postinc', from: r.node.from, to: r.next, type: r.node.type, child: r.node }, next: r.next + 1 };
				}
				else { break; }
			}
			return r;
		}

		function unary(p)
		{
			var s = txt(p);
			// Intermediate ReShade FX includes numeric casts emitted by the porter.
			// Parse them before treating '(' as an ordinary grouped expression.
			var castType = s === '(' && txt(p + 2) === ')' && resolveType(txt(p + 1));
			if (castType && anParseType(castType))
			{
				var operand = unary(p + 3);
				if (!operand) { return null; }
				return { node: { kind: 'cast', from: p, to: operand.node.to, type: castType, child: operand.node }, next: operand.next };
			}
			if (s === '-' || s === '+' || s === '!' || s === '~' || s === '++' || s === '--')
			{
				var r = unary(p + 1);
				if (!r) { return null; }
				var ty = s === '!' ? 'bool' : r.node.type;
				return { node: { kind: 'unary', op: s, from: p, to: r.node.to, type: ty, child: r.node }, next: r.next };
			}
			return postfix(p);
		}

		function binary(p, minPrec)
		{
			var left = unary(p);
			if (!left) { return null; }
			while (true)
			{
				var op = txt(left.next);
				var prec = BIN[op];
				if (prec === undefined || prec < minPrec) { break; }
				var right = binary(left.next + 1, prec + 1);
				if (!right) { return null; }
				left = { node: { kind: 'binary', op: op, from: left.node.from, to: right.node.to, type: anBinaryType(op, left.node.type, right.node.type), left: left.node, right: right.node, opTok: left.next }, next: right.next };
			}
			return left;
		}

		function parseTernary(p)
		{
			var c = binary(p, 3);
			if (!c) { return null; }
			if (txt(c.next) === '?')
			{
				var a = parseAssign(c.next + 1);
				if (!a || txt(a.next) !== ':') { return null; }
				var b = parseTernary(a.next + 1);
				if (!b) { return null; }
				var ty = a.node.type || b.node.type;
				return { node: { kind: 'ternary', from: c.node.from, to: b.node.to, type: ty, cond: c.node, a: a.node, b: b.node }, next: b.next };
			}
			return c;
		}

		function parseAssign(p)
		{
			var l = parseTernary(p);
			if (!l) { return null; }
			var op = txt(l.next);
			if (ASSIGN[op])
			{
				var r = parseAssign(l.next + 1);
				if (!r) { return null; }
				return { node: { kind: 'assign', op: op, from: l.node.from, to: r.node.to, type: l.node.type, left: l.node, right: r.node }, next: r.next };
			}
			return l;
		}

		var res = parseAssign(p);
		return res;
	};
}

// A.eachExpression: every expression of the file-scope initialisers and function bodies
function anAddWalker(an)
{
	var A = an.A;
	var txt = an.txt;
	var T = an.T;
	var matchClose = an.matchClose;
	var isTypeName = an.isTypeName;
	var QUALS = an.QUALS;
	// ── statement walker: calls cb(rootNode) for every file-scope initializer and, inside function
	//    bodies, every expression statement / initializer / condition / return value ──
	A.parseFailures = 0;
	A.eachExpression = function (cb)
	{
		function skipToSemicolon(j, end)
		{
			var d = 0;
			while (j < end)
			{
				var s = txt(j);
				if (s === '(' || s === '[' || s === '{') { d++; }
				else if (s === ')' || s === ']' || s === '}') { d--; }
				else if (s === ';' && d <= 0) { return j; }
				j++;
			}
			return end;
		}
		function exprList(j, end)
		{
			// one or more comma-separated expressions starting at j; returns index after them
			while (j < end)
			{
				var r = A.parseExpr(j);
				if (!r) { A.parseFailures++; return skipToSemicolon(j, end); }
				cb(r.node);
				j = r.next;
				if (txt(j) === ',') { j++; continue; }
				break;
			}
			return j;
		}
		function declList(q, end)
		{
			// after the type name: name [array] [= init] {, name ...}
			while (q < end)
			{
				if (!T(q) || T(q).type !== 'ident') { return skipToSemicolon(q, end); }
				q++;
				while (txt(q) === '[') { var c = matchClose(q, '[', ']'); if (c < 0) { return end; } q = c + 1; }
				if (txt(q) === '=')
				{
					var r = A.parseExpr(q + 1);
					if (!r) { A.parseFailures++; return skipToSemicolon(q, end); }
					cb(r.node);
					q = r.next;
				}
				if (txt(q) === ',') { q++; continue; }
				break;
			}
			return q;
		}
		function walk(j, end)
		{
			while (j < end)
			{
				var s = txt(j);
				if (s === ';' || s === '{' || s === '}' || s === 'else' || s === 'do') { j++; continue; }
				// HLSL statement attributes precede the statement rather than forming an
				// expression. In particular, the porter's conditional [loop] hints must
				// not make later passes skip every texture lookup inside that loop.
				if (s === '[' && /^(?:loop|unroll|fastopt|flatten|branch|allow_uav_condition)$/.test(txt(j + 1)))
				{
					var attributeEnd = matchClose(j, '[', ']');
					if (attributeEnd >= 0) { j = attributeEnd + 1; continue; }
				}
				if (s === 'break' || s === 'continue' || s === 'discard') { j++; continue; }
				if (s === 'for' && txt(j + 1) === '(')
				{
					var hc = matchClose(j + 1, '(', ')');
					if (hc < 0) { return; }
					var q = j + 2;
					var qq = q;
					while (QUALS[txt(qq)]) { qq++; }
					if (isTypeName(txt(qq)) && T(qq + 1) && T(qq + 1).type === 'ident') { q = declList(qq + 1, hc); }
					else if (txt(q) !== ';') { q = exprList(q, hc); }
					if (txt(q) === ';') { q++; }
					if (txt(q) !== ';') { q = exprList(q, hc); }
					if (txt(q) === ';') { q++; }
					if (q < hc) { exprList(q, hc); }
					j = hc + 1;
					continue;
				}
				if ((s === 'if' || s === 'while' || s === 'switch') && txt(j + 1) === '(')
				{
					var pc = matchClose(j + 1, '(', ')');
					if (pc < 0) { return; }
					exprList(j + 2, pc);
					j = pc + 1;
					continue;
				}
				if (s === 'return')
				{
					if (txt(j + 1) === ';') { j++; continue; }
					j = exprList(j + 1, end);
					continue;
				}
				if (s === 'case' || s === 'default')
				{
					while (j < end && txt(j) !== ':') { j++; }
					j++;
					continue;
				}
				var q2 = j;
				while (QUALS[txt(q2)]) { q2++; }
				if (isTypeName(txt(q2)) && T(q2 + 1) && T(q2 + 1).type === 'ident' && txt(q2 + 2) !== '(')
				{
					j = declList(q2 + 1, end);
					continue;
				}
				j = exprList(j, end);
				if (j < end && txt(j) !== ';' && txt(j) !== '}' && txt(j) !== '{') { A.parseFailures++; j = skipToSemicolon(j, end); }
			}
		}
		// file-scope initialisers:  static float2 res = float2(0);
		A.globalInits.forEach(function (at)
		{
			var r = A.parseExpr(at);
			if (!r) { A.parseFailures++; return; }
			cb(r.node);
		});
		Object.keys(A.functions).forEach(function (name)
		{
			A.functions[name].forEach(function (fn)
			{
				if (fn.bodyFrom === undefined) { return; }
				walk(fn.bodyFrom + 1, fn.bodyTo);
			});
		});
	};

	// true if the node sits in a literally dead preprocessor branch
}

// A.isDead, charStart, charEnd, textOf
function anAddHelpers(an)
{
	var A = an.A;
	var tokens = an.tokens;
	var sigIdx = an.sig;
	var src = an.src;
	A.isDead = function (node) { return !!tokens[sigIdx[node.from]].dead; };

	// char range helpers
	A.charStart = function (node) { return tokens[sigIdx[node.from]].start; };
	A.charEnd = function (node) { return tokens[sigIdx[node.to]].end; };

	// Convenience: char range of an expression node in the source text
	A.textOf = function (node) { return src.slice(tokens[sigIdx[node.from]].start, tokens[sigIdx[node.to]].end); };
}

function analyzeSource(src)
{
	var an = { src: src };
	anTokenize(an);
	anScanMacros(an);
	anMakeHelpers(an);
	anScanTopLevel(an);
	anScanLocals(an);
	anAddLookup(an);
	anAddMacroTyping(an);
	anAddParser(an);
	anAddWalker(an);
	anAddHelpers(an);
	return an.A;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rewrite expressions using the analyzer's expression trees.
//
// rewriteHere(node, render) is called for every node. It returns replacement text for
// that node, or null to keep it. render(child) gives a child's text with all rewrites
// inside it already applied, so nested rewrites compose and operator precedence comes
// from the tree instead of from scanning text. Text between rewrites (comments,
// whitespace) is preserved exactly.
//
// Returns { src, edits, parseFailures }. parseFailures counts expressions the parser could
// not read; those are left untouched.
// ─────────────────────────────────────────────────────────────────────────────

var EXPR_CHILD_KEYS = ['child', 'left', 'right', 'base', 'index', 'cond', 'a', 'b'];

function exprChildren(node)
{
	var out = [];
	EXPR_CHILD_KEYS.forEach(function (key)
	{
		if (node[key] && typeof node[key] === 'object' && node[key].kind) { out.push(node[key]); }
	});
	['args', 'items'].forEach(function (key)
	{
		if (node[key]) { node[key].forEach(function (child) { out.push(child); }); }
	});
	return out.sort(function (x, y) { return x.from - y.from; });
}

function rewriteExpressions(src, rewriteHere)
{
	var A = analyzeSource(src);
	var edits = [];

	function applyEdits(text, list)
	{
		list.sort(function (x, y) { return y.a - x.a; }).forEach(function (e)
		{
			text = text.slice(0, e.a) + e.text + text.slice(e.b);
		});
		return text;
	}

	// A rewrite that replaces a binary or assignment node discards whatever sat between its
	// operands, apart from the operator. Keep comments (and the porter's comment
	// placeholders) found there by appending them after the replacement.
	function keptComments(node)
	{
		var kept = [];
		function keep(from, to)
		{
			for (var i = from; i < to; i++)
			{
				var token = A.tokens[i];
				if (token.type === 'placeholder' || (token.type === 'comment' && token.text.indexOf('/*') === 0)) { kept.push(token.text); }
				else if (token.type === 'comment') { kept.push('/*' + token.text.slice(2).replace(/\*\//g, '* /') + ' */'); }
			}
		}
		if (node.kind === 'binary' || node.kind === 'assign') { keep(A.sig[node.left.to] + 1, A.sig[node.right.from]); }
		else if (node.kind === 'call')
		{
			// between the parentheses but outside every argument
			var cursor = A.sig[node.open] + 1;
			node.args.forEach(function (arg)
			{
				keep(cursor, A.sig[arg.from]);
				cursor = A.sig[arg.to] + 1;
			});
			keep(cursor, A.sig[node.to]);
		}
		return kept.join(' ');
	}

	function render(node)
	{
		var own = rewriteHere(node, render);
		if (own !== null)
		{
			var kept = keptComments(node);
			return kept ? own + ' ' + kept : own;
		}
		var base = A.charStart(node);
		var original = src.slice(base, A.charEnd(node));
		var local = [];
		exprChildren(node).forEach(function (child)
		{
			var text = render(child);
			var childOriginal = src.slice(A.charStart(child), A.charEnd(child));
			if (text !== childOriginal) { local.push({ a: A.charStart(child) - base, b: A.charEnd(child) - base, text: text }); }
		});
		return applyEdits(original, local);
	}

	A.eachExpression(function (root)
	{
		var text = render(root);
		if (text !== src.slice(A.charStart(root), A.charEnd(root))) { edits.push({ a: A.charStart(root), b: A.charEnd(root), text: text }); }
	});
	return { src: applyEdits(src, edits.slice()), edits: edits.length, parseFailures: A.parseFailures + (A.ok ? 0 : 1) };
}

if (typeof module !== 'undefined') { module.exports = { analyzeSource: analyzeSource, anParseType: anParseType, rewriteExpressions: rewriteExpressions }; }
