// ═════════════════════════════════════════════════════════════════════════════
// VERSION
// ═════════════════════════════════════════════════════════════════════════════

var PORTER_VERSION = '3.0.62';

// ═════════════════════════════════════════════════════════════════════════════
// ANALYSIS PASS  — detect issues before transformation
// ═════════════════════════════════════════════════════════════════════════════

function analyzeShader(src, messages) {
	if (!/\b(?:mainImage|mainCubemap)\b/.test(src)) {
		messages.push({ level: 'error', text: 'No mainImage() found. Is this an Image tab shader?' });
	}
	if (/\bmainSound\s*\(/.test(src)) {
		messages.push({ level: 'error', text: 'Sound shader entry point detected (mainSound). Sound is not supported in ReShade.' });
	}
	if (/#version\b/.test(src)) {
		messages.push({ level: 'info', text: '#version directive removed (not used in HLSL / ReShade FX).' });
	}
	if (/\bprecision\s+(highp|mediump|lowp)\b/.test(src)) {
		messages.push({ level: 'info', text: 'GLSL precision qualifiers removed (not applicable in HLSL).' });
	}
	if (/\blayout\s*\(/.test(src)) {
		messages.push({ level: 'warn', text: 'GLSL layout qualifier found and removed. Verify no semantics were lost.' });
	}
	if (/\bgl_FragDepth\b/.test(src)) {
		messages.push({ level: 'warn', text: 'gl_FragDepth is not supported in ReShade pixel shaders. Remove or replace manually.' });
	}
	if (/\bgl_FrontFacing\b/.test(src)) {
		messages.push({ level: 'warn', text: 'gl_FrontFacing is not supported in ReShade pixel shaders. Remove or replace manually.' });
	}
	if (/\bpow\s*\(/.test(src)) {
		messages.push({ level: 'info', text: 'pow(f, e) is undefined for negative f in HLSL (X3571). If you see visual artifacts, consider wrapping the base with abs().' });
	}
	if (/\bmat[234]\b|\bfloat[234]x[234]\b/.test(src)) {
		messages.push({ level: 'warn', text: 'Matrix type(s) detected. GLSL is column-major (M*v), HLSL is row-major (v*M). Review matrix math and mul() calls manually.' });
	}
	if (/\batan\s*\([^,)]+,[^)]+\)/.test(src)) {
		messages.push({ level: 'info', text: 'Two-argument atan(y,x) detected and rewritten to atan2(y,x).' });
	}

}

// ═════════════════════════════════════════════════════════════════════════════
// DETECT referenced uniforms and channels
// ═════════════════════════════════════════════════════════════════════════════

function detectUniforms(src, usedUniforms) {
	var keywords =
		[
			'iResolution', 'iTime', 'iTimeDelta', 'iFrameRate', 'iFrame',
			'iDate', 'iMouse', 'iSampleRate', 'iChannelTime', 'iChannelResolution',
			'iChannel0', 'iChannel1', 'iChannel2', 'iChannel3'
		];
	keywords.forEach(function (u) {
		if (new RegExp('\\b' + u + '\\b').test(src)) {
			usedUniforms.add(u);
		}
	});
}

function detectChannelUse(src) {
	var used = [];
	for (var i = 0; i < 4; i++) {
		if (new RegExp('\\biChannel' + i + '\\b').test(src)) {
			used.push(i);
		}
	}
	return used;
}

// ═════════════════════════════════════════════════════════════════════════════
// GLSL → HLSL TEXT TRANSFORMATION
// ═════════════════════════════════════════════════════════════════════════════

// The superscript digits that number the comment placeholders («⁰», «¹» ...)
var COMMENT_DIGITS = '⁰¹²³⁴⁵⁶⁷⁸⁹';

// texture() / texture2D() → tex2D()
// Uses a paren-balanced walker to split args correctly — prevents [^)]+ from
// spanning newlines and consuming code beyond the call site.
function rewriteTextureCalls(src)
{
	var result = [];
	var last = 0;
	var re = /\b(texture2D|texture)\s*\(/g;
	var match;
	while ((match = re.exec(src)) !== null) {
		var fnName = match[1];
		var parenOpen = match.index + match[0].length - 1;
		// Walk to matching close paren, collecting top-level comma positions
		var depth = 1;
		var k = parenOpen + 1;
		var commaPositions = [];
		while (k < src.length && depth > 0) {
			if (src[k] === '(') { depth++; }
			else if (src[k] === ')') { depth--; }
			else if (src[k] === ',' && depth === 1) { commaPositions.push(k); }
			k++;
		}
		// k points just past closing ')'
		var inner = src.slice(parenOpen + 1, k - 1);
		var replacement;
		if (commaPositions.length >= 2) {
			// 3+ args: strip everything after second comma (bias arg)
			var arg1 = src.slice(parenOpen + 1, commaPositions[0]).trim();
			var arg2 = src.slice(commaPositions[0] + 1, commaPositions[1]).trim();
			replacement = 'tex2D(' + arg1 + ', ' + arg2 + ')';
		}
		else {
			// 1 or 2 args: simple rename
			replacement = 'tex2D(' + inner + ')';
		}
		result.push(src.slice(last, match.index));
		result.push(replacement);
		last = k;
		re.lastIndex = last;
	}
	result.push(src.slice(last));
	return result.join('');
}

// textureLod(s, uv, lod) → tex2Dlod(s, float4(uv, 0, lod))
function rewriteTextureLod(src)
{
	var result = [];
	var last = 0;
	var re = /\btextureLod\s*\(/g;
	var m;
	while ((m = re.exec(src)) !== null) {
		var parsed = splitCallArgs(src, m.index + m[0].length - 1);
		if (!parsed || parsed.args.length < 2) { continue; }
		result.push(src.slice(last, m.index));
		result.push('tex2Dlod(' + parsed.samp + ', float4(' + parsed.args[0] + ', 0.0, ' + parsed.args[1] + '))');
		last = parsed.end;
		re.lastIndex = last;
	}
	result.push(src.slice(last));
	return result.join('');
}

	// ── Rewrite gradient texture instructions inside loops ────────────────────
	// tex2D / tex3D / texCUBE are gradient instructions. The HLSL compiler tries
	// to unroll any loop containing one; if it cannot it fails with X3511/X3570.
	// Rewrite to explicit-LOD equivalents (not gradient instructions):
	//   tex2D(samp, uv)                    → tex2Dlod(samp, float4(uv, 0.0, 0.0))
	//   tex3D(samp, uvw)                   → tex3Dlod(samp, float4(uvw, 0.0))
	//   texCUBE(samp, uvw)                 → texCUBElod(samp, float4(uvw, 0.0))
	//   tex2Dbias(samp, float4(uv,0,bias)) → tex2Dlod(samp, float4(uv,0,bias))
	// tex2Dgrad already provides explicit gradients — left alone.
	// Only applied inside loop bodies. Runs before comment restore.
function rewriteLoopGradientTex(src, messages)
{
	var loopGradCount = 0;
	// Table of gradient instructions to rewrite.
	// fn: original function name (regex-escaped)
	// argCount: number of top-level comma-separated args
	// rewrite(samp, args): returns replacement string
	var gradFns = [
		{
			re: /\btex2D\s*\(/g,
			rewrite: function (samp, args) {
				// tex2D(samp, uv) — uv is args[0]
				if (args.length < 1) { return null; }
				return 'tex2Dlod(' + samp + ', float4(' + args[0] + ', 0.0, 0.0))';
			}
		},
		{
			re: /\btex3D\s*\(/g,
			rewrite: function (samp, args) {
				// tex3D(samp, uvw) — uvw is args[0]
				if (args.length < 1) { return null; }
				return 'tex3Dlod(' + samp + ', float4(' + args[0] + ', 0.0))';
			}
		},
		{
			re: /\btexCUBE\s*\(/g,
			rewrite: function (samp, args) {
				// texCUBE(samp, uvw) — uvw is args[0]
				if (args.length < 1) { return null; }
				return 'texCUBElod(' + samp + ', float4(' + args[0] + ', 0.0))';
			}
		},
		{
			re: /\btex2Dbias\s*\(/g,
			rewrite: function (samp, args) {
				// tex2Dbias(samp, float4(uv, 0, bias)) — already float4, just rename
				if (args.length < 1) { return null; }
				return 'tex2Dlod(' + samp + ', ' + args[0] + ')';
			}
		}
	];

	// Split args at top-level commas inside an already-opened paren.
	// parenOpen: index of '(' in b; returns { args, end } where end is just past ')'
	function splitArgs(b, parenOpen) {
		var args = [];
		var depth = 1;
		var k = parenOpen + 1;
		var segStart = k;
		// First arg is the sampler — find first top-level comma
		var sampEnd = -1;
		while (k < b.length && depth > 0) {
			if (b[k] === '(') { depth++; }
			else if (b[k] === ')') { depth--; }
			else if (b[k] === ',' && depth === 1 && sampEnd === -1) {
				sampEnd = k;
				segStart = k + 1;
			}
			k++;
		}
		// k now points just past closing ')'
		if (sampEnd === -1) { return null; } // no comma — can't split samp from args
		var samp = b.slice(parenOpen + 1, sampEnd).trim();
		var remainingArgs = [];
		// Split remaining args (everything after first comma) at top-level commas
		var rem = b.slice(segStart, k - 1);
		var d2 = 0;
		var start = 0;
		for (var ri = 0; ri < rem.length; ri++) {
			if (rem[ri] === '(' || rem[ri] === '[') { d2++; }
			else if (rem[ri] === ')' || rem[ri] === ']') { d2--; }
			else if (rem[ri] === ',' && d2 === 0) {
				remainingArgs.push(rem.slice(start, ri).trim());
				start = ri + 1;
			}
		}
		remainingArgs.push(rem.slice(start).trim());
		return { samp: samp, args: remainingArgs, end: k };
	}

	var result = [];
	var last = 0;
	var loopRe = /\b(for|while)\s*\(/g;
	var lm;
	while ((lm = loopRe.exec(src)) !== null) {
		// Walk to end of loop header closing paren
		var depth = 1;
		var k = lm.index + lm[0].length;
		while (k < src.length && depth > 0) {
			if (src[k] === '(') { depth++; }
			else if (src[k] === ')') { depth--; }
			k++;
		}
		// Skip whitespace to find opening brace of body
		var bodyStart = k;
		while (bodyStart < src.length && /\s/.test(src[bodyStart])) { bodyStart++; }
		if (src[bodyStart] !== '{') { continue; }

		// Walk to matching closing brace
		depth = 1;
		var j = bodyStart + 1;
		while (j < src.length && depth > 0) {
			if (src[j] === '{') { depth++; }
			else if (src[j] === '}') { depth--; }
			j++;
		}
		var bodyEnd = j;
		var body = src.slice(bodyStart, bodyEnd);

		// Quick check — skip if no gradient instructions present
		if (!/\b(tex2D|tex3D|texCUBE|tex2Dbias)\s*\(/.test(body)) { continue; }

		// Apply each gradient function rewrite to the body
		var newBody = body;
		gradFns.forEach(function (gf) {
			var r2 = [];
			var l2 = 0;
			var re2 = new RegExp(gf.re.source, 'g');
			var tm;
			while ((tm = re2.exec(newBody)) !== null) {
				var parenOpen = tm.index + tm[0].length - 1;
				var split = splitArgs(newBody, parenOpen);
				if (!split) { continue; }
				var replacement = gf.rewrite(split.samp, split.args);
				if (!replacement) { continue; }
				r2.push(newBody.slice(l2, tm.index));
				r2.push(replacement);
				l2 = split.end;
				re2.lastIndex = l2;
				loopGradCount++;
			}
			r2.push(newBody.slice(l2));
			newBody = r2.join('');
		});

		result.push(src.slice(last, bodyStart));
		result.push(newBody);
		last = bodyEnd;
		loopRe.lastIndex = last;
	}
	result.push(src.slice(last));
	var rewritten = result.join('');
	if (loopGradCount > 0) {
		messages.push({
			level: 'info', text:
				loopGradCount + ' gradient texture call(s) inside loop(s) rewritten to explicit-LOD equivalents (tex2Dlod/tex3Dlod/texCUBElod) to prevent compiler unroll errors (X3511/X3570).'
		});
	}
	return rewritten;
}

function stepExtractComments(ctx)
{
	var s = ctx.src;
	// ── Extract comments before any transforms so we never mangle them ────────
	var xSuperDigits = COMMENT_DIGITS;
	var xComments = ctx.comments;
	function xMakePH(i) {
		var s = '';
		var n = i;
		do { s = xSuperDigits[n % 10] + s; n = Math.floor(n / 10); } while (n > 0);
		return '«' + s + '»';
	}

	// Block comments first, then line comments
	s = s.replace(/\/\*[\s\S]*?\*\//g, function (m) {
		xComments.push(m);
		return xMakePH(xComments.length - 1);
	});
	s = s.replace(/\/\/[^\n]*/g, function (m) {
		xComments.push(m);
		return xMakePH(xComments.length - 1) + '\n';
	});
	ctx.src = s;
}

function stepRemoveDirectives(ctx)
{
	var s = ctx.src;
	// ── Remove directives not valid in HLSL ──────────────────────────────────
	s = s.replace(/#version\s+\d+[^\n]*/g, '');
	s = s.replace(/\blayout\s*\([^)]*\)\s*/g, '');
	ctx.src = s;
}

function stepPrecision(ctx)
{
	var s = ctx.src;
	// ── Precision statements and qualifiers ──────────────────────────────────
	s = s.replace(/^[ \t]*precision\s+(?:highp|mediump|lowp)\s+\w+\s*;[ \t]*\n?/gm, '');
	s = s.replace(/\b(highp|mediump|lowp)\s+/g, '');
	ctx.src = s;
}

function stepGlFragCoord(ctx)
{
	var s = ctx.src;
	// ── GLSL built-in variables ───────────────────────────────────────────────
	// gl_FragCoord is a global in GLSL, readable from any function; the entry point fills in ST_FragCoord
	var usesGlFragCoord = /\bgl_FragCoord\b/.test(s);
	s = s.replace(/\bgl_FragCoord\b/g, 'ST_FragCoord');
	ctx.usesGlFragCoord = usesGlFragCoord;
	ctx.src = s;
}

function stepUniformRedeclarations(ctx)
{
	var s = ctx.src;
	// ── Remove shadertoy-style uniform re-declarations ────────────────────────
	s = s.replace(/uniform\s+\S+\s+i(Resolution|Time|TimeDelta|Frame|Date|Mouse|Channel[0-3])\s*;[^\n]*/g, '');
	ctx.src = s;
}

function stepFloatSuffix(ctx)
{
	var s = ctx.src;
	// ── Strip trailing f suffix from float literals (1.0f → 1.0) ────────────
	s = s.replace(/(\d*\.\d+|\d+\.\d*)f\b/g, '$1');
	ctx.src = s;
}

function stepTypeNames(ctx)
{
	var s = ctx.src;
	// ── Inline type replacements (no #define needed) ──────────────────────────
	s = s.replace(/\bvec([234])\b/g, 'float$1');
	s = s.replace(/\bivec([234])\b/g, 'int$1');
	s = s.replace(/\buvec([234])\b/g, 'uint$1');
	s = s.replace(/\bbvec([234])\b/g, 'bool$1');
	s = s.replace(/\bmat([234])x([234])\b/g, 'float$1x$2');
	s = s.replace(/\bmat([234])\b/g, 'float$1x$1');
	ctx.src = s;
}

function stepStructConstructors(ctx)
{
	var s = ctx.src;
	var messages = ctx.messages;
	// ── Struct constructor syntax: Name(a,b,c) → Name_ctor(a,b,c) ────────────
	// HLSL has no positional struct constructors. Generate a helper function for
	// each struct that is used as a constructor and rename all call sites.
	// Must run after type replacements so member types are already in HLSL form.
	s = rewriteStructConstructors(s, messages);
	ctx.src = s;
}

function stepIntrinsicNames(ctx)
{
	var s = ctx.src;
	// ── Inline intrinsic replacements ─────────────────────────────────────────
	s = s.replace(/\bmix\s*\(/g, 'lerp(');
	s = s.replace(/\bfract\s*\(/g, 'frac(');
	s = s.replace(/\binversesqrt\s*\(/g, 'rsqrt(');
	s = s.replace(/\bdFdx\s*\(/g, 'ddx(');
	s = s.replace(/\bdFdy\s*\(/g, 'ddy(');
	ctx.src = s;
}

function stepReservedIdentifiers(ctx)
{
	var s = ctx.src;
	var messages = ctx.messages;
	// ── Rename ReShade FX / HLSL reserved words used as identifiers in GLSL ──
	s = renameReservedIdentifiers(s, messages);
	ctx.src = s;
}

function stepSplitGlobalDeclarators(ctx)
{
	var s = ctx.src;
	var messages = ctx.messages;
	// several variables in one global declaration: one declaration per variable
	s = splitGlobalDeclarators(s, messages);
	var globals = fileScopeTokenOffsets(s);
	s = s.replace(/;[ \t]*(?=\S)/g, function (match, offset) { return globals[offset] ? ';\n' : match; });
	ctx.src = s;
}

function stepUnsignedFloatConstants(ctx)
{
	function rewrite(text)
	{
		var tokens = tokenizeSource(text);
		var strings = tokens.filter(function (t) { return t.type === 'string' || t.type === 'preproc'; });
		var quoted = /"(?:\\[\s\S]|[^"\\])*"/g, quotedMatch;
		while ((quotedMatch = quoted.exec(text))) { strings.push({ start: quotedMatch.index, end: quoted.lastIndex }); }
		text = text.replace(/\b(float[234]?(?:x[234])?)\s*\(\s*(0[xX][\da-fA-F]+|\d+)[uU]\s*\)/g, function (match, type, digits, offset)
		{
			if (strings.some(function (t) { return offset >= t.start && offset < t.end; })) { return match; }
			var value = Number(digits);
			// ReShade's constant folder treats high uint values as signed when casting to float.
			return value > 2147483647 && value <= 4294967295 ? type + '(' + value + '.0)' : match;
		});
		return text;
	}
	ctx.src = tokenizeSource(ctx.src).map(function (t)
	{
		if (t.type === 'preproc')
		{
			var m = /^(#\s*define\s+\w+(?:\([^)]*\))?\s+)([\s\S]*)$/.exec(t.text);
			return m ? m[1] + rewrite(m[2]) : t.text;
		}
		return t.text;
	}).join('');
	ctx.src = rewrite(ctx.src);
}

function stepCompatibilityMacros(ctx)
{
	// ReShade's preprocessor can drop a bare identifier that also names a function macro.
	// Give variables distinct names while retaining macro calls and directive names.
	var macroVariables = Object.create(null);
	var declaredVariables = Object.create(null);
	analyzeSource(ctx.src).decls.forEach(function (d) { declaredVariables[d.name] = true; });
	tokenizeSource(ctx.src).forEach(function (t)
	{
		var m = t.type === 'preproc' && /^#\s*define\s+([A-Za-z_]\w*)\(/.exec(t.text);
		if (m && declaredVariables[m[1]])
		{
			var name = 'ST_var_' + m[1];
			while (ctx.src.indexOf(name) >= 0) { name += '_'; }
			macroVariables[m[1]] = name;
		}
	});
	function renameBare(text)
	{
		var parts = tokenizeSource(text), quoted = /"(?:\\[\s\S]|[^"\\])*"/g, spans = [], m;
		while ((m = quoted.exec(text))) { spans.push([m.index, quoted.lastIndex]); }
		return parts.map(function (t, i)
		{
			if (t.type !== 'ident' || !macroVariables[t.text] || spans.some(function (s) { return t.start >= s[0] && t.start < s[1]; })) { return t.text; }
			var j = i + 1;
			while (j < parts.length && (parts[j].type === 'ws' || parts[j].type === 'placeholder' || parts[j].type === 'comment')) { j++; }
			return parts[j] && parts[j].text === '(' ? t.text : macroVariables[t.text];
		}).join('');
	}
	ctx.src = tokenizeSource(ctx.src).map(function (t)
	{
		if (t.type !== 'preproc') { return t.text; }
		var m = /^(#\s*define\s+)([\s\S]*)$/.exec(t.text);
		return m ? m[1] + renameBare(m[2]) : t.text;
	}).join('');
	ctx.src = rewriteOutsideDirectives(ctx.src, renameBare);
	// Expose constructors and lookups to the ordinary typed rewrites, including macros
	// that hide them behind other macros. Keep directives for conditional compilation;
	// ambiguous definitions and preprocessor metaprogramming stay with the preprocessor.
	var tokens = tokenizeSource(ctx.src), macros = Object.create(null);
	var conditional = 0, definitionKeys = Object.create(null), conflicts = Object.create(null);
	tokens.forEach(function (t)
	{
		if (t.type !== 'preproc') { return; }
		var branch = /^#\s*(if|ifdef|ifndef|endif)\b/.exec(t.text);
		if (branch) { conditional += branch[1] === 'endif' ? -1 : 1; }
		var m = /^#\s*(define|undef)\s+([A-Za-z_]\w*)(\(([^)]*)\))?([^\n]*)/.exec(t.text.replace(/\\\r?\n/g, ' '));
		if (!m) { return; }
		var body = m[5].replace(/«[⁰¹²³⁴⁵⁶⁷⁸⁹0-9]+»/g, ' ').trim();
		var params = m[3] ? m[4].split(',').map(function (p) { return p.trim(); }).filter(Boolean) : null;
		var key = (m[3] || '') + '|' + tokenizeSource(body).filter(function (t) { return t.type !== 'ws'; }).map(function (t) { return t.text; }).join('');
		if (m[1] === 'undef' || (definitionKeys[m[2]] !== undefined && definitionKeys[m[2]] !== key)) { conflicts[m[2]] = true; }
		definitionKeys[m[2]] = key;
		if (m[1] === 'define' && conditional === 0 && !/#/.test(body) && (!params || params.every(function (p) { return /^[A-Za-z_]\w*$/.test(p); })))
		{
			macros[m[2]] = { body: body, params: params };
		}
	});
	Object.keys(macros).forEach(function (name) { if (conflicts[name]) { delete macros[name]; } });
	var availableMacros = Object.create(null);
	function needsExpansion(name, seen)
	{
		var macro = availableMacros[name];
		if (!macro || seen.indexOf(name) >= 0 || seen.length > 24) { return false; }
		if (/\bmainImage\s*\(/.test(macro.body)) { return true; }
		if (/[{};]/.test(macro.body)) { return true; }
		var bodyTokens = tokenizeSource(macro.body).filter(function (t) { return t.type !== 'ws'; });
		return bodyTokens.some(function (t, i)
		{
			var constructorOrLookup = /^(?:(?:float|int|uint|bool)[234]|texture\w*|texelFetch\w*|tex[23]D\w*|texCUBE\w*)$/.test(t.text);
			var rectangular = /^float([234])x([234])$/.exec(t.text);
			return t.type === 'ident' && (((constructorOrLookup || (rectangular && rectangular[1] !== rectangular[2])) && bodyTokens[i + 1] && bodyTokens[i + 1].text === '(') || needsExpansion(t.text, seen.concat(name)));
		});
	}
	var expansionCount = 0;
	function expand(text, disabled)
	{
		if (disabled.length > 24 || text.length > 200000) { return text; }
		var parts = tokenizeSource(text), out = '';
		for (var i = 0; i < parts.length; i++)
		{
			var t = parts[i], macro = t.type === 'ident' && availableMacros[t.text];
			if (!macro || disabled.indexOf(t.text) >= 0 || !needsExpansion(t.text, [])) { out += t.text; continue; }
			if (++expansionCount > 10000) { out += t.text; continue; }
			var args = [], end = i;
			if (macro.params)
			{
				var open = i + 1;
				while (open < parts.length && (parts[open].type === 'ws' || parts[open].type === 'placeholder')) { open++; }
				if (!parts[open] || parts[open].text !== '(') { out += t.text; continue; }
				var depth = 1, start = open + 1;
				for (end = start; end < parts.length; end++)
				{
					if (parts[end].text === '(') { depth++; }
					else if (parts[end].text === ')') { depth--; }
					if (depth === 0 || (depth === 1 && parts[end].text === ','))
					{
						args.push(parts.slice(start, end).map(function (p) { return p.text; }).join(''));
						start = end + 1;
						if (depth === 0) { break; }
					}
				}
				if (macro.params.length === 0 && args.length === 1 && !args[0].trim()) { args = []; }
				if (depth !== 0 || args.length !== macro.params.length) { out += t.text; continue; }
			}
			var replacements = Object.create(null);
			(macro.params || []).forEach(function (p, index) { replacements[p] = expand(args[index], disabled.concat(t.text)); });
			var body = tokenizeSource(macro.body).map(function (p)
			{
				return p.type === 'ident' && Object.prototype.hasOwnProperty.call(replacements, p.text) ? replacements[p.text] : p.text;
			}).join('');
			out += expand(body, disabled.concat(t.text));
			if (out.length > 200000) { return text; }
			i = end;
		}
		return out;
	}
	// A definition applies only after its directive. In particular, a later function macro
	// must not rewrite a real function declaration or call earlier in the source.
	var output = '', pending = '', level = 0;
	tokens.forEach(function (t)
	{
		if (t.type !== 'preproc') { pending += t.text; return; }
		output += expand(pending, []) + t.text;
		pending = '';
		var branch = /^#\s*(if|ifdef|ifndef|endif)\b/.exec(t.text);
		if (branch) { level += branch[1] === 'endif' ? -1 : 1; }
		var definition = /^#\s*define\s+([A-Za-z_]\w*)/.exec(t.text);
		if (definition && level === 0 && macros[definition[1]]) { availableMacros[definition[1]] = macros[definition[1]]; }
	});
	ctx.src = output + expand(pending, []);
}

function fileScopeTokenOffsets(src)
{
	var offsets = Object.create(null);
	var braces = 0, parens = 0, brackets = 0;
	tokenizeSource(src).forEach(function (t)
	{
		if (t.type === 'ws' || t.type === 'comment' || t.type === 'placeholder' || t.type === 'preproc') { return; }
		if (braces === 0 && parens === 0 && brackets === 0) { offsets[t.start] = true; }
		if (t.text === '{') { braces++; }
		else if (t.text === '}') { braces--; }
		else if (t.text === '(') { parens++; }
		else if (t.text === ')') { parens--; }
		else if (t.text === '[') { brackets++; }
		else if (t.text === ']') { brackets--; }
	});
	return offsets;
}

function stepConstToStaticConst(ctx)
{
	var s = ctx.src;
	// ── const → static const  (file scope only) ───────────────────────────────
	var globals = fileScopeTokenOffsets(s);
	s = s.replace(/^([ ]*)(const\s+)/gm, function (match, indent, kw, offset, str) {
		if (!globals[offset + indent.length]) { return match; }
		return indent + 'static ' + kw;
	});
	ctx.src = s;
}

function stepConstInitialisers(ctx)
{
	var s = ctx.src;
	// ── Replace common const initialisers that use function calls (not valid in HLSL static const) ─
	s = s.replace(/\bstatic\s+const\s+float\s+(\w+)\s*=\s*acos\s*\(\s*-1\.0*\s*\)\s*;/g,
		'static const float $1 = 3.1415927;');
	s = s.replace(/\bstatic\s+const\s+float\s+(\w+)\s*=\s*sqrt\s*\(\s*0?\.5\s*\)\s*;/g,
		'static const float $1 = 0.70710678;');
	ctx.src = s;
}

function stepStaticGlobals(ctx)
{
	var s = ctx.src;
	// ── Mutable file-scope globals need 'static' in HLSL ────────────────────
	// Pass 1: match type declarations at start of line
	var structNames = [];
	s.replace(/\bstruct\s+(\w+)\s*\{/g, function (_, name) { structNames.push(name); return _; });
	var globalTypes = 'float[234x]*|int[234]?|uint[234]?|bool' + structNames.map(function (n) { return '|' + n; }).join('');
	var globals = fileScopeTokenOffsets(s);
	s = s.replace(new RegExp('^([ \\t]*)((?:' + globalTypes + ')\\s+)([a-zA-Z_]\\w*)\\s*(?=[,;=\\s\\[])', 'gm'),
		function (match, indent, type, name, offset, str) {
			if (!globals[offset + indent.length]) { return match; }
			if (/^\s*\(/.test(str.slice(offset + match.length))) { return match; }
			return indent + 'static ' + match.slice(indent.length);
		});
	// Pass 2: handle  ;type  declarations on same line (e.g. float A,D,E;vec3 B,C;)
	globals = fileScopeTokenOffsets(s);
	s = s.replace(/;([ \t]*)(float[234x]*|int[234]?|uint[234]?|bool)(\s+)([a-zA-Z_]\w*)\s*(?=[,;=\s])/gm,
		function (match, indent, type, space, name, offset, str) {
			if (!globals[offset]) { return match; }
			if (/^\s*\(/.test(str.slice(offset + match.length))) { return match; }
			var lineStart = str.lastIndexOf('\n', offset) + 1;
			if (/^\s+/.test(str.slice(lineStart, offset + 1))) { return match; } // indented
			return ';' + indent + 'static ' + type + space + name;
		});
	// ── iTime is kept as-is; assemble.js defines it directly ─────────────────
	ctx.src = s;
}

function stepUnreachableCode(ctx)
{
	var s = ctx.src;
	// ── Remove unreachable statements after return (ReShade FX errors on these) ─
	// A return on the next line may be the fallback after an unbraced if/else/loop.
	// Leave return removal to the token-aware pass below, which checks the statement context.
	// Lone ; before } after a return, where a commented-out statement
	// (placeholder line) sits between them — Yoda-semicolon golf closing brace.
	// Requires at least one placeholder line between return and ;} so we don't
	// eat the ; in normal single-statement functions like {return x;}
	// Note: comment extraction leaves the original \n AND appends one, giving \n\n.
	// The ; prefix on the commented-out line stays in source as ;«N»
	s = s.replace(
		/(\breturn\b[^\n;{}]+;?)\n(\n?(?:\s*;?«[⁰¹²³⁴⁵⁶⁷⁸⁹]+»\n\n?)+)\s*;\s*(?=})/g,
		function (match, ret, middle) {
			return ret + '\n' + middle;
		});
	// Anything after a return that stands on its own in a block, however it is laid out
	s = removeCodeAfterReturn(s);
	ctx.src = s;
}

function stepArrayConstructors(ctx)
{
	var s = ctx.src;
	// ── GLSL array constructors: type[N](...) → {...} ───────────────────────────
	// Runs before the expression-tree rewrites, which cannot read type[N](...).
	var arrayStructNames = [];
	s.replace(/\bstruct\s+(\w+)\s*\{/g, function (m, name) { arrayStructNames.push(name); return m; });
	s = rewriteArrayConstructors(s, arrayStructNames);
	ctx.src = s;
}

function stepArrayLength(ctx)
{
	var s = ctx.src;
	var messages = ctx.messages;
	// array.length() → the size of the array
	s = rewriteArrayLength(s, messages);
	ctx.src = s;
}

function stepMatrixMul(ctx)
{
	var s = ctx.src;
	var messages = ctx.messages;
	s = rewriteInlineMatrixMul(s, messages);
	ctx.src = s;
}

function stepVectorConstructorArgs(ctx)
{
	var s = ctx.src;
	var messages = ctx.messages;
	// ── Truncate over-specified vector constructors: float3(a, b, vec3) → float3(a, b, vec3.x) ─
	s = rewriteVectorConstructorArgs(s, messages);
	ctx.src = s;
}

function stepBroadcastConstructors(ctx)
{
	var s = ctx.src;
	var messages = ctx.messages;
	// ── Broadcast constructors: vec3(x) → float3(x, x, x) ───────────────────
	// ReshadeFX does not support single-scalar-argument vector constructors.
	// We only expand when the single argument is clearly a numeric literal or
	// simple arithmetic expression (contains digits, operators, dots, parens).
	// Single bare identifiers are left alone — they may be valid same-type casts.
	// the same inside a #define, where the analyzer does not look (only a literal number can be told to be a scalar)
	s = expandLiteralConstructorsInMacros(s, messages);
	s = rewriteBroadcastConstructors(s, messages);
	ctx.src = s;
}

function stepDiagonalMatrices(ctx)
{
	var s = ctx.src;
	var messages = ctx.messages;
	s = rewriteDiagonalMatrices(s, messages);
	ctx.src = s;
}

function stepTextureVariants(ctx)
{
	var s = ctx.src;
	var messages = ctx.messages;
	s = rewriteTextureVariants(s, messages);
	ctx.src = s;
}

function stepVectorEquality(ctx)
{
	var s = ctx.src;
	var messages = ctx.messages;
	// == and != on vectors: all(...) / any(...)
	s = rewriteVectorEquality(s, messages);
	ctx.src = s;
}

function stepCastsOnVectors(ctx)
{
	var s = ctx.src;
	// ── Upgrade scalar casts applied to vector expressions ───────────────────
	// e.g. int(expr.xy) → int2(expr.xy)  when swizzle is the final operation.
	// When a vector swizzle appears mid-expression (e.g. fragCoord.xy / y * s),
	// the result is still a vector — append .x to produce the scalar GLSL implied.
	s = s.replace(/\b(int|uint|float)\s*\(([^()]+)\)/g, function (match, type, inner) {
		var t = inner.trim();
		if (/\.(xy|rg)\s*$/.test(t) || /\bfloat2\b/.test(t)) { return type + '2(' + inner + ')'; }
		if (/\.(xyz|rgb)\s*$/.test(t) || /\bfloat3\b/.test(t)) { return type + '3(' + inner + ')'; }
		if (/\.(xyzw|rgba)\s*$/.test(t) || /\bfloat4\b/.test(t)) { return type + '4(' + inner + ')'; }
		// Vector swizzle mid-expression — result is vector, but cast target is scalar: extract .x
		if (/\.(xy|rg|xyz|rgb|xyzw|rgba)\b/.test(t)) { return type + '((' + inner + ').x)'; }
		return match;
	});
	ctx.src = s;
}

function stepAtan2(ctx)
{
	var s = ctx.src;
	// ── Two-argument atan(y, x) → atan2(y, x) ────────────────────────────────
	s = rewriteTwoArgAtan(s);
	ctx.src = s;
}

function stepTextureCalls(ctx)
{
	var s = ctx.src;
	// ── texture() / texture2D() → tex2D() ────────────────────────────────────
	// Uses a paren-balanced walker to split args correctly — prevents [^)]+ from
	// spanning newlines and consuming code beyond the call site.
	s = rewriteTextureCalls(s);
	ctx.src = s;
}

function stepTextureGrad(ctx)
{
	var s = ctx.src;
	// ── textureGrad(s, uv, ddx, ddy) → tex2Dgrad(s, uv, ddx, ddy) ──────────
	s = s.replace(/\btextureGrad\s*\(/g, 'tex2Dgrad(');
	ctx.src = s;
}

function stepTextureLod(ctx)
{
	var s = ctx.src;
	// ── textureLod(s, uv, lod) → tex2Dlod(s, float4(uv, 0, lod)) ────────────
	s = rewriteTextureLod(s);
	ctx.src = s;
}

function stepTexelFetch(ctx)
{
	var s = ctx.src;
	// ── texelFetch(s, p, lod) → tex2Dfetch(s, p) ;  textureSize → tex2Dsize ──
	s = rewriteTexelFetch(s);
	ctx.src = s;
}

function stepGlslBuiltins(ctx)
{
	var s = ctx.src;
	// ── GLSL built-ins ReShade FX lacks or spells differently ─────────────────
	s = rewriteGlslBuiltins(s);
	ctx.src = s;
}

function stepSwitchBreaks(ctx)
{
	var s = ctx.src;
	var messages = ctx.messages;
	s = rewriteSwitchBreaks(s, messages);
	ctx.src = s;
}

function stepCubemapSamples(ctx)
{
	var s = ctx.src;
	var messages = ctx.messages;
	// ── textureCube(s, dir) → tex2D(s, ST_cubemap_uv(dir)) ──────────────────
	// Must run before the loop-gradient rewriter so any resulting tex2D calls
	// inside loops are caught and promoted to tex2Dlod.
	s = rewriteCubemapSamples(s, messages);
	ctx.src = s;
}

function stepCubemapLookups(ctx)
{
	var s = ctx.src;
	var messages = ctx.messages;
	var options = ctx.options;
	s = rewriteCubemapLookups(s, (options && options.cubemapSamplers) || [], messages);
	ctx.src = s;
}

function stepEmptyChannels(ctx)
{
	var s = ctx.src;
	var messages = ctx.messages;
	var options = ctx.options;
	// a lookup in a channel with nothing behind it reads zero
	s = rewriteEmptyChannels(s, (options && options.emptySamplers) || [], messages);
	ctx.src = s;
}

function stepClampToSaturate(ctx)
{
	var s = ctx.src;
	// ── clamp(x, 0.0, 1.0) → saturate(x) ────────────────────────────────────
	s = s.replace(/\bclamp\s*\(\s*([^,]+),\s*0\.0+f?\s*,\s*1\.0+f?\s*\)/g, 'saturate($1)');
	s = s.replace(/\bclamp\s*\(\s*([^,]+),\s*0\s*,\s*1\s*\)/g, 'saturate($1)');
	ctx.src = s;
}

function rewriteOutsideDirectives(src, rewrite)
{
	var directives = [], marker = '§SBPP';
	while (src.indexOf(marker) >= 0) { marker += '_'; }
	var masked = tokenizeSource(src).map(function (t)
	{
		if (t.type !== 'preproc') { return t.text; }
		directives.push(t.text);
		return marker + (directives.length - 1) + '§';
	}).join('');
	return rewrite(masked).replace(new RegExp(marker + '(\\d+)§', 'g'), function (_, index) { return directives[+index]; });
}

function stepMainImageSignature(ctx)
{
	var s = ctx.src;
	var mainImageName = ctx.mainImageName;
	var mainImageOutVar = ctx.outVar;
	var mainImageCoordVar = ctx.coordVar;
	// ── mainImage signature → HLSL entry point ──────────────────────────────
	// Capture output and coord variable names for use in the PS entry wrapper.
	// In multipass, rename to avoid collision between passes.
	s = rewriteOutsideDirectives(s, function (code) { return code.replace(
		/void\s+mainImage\s*\(\s*out\s+\w+4\s+(\w+)\s*,\s*(?:in\s+)?\w+2\s+(\w+)\s*\)/g,
		function (_, outVar, coordVar) {
			mainImageOutVar = outVar;
			mainImageCoordVar = coordVar;
			return 'void ' + mainImageName + '(float2 ' + coordVar + ', out float4 ' + outVar + ' : SV_Target)';
		}
	); });
	ctx.outVar = mainImageOutVar;
	ctx.coordVar = mainImageCoordVar;
	ctx.src = s;
}

function stepMainImageBody(ctx)
{
	var s = ctx.src;
	var messages = ctx.messages;
	var mainImageName = ctx.mainImageName;
	var mainImageOutVar = ctx.outVar;
	var mainImageCoordVar = ctx.coordVar;
	// ── Rewrite mainImage body to inject output var local and return statement ──
	s = rewriteMainBody(s, messages, mainImageOutVar, mainImageCoordVar, mainImageName);
	ctx.src = s;
}

function stepIndentation(ctx)
{
	var s = ctx.src;
	// ── Normalize space indentation to tabs ───────────────────────────────────
	s = normalizeIndentation(s);
	ctx.src = s;
}

function stepAllmanBraces(ctx)
{
	var s = ctx.src;
	// ── Allman style braces ───────────────────────────────────────────────────
	// Space after flow control keywords
	s = s.replace(/\b(for|if|while|switch)\s*\(/g, '$1 (');

	// Move K&R opening brace to its own line.
	// Matches ) { or identifier/keyword { at end of a statement header.
	// Strategy: work line by line so we can handle indentation correctly.
	s = s.split('\n').map(function (line) {
		// Match a line that ends with { (possibly with trailing spaces),
		// but where { is not the only non-whitespace character (i.e. not already Allman).
		// Also skip preprocessor lines and single-line bodies like { return ...; }
		var trimmed = line.trimRight();
		if (trimmed.match(/^\s*[#{]/)) { return line; } // already Allman or preprocessor
		if (trimmed.match(/\{[^}]*\}[⁰¹²³⁴⁵⁶⁷⁸⁹«»§‹›]*\s*;?\s*$/)) { return line; } // single-line body — leave alone

		// Line ends with { — move it to next line with same indentation
		var m = trimmed.match(/^(\s*)(.*\S)\s*\{$/);
		if (m) {
			return m[1] + m[2] + '\n' + m[1] + '{';
		}
		return line;
	}).join('\n');
	ctx.src = s;
}

function stepLoopGradientTex(ctx)
{
	var s = ctx.src;
	var messages = ctx.messages;
	// ── Rewrite gradient texture instructions inside loops (see rewriteLoopGradientTex) ──
	s = rewriteLoopGradientTex(s, messages);
	ctx.src = s;
}

function stepDropIntrinsicMacros(ctx)
{
	var s = ctx.src;
	var messages = ctx.messages;
	// ── Drop user macros that re-implement an HLSL intrinsic ────────────────────
	// Shaders ported from HLSL often define  #define mul(a,b) b*a  so that GLSL can call mul().
	// For GLSL, b*a is HLSL mul(a, b), so the macro is the identity here; left in place it would
	// expand every mul(M, v) into a component-wise v*M. The same goes for a saturate macro,
	// which the clamp(x, 0, 1) rewrite above turns into  #define saturate(a) saturate(a).
	var droppedMacros = [];
	s = s.replace(/^[ \t]*#[ \t]*define[ \t]+mul[ \t]*\([ \t]*(\w+)[ \t]*,[ \t]*(\w+)[ \t]*\)[ \t]*\(?[ \t]*\2[ \t]*\)?[ \t]*\*[ \t]*\(?[ \t]*\1[ \t]*\)?[ \t]*(?:\n|$)/gm,
		function () { droppedMacros.push('mul'); return ''; });
	s = s.replace(/^[ \t]*#[ \t]*define[ \t]+saturate[ \t]*\([ \t]*(\w+)[ \t]*\)[ \t]*saturate[ \t]*\([ \t]*\1[ \t]*\)[ \t]*(?:\n|$)/gm,
		function () { droppedMacros.push('saturate'); return ''; });
	if (droppedMacros.length > 0)
	{
		messages.push({ level: 'info', text: 'Removed user macro(s) re-implementing HLSL intrinsics (' + droppedMacros.join(', ') + '); the intrinsic is used instead.' });
	}
	ctx.src = s;
}

function stepHoistGlobalInits(ctx)
{
	var s = ctx.src;
	// ── Hoist file-scope initialisers that cannot be evaluated at compile time ──────────────────
	// ReShade FX wants a literal expression in a global initialiser: a function call is rejected
	// (X3005) and so is a value that depends on another global that is not a constant (X3011), but
	// GLSL allows both, e.g.  float tau = atan(1.0)*8.0;  or  mat2 g = rot0;  The declaration stays,
	// the assignment moves to the pass entry point where it runs before mainImage, in the order the
	// declarations had. A global that is hoisted is no longer a constant, so an initialiser that uses
	// one is hoisted as well, and so on down the file.
	var globalInits = [];
	var hoisted = [];
	var globals = fileScopeTokenOffsets(s);
	s = s.replace(/^static[ ]+(const[ ]+)?(float[234x]*|int[234]?|uint[234]?|bool)[ ]+(\w+)[ ]*=[ ]*([^;{«]*?);/gm,
		function (match, isConst, type, name, init, offset) {
			if (!globals[offset]) { return match; }
			var callRe = /\b(?!(?:float[234]?(?:x[234])?|int[234]?|uint[234]?|bool)\b)[A-Za-z_]\w*\s*\(/;
			var usesHoisted = hoisted.some(function (h) { return new RegExp('(?<![\\w.])' + h + '(?!\\w)').test(init); });
			if (!callRe.test(init) && !usesHoisted) { return match; }
			hoisted.push(name);
			globalInits.push(name + ' = ' + init.replace(/\s+/g, ' ').trim() + ';');
			return 'static ' + type + ' ' + name + ';';
		});
	ctx.globalInits = globalInits;
	ctx.src = s;
}

function stepReorderFunctions(ctx)
{
	var s = ctx.src;
	var messages = ctx.messages;
	// ── ReShade FX has no forward declarations: define every function before it is used ──
	s = reorderFunctions(s, messages);
	ctx.src = s;
}

function stepGlslHelpers(ctx)
{
	var s = ctx.src;
	// ── Helper functions for GLSL built-ins ReShade FX lacks (inverse, outerProduct, matrixCompMult) ──
	s = injectGlslHelpers(s);
	ctx.src = s;
}

function stepVectorComponentWrites(ctx)
{
	// FXC cannot address dynamic vector components for writes in rolled loops.
	// Pass the whole vector by reference; constant swizzles in the helper
	// keep the loop addressable and evaluate both indices and the RHS only once.
	var helpers = {};
	var operations = { '=': 'set', '+=': 'add', '-=': 'sub', '*=': 'mul', '/=': 'div' };
	var result = rewriteExpressions(ctx.src, function (node, render)
	{
		if (node.kind !== 'assign' || !operations[node.op]) { return null; }
		var target = node.left;
		if (target.kind !== 'index' || target.index.kind === 'num' || !/^float[234]$/.test(target.base.type || '')) { return null; }
		// Matrix rows cannot be passed by reference with a dynamic row index.
		if (target.base.kind === 'index' && /^float[234]x[234]$/.test(target.base.base.type || '')) { return null; }
		var type = target.base.type;
		var name = 'ST_component_' + operations[node.op] + '_' + type;
		helpers[name] = { type: type, op: node.op };
		return name + '(' + render(target.base) + ', ' + render(target.index) + ', ' + render(node.right) + ')';
	});
	var declarations = Object.keys(helpers).map(function (name)
	{
		var helper = helpers[name];
		var body = '';
		for (var i = 0; i < +helper.type.slice(-1); i++)
		{
			var field = 'value.' + 'xyzw'[i];
			body += '\tif (component == ' + i + ') { ' + field + ' ' + helper.op + ' amount; return ' + field + '; }\n';
		}
		return 'float ' + name + '(inout ' + helper.type + ' value, int component, float amount)\n{\n' + body + '\treturn 0.;\n}\n';
	}).join('\n');
	ctx.src = declarations ? declarations + '\n' + result.src : result.src;
}

function stepNestedStructs(ctx)
{
	ctx.src = flattenNestedStructs(ctx.src, ctx.messages);
}

function flattenNestedStructs(src, messages)
{
	// ReShade rejects struct-valued fields. Flatten one level at a time, with
	// typed views for reads, assignments, and out/inout arguments. Separate
	// nested fields of the same object share a wrapper argument so copy-out
	// cannot overwrite an update to a sibling field.
	for (var depth = 0; depth < 16; depth++)
	{
		var A = analyzeSource(src), layouts = {}, definitions = {}, conditionalStructs = {};
		var conditionalDepth = 0;
		A.tokens.forEach(function (token, index)
		{
			if (token.type === 'preproc')
			{
				if (/^#\s*(?:if|ifdef|ifndef)\b/.test(token.text)) { conditionalDepth++; }
				else if (/^#\s*endif\b/.test(token.text)) { conditionalDepth--; }
			}
			if (conditionalDepth > 0 && token.type === 'ident' && token.text === 'struct')
			{
				var next = index + 1;
				while (A.tokens[next] && A.tokens[next].type === 'ws') { next++; }
				if (A.tokens[next]) { conditionalStructs[A.tokens[next].text] = true; }
			}
		});
		var structRe = /\bstruct\s+(\w+)\s*\{([^}]*)\}/g, match;
		while ((match = structRe.exec(src)) !== null)
		{
			definitions[match[1]] = Object.prototype.hasOwnProperty.call(definitions, match[1]) ? null : match[2];
		}
		Object.keys(A.structs).forEach(function (name)
		{
			var fields = A.structs[name].fields;
			var nested = Object.keys(fields).filter(function (field) { return !!A.structs[fields[field]]; });
			if (!nested.length || conditionalStructs[name] || definitions[name] == null || /\[/.test(definitions[name])) { return; }
			if (nested.some(function (field)
			{
				var type = fields[field];
				return conditionalStructs[type] || definitions[type] == null || /\[/.test(definitions[type]) || Object.keys(A.structs[type].fields).some(function (f) { return !!A.structs[A.structs[type].fields[f]]; });
			})) { return; }
			var used = Object.keys(fields), layout = { fields: fields, nested: {} };
			nested.forEach(function (field)
			{
				var child = A.structs[fields[field]].fields, names = {};
				Object.keys(child).forEach(function (f)
				{
					var flat = 'ST_' + field + '_' + f;
					while (used.indexOf(flat) >= 0) { flat += '_'; }
					used.push(flat); names[f] = flat;
				});
				layout.nested[field] = { type: fields[field], fields: child, names: names };
			});
			layouts[name] = layout;
		});
		if (!Object.keys(layouts).length) { break; }
		var helpers = [], wrappers = [], serial = 0;
		function view(node)
		{
			if (node.kind !== 'member' || !layouts[node.base.type]) { return null; }
			var child = layouts[node.base.type].nested[node.field];
			return child ? { root: node.base, parent: node.base.type, field: node.field, child: child } : null;
		}
		function helperName(v, op) { return 'ST_' + op + '_' + v.parent + '_' + v.field; }
		function direction(param)
		{
			for (var i = param.tok - 2; i >= 0; i--)
			{
				var text = A.tokens[A.sig[i]].text;
				if (text === 'inout' || text === 'out') { return text; }
				if (!/^(?:in|const|highp|mediump|lowp|precise)$/.test(text)) { break; }
			}
			return 'in';
		}
		function stable(node)
		{
			return !/^(?:call|assign|postinc|preinc)$/.test(node.kind) && node.op !== '++' && node.op !== '--' && exprChildren(node).every(stable);
		}
		function writableMember(node, render)
		{
			if (node.kind !== 'member') { return null; }
			var nested = view(node.base);
			if (nested && nested.child.names[node.field]) { return { root: nested.root, field: nested.child.names[node.field] }; }
			if (layouts[node.base.type] && !layouts[node.base.type].nested[node.field]) { return { root: node.base, field: node.field }; }
			var base = writableMember(node.base, render);
			return base ? { root: base.root, field: base.field + '.' + node.field } : null;
		}
		Object.keys(layouts).forEach(function (name)
		{
			Object.keys(layouts[name].nested).forEach(function (field)
			{
				var child = layouts[name].nested[field], v = { parent: name, field: field };
				var read = [], write = [];
				Object.keys(child.fields).forEach(function (f)
				{
					read.push('\tresult.' + f + ' = value.' + child.names[f] + ';');
					write.push('\tvalue.' + child.names[f] + ' = replacement.' + f + ';');
				});
				helpers.push(child.type + ' ' + helperName(v, 'get') + '(' + name + ' value)\n{\n\t' + child.type + ' result;\n' + read.join('\n') + '\n\treturn result;\n}');
				helpers.push(child.type + ' ' + helperName(v, 'set') + '(inout ' + name + ' value, ' + child.type + ' replacement)\n{\n' + write.join('\n') + '\n\treturn replacement;\n}');
			});
		});
		var result = rewriteExpressions(src, function (node, render)
		{
			var v;
			if (node.kind === 'assign' && node.op === '=' && (v = view(node.left)))
			{
				return helperName(v, 'set') + '(' + render(v.root) + ', ' + render(node.right) + ')';
			}
			if (node.kind === 'call' && A.functions[node.name])
			{
				var functions = A.functions[node.name].filter(function (fn)
				{
					return fn.bodyFrom !== undefined && fn.params.length === node.args.length && fn.params.every(function (p, i) { return !node.args[i].type || p.type === node.args[i].type; });
				});
				var fn = functions.length === 1 ? functions[0] : null;
				if (fn && fn.params.some(function (p, i) { return direction(p) !== 'in' && view(node.args[i]); }))
				{
					var name = 'ST_nested_call_' + node.name + '_' + serial++;
					var params = [], args = [], call = [], before = [], after = [], roots = {};
					function rootArg(root)
					{
						var text = render(root), key = stable(root) ? root.type + ':' + text : 'unstable:' + params.length;
						if (!roots[key])
						{
							roots[key] = 'arg' + params.length;
							params.push('inout ' + root.type + ' ' + roots[key]); args.push(text);
						}
						return roots[key];
					}
					node.args.forEach(function (arg, i)
					{
						var dir = direction(fn.params[i]), nested = dir !== 'in' && view(arg);
						if (nested)
						{
							var root = rootArg(nested.root), temp = 'nested' + i;
							before.push('\t' + nested.child.type + ' ' + temp + (dir === 'inout' ? ' = ' + helperName(nested, 'get') + '(' + root + ')' : '') + ';');
							after.push('\t' + helperName(nested, 'set') + '(' + root + ', ' + temp + ');');
							call.push(temp);
						}
						else if (dir !== 'in' && writableMember(arg, render))
						{
							var member = writableMember(arg, render);
							call.push(rootArg(member.root) + '.' + member.field);
						}
						else
						{
							var parameter = 'arg' + params.length;
							params.push(dir + ' ' + fn.params[i].type + ' ' + parameter); args.push(render(arg)); call.push(parameter);
						}
					});
					var invocation = node.name + '(' + call.join(', ') + ')';
					wrappers.push(fn.ret + ' ' + name + '(' + params.join(', ') + ')\n{\n' + before.join('\n') + '\n\t' + (fn.ret === 'void' ? invocation : fn.ret + ' result = ' + invocation) + ';\n' + after.join('\n') + (fn.ret === 'void' ? '' : '\n\treturn result;') + '\n}');
					return name + '(' + args.join(', ') + ')';
				}
			}
			if (node.kind === 'member' && (v = view(node.base)) && v.child.names[node.field])
			{
				return render(v.root) + '.' + v.child.names[node.field];
			}
			if ((v = view(node))) { return helperName(v, 'get') + '(' + render(v.root) + ')'; }
			return null;
		});
		src = result.src.replace(structRe, function (text, name)
		{
			if (!layouts[name]) { return text; }
			var fields = [];
			Object.keys(layouts[name].fields).forEach(function (field)
			{
				var child = layouts[name].nested[field];
				if (!child) { fields.push('\t' + layouts[name].fields[field] + ' ' + field + ';'); return; }
				Object.keys(child.fields).forEach(function (f) { fields.push('\t' + child.fields[f] + ' ' + child.names[f] + ';'); });
			});
			var comments = (definitions[name].match(/«[^»]*»/g) || []).join('\n');
			return '\n' + comments + (comments ? '\n' : '') + 'struct ' + name + '\n{\n' + fields.join('\n') + '\n}';
		});
		helpers = helpers.concat(wrappers);
		src += '\n' + helpers.map(function (h) { return h.slice(0, h.indexOf('\n')) + ';'; }).join('\n') + '\n' + helpers.join('\n\n') + '\n';
		if (messages) { messages.push({ level: 'info', text: 'Flattened nested struct members in ' + Object.keys(layouts).join(', ') + ', preserving value copies and out/inout updates.' }); }
	}
	return src;
}

function stepFragCoordDeclaration(ctx)
{
	var s = ctx.src;
	// ── ST_FragCoord is what gl_FragCoord became; the entry point fills it in ──
	if (ctx.usesGlFragCoord) { s = 'static float4 ST_FragCoord;\n' + s; }
	ctx.src = s;
}

function stepRestoreComments(ctx)
{
	var s = ctx.src;
	var xSuperDigits = COMMENT_DIGITS;
	var xComments = ctx.comments;
	// ── Restore extracted comments ────────────────────────────────────────────
	s = s.replace(/«([⁰¹²³⁴⁵⁶⁷⁸⁹]+)»/g, function (_, supIdx) {
		var idx = supIdx.split('').map(function (c) { return xSuperDigits.indexOf(c); }).join('');
		return xComments[parseInt(idx, 10)];
	});
	ctx.src = s;
}

function stepD3D9ForLoops(ctx)
{
	// DX9 drivers can reject bytecode that D3DCompile accepts when unrolling exceeds the
	// device's instruction-slot limit. Keep for loops rolled on DX9; other APIs keep their
	// usual optimization. Insert these directives after analysis and function reordering,
	// since conditional code inside a function makes those earlier steps conservative.
	var tokens = tokenizeSource(ctx.src);
	var significant = tokens.filter(function (t)
	{
		return t.type !== 'ws' && t.type !== 'comment' && t.type !== 'placeholder' && t.type !== 'preproc';
	});
	var insertions = [];
	significant.forEach(function (t, i)
	{
		if (t.type !== 'ident' || t.text !== 'for' || !significant[i + 1] || significant[i + 1].text !== '(') { return; }
		// SM3's rolled-loop counter is limited to 255 iterations. Let the compiler unroll
		// a larger, purely constant loop instead of giving it contradictory instructions.
		var fixedLoop = /^for\s*\(\s*(?:int|uint|float)\s+(\w+)\s*=\s*0\s*;\s*\1\s*(<|<=)\s*(\d+)\s*;\s*(?:\1\s*\+\+|\+\+\s*\1)\s*\)/.exec(ctx.src.slice(t.start));
		if (fixedLoop && +fixedLoop[3] + (fixedLoop[2] === '<=' ? 1 : 0) > 255) { return; }
		// Respect explicit loop attributes rather than combining [loop] with [unroll].
		if (i > 0 && significant[i - 1].text === ']') { return; }
		insertions.push(t.start);
	});
	for (var i = insertions.length - 1; i >= 0; i--)
	{
		var at = insertions[i];
		ctx.src = ctx.src.slice(0, at) + '\n#if __RENDERER__ == 0x9000\n[loop]\n#endif\n' + ctx.src.slice(at);
	}
}

function stepD3D9BitOperations(ctx)
{
	// SM3 uses floating-point registers for integers. Powers of two let these operations be
	// expressed arithmetically for values representable by that profile; modern APIs keep
	// native integer operations. Other masks and dynamic shifts are deliberately left alone.
	var helpers = {};
	function integerLiteral(node)
	{
		if (node.kind !== 'num') { return null; }
		var text = ctx.src.slice(analysis.charStart(node), analysis.charEnd(node));
		return /^(?:\d+|0[xX][\da-fA-F]+)[uU]?$/.test(text) ? Number(text.replace(/[uU]$/, '')) : null;
	}
	var analysis = analyzeSource(ctx.src);
	var result = rewriteExpressions(ctx.src, function (node, render)
	{
		if (node.kind !== 'binary' || (node.op !== '>>' && node.op !== '&')) { return null; }
		var type = node.left.type;
		if (type !== 'int' && type !== 'uint') { return null; }
		var value = integerLiteral(node.right);
		if (value === null) { return null; }
		var name;
		if (node.op === '>>' && value >= 0 && value <= 30) { name = 'ST_shiftRight'; }
		else if (node.op === '&' && value >= 0 && value <= 65535 && ((value + 1) & value) === 0) { name = 'ST_lowBits'; }
		else { return null; }
		// SM3 lowers uint to int, so signed/unsigned overloads would collide in generated HLSL.
		if (type === 'uint') { name += '_uint'; }
		helpers[name + ':' + type] = { name: name, type: type };
		return name + '(' + render(node.left) + ', ' + render(node.right) + ')';
	});
	var declarations = Object.keys(helpers).map(function (key)
	{
		var h = helpers[key], type = h.type;
		var body = h.name.indexOf('ST_shiftRight') === 0
			? type + '(floor(float(value) * exp2(-float(amount))))'
			: type + '(float(value) - floor(float(value) / float(amount + 1)) * float(amount + 1))';
		var nativeOp = h.name.indexOf('ST_shiftRight') === 0 ? '>>' : '&';
		return type + ' ' + h.name + '(' + type + ' value, ' + type + ' amount)\n{\n'
			+ '#if __RENDERER__ == 0x9000\n\treturn ' + body + ';\n'
			+ '#else\n\treturn value ' + nativeOp + ' amount;\n#endif\n}\n';
	}).join('\n');
	ctx.src = declarations ? declarations + '\n' + result.src : result.src;
}

// ─────────────────────────────────────────────────────────────────────────────
// The steps, in the order they run. Each step has a name and a function that reads and changes
// the pass (ctx.src is the source; the other fields are what steps tell each other and what the
// pass hands back). An order that matters is written down as  after  with a reason, and is checked
// every time the pipeline runs (checkTransformPipeline), so moving a step cannot silently break it.
// ─────────────────────────────────────────────────────────────────────────────
var TRANSFORM_STEPS = [
	{ name: 'extractComments', run: stepExtractComments },
	{ name: 'removeDirectives', run: stepRemoveDirectives },
	{ name: 'precision', run: stepPrecision },
	{ name: 'glFragCoord', run: stepGlFragCoord },
	{ name: 'uniformRedeclarations', run: stepUniformRedeclarations },
	{ name: 'floatSuffix', run: stepFloatSuffix },
	{ name: 'typeNames', run: stepTypeNames },
	{
		name: 'structConstructors',
		run: stepStructConstructors,
		after: ['typeNames'],
		why: 'member types must already be in HLSL form'
	},
	{ name: 'intrinsicNames', run: stepIntrinsicNames },
	{ name: 'reservedIdentifiers', run: stepReservedIdentifiers },
	{ name: 'unsignedFloatConstants', run: stepUnsignedFloatConstants, after: ['typeNames'], why: 'floating-point constructor names must already be in HLSL form' },
	{ name: 'compatibilityMacros', run: stepCompatibilityMacros, after: ['typeNames', 'reservedIdentifiers'], why: 'macro bodies must use the same type and identifier names as the expressions they expand into' },
	{ name: 'splitGlobalDeclarators', run: stepSplitGlobalDeclarators, after: ['extractComments'], why: 'it moves comment placeholders and must see them rather than the comments' },
	{
		name: 'constToStaticConst',
		run: stepConstToStaticConst,
		after: ['splitGlobalDeclarators'],
		why: 'it looks for one variable per declaration'
	},
	{
		name: 'constInitialisers',
		run: stepConstInitialisers,
		after: ['splitGlobalDeclarators'],
		why: 'it looks for one variable per declaration'
	},
	{
		name: 'staticGlobals',
		run: stepStaticGlobals,
		after: ['splitGlobalDeclarators'],
		why: 'it looks for one variable per declaration'
	},
	{
		name: 'unreachableCode',
		run: stepUnreachableCode,
		after: ['extractComments'],
		why: 'it reads the comment placeholders'
	},
	{ name: 'arrayConstructors', run: stepArrayConstructors },
	{ name: 'nestedStructs', run: stepNestedStructs, after: ['structConstructors', 'arrayConstructors'], why: 'struct constructor helpers and array initializers must be visible to typed member rewrites' },
	{ name: 'arrayLength', run: stepArrayLength, after: ['arrayConstructors'], why: 'it counts the elements of the braced initialisers that step produces' },
	{
		name: 'matrixMul',
		run: stepMatrixMul,
		after: ['typeNames', 'arrayConstructors'],
		why: 'the expression tree reads HLSL type names and cannot read type[N](...)'
	},
	{
		name: 'vectorConstructorArgs',
		run: stepVectorConstructorArgs,
		after: ['typeNames', 'arrayConstructors'],
		why: 'the expression tree reads HLSL type names and cannot read type[N](...)'
	},
	{
		name: 'broadcastConstructors',
		run: stepBroadcastConstructors,
		after: ['typeNames', 'arrayConstructors'],
		why: 'the expression tree reads HLSL type names and cannot read type[N](...)'
	},
	{
		name: 'diagonalMatrices',
		run: stepDiagonalMatrices,
		after: ['typeNames', 'arrayConstructors'],
		why: 'the expression tree reads HLSL type names and cannot read type[N](...)'
	},
	{
		name: 'textureVariants',
		run: stepTextureVariants,
		after: ['typeNames', 'arrayConstructors'],
		why: 'the expression tree reads HLSL type names and cannot read type[N](...)'
	},
	{
		name: 'vectorEquality',
		run: stepVectorEquality,
		after: ['typeNames', 'arrayConstructors'],
		why: 'the expression tree reads HLSL type names and cannot read type[N](...)'
	},
	{ name: 'castsOnVectors', run: stepCastsOnVectors },
	{ name: 'atan2', run: stepAtan2 },
	{ name: 'textureCalls', run: stepTextureCalls },
	{ name: 'textureGrad', run: stepTextureGrad },
	{ name: 'textureLod', run: stepTextureLod },
	{ name: 'texelFetch', run: stepTexelFetch },
	{
		name: 'glslBuiltins',
		run: stepGlslBuiltins,
		after: ['vectorEquality'],
		why: 'it turns equal() and notEqual() into component-wise operators on purpose; vectorEquality must only see the comparisons the shader wrote'
	},
	{ name: 'switchBreaks', run: stepSwitchBreaks },
	{ name: 'cubemapSamples', run: stepCubemapSamples },
	{
		name: 'cubemapLookups',
		run: stepCubemapLookups,
		after: ['textureCalls', 'textureLod'],
		why: 'it looks for the tex2D and tex2Dlod calls those steps make'
	},
	{
		name: 'emptyChannels',
		run: stepEmptyChannels,
		after: ['textureCalls', 'textureGrad', 'textureLod', 'texelFetch', 'cubemapLookups'],
		why: 'it looks for the tex2D family calls those steps make'
	},
	{ name: 'clampToSaturate', run: stepClampToSaturate },
	{ name: 'mainImageSignature', run: stepMainImageSignature },
	{
		name: 'mainImageBody',
		run: stepMainImageBody,
		after: ['mainImageSignature'],
		why: 'it needs the parameter names of the entry point'
	},
	{ name: 'indentation', run: stepIndentation },
	{ name: 'allmanBraces', run: stepAllmanBraces },
	{
		name: 'loopGradientTex',
		run: stepLoopGradientTex,
		after: ['textureCalls', 'textureLod', 'cubemapSamples', 'cubemapLookups'],
		why: 'every tex2D call inside a loop, including the ones made above, must be promoted to tex2Dlod'
	},
	{
		name: 'dropIntrinsicMacros',
		run: stepDropIntrinsicMacros,
		after: ['clampToSaturate'],
		why: 'the clamp rewrite turns a saturate macro into one that calls itself, which this step then recognises'
	},
	{
		name: 'hoistGlobalInits',
		run: stepHoistGlobalInits,
		after: ['constToStaticConst', 'staticGlobals', 'nestedStructs'],
		why: 'file-scope declarations must be static and nested member reads lowered before initializers move out of the source'
	},
	{
		name: 'vectorComponentWrites',
		run: stepVectorComponentWrites,
		after: ['typeNames', 'arrayConstructors'],
		why: 'expression analysis needs HLSL types and rewritten array constructors'
	},
	{
		name: 'reorderFunctions',
		run: stepReorderFunctions,
		after: ['typeNames', 'vectorComponentWrites', 'nestedStructs'],
		why: 'the analysis reads HLSL type names and must see generated component-write and nested-struct helpers'
	},
	{
		name: 'glslHelpers',
		run: stepGlslHelpers,
		after: ['glslBuiltins'],
		why: 'it looks at the finished source for calls that need a helper'
	},
	{
		name: 'fragCoordDeclaration',
		run: stepFragCoordDeclaration,
		after: ['glFragCoord'],
		why: 'it reads the flag that step sets'
	},
	{
		name: 'd3d9BitOperations',
		run: stepD3D9BitOperations,
		after: ['reorderFunctions', 'glslHelpers'],
		why: 'conditional helper bodies must be inserted after function reordering and expression analysis'
	},
	{
		name: 'd3d9ForLoops',
		run: stepD3D9ForLoops,
		after: ['reorderFunctions', 'glslHelpers', 'loopGradientTex'],
		why: 'conditional loop hints must follow expression analysis, function reordering and gradient lookup rewriting'
	},
	{ name: 'restoreComments', run: stepRestoreComments }
];

// What is wrong with the order of a list of steps, as readable sentences (empty when it is fine)
function checkTransformPipeline(steps)
{
	steps = steps || TRANSFORM_STEPS;
	var problems = [];
	var index = {};
	steps.forEach(function (step, i)
	{
		if (index[step.name] !== undefined) { problems.push('step "' + step.name + '" appears twice'); }
		index[step.name] = i;
		if (typeof step.run !== 'function') { problems.push('step "' + step.name + '" has nothing to run'); }
	});
	steps.forEach(function (step, i)
	{
		var after = step.after || [];
		after.forEach(function (other)
		{
			if (index[other] === undefined) { problems.push('step "' + step.name + '" must follow "' + other + '", which does not exist'); }
			else if (index[other] >= i) { problems.push('step "' + step.name + '" must come after "' + other + '" (' + (step.why || 'no reason given') + ')'); }
		});
		if (after.length > 0 && !step.why) { problems.push('step "' + step.name + '" has an order that matters but gives no reason'); }
	});
	if (steps.length > 0 && steps[0].name !== 'extractComments') { problems.push('the first step must be "extractComments", so that no step ever sees a comment'); }
	if (steps.length > 0 && steps[steps.length - 1].name !== 'restoreComments') { problems.push('the last step must be "restoreComments"'); }
	return problems;
}

// Turn the GLSL of one pass into HLSL text. The work is done by the steps above, one after the other.
function transformGLSL(src, messages, passLabel, options)
{
	var problems = checkTransformPipeline();
	if (problems.length > 0) { throw new Error('ShaderBridge: the order of the transform steps is wrong: ' + problems.join('; ')); }

	if (options && options.cubemapPass)
	{
		src = tokenizeSource(src).map(function (t)
		{
			if (t.type === 'ident' && t.text === 'iResolution') { return 'ST_CubeResolution'; }
			if (t.type === 'preproc') { return t.text.replace(/\biResolution\b/g, 'ST_CubeResolution'); }
			return t.text;
		}).join('');
		src += '\nvec3 ST_cubemap_direction(vec2 coord)\n{\n'
			+ '\tfloat face=floor(coord.x/float(ST_CUBEMAP_SIZE));\n'
			+ '\tvec2 uv=vec2(mod(coord.x,float(ST_CUBEMAP_SIZE)),coord.y)*(2./float(ST_CUBEMAP_SIZE))-1.;\n'
			+ '\tif(face<0.5) return normalize(vec3(1.,-uv.y,-uv.x));\n'
			+ '\tif(face<1.5) return normalize(vec3(-1.,-uv.y,uv.x));\n'
			+ '\tif(face<2.5) return normalize(vec3(uv.x,1.,uv.y));\n'
			+ '\tif(face<3.5) return normalize(vec3(uv.x,-1.,-uv.y));\n'
			+ '\tif(face<4.5) return normalize(vec3(uv.x,-uv.y,1.));\n'
			+ '\treturn normalize(vec3(-uv.x,-uv.y,-1.));\n}\n'
			+ 'void mainImage(out vec4 ST_cubeOutput,in vec2 ST_cubeCoord)\n{\n'
			+ '\tvec2 ST_cubePixel=vec2(mod(ST_cubeCoord.x,float(ST_CUBEMAP_SIZE)),ST_cubeCoord.y);\n'
			+ '\tmainCubemap(ST_cubeOutput,ST_cubePixel,vec3(0.),ST_cubemap_direction(ST_cubeCoord));\n}\n';
	}
	var ctx = {
		src: src,
		messages: messages,
		options: options,
		// In multipass, rename mainImage to avoid collisions between passes
		mainImageName: passLabel ? 'mainImage_' + passLabel : 'mainImage',
		outVar: 'fragColor',
		coordVar: 'fragCoord',
		comments: [],
		usesGlFragCoord: false,
		globalInits: []
	};
	TRANSFORM_STEPS.forEach(function (step) { step.run(ctx); });
	return { src: ctx.src, outVar: ctx.outVar, coordVar: ctx.coordVar, mainImageName: ctx.mainImageName, globalInits: ctx.globalInits };
}
// ReshadeFX does not support float3(1.0) — requires float3(1.0, 1.0, 1.0).
//
// Handles: vec2/3/4, float2/3/4, int2/3/4, uint2/3/4
// Only expands when the single argument looks like a numeric expression
// (contains a digit, or starts with - followed by a digit, or is a known
// float literal). Bare single identifiers are left alone as they may be
// valid same-type cast constructors.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Rewrite GLSL struct constructor calls to generated _ctor helper functions.
// HLSL/ReShade FX does not support positional struct constructor syntax.
//
// For each struct definition found in src:
//   1. Parse member names and types from the struct body.
//   2. Emit a Name_ctor(type0 m0, type1 m1, ...) helper immediately after the
//      struct closing brace+semicolon.
//   3. Replace every Name( call site (that is not a declaration or struct def)
//      with Name_ctor(.
//
// Only acts on structs that are actually called as constructors somewhere in src.
// Member types must already be in HLSL form (float3 not vec3) — call after
// type replacements.
// ─────────────────────────────────────────────────────────────────────────────

function rewriteStructConstructors(src, messages) {
	// ── Step 1: find all struct definitions and parse their members ───────────
	var structs = {}; // name → [ { type, name }, ... ]
	var knownStructs = analyzeSource(src).structs;
	var structRe = /\bstruct\s+(\w+)\s*\{([^}]*)\}/g;
	var sm;
	while ((sm = structRe.exec(src)) !== null) {
		var structName = sm[1];
		var body = sm[2];
		var members = [];
		if (knownStructs[structName] && !/\[/.test(body))
		{
			Object.keys(knownStructs[structName].fields).forEach(function (field) { members.push({ type: knownStructs[structName].fields[field], name: field }); });
		}
		if (members.length > 0) {
			structs[structName] = members;
		}
	}

	if (Object.keys(structs).length === 0) { return src; }

	// ── Step 2: for each struct that has actual constructor call sites,
	//           insert the _ctor helper after the struct definition and
	//           rename the call sites ─────────────────────────────────────────
	var result = src;

	Object.keys(structs).forEach(function (name) {
		// Only act if there is at least one constructor call site
		var callRe = new RegExp('(?<![\\w.])' + name + '\\s*\\(', 'g');
		// Check for any occurrence that is NOT the struct definition itself
		// and NOT a type declaration (e.g. "Name varName")
		var hasCall = false;
		var scanRe = new RegExp('\\b' + name + '\\s*\\(', 'g');
		var sm2;
		while ((sm2 = scanRe.exec(result)) !== null) {
			// Skip if preceded by 'struct ' keyword
			var before = result.slice(Math.max(0, sm2.index - 10), sm2.index);
			if (/struct\s+$/.test(before)) { continue; }
			// Skip if this is a function definition returning the struct type
			// (e.g. "Hit march(..." — name followed by ( but preceded by return type context)
			// We check: is the char before name (skipping spaces) something that suggests
			// this is a function return type? Specifically a newline or ; or }
			var charBefore = '';
			var cb = sm2.index - 1;
			while (cb >= 0 && result[cb] === ' ') { cb--; }
			charBefore = cb >= 0 ? result[cb] : '';
			// If preceded by newline/semicolon/brace it's a function definition, skip
			if (charBefore === '\n' || charBefore === '}' || charBefore === ';') { continue; }
			hasCall = true;
			break;
		}

		if (!hasCall) { return; }

		var members = structs[name];

		// Build _ctor function
		var params = members.map(function (m) { return m.type + ' ' + m.name; }).join(', ');
		var assigns = members.map(function (m) { return '\t_h.' + m.name + ' = ' + m.name + ';'; }).join('\n');
		var ctorBody = name + ' ' + name + '_ctor(' + params + ')\n'
			+ '{\n'
			+ '\t' + name + ' _h;\n'
			+ assigns + '\n'
			+ '\treturn _h;\n'
			+ '}';

		// Insert _ctor after the struct closing }; 
		var insertRe = new RegExp('(\\bstruct\\s+' + name + '\\s*\\{[^}]*\\}\\s*;)');
		result = result.replace(insertRe, '$1\n\n' + ctorBody);

		// Rename call sites: Name( → Name_ctor(
		// Skip occurrences preceded by 'struct ' (the definition itself, now updated)
		result = result.replace(new RegExp('\\b' + name + '\\s*\\(', 'g'), function (match, offset) {
			var before = result.slice(Math.max(0, offset - 10), offset);
			if (/struct\s+$/.test(before)) { return match; }
			// Skip the _ctor definition we just inserted
			var afterName = result.slice(offset + name.length).replace(/^\s*/, '');
			// If this is "Name_ctor(" already, skip (won't match since we look for Name()
			return name + '_ctor(';
		});

		messages.push({ level: 'info', text: 'Struct constructor ' + name + '(...) auto-rewritten to ' + name + '_ctor(...) helper.' });
	});

	return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rewrite scalar broadcast constructors:  float3(x)  →  float3(x, x, x)  when x is a scalar.
//
// GLSL builds a vector from one scalar; ReShade FX rejects it (X3014). A single argument that is
// itself a vector is a conversion or a copy (int2(v2), float3(v3)), which ReShade accepts, and
// must stay as it is. Whether the argument is a scalar comes from the analyzer's type inference,
// so a plain variable named p is looked up in its own function's scope. An argument whose type
// cannot be determined is left alone and reported.
// ─────────────────────────────────────────────────────────────────────────────

function rewriteBroadcastConstructors(src, messages)
{
	var unknown = {};

	var result = rewriteExpressions(src, function (node, render)
	{
		if (node.kind !== 'call' || node.args.length !== 1) { return null; }
		var target = anParseType(node.ctor || node.name);
		if (!target || target.kind !== 'vec') { return null; }

		var argType = node.args[0].type && anParseType(node.args[0].type);
		if (!argType)
		{
			unknown[node.name + '(' + argLabel(node) + ')'] = true;
			return null;
		}
		if (argType.kind !== 'scalar') { return null; }

		var text = render(node.args[0]);
		var parts = [];
		for (var i = 0; i < target.rows; i++) { parts.push(text); }
		return node.name + '(' + parts.join(', ') + ')';
	});

	function argLabel(node)
	{
		return node.args[0].kind === 'ident' ? node.args[0].name : 'expression';
	}

	var unknownList = Object.keys(unknown);
	if (messages && unknownList.length > 0)
	{
		messages.push({ level: 'warn', text: 'Could not tell whether the argument is a scalar in ' + unknownList.slice(0, 3).join(', ') + (unknownList.length > 3 ? ' (and ' + (unknownList.length - 3) + ' more)' : '') + '. ReShade needs a scalar spelled out, e.g. float3(x, x, x).' });
	}
	if (messages && result.parseFailures > 0)
	{
		messages.push({ level: 'warn', text: result.parseFailures + ' expression(s) could not be analysed for scalar vector constructors; check any float2/float3/float4 built from a single scalar by hand.' });
	}
	return result.src;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rewrite vector constructors whose arguments provide more components than needed.
// GLSL lets the last argument overflow; HLSL does not.
// e.g. float3(Z.z, 0, -Z)  where -Z is a float3  →  float3(Z.z, 0, -Z.x)
//
// Each argument's component count comes from the analyzer's type inference (a scalar is 1,
// a floatN is N), so names like x or p are looked up in their own function's scope rather than
// guessed. The overflowing vector argument is cut down with a swizzle and any further
// arguments are dropped. A constructor with an argument of unknown type is left alone.
// ─────────────────────────────────────────────────────────────────────────────

function rewriteVectorConstructorArgs(src, messages)
{
	var swizzle = ['x', 'y', 'z', 'w'];

	function components(type)
	{
		var parsed = anParseType(type);
		return parsed.kind === 'scalar' ? 1 : parsed.rows * parsed.cols;
	}

	// Apply a swizzle to an argument. A swizzle binds tighter than any operator, so anything
	// other than a primary expression needs parentheses first.
	function swizzled(node, render, swz)
	{
		if (node.kind === 'unary') { return node.op + swizzled(node.child, render, swz); }
		var primary = node.kind === 'ident' || node.kind === 'call' || node.kind === 'member' || node.kind === 'index' || node.kind === 'paren';
		return (primary ? render(node) : '(' + render(node) + ')') + '.' + swz;
	}

	var result = rewriteExpressions(src, function (node, render)
	{
		if (node.kind !== 'call') { return null; }
		var target = anParseType(node.ctor || node.name);
		if (!target || target.kind !== 'vec') { return null; }
		if (node.args.some(function (arg) { return !arg.type || !anParseType(arg.type); })) { return null; }

		var total = node.args.reduce(function (sum, arg) { return sum + components(arg.type); }, 0);
		if (total <= target.rows) { return null; }

		var parts = [];
		var used = 0;
		for (var i = 0; i < node.args.length && used < target.rows; i++)
		{
			var arg = node.args[i];
			var count = components(arg.type);
			var remaining = target.rows - used;
			if (count <= remaining) { parts.push(render(arg)); used += count; }
			else
			{
				var isVector = anParseType(arg.type).kind === 'vec';
				parts.push(isVector ? swizzled(arg, render, swizzle.slice(0, remaining).join('')) : render(arg));
				used += remaining;
			}
		}
		return node.name + '(' + parts.join(', ') + ')';
	});

	if (messages && result.parseFailures > 0)
	{
		messages.push({ level: 'warn', text: result.parseFailures + ' expression(s) could not be analysed for over-long vector constructors; check any float2/float3/float4 built from a longer vector by hand.' });
	}
	return result.src;
}
// ─────────────────────────────────────────────────────────────────────────────
// == and != on vectors.
//
// In GLSL a == b on two vectors is one boolean: all components equal. In HLSL it is a vector of
// booleans, which an if or a && cannot take (X3019). So
//
//   a == b  →  all(a == b)        a != b  →  any(a != b)
//
// Only comparisons the shader wrote are changed: the component-wise operators that equal() and
// notEqual() become later (rewriteGlslBuiltins) are meant to give a vector and are left alone, which
// is why this runs first. The analyzer types every comparison as a single bool, as GLSL does.
// Matrices are not handled: ReShade FX has no all() or any() for them, so such a comparison is left
// as it is and reported.
// ─────────────────────────────────────────────────────────────────────────────

function rewriteVectorEquality(src, messages)
{
	if (!/[=!]=/.test(src)) { return src; }
	function kindOf(type)
	{
		var parsed = type && anParseType(type);
		return parsed ? parsed.kind : null;
	}

	var matrixCompares = 0;
	var result = rewriteExpressions(src, function (node, render)
	{
		if (node.kind !== 'binary' || (node.op !== '==' && node.op !== '!=')) { return null; }
		if (kindOf(node.left.type) === 'mat' || kindOf(node.right.type) === 'mat') { matrixCompares++; return null; }
		if (kindOf(node.left.type) !== 'vec' && kindOf(node.right.type) !== 'vec') { return null; }
		return (node.op === '==' ? 'all(' : 'any(') + render(node.left) + ' ' + node.op + ' ' + render(node.right) + ')';
	});

	if (messages && matrixCompares > 0)
	{
		messages.push({ level: 'warn', text: 'ReShade FX cannot compare whole matrices with == or !=; ' + matrixCompares + ' such comparison(s) were left as they are. Compare the rows by hand.' });
	}
	if (messages && result.parseFailures > 0)
	{
		messages.push({ level: 'warn', text: result.parseFailures + ' expression(s) could not be analysed for vector comparisons; check any == or != on vectors in this pass by hand.' });
	}
	return result.src;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rewrite matrix multiplies:  a * b  →  mul(b, a)  when either operand is a matrix,
// and  v *= M  →  v = mul(M, v).
//
// HLSL fills a matrix row by row, GLSL column by column, so for the same constructor
// arguments GLSL M*v is HLSL mul(v, M), and GLSL v*M is mul(M, v). The rule is the same in
// both directions: if one operand of * is a matrix, emit mul(right, left). That also
// covers matrix * matrix.
//
// Which operands are matrices comes from the analyzer's type inference (variables,
// constructors, matrix-returning functions, nested expressions), and the expression tree
// gives operator precedence, so chains such as  a * b * M * v  need no special handling.
// Expressions whose operand types cannot be determined are left alone.
// ─────────────────────────────────────────────────────────────────────────────

function expandMatrixExpressionMacros(src, messages)
{
	if (!/#\s*define\b/.test(src)) { return src; }
	function isMatrix(type) { var p = type && anParseType(type); return p && p.kind === 'mat'; }
	var expanded = 0;
	for (var pass = 0; pass < 5; pass++)
	{
		var A = analyzeSource(src);
		var definitions = Object.create(null);
		A.tokens.forEach(function (t)
		{
			var m = t.type === 'preproc' && /^#\s*(?:define|undef)\s+([A-Za-z_]\w*)/.exec(t.text);
			if (m) { definitions[m[1]] = (definitions[m[1]] || 0) + 1; }
		});
		var matrices = Object.create(null);
		A.decls.forEach(function (d) { if (d.global && isMatrix(d.type)) { matrices[d.name] = true; } });
		Object.keys(A.functions).forEach(function (name)
		{
			if (A.functions[name].some(function (fn) { return isMatrix(fn.ret); })) { matrices[name] = true; }
		});
		function matrixBody(name, seen)
		{
			var macro = A.macros[name];
			if (!macro || definitions[name] !== 1 || seen.indexOf(name) >= 0 || seen.length > 5) { return false; }
			return tokenizeSource(macro.body).some(function (t)
			{
				return t.type === 'ident' && (matrices[t.text] || isMatrix(t.text) || matrixBody(t.text, seen.concat(name)));
			});
		}
		var changed = 0;
		var result = rewriteExpressions(src, function (node, render)
		{
			if (node.kind !== 'call') { return null; }
			var macro = A.macros[node.name];
			if (!macro || definitions[node.name] !== 1 || !macro.fn || !macro.params || macro.params.length !== node.args.length || /[#{};]/.test(macro.body)) { return null; }
			if (macro.params.some(function (p) { return !/^[A-Za-z_]\w*$/.test(p); })) { return null; }
			var hasProduct = /\*/.test(macro.body);
			var hasNestedMacro = tokenizeSource(macro.body).some(function (t) { return t.type === 'ident' && A.macros[t.text] && A.macros[t.text].fn; });
			if ((!hasProduct && !hasNestedMacro) || (!matrixBody(node.name, []) && !node.args.some(function (arg) { return isMatrix(arg.type); }))) { return null; }
			var args = Object.create(null);
			macro.params.forEach(function (p, i) { args[p] = '(' + render(node.args[i]) + ')'; });
			changed++;
			return '(' + tokenizeSource(macro.body).map(function (t)
			{
				return t.type === 'ident' && Object.prototype.hasOwnProperty.call(args, t.text) ? args[t.text] : t.text;
			}).join('') + ')';
		});
		if (!changed) { break; }
		expanded += changed;
		src = result.src;
	}
	if (expanded && messages) { messages.push({ level: 'info', text: 'Expanded ' + expanded + ' matrix expression macro call(s) so their products can be rewritten.' }); }
	return src;
}

function rewriteInlineMatrixMul(src, messages)
{
	src = expandMatrixExpressionMacros(src, messages);
	function isMatrix(type)
	{
		var parsed = type && anParseType(type);
		return !!parsed && parsed.kind === 'mat';
	}

	var result = rewriteExpressions(src, function (node, render)
	{
		if (node.kind === 'binary' && node.op === '*' && (isMatrix(node.left.type) || isMatrix(node.right.type)))
		{
			return 'mul(' + render(node.right) + ', ' + render(node.left) + ')';
		}
		if (node.kind === 'assign' && node.op === '*=' && (isMatrix(node.left.type) || isMatrix(node.right.type)))
		{
			return render(node.left) + ' = mul(' + render(node.right) + ', ' + render(node.left) + ')';
		}
		return null;
	});

	if (messages && result.parseFailures > 0)
	{
		messages.push({ level: 'warn', text: result.parseFailures + ' expression(s) could not be analysed for matrix multiplication; check any matrix * vector in this pass by hand.' });
	}
	return result.src;
}
// Single-argument atan(x) is left unchanged.
// Uses a character-walk to correctly handle nested parentheses.
// ─────────────────────────────────────────────────────────────────────────────

function rewriteTwoArgAtan(src) {
	var result = [];
	var i = 0;

	while (i < src.length) {
		var atanIdx = src.indexOf('atan', i);
		if (atanIdx === -1) {
			result.push(src.slice(i));
			break;
		}

		// Verify word boundary before 'atan'
		var charBefore = atanIdx > 0 ? src[atanIdx - 1] : ' ';
		if (/\w/.test(charBefore)) {
			result.push(src.slice(i, atanIdx + 4));
			i = atanIdx + 4;
			continue;
		}

		// Skip whitespace to find opening paren
		var j = atanIdx + 4;
		while (j < src.length && src[j] === ' ') { j++; }

		if (src[j] !== '(') {
			result.push(src.slice(i, atanIdx + 4));
			i = atanIdx + 4;
			continue;
		}

		// Walk the argument list counting commas at depth 1
		var depth = 1;
		var k = j + 1;
		var commaAt1 = 0;
		var commaPos = -1;

		while (k < src.length && depth > 0) {
			if (src[k] === '(') { depth++; }
			else if (src[k] === ')') { depth--; }
			else if (src[k] === ',' && depth === 1) {
				commaAt1++;
				if (commaAt1 === 1) { commaPos = k; }
			}
			k++;
		}
		// k now points just past the closing ')'

		result.push(src.slice(i, atanIdx));

		if (commaAt1 === 1) {
			result.push('atan2(');
			result.push(src.slice(j + 1, commaPos).trim());
			result.push(', ');
			result.push(src.slice(commaPos + 1, k - 1).trim());
			result.push(')');
		}
		else {
			// Single-arg or unexpected — leave unchanged
			result.push('atan');
			result.push(src.slice(j, k));
		}

		i = k;
	}

	return result.join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// Rewrite mainImage body —
//   • Move opening brace to its own line (Allman style)
//   • Insert  float4 fragColor = float4(0.0, 0.0, 0.0, 1.0);  at the top
//   • Append  return fragColor;  before the closing brace
// ─────────────────────────────────────────────────────────────────────────────

function rewriteMainBody(src, messages, outVar, coordVar, fnName)
{
	return rewriteOutsideDirectives(src, function (code) { return rewriteMainBodyCode(code, messages, outVar, coordVar, fnName); });
}

function rewriteMainBodyCode(src, messages, outVar, coordVar, fnName) {
	if (!outVar) { outVar = 'fragColor'; }
	if (!coordVar) { coordVar = 'fragCoord'; }
	if (!fnName) { fnName = 'mainImage'; }

	var fnEsc = fnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

	// Move the opening { to its own line if it isn't already (Allman style).
	src = src.replace(
		new RegExp('(void\\s+' + fnEsc + '\\s*\\([^)]*\\))([\\s«»⁰¹²³⁴⁵⁶⁷⁸⁹]*)\\{'),
		function (_, signature, between) { return signature + between + (/\n$/.test(between) ? '' : '\n') + '{'; }
	);

	var sigRegex = new RegExp('void\\s+' + fnEsc + '\\s*\\([^)]*\\)[\\s«»⁰¹²³⁴⁵⁶⁷⁸⁹]*\\{');
	var match = sigRegex.exec(src);

	if (!match) {
		messages.push({ level: 'warn', text: 'Could not locate mainImage body. Check the output manually.' });
		return src;
	}

	var openBrace = match.index + match[0].length;
	var depth = 1;
	var i = openBrace;

	while (i < src.length && depth > 0) {
		if (src[i] === '{') { depth++; }
		else if (src[i] === '}') { depth--; }
		i++;
	}

	var closeBrace = i - 1;
	var before = src.slice(0, openBrace);
	var body = src.slice(openBrace, closeBrace);
	var after = src.slice(closeBrace);

	var newBody =
		'\n\t' + outVar + ' = float4(0.0, 0.0, 0.0, 1.0);\n'
		+ body
		+ '\n';

	return before + newBody + after;
}

// ─────────────────────────────────────────────────────────────────────────────
// Walk balanced parens from the position of '(' and return { samp, args[], end }
// where samp is the first argument and args[] are the top-level comma-separated
// arguments after it. end is just past the closing ')'. Returns null if there is
// only one argument. Commas inside nested parentheses are not split.
// ─────────────────────────────────────────────────────────────────────────────

function splitCallArgs(s, parenPos)
{
	var depth = 1;
	var k = parenPos + 1;
	var commas = [];
	while (k < s.length && depth > 0)
	{
		if (s[k] === '(') { depth++; }
		else if (s[k] === ')') { depth--; }
		else if (s[k] === ',' && depth === 1) { commas.push(k); }
		k++;
	}
	if (commas.length === 0) { return null; } // malformed
	var samp = s.slice(parenPos + 1, commas[0]).trim();
	var rest = [];
	for (var ci = 0; ci < commas.length; ci++)
	{
		var from = commas[ci] + 1;
		var to   = ci + 1 < commas.length ? commas[ci + 1] : k - 1;
		rest.push(s.slice(from, to).trim());
	}
	return { samp: samp, args: rest, end: k };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rewrite texel fetches.
//   texelFetch(s, p, lod)  →  tex2Dfetch(s, p, lod)   (a literal lod of 0 is the default and is dropped)
//   textureSize(s, lod)    →  tex2Dsize(s, lod)
// Both fetch by integer texel position. Buffers keep Shadertoy's row order, so a fetch from a
// buffer needs no flip; textures with a Vflip option are handled later by rewriteTextureVFlip.
// ─────────────────────────────────────────────────────────────────────────────

function rewriteTexelFetch(src)
{
	var result = [];
	var last = 0;
	var re = /\btexelFetch\s*\(/g;
	var m;
	while ((m = re.exec(src)) !== null)
	{
		var parsed = splitCallArgs(src, m.index + m[0].length - 1);
		if (!parsed || parsed.args.length < 1) { continue; }
		var args = [parsed.samp, parsed.args[0]];
		if (parsed.args.length > 1 && parsed.args[1] !== '0') { args.push(parsed.args[1]); }
		result.push(src.slice(last, m.index));
		result.push('tex2Dfetch(' + args.join(', ') + ')');
		last = parsed.end;
		re.lastIndex = last;
	}
	result.push(src.slice(last));
	return result.join('').replace(/\btextureSize\s*\(/g, 'tex2Dsize(');
}

var CUBEMAP_HELPER_SOURCE =
	'// ST_cubemap_uv: maps a direction vector to a 2D UV in a 6-face horizontal strip.\n'
	+ '// Face order (left to right): +X, -X, +Y, -Y, +Z, -Z\n'
	+ 'float2 ST_cubemap_uv(float3 d)\n'
	+ '{\n'
	+ '\tfloat3 a = abs(d);\n'
	+ '\tfloat face;\n'
	+ '\tfloat2 uv;\n'
	+ '\tif (a.x >= a.y && a.x >= a.z)\n'
	+ '\t{\n'
	+ '\t\tface = d.x > 0.0 ? 0.0 : 1.0;\n'
	+ '\t\tuv   = d.x > 0.0 ? float2(-d.z, -d.y) / a.x\n'
	+ '\t\t                  : float2( d.z, -d.y) / a.x;\n'
	+ '\t}\n'
	+ '\telse if (a.y >= a.z)\n'
	+ '\t{\n'
	+ '\t\tface = d.y > 0.0 ? 2.0 : 3.0;\n'
	+ '\t\tuv   = d.y > 0.0 ? float2( d.x,  d.z) / a.y\n'
	+ '\t\t                  : float2( d.x, -d.z) / a.y;\n'
	+ '\t}\n'
	+ '\telse\n'
	+ '\t{\n'
	+ '\t\tface = d.z > 0.0 ? 4.0 : 5.0;\n'
	+ '\t\tuv   = d.z > 0.0 ? float2( d.x, -d.y) / a.z\n'
	+ '\t\t                  : float2(-d.x, -d.y) / a.z;\n'
	+ '\t}\n'
	+ '\tuv = uv * 0.5 + 0.5;\n'
	+ '\tuv.x = (uv.x + face) * (1.0 / 6.0);\n'
	+ '\treturn uv;\n'
	+ '}\n';

// Put the ST_cubemap_uv() helper in front of the source when it is used and not yet defined
function injectCubemapHelper(src)
{
	if (!/\bST_cubemap_uv\s*\(/.test(src) || /float2\s+ST_cubemap_uv\s*\(/.test(src)) { return src; }
	return CUBEMAP_HELPER_SOURCE + '\n' + src;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rewrite cubemap lookups made with texture() / textureLod().
//
// A Shadertoy cubemap is sampled with the ordinary  texture(samp, vec3 dir)  but ReShade has the six
// faces side by side in one 2D strip, so the direction must go through ST_cubemap_uv. A lookup is a
// cubemap lookup when its sampler is a cubemap channel (the UI says which) or when its coordinate is
// a three-component vector, which a 2D texture never takes; the second rule also covers a samplerCube
// function parameter. Without this the third component is silently dropped and the wrong texel read.
//
//   tex2D(s, dir)                         →  tex2D(s, ST_cubemap_uv(dir))
//   tex2Dlod(s, float4(dir, 0.0, lod))    →  tex2Dlod(s, float4(ST_cubemap_uv(dir), 0.0, lod))
// ─────────────────────────────────────────────────────────────────────────────

function rewriteCubemapLookups(src, cubemapSamplers, messages)
{
	src = src.replace(/\bsamplerCube\b/g, 'sampler2D');
	if (!/\btex2D(?:lod|bias|grad)?\s*\(/.test(src)) { return src; }

	var count = 0;
	var unsupported = {};
	var result = rewriteExpressions(src, function (node, render)
	{
		if (node.kind !== 'call' || node.args.length < 2) { return null; }
		if (node.name !== 'tex2D' && node.name !== 'tex2Dlod' && node.name !== 'tex2Dgrad' && node.name !== 'tex2Dbias') { return null; }
		var cubeSampler = node.args[0].kind === 'ident' && cubemapSamplers.indexOf(node.args[0].name) !== -1;
		var coord = node.args[1];
		var type = coord.type && anParseType(coord.type);

		if (node.name === 'tex2D' || node.name === 'tex2Dgrad')
		{
			var isDirection = (type && type.kind === 'vec' && type.rows === 3) || (cubeSampler && !type);
			if (!isDirection) { return null; }
			if (node.name === 'tex2Dgrad') { unsupported['tex2Dgrad'] = true; }
			count++;
			return 'tex2D(' + render(node.args[0]) + ', ST_cubemap_uv(' + render(coord) + '))';
		}

		if (node.name === 'tex2Dlod')
		{
			var ctor = coord.kind === 'call' && coord.name === 'float4' && coord.args.length >= 2 && coord.args.length <= 3;
			var first = ctor && coord.args[0].type && anParseType(coord.args[0].type);
			if (ctor && first && first.kind === 'vec' && first.rows === 3)
			{
				var lod = render(coord.args[coord.args.length - 1]);
				count++;
				return 'tex2Dlod(' + render(node.args[0]) + ', float4(ST_cubemap_uv(' + render(coord.args[0]) + '), 0.0, ' + lod + ')' + (node.args.length > 2 ? ', ' + render(node.args[2]) : '') + ')';
			}
			if (cubeSampler && !ctor)
			{
				var c = render(coord);
				var wrapped = /^[\w.]+$/.test(c) ? c : '(' + c + ')';
				count++;
				return 'tex2Dlod(' + render(node.args[0]) + ', float4(ST_cubemap_uv(' + wrapped + '.xyz), 0.0, ' + wrapped + '.w)' + (node.args.length > 2 ? ', ' + render(node.args[2]) : '') + ')';
			}
			return null;
		}

		// tex2Dbias on a cubemap sampler is not translated
		if (cubeSampler) { unsupported['tex2Dbias'] = true; }
		return null;
	});

	if (messages && count > 0)
	{
		messages.push({ level: 'info', text: count + ' cubemap lookup(s) made with texture() / textureLod() rewritten to use ST_cubemap_uv().' });
	}
	if (messages && unsupported['tex2Dgrad'])
	{
		messages.push({ level: 'warn', text: 'A cubemap lookup with explicit gradients (textureGrad) was turned into a plain lookup; the gradients cannot be mapped onto the strip.' });
	}
	if (messages && unsupported['tex2Dbias'])
	{
		messages.push({ level: 'warn', text: 'A cubemap lookup with a bias was not translated; check it by hand.' });
	}
	return injectCubemapHelper(result.src);
}

// ─────────────────────────────────────────────────────────────────────────────
// Rewrite textureCube / textureCubeLod calls to tex2D with UV helper
//
// GLSL:  textureCube(samp, dir)          → tex2D(samp, ST_cubemap_uv(dir))
// GLSL:  textureCubeLod(samp, dir, lod)  → tex2Dlod(samp, float4(ST_cubemap_uv(dir), 0.0, lod))
//
// Injects ST_cubemap_uv() helper once at the top of the source when needed.
// Face layout (standard OpenGL / Shadertoy convention, left-to-right strip):
//   face 0 = +X,  face 1 = -X
//   face 2 = +Y,  face 3 = -Y
//   face 4 = +Z,  face 5 = -Z
// ─────────────────────────────────────────────────────────────────────────────

function rewriteCubemapSamples(src, messages)
{
	var hasCube    = /\btextureCube\s*\(/.test(src);
	var hasCubeLod = /\btextureCubeLod\s*\(/.test(src);
	if (!hasCube && !hasCubeLod) { return src; }

	// Rewrite all textureCube(samp, dir) occurrences
	if (hasCube)
	{
		var result = [];
		var last   = 0;
		var re     = /\btextureCube\s*\(/g;
		var m;
		while ((m = re.exec(src)) !== null)
		{
			var parenPos = m.index + m[0].length - 1;
			var parsed   = splitCallArgs(src, parenPos);
			if (!parsed) { continue; }
			result.push(src.slice(last, m.index));
			result.push('tex2D(' + parsed.samp + ', ST_cubemap_uv(' + parsed.args[0] + '))');
			last = parsed.end;
			re.lastIndex = last;
		}
		result.push(src.slice(last));
		src = result.join('');
	}

	// Rewrite all textureCubeLod(samp, dir, lod) occurrences
	if (hasCubeLod)
	{
		var result = [];
		var last   = 0;
		var re     = /\btextureCubeLod\s*\(/g;
		var m;
		while ((m = re.exec(src)) !== null)
		{
			var parenPos = m.index + m[0].length - 1;
			var parsed   = splitCallArgs(src, parenPos);
			if (!parsed || parsed.args.length < 2) { continue; }
			var dir = parsed.args[0];
			var lod = parsed.args[1];
			result.push(src.slice(last, m.index));
			result.push('tex2Dlod(' + parsed.samp + ', float4(ST_cubemap_uv(' + dir + '), 0.0, ' + lod + '))');
			last = parsed.end;
			re.lastIndex = last;
		}
		result.push(src.slice(last));
		src = result.join('');
	}

	src = injectCubemapHelper(src);

	messages.push({ level: 'info', text: 'textureCube() rewritten to tex2D() + ST_cubemap_uv() helper (horizontal 6-face strip, +X/-X/+Y/-Y/+Z/-Z order).' });
	return src;
}

// ─────────────────────────────────────────────────────────────────────────────
// Flip V at the sample sites of textures with a Vflip option.
//
// Shadertoy uploads such textures upside-down, so v = 0 is the bottom row of the image; in
// ReShade v = 0 is the top row. samplerFlags maps a sampler name (iChannel0 ...) to the
// expression that says whether to flip it, normally a preprocessor definition the user can
// change in ReShade. For every texture call on such a sampler the V coordinate is conditionally
// mirrored:  tex2D(s, uv)  →  tex2D(s, ST_flipV(uv, FLAG)).
//
// A sampler can also be handed to a user function (blur(iChannel0, uv) → sampler2D sp inside it).
// The flag travels with it: every sampler2D parameter gets a following  bool <name>_vflip
// parameter, every call passes the flag of its sampler argument (false for samplers without
// the option), and the sample sites inside the function use that parameter.
//
// Returns { src, count, helpers, warnings }. helpers says which ST_flip* functions the result
// uses, so the caller can emit their definitions.
// ─────────────────────────────────────────────────────────────────────────────

function rewriteTextureVFlip(src, samplerFlags)
{
	var helpers = { v2: false, v4: false, dir: false, fetch: false };
	var warnings = [];
	if (Object.keys(samplerFlags).length === 0) { return { src: src, count: 0, helpers: helpers, warnings: warnings }; }

	var A = analyzeSource(src);
	var warned = {};
	var count = 0;

	function warnOnce(key, text)
	{
		if (!warned[key]) { warned[key] = true; warnings.push(text); }
	}

	function enclosingFunction(sigIndex)
	{
		var names = Object.keys(A.functions);
		for (var i = 0; i < names.length; i++)
		{
			var list = A.functions[names[i]];
			for (var j = 0; j < list.length; j++)
			{
				if (list[j].bodyFrom !== undefined && sigIndex >= list[j].bodyFrom && sigIndex <= list[j].bodyTo) { return list[j]; }
			}
		}
		return null;
	}

	function isSamplerParam(fn, name)
	{
		if (!fn) { return false; }
		for (var i = 0; i < fn.params.length; i++)
		{
			if (fn.params[i].name === name && fn.params[i].type === 'sampler2D') { return true; }
		}
		return false;
	}

	// User functions that take sampler2D parameters: name → indices of those parameters
	var samplerParams = {};
	Object.keys(A.functions).forEach(function (name)
	{
		A.functions[name].forEach(function (fn)
		{
			fn.params.forEach(function (param, k)
			{
				if (param.type !== 'sampler2D') { return; }
				samplerParams[name] = samplerParams[name] || [];
				if (samplerParams[name].indexOf(k) === -1) { samplerParams[name].push(k); }
			});
		});
	});

	// The flag expression for a sampler argument: 'false' when it has no Vflip option,
	// null when the argument is not a plain name and so cannot be traced.
	function flagOf(arg, fn)
	{
		if (!arg || arg.kind !== 'ident') { return null; }
		if (isSamplerParam(fn, arg.name)) { return arg.name + '_vflip'; }
		return samplerFlags[arg.name] !== undefined ? samplerFlags[arg.name] : 'false';
	}

	var result = rewriteExpressions(src, function (node, render)
	{
		if (node.kind !== 'call') { return null; }
		var fn = enclosingFunction(node.from);
		var quiet = A.isDead(node); // no warnings about code in a dead #if branch

		// a call to a user function that takes samplers: pass each sampler's flag along with it
		if (samplerParams[node.name])
		{
			var passed = [];
			node.args.forEach(function (arg, k)
			{
				passed.push(render(arg));
				if (samplerParams[node.name].indexOf(k) === -1) { return; }
				var flag = flagOf(arg, fn);
				if (flag === null)
				{
					if (!quiet) { warnOnce('trace:' + node.name, 'A sampler passed to ' + node.name + '() is not a plain name, so its Vflip cannot be followed; it is treated as not flipped.'); }
					flag = 'false';
				}
				passed.push(flag);
			});
			return node.name + '(' + passed.join(', ') + ')';
		}

		var isSample = node.name === 'tex2D' || node.name === 'tex2Dlod' || node.name === 'tex2Dbias' || node.name === 'tex2Dgrad';
		var isFetch = node.name === 'tex2Dfetch';
		var isUnsupported = node.name === 'tex2Dproj' || node.name === 'texelFetch';
		if ((!isSample && !isFetch && !isUnsupported) || !node.args.length) { return null; }

		var flag = flagOf(node.args[0], fn);
		if (flag === null)
		{
			if (!quiet) { warnOnce('trace:' + node.name, node.name + '() on a sampler that is not a plain name: its Vflip cannot be followed, so V is not flipped there.'); }
			return null;
		}
		if (flag === 'false') { return null; }
		if (isUnsupported)
		{
			if (!quiet) { warnOnce('unsupported:' + node.name, node.name + '() on a Vflip texture is not flipped automatically; check its V coordinate by hand.'); }
			return null;
		}

		var parts = node.args.map(function (arg) { return render(arg); });

		// The offset overloads take a constant int2 offset that cannot be mirrored through a function, so
		// for a texture with a Vflip option the offset is folded into the coordinate instead:
		//   v' = 1 - (v + off.y / height)  is the mirrored lookup at an offset of off texels.
		var offsetIndex = (node.name === 'tex2D' && node.args.length === 3) || (node.name === 'tex2Dlod' && node.args.length === 3) ? 2
			: (node.name === 'tex2Dgrad' && node.args.length === 5 ? 4 : -1);
		if (offsetIndex >= 0)
		{
			var off = parts[offsetIndex];
			var sampler = parts[0];
			var moved = function (coord, lod)
			{
				var size = 'tex2Dsize(' + sampler + (lod ? ', int(' + lod + ')' : '') + ')';
				var base = /^[\w.]+$/.test(coord) ? coord : '(' + coord + ')';
				return base + ' + float2(' + off + ') / float2(' + size + ')';
			};
			if (node.name === 'tex2D')
			{
				parts = [parts[0], 'ST_flipV(' + moved(parts[1]) + ', ' + flag + ')'];
				helpers.v2 = true;
			}
			else if (node.name === 'tex2Dgrad')
			{
				parts = [parts[0], 'ST_flipV(' + moved(parts[1]) + ', ' + flag + ')', 'ST_flipDir(' + parts[2] + ', ' + flag + ')', 'ST_flipDir(' + parts[3] + ', ' + flag + ')'];
				helpers.v2 = true;
				helpers.dir = true;
			}
			else
			{
				// tex2Dlod: the float4 coordinate is (u, v, 0, lod)
				var coord4 = node.args[1];
				var ctor = coord4.kind === 'call' && coord4.name === 'float4' && coord4.args.length === 3 && anParseType(coord4.args[0].type || '');
				if (ctor && ctor.kind === 'vec' && ctor.rows === 2)
				{
					var lodText = render(coord4.args[2]);
					parts = [parts[0], 'float4(ST_flipV(' + moved(render(coord4.args[0]), lodText) + ', ' + flag + '), ' + render(coord4.args[1]) + ', ' + lodText + ')'];
				}
				else
				{
					var c4 = /^[\w.]+$/.test(parts[1]) ? parts[1] : '(' + parts[1] + ')';
					parts = [parts[0], 'float4(ST_flipV(' + moved(c4 + '.xy', c4 + '.w') + ', ' + flag + '), ' + c4 + '.zw)'];
				}
				helpers.v2 = true;
			}
			count++;
			return node.name + '(' + parts.join(', ') + ')';
		}

		if (isFetch)
		{
			// the row counts from the other end of a texture that Shadertoy stores upside-down
			var lod = parts.length > 2 ? ', ' + parts[2] : '';
			parts[1] = 'ST_flipFetch(' + parts[1] + ', tex2Dsize(' + parts[0] + lod + '), ' + flag + ')';
			helpers.fetch = true;
		}
		else if (node.name === 'tex2D' || node.name === 'tex2Dgrad')
		{
			parts[1] = 'ST_flipV(' + parts[1] + ', ' + flag + ')';
			helpers.v2 = true;
			if (node.name === 'tex2Dgrad' && parts.length >= 4)
			{
				parts[2] = 'ST_flipDir(' + parts[2] + ', ' + flag + ')';
				parts[3] = 'ST_flipDir(' + parts[3] + ', ' + flag + ')';
				helpers.dir = true;
			}
		}
		else
		{
			// tex2Dlod / tex2Dbias take a float4 coordinate
			var coord = node.args[1];
			var firstType = coord.kind === 'call' && coord.name === 'float4' && coord.args.length === 3 && anParseType(coord.args[0].type || '');
			if (firstType && firstType.kind === 'vec' && firstType.rows === 2)
			{
				parts[1] = 'float4(ST_flipV(' + render(coord.args[0]) + ', ' + flag + '), ' + render(coord.args[1]) + ', ' + render(coord.args[2]) + ')';
				helpers.v2 = true;
			}
			else
			{
				parts[1] = 'ST_flipV4(' + parts[1] + ', ' + flag + ')';
				helpers.v4 = true;
			}
		}
		count++;
		return node.name + '(' + parts.join(', ') + ')';
	});

	// Add the  bool <name>_vflip  parameter after every sampler2D parameter (definitions and prototypes)
	var out = result.src;
	if (Object.keys(samplerParams).length > 0)
	{
		var B = analyzeSource(out);
		var inserts = [];
		Object.keys(B.functions).forEach(function (name)
		{
			B.functions[name].forEach(function (fn)
			{
				fn.params.forEach(function (param)
				{
					if (param.type === 'sampler2D') { inserts.push({ at: B.tokens[B.sig[param.tok]].end, text: ', bool ' + param.name + '_vflip' }); }
				});
			});
		});
		inserts.sort(function (x, y) { return y.at - x.at; }).forEach(function (ins)
		{
			out = out.slice(0, ins.at) + ins.text + out.slice(ins.at);
		});
	}

	return { src: out, count: count, helpers: helpers, warnings: warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rename identifiers that ReShade FX reserves.
//
// GLSL lets a shader call a variable half, matrix, vector, texture, string, sample, register ...
// but each of those is a keyword to the ReShade FX compiler. The list is the keyword table of
// ReShade's own lexer (effect_lexer.cpp), minus the words GLSL itself uses as keywords or types
// (if, const, struct, sampler2D ...) and the preprocessor directive names. A reserved word gets a
// trailing underscore, everywhere: declarations, uses, struct fields and #define lines.
//
// texture / texture1D / texture2D / texture3D are also GLSL's sampling functions, so they are
// renamed only where they are not being called.
// ─────────────────────────────────────────────────────────────────────────────

var RESERVED_IDENTIFIERS = (function ()
{
	var words = ('FALSE TRUE SamplerState Texture1D Texture1DArray Texture2D Texture2DArray Texture2DMS Texture2DMSArray Texture3D '
		+ 'TextureCube TextureCubeArray asm asm_fragment auto cast catch char class column_major compile const_cast delete '
		+ 'double dynamic_cast enum explicit extern external friend globallycoherent goto groupshared half inline linear long '
		+ 'matrix mutable namespace new noinline nointerpolation noperspective operator packed packoffset pass point line precise '
		+ 'private protected public register reinterpret_cast restrict row_major sample sampler sampler_state samplerRECT samplerRect '
		+ 'shared short signed sizeof snorm static_cast storage storage1D storage2D storage3D string technique template texture '
		+ 'texture1D texture2D texture3D textureCUBE textureRECT this try typedef union unorm unsigned using vector virtual volatile '
		+ 'foreach interface samplerCUBE '
		// reserved by HLSL itself rather than by ReShade's lexer; ReShade writes local names straight into the HLSL
		// that the Direct3D compiler then reads, so these fail there even though ReShade's own parser accepts them
		+ 'decl export triangle triangleadj lineadj cbuffer tbuffer NULL stateblock stateblock_state fxgroup technique10 technique11 '
		+ 'pixelfragment vertexfragment compile_fragment CompileShader BlendState DepthStencilState DepthStencilView RasterizerState '
		+ 'RenderTargetView SamplerComparisonState Buffer ByteAddressBuffer StructuredBuffer AppendStructuredBuffer ConsumeStructuredBuffer '
		+ 'RWBuffer RWByteAddressBuffer RWStructuredBuffer RWTexture1D RWTexture1DArray RWTexture2D RWTexture2DArray RWTexture3D '
		+ 'InputPatch OutputPatch LineStream PointStream TriangleStream ComputeShader DomainShader GeometryShader HullShader PixelShader VertexShader').split(' ');
	var map = {};
	words.forEach(function (w) { map[w] = w + '_'; });
	// the HLSL half and min16 type families (half2, half3x3, min16float4 ...) and dword vectors
	['half', 'dword', 'min16float', 'min16int', 'min16uint'].forEach(function (family)
	{
		map[family] = family + '_';
		for (var n = 1; n <= 4; n++)
		{
			map[family + n] = family + n + '_';
			for (var m = 1; m <= 4; m++) { map[family + n + 'x' + m] = family + n + 'x' + m + '_'; }
		}
	});
	return map;
}());

var RESERVED_BUT_ALSO_GLSL_FUNCTIONS = { texture: true, texture1D: true, texture2D: true, texture3D: true };

function renameReservedIdentifiers(src, messages)
{
	var renamed = {};
	var tokens = tokenizeSource(src);
	var out = tokens.map(function (token, i)
	{
		if (token.type === 'ident' && Object.prototype.hasOwnProperty.call(RESERVED_IDENTIFIERS, token.text))
		{
			if (RESERVED_BUT_ALSO_GLSL_FUNCTIONS[token.text])
			{
				var j = i + 1;
				while (j < tokens.length && (tokens[j].type === 'ws' || tokens[j].type === 'comment' || tokens[j].type === 'placeholder')) { j++; }
				if (j < tokens.length && tokens[j].text === '(') { return token.text; }
			}
			renamed[token.text] = true;
			return RESERVED_IDENTIFIERS[token.text];
		}
		if (token.type === 'preproc' && !/^#\s*(include|pragma|error|warning)\b/.test(token.text))
		{
			return token.text.replace(/\b[A-Za-z_]\w*\b/g, function (word, offset)
			{
				if (!Object.prototype.hasOwnProperty.call(RESERVED_IDENTIFIERS, word)) { return word; }
				if (RESERVED_BUT_ALSO_GLSL_FUNCTIONS[word] && /^\s*\(/.test(token.text.slice(offset + word.length))) { return word; }
				renamed[word] = true;
				return RESERVED_IDENTIFIERS[word];
			});
		}
		return token.text;
	}).join('');
	var names = Object.keys(renamed);
	if (messages && names.length > 0)
	{
		messages.push({ level: 'info', text: 'Renamed identifiers that are reserved words in ReShade FX: ' + names.map(function (n) { return n + ' → ' + n + '_'; }).join(', ') + '.' });
	}
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rewrite GLSL array constructors.
//   float[3](1., 2., 3.)   →  {1., 2., 3.}        (the size may be left out: float[](...))
//   vec2[2](vec2(..), ..)  →  {float2(..), ..}    (arguments may contain parentheses and nest)
//   float[3] a = ...       →  float a[3] = ...    (GLSL allows the brackets after the type)
// ─────────────────────────────────────────────────────────────────────────────

function rewriteArrayConstructors(src, structNames)
{
	var types = 'float[234]?(?:x[234])?|int[234]?|uint[234]?|bool[234]?' + structNames.map(function (n) { return '|' + n; }).join('');
	var ctor = new RegExp('\\b(?:' + types + ')\\s*\\[[^\\[\\]]*\\]\\s*\\(', 'g');
	var out = [];
	var last = 0;
	var m;
	while ((m = ctor.exec(src)) !== null)
	{
		var open = m.index + m[0].length - 1;
		var depth = 1;
		var k = open + 1;
		while (k < src.length && depth > 0)
		{
			if (src[k] === '(') { depth++; }
			else if (src[k] === ')') { depth--; }
			k++;
		}
		if (depth !== 0) { continue; }
		out.push(src.slice(last, m.index));
		out.push('{' + rewriteArrayConstructors(src.slice(open + 1, k - 1), structNames) + '}');
		last = k;
		ctor.lastIndex = k;
	}
	out.push(src.slice(last));
	var declaration = new RegExp('\\b(' + types + ')\\s*\\[\\s*([^\\[\\]]*?)\\s*\\]\\s+([A-Za-z_]\\w*)(?=\\s*[=;,)])', 'g');
	return out.join('').replace(declaration, '$1 $3[$2]');
}

// ─────────────────────────────────────────────────────────────────────────────
// Rewrite diagonal matrix constructors:  mat2(s)  →  float2x2(s, 0.0, 0.0, s)
//
// In GLSL a matrix built from one scalar has that scalar on its diagonal and zeros elsewhere, so
// mat3(1.0) is the identity. ReShade FX wants every element spelled out (X3014). The diagonal is
// the same whichever way the matrix is stored. A matrix built from another matrix is left alone.
// ─────────────────────────────────────────────────────────────────────────────

function rewriteDiagonalMatrices(src, messages)
{
	var result = rewriteExpressions(src, function (node, render)
	{
		if (node.kind !== 'call' || node.args.length !== 1) { return null; }
		var target = anParseType(node.ctor || node.name);
		if (!target || target.kind !== 'mat') { return null; }
		var argType = node.args[0].type && anParseType(node.args[0].type);
		if (!argType || argType.kind !== 'scalar') { return null; }

		var text = render(node.args[0]);
		var parts = [];
		for (var row = 0; row < target.rows; row++)
		{
			for (var col = 0; col < target.cols; col++) { parts.push(row === col ? text : '0.0'); }
		}
		return node.name + '(' + parts.join(', ') + ')';
	});

	if (messages && result.parseFailures > 0)
	{
		messages.push({ level: 'warn', text: result.parseFailures + ' expression(s) could not be analysed for diagonal matrix constructors; check any matrix built from a single scalar by hand.' });
	}
	return result.src;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rewrite GLSL built-ins that ReShade FX lacks or names differently.
//
//   lessThan(a, b)  lessThanEqual  greaterThan  greaterThanEqual  equal  notEqual  →  a < b  and so on
//   not(x)                                                                          →  !x
//   roundEven → round    floatBitsToInt → asint    floatBitsToUint → asuint
//   intBitsToFloat / uintBitsToFloat → asfloat
//
// ReShade FX has none of the comparison functions, but its operators work on vectors and give
// a bool vector, which is what GLSL's functions return. A function the shader defines itself
// under one of these names is left alone.
// ─────────────────────────────────────────────────────────────────────────────

var GLSL_COMPARISON_FUNCTIONS = { lessThan: '<', lessThanEqual: '<=', greaterThan: '>', greaterThanEqual: '>=', equal: '==', notEqual: '!=' };
var GLSL_RENAMED_BUILTINS = { roundEven: 'round', floatBitsToInt: 'asint', floatBitsToUint: 'asuint', intBitsToFloat: 'asfloat', uintBitsToFloat: 'asfloat' };

function rewriteGlslBuiltins(src)
{
	function definedByShader(name)
	{
		return new RegExp('\\b(?:void|bool[234]?|int[234]?|uint[234]?|float[234]?(?:x[234])?|\\w+)\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{').test(src);
	}

	// an operand is used as is when it is a plain name or already wrapped in one pair of parentheses
	function operand(text)
	{
		if (/^[\w.]+$/.test(text)) { return text; }
		if (text[0] === '(')
		{
			var depth = 0;
			for (var i = 0; i < text.length; i++)
			{
				if (text[i] === '(') { depth++; }
				else if (text[i] === ')') { depth--; if (depth === 0) { return i === text.length - 1 ? text : '(' + text + ')'; } }
			}
		}
		return '(' + text + ')';
	}

	function rewrite(text)
	{
		var names = Object.keys(GLSL_COMPARISON_FUNCTIONS).concat(['not']).filter(function (n) { return !definedByShader(n); });
		if (names.length === 0) { return text; }
		var re = new RegExp('\\b(' + names.join('|') + ')\\s*\\(', 'g');
		var out = [];
		var last = 0;
		var m;
		while ((m = re.exec(text)) !== null)
		{
			var open = m.index + m[0].length - 1;
			var parsed = splitCallArgs(text, open);
			var args;
			if (m[1] === 'not')
			{
				// one argument: splitCallArgs wants a comma, so find the closing parenthesis by hand
				var depth = 1;
				var k = open + 1;
				while (k < text.length && depth > 0) { if (text[k] === '(') { depth++; } else if (text[k] === ')') { depth--; } k++; }
				if (depth !== 0) { continue; }
				var inner = rewrite(text.slice(open + 1, k - 1).trim());
				out.push(text.slice(last, m.index));
				out.push('(!' + operand(inner) + ')');
				last = k;
				re.lastIndex = k;
				continue;
			}
			if (!parsed || parsed.args.length !== 1) { continue; }
			args = [rewrite(parsed.samp), rewrite(parsed.args[0])];
			out.push(text.slice(last, m.index));
			out.push('(' + operand(args[0]) + ' ' + GLSL_COMPARISON_FUNCTIONS[m[1]] + ' ' + operand(args[1]) + ')');
			last = parsed.end;
			re.lastIndex = parsed.end;
		}
		out.push(text.slice(last));
		return out.join('');
	}

	var renames = {};
	Object.keys(GLSL_RENAMED_BUILTINS).forEach(function (name) { if (!definedByShader(name)) { renames[name] = GLSL_RENAMED_BUILTINS[name]; } });
	return renameIdentifiers(rewrite(src), renames);
}

// ─────────────────────────────────────────────────────────────────────────────
// Make switch statements acceptable to ReShade FX.
//
// ReShade requires every non-empty case to end in break or return (X3533); GLSL does not, and
// the last group, usually default:, is often left open. A final group without a terminator gets a
// break; the result is the same. A group in the middle that falls through into the next one cannot
// be expressed, so it is reported instead of changed.
// ─────────────────────────────────────────────────────────────────────────────

function rewriteSwitchBreaks(src, messages)
{
	var tokens = tokenizeSource(src);
	var insertions = [];
	var fallthrough = 0;

	function sig(i) { return tokens[i]; }
	function isSignificant(t) { return t.type !== 'ws' && t.type !== 'comment' && t.type !== 'placeholder' && t.type !== 'preproc'; }

	for (var i = 0; i < tokens.length; i++)
	{
		if (!(tokens[i].type === 'ident' && tokens[i].text === 'switch')) { continue; }
		// find the opening brace of the switch body
		var j = i + 1;
		var parenDepth = 0;
		while (j < tokens.length)
		{
			if (tokens[j].text === '(') { parenDepth++; }
			else if (tokens[j].text === ')') { parenDepth--; }
			else if (tokens[j].text === '{' && parenDepth === 0) { break; }
			j++;
		}
		if (j >= tokens.length) { continue; }
		var bodyOpen = j;
		var depth = 0;
		var bodyClose = -1;
		var labels = []; // index of each top-level case/default token
		for (j = bodyOpen; j < tokens.length; j++)
		{
			var t = tokens[j];
			if (t.text === '{') { depth++; }
			else if (t.text === '}') { depth--; if (depth === 0) { bodyClose = j; break; } }
			else if (depth === 1 && t.type === 'ident' && (t.text === 'case' || t.text === 'default')) { labels.push(j); }
		}
		if (bodyClose < 0) { continue; }

		labels.forEach(function (labelIdx, g)
		{
			var isLast = g === labels.length - 1;
			var groupEnd = isLast ? bodyClose : labels[g + 1];
			// skip past the label's colon
			var k = labelIdx;
			while (k < groupEnd && tokens[k].text !== ':') { k++; }
			k++;
			// last significant tokens of the group body
			var body = [];
			for (var q = k; q < groupEnd; q++) { if (isSignificant(tokens[q])) { body.push(q); } }
			if (body.length === 0) { return; } // empty case: falls into the next one, which is allowed
			var lastTok = tokens[body[body.length - 1]];
			var prevTok = body.length > 1 ? tokens[body[body.length - 2]] : null;
			var closesBlock = lastTok.text === '}';
			var endsWithBreak = lastTok.text === ';' && prevTok && (prevTok.text === 'break' || prevTok.text === 'continue' || prevTok.text === 'discard');
			var returns = false;
			for (var r = body.length - 1; r >= 0; r--)
			{
				// a statement starting with return that ends the group
				if (tokens[body[r]].text === ';' && r < body.length - 1) { break; }
				if (tokens[body[r]].text === 'return') { returns = true; }
			}
			if (endsWithBreak || returns || closesBlock) { return; }
			if (isLast) { insertions.push({ at: tokens[body[body.length - 1]].end, text: ' break;' }); }
			else { fallthrough++; }
		});
	}

	if (messages && fallthrough > 0)
	{
		messages.push({ level: 'warn', text: fallthrough + ' switch case(s) fall through into the next case; ReShade FX does not allow that, add a break or repeat the code.' });
	}
	var out = src;
	insertions.sort(function (a, b) { return b.at - a.at; }).forEach(function (ins) { out = out.slice(0, ins.at) + ins.text + out.slice(ins.at); });
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers for GLSL built-ins that ReShade FX does not have.
//
//   inverse(mat2/3/4)        the matrix inverse, written out from its cofactors
//   outerProduct(c, r)       c * transpose(r), in the element order a matrix constructor takes
//   matrixCompMult(a, b)     component-wise product (a plain * on matrices would be a matrix product)
//
// Each helper is added to the pass source only when the shader calls it, and only for the matrix
// sizes the shader uses. A shader that defines a function with that name itself is left alone.
// Overloads for several sizes are fine in ReShade FX, and a helper repeated by several passes is
// removed again by the function de-duplication.
//
// A matrix is stored transposed (see rewriteInlineMatrixMul), and the inverse of a transpose is the
// transpose of the inverse, so the formula applies to the stored matrix unchanged.
// ─────────────────────────────────────────────────────────────────────────────

// The determinant of the submatrix of m that keeps `rows` and `cols`, as an expression over m[r][c]
function matrixMinorExpression(rows, cols)
{
	if (rows.length === 1) { return 'm[' + rows[0] + '][' + cols[0] + ']'; }
	var terms = [];
	for (var k = 0; k < cols.length; k++)
	{
		var rest = cols.filter(function (c, i) { return i !== k; });
		var sub = matrixMinorExpression(rows.slice(1), rest);
		terms.push((k % 2 === 0 ? '+ ' : '- ') + 'm[' + rows[0] + '][' + cols[k] + '] * ' + (rows.length > 2 ? '(' + sub + ')' : sub));
	}
	return terms.join(' ').replace(/^\+ /, '');
}

// Row-major element expressions of the inverse of an n x n matrix m, before dividing by the determinant:
// element (i, j) is the cofactor of m[j][i].
function inverseElementExpressions(n)
{
	var all = [];
	for (var i = 0; i < n; i++) { all.push(i); }
	var out = [];
	for (var i2 = 0; i2 < n; i2++)
	{
		for (var j = 0; j < n; j++)
		{
			var rows = all.filter(function (r) { return r !== j; });
			var cols = all.filter(function (c) { return c !== i2; });
			var minor = n === 2 ? 'm[' + rows[0] + '][' + cols[0] + ']' : matrixMinorExpression(rows, cols);
			out.push(((i2 + j) % 2 === 0 ? '' : '-') + '(' + minor + ')');
		}
	}
	return out;
}

function glslHelperSource(name, n)
{
	var type = 'float' + n + 'x' + n;
	var vec = 'float' + n;
	var comps = ['x', 'y', 'z', 'w'].slice(0, n);
	if (name === 'inverse')
	{
		return type + ' inverse(' + type + ' m)\n{\n\tfloat id = 1.0 / determinant(m);\n\treturn ' + type + '(\n\t\t'
			+ inverseElementExpressions(n).map(function (e) { return e + ' * id'; }).join(',\n\t\t') + ');\n}\n\n';
	}
	if (name === 'outerProduct')
	{
		// GLSL builds the columns first: element k is c[k mod n] * r[k div n]
		var args = [];
		for (var k = 0; k < n * n; k++) { args.push('c.' + comps[k % n] + ' * r.' + comps[Math.floor(k / n)]); }
		return type + ' outerProduct(' + vec + ' c, ' + vec + ' r)\n{\n\treturn ' + type + '(' + args.join(', ') + ');\n}\n\n';
	}
	// matrixCompMult: the product of corresponding rows is the product of corresponding elements
	var rows = [];
	for (var r = 0; r < n; r++) { rows.push('a[' + r + '] * b[' + r + ']'); }
	return type + ' matrixCompMult(' + type + ' a, ' + type + ' b)\n{\n\treturn ' + type + '(' + rows.join(', ') + ');\n}\n\n';
}

function injectGlslHelpers(src)
{
	var helpers = '';
	// GLSL stores x in the low half and y in the high half. A helper evaluates
	// the argument once, including when the caller supplies a stateful expression.
	if (/\bunpackHalf2x16\s*\(/.test(src) && !/\bfloat2\s+unpackHalf2x16\s*\([^)]*\)\s*\{/.test(src))
	{
		helpers += 'float2 unpackHalf2x16(uint bits)\n{\n\treturn f16tof32(uint2(bits, bits >> 16));\n}\n\n';
	}
	['inverse', 'outerProduct', 'matrixCompMult'].forEach(function (name)
	{
		if (!new RegExp('\\b' + name + '\\s*\\(').test(src)) { return; }
		if (new RegExp('\\b(?:float\\d?(?:x\\d)?|void)\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{').test(src)) { return; }
		[2, 3, 4].forEach(function (n)
		{
			if (new RegExp('\\bfloat' + n + 'x' + n + '\\b').test(src) || (name === 'outerProduct' && new RegExp('\\bfloat' + n + '\\b').test(src))) { helpers += glslHelperSource(name, n); }
		});
	});
	return helpers + src;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rewrite the GLSL texture lookups that take an offset or a projective coordinate.
//
//   textureOffset(s, uv, off)              →  tex2D(s, uv, off)
//   textureLodOffset(s, uv, lod, off)      →  tex2Dlod(s, float4(uv, 0.0, lod), off)
//   textureGradOffset(s, uv, dx, dy, off)  →  tex2Dgrad(s, uv, dx, dy, off)
//   texelFetchOffset(s, p, lod, off)       →  tex2Dfetch(s, p + off, lod)
//   textureProj(s, p)                      →  tex2D(s, p.xy / p.z)    or  p.xy / p.w  for a float4
//
// ReShade FX has offset overloads of tex2D, tex2Dlod and tex2Dgrad (the offset is an int2 in texels
// and must be a constant, as in GLSL), so those calls map one to one. tex2Dfetch has no offset form,
// so the offset is added to the texel position. There is no projective lookup, so textureProj divides
// by hand. A Vflip texture needs its offset mirrored too; that is handled with the other V flips.
// ─────────────────────────────────────────────────────────────────────────────

function rewriteTextureVariants(src, messages)
{
	if (!/\b(?:textureOffset|textureLodOffset|textureGradOffset|texelFetchOffset|textureProj)\s*\(/.test(src)) { return src; }

	function operand(text)
	{
		return /^[\w.]+$/.test(text) ? text : '(' + text + ')';
	}

	var result = rewriteExpressions(src, function (node, render)
	{
		if (node.kind !== 'call') { return null; }
		var a = node.args;
		if (node.name === 'textureOffset' && a.length === 3)
		{
			return 'tex2D(' + render(a[0]) + ', ' + render(a[1]) + ', ' + render(a[2]) + ')';
		}
		if (node.name === 'textureLodOffset' && a.length === 4)
		{
			return 'tex2Dlod(' + render(a[0]) + ', float4(' + render(a[1]) + ', 0.0, ' + render(a[2]) + '), ' + render(a[3]) + ')';
		}
		if (node.name === 'textureGradOffset' && a.length === 5)
		{
			return 'tex2Dgrad(' + render(a[0]) + ', ' + render(a[1]) + ', ' + render(a[2]) + ', ' + render(a[3]) + ', ' + render(a[4]) + ')';
		}
		if (node.name === 'texelFetchOffset' && a.length === 4)
		{
			var lod = render(a[2]);
			return 'tex2Dfetch(' + render(a[0]) + ', ' + operand(render(a[1])) + ' + ' + operand(render(a[3])) + (lod === '0' ? '' : ', ' + lod) + ')';
		}
		if (node.name === 'textureProj' && a.length === 2)
		{
			var type = a[1].type && anParseType(a[1].type);
			if (!type || type.kind !== 'vec' || type.rows < 3) { return null; }
			var p = operand(render(a[1]));
			return 'tex2D(' + render(a[0]) + ', ' + p + '.xy / ' + p + '.' + (type.rows === 3 ? 'z' : 'w') + ')';
		}
		return null;
	});
	if (messages && result.parseFailures > 0)
	{
		messages.push({ level: 'warn', text: result.parseFailures + ' expression(s) could not be analysed for the texture offset / projection lookups; check those calls by hand.' });
	}
	return result.src;
}

// ─────────────────────────────────────────────────────────────────────────────
// Define every function before it is used.
//
// GLSL lets a shader declare a function near the top and define it further down, so the main code
// can come first. ReShade FX accepts no forward declarations at all: a declaration without its
// body is an error even when the body follows directly (X3510), and a call to a function that is
// defined later is an undeclared identifier. So:
//   - every function declaration that has a definition is removed, and
//   - a function that calls a function defined after it is moved to follow that function.
// Nothing else moves: globals, structs and macros stay where they are. A function moved later only
// gains access to more of them. The call graph of a GLSL program has no cycles, so this ends.
// A function inside an #if block is not moved (that would pull it out of its condition); it is
// reported instead.
// ─────────────────────────────────────────────────────────────────────────────

function reorderFunctions(src, messages)
{
	// quick exit: no declaration without a body anywhere
	if (!/^[A-Za-z_][\w \t]*\b[A-Za-z_]\w*[ \t]*\([^;{}]*\)[ \t]*;/m.test(src)) { return src; }

	var A = analyzeSource(src);
	var definitions = [];
	var prototypes = [];
	Object.keys(A.functions).forEach(function (name)
	{
		A.functions[name].forEach(function (fn)
		{
			var first = A.tokens[A.sig[fn.from]];
			if (fn.bodyFrom !== undefined) { definitions.push({ name: name, fn: fn, start: first.start, end: A.tokens[A.sig[fn.bodyTo]].end, callees: [] }); }
			else { prototypes.push({ name: name, fn: fn, start: first.start, end: A.tokens[A.sig[fn.protoTo]].end }); }
		});
	});
	if (prototypes.length === 0 || definitions.length === 0) { return src; }

	// outermost #if ... #endif blocks, as character ranges
	var blocks = [];
	var depth = 0;
	var blockStart = 0;
	A.tokens.forEach(function (t)
	{
		if (t.type !== 'preproc') { return; }
		if (/^#\s*(if|ifdef|ifndef)\b/.test(t.text)) { if (depth === 0) { blockStart = t.start; } depth++; }
		else if (/^#\s*endif\b/.test(t.text)) { depth--; if (depth === 0) { blocks.push({ start: blockStart, end: t.end }); } }
	});
	function inConditional(item) { return blocks.some(function (b) { return item.start < b.end && item.end > b.start; }); }

	// which functions each definition calls
	var defined = {};
	definitions.forEach(function (d) { defined[d.name] = true; });
	definitions.forEach(function (d)
	{
		var seen = {};
		for (var i = d.fn.bodyFrom; i <= d.fn.bodyTo; i++)
		{
			var tok = A.tokens[A.sig[i]];
			if (tok.type === 'ident' && defined[tok.text] && tok.text !== d.name && A.tokens[A.sig[i + 1]] && A.tokens[A.sig[i + 1]].text === '(' && !(A.tokens[A.sig[i - 1]] && A.tokens[A.sig[i - 1]].text === '.')) { seen[tok.text] = true; }
		}
		d.callees = Object.keys(seen);
	});

	// split the source into  gap, definition, gap, definition ... gap  with declarations cut out of the gaps
	var removed = prototypes.filter(function (p) { return defined[p.name]; });
	var kept = prototypes.filter(function (p) { return !defined[p.name]; });
	var cuts = removed.map(function (p) { return { start: p.start, end: p.end }; });
	definitions.sort(function (a, b) { return a.start - b.start; });
	var gaps = [];
	var cursor = 0;
	function gapText(from, to)
	{
		var text = '';
		var at = from;
		cuts.filter(function (c) { return c.start >= from && c.end <= to; }).sort(function (a, b) { return a.start - b.start; }).forEach(function (c)
		{
			text += src.slice(at, c.start);
			at = c.end;
			if (src[at] === '\r') { at++; }
			if (src[at] === '\n') { at++; } // the declaration's own line goes with it
		});
		return text + src.slice(at, to);
	}
	definitions.forEach(function (d) { gaps.push(gapText(cursor, d.start)); cursor = d.end; d.text = src.slice(d.start, d.end); });
	gaps.push(gapText(cursor, src.length));
	var slots = definitions.map(function (d) { return [d]; });
	definitions.forEach(function (d, i) { d.slot = i; d.movable = !inConditional(d); });

	function position(d) { return d.slot * 100000 + slots[d.slot].indexOf(d); }
	var moved = {};
	var blocked = {};
	for (var round = 0; round < 5000; round++)
	{
		var changed = false;
		for (var i = 0; i < definitions.length && !changed; i++)
		{
			var f = definitions[i];
			var target = null;
			f.callees.forEach(function (name)
			{
				definitions.forEach(function (x) { if (x.name === name && position(x) > position(f) && (!target || position(x) > position(target))) { target = x; } });
			});
			if (!target) { continue; }
			if (!f.movable) { blocked[f.name] = true; continue; }
			slots[f.slot].splice(slots[f.slot].indexOf(f), 1);
			f.slot = target.slot;
			slots[target.slot].splice(slots[target.slot].indexOf(target) + 1, 0, f);
			moved[f.name] = true;
			changed = true;
		}
		if (!changed) { break; }
	}

	var out = '';
	for (var k = 0; k < slots.length; k++)
	{
		out += gaps[k];
		out += slots[k].map(function (d) { return d.text; }).join('\n\n');
	}
	out += gaps[gaps.length - 1];

	if (messages)
	{
		var movedNames = Object.keys(moved);
		messages.push({ level: 'info', text: 'ReShade FX has no forward declarations: removed ' + removed.length + ' function declaration(s)' + (movedNames.length ? ' and moved ' + movedNames.slice(0, 4).join(', ') + (movedNames.length > 4 ? ' (and ' + (movedNames.length - 4) + ' more)' : '') + ' after the function(s) they call' : '') + '.' });
		var blockedNames = Object.keys(blocked);
		if (blockedNames.length) { messages.push({ level: 'warn', text: blockedNames.join(', ') + ' calls a function defined later but sits inside an #if block, so it was not moved; define the called function first.' }); }
		if (kept.length) { messages.push({ level: 'warn', text: 'Function(s) declared but never defined: ' + kept.map(function (p) { return p.name; }).join(', ') + '.' }); }
	}
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Global declarations with several variables.
//
//   const float pi = acos(-1.), tau = 2.*pi;   →   const float pi = acos(-1.);
//                                                   const float tau = 2.*pi;
//
// The steps that make globals static, evaluate constant initialisers and move the ones ReShade FX
// cannot take (hoistGlobalInits) each look for one variable per declaration. Only declarations at file
// scope are split; inside a function, a struct or a parameter list nothing is touched. A comma inside
// parentheses, brackets or braces separates nothing. A comment at the end of a variable stays with it,
// whether it stands before the comma or after it on the same line, and the semicolon goes before it,
// so a line comment cannot swallow the semicolon.
// ─────────────────────────────────────────────────────────────────────────────

function splitGlobalDeclarators(src, messages)
{
	if (src.indexOf(',') < 0) { return src; }
	var tokens = tokenizeSource(src);
	var QUALIFIERS = { 'const': true, 'static': true, 'uniform': true, 'volatile': true, 'precise': true, 'extern': true };
	var pieces = [];
	var split = 0;
	var i = 0;
	var n = tokens.length;

	function skippable(t) { return t.type === 'ws' || t.type === 'comment' || t.type === 'placeholder'; }

	while (i < n)
	{
		if (skippable(tokens[i]) || tokens[i].type === 'preproc') { i++; continue; }

		// one statement at file scope: from i to its end
		var start = i;
		var depth = 0;
		var sawFunctionBody = false;
		var endTok = -1;
		var spoiled = false;
		var commas = [];
		var paren = 0;
		for (var j = i; j < n; j++)
		{
			var tk = tokens[j];
			if (tk.type === 'preproc') { spoiled = true; continue; }
			if (tk.type !== 'punct') { continue; }
			var c = tk.text;
			if (c === '(' || c === '[') { paren++; }
			else if (c === ')' || c === ']') { paren--; }
			else if (c === '{')
			{
				if (paren === 0 && depth === 0 && tokens[start].text !== 'struct' && !sawParenBeforeBrace(tokens, start, j)) { /* an initialiser list */ }
				else if (paren === 0 && depth === 0 && sawParenBeforeBrace(tokens, start, j)) { sawFunctionBody = true; }
				depth++;
			}
			else if (c === '}')
			{
				depth--;
				if (depth === 0 && sawFunctionBody) { endTok = j; break; }
			}
			else if (c === ',' && depth === 0 && paren === 0) { commas.push(j); }
			else if (c === ';' && depth === 0 && paren === 0) { endTok = j; break; }
		}
		if (endTok < 0) { break; }

		if (!sawFunctionBody && !spoiled && commas.length > 0 && tokens[start].text !== 'struct' && tokens[start].text !== 'typedef')
		{
			// qualifiers, then a type, then the first variable's name
			var k = start;
			var header = [];
			while (k < endTok && (skippable(tokens[k]) || QUALIFIERS[tokens[k].text])) { if (!skippable(tokens[k])) { header.push(tokens[k].text); } k++; }
			var typeTok = tokens[k];
			var nameIdx = k + 1;
			while (nameIdx < endTok && skippable(tokens[nameIdx])) { nameIdx++; }
			var nameTok = tokens[nameIdx];
			var afterName = nameIdx + 1;
			while (afterName < endTok && skippable(tokens[afterName])) { afterName++; }
			var isFunction = tokens[afterName] && tokens[afterName].text === '(';
			if (typeTok && typeTok.type === 'ident' && nameTok && nameTok.type === 'ident' && !isFunction)
			{
				header.push(typeTok.text);
				var headerText = header.join(' ');
				var indent = /[ \t]*$/.exec(src.slice(0, tokens[start].start))[0];
				var bounds = [nameIdx].concat(commas.map(function (cIdx) { return cIdx + 1; }));
				var parts = [];
				for (var b = 0; b < bounds.length; b++)
				{
					var from = tokens[bounds[b]].start;
					var to = b + 1 < bounds.length ? tokens[commas[b]].start : tokens[endTok].start;
					var raw = src.slice(from, to);
					if (b > 0)
					{
						// a comment on the same line after the comma belongs to the variable before it
						var lead = /^(?:[ \t]*«[^»]*»)*/.exec(raw)[0];
						parts[b - 1].tail += lead;
						raw = raw.slice(lead.length);
					}
					// comments on lines of their own before a variable stand before its declaration
					var before = '';
					var own = /^(?:\s*«[^»]*»)+/.exec(raw);
					if (own)
					{
						before = own[0].match(/«[^»]*»/g).join('\n' + indent) + '\n' + indent;
						raw = raw.slice(own[0].length);
					}
					var text = raw.replace(/^\s+/, '');
					// trailing comment placeholders go after the semicolon
					var m = /((?:\s*«[^»]*»)*)\s*$/.exec(text);
					var tail = m[1] || '';
					text = text.slice(0, text.length - m[0].length).replace(/\s+$/, '');
					parts.push({ core: before + headerText + ' ' + text, tail: tail });
				}
				parts = parts.map(function (pt) { return pt.core + ';' + pt.tail; });
				pieces.push({ from: tokens[start].start, to: tokens[endTok].end, text: parts.join('\n' + indent) });
				split++;
			}
		}
		i = endTok + 1;
	}
	if (pieces.length === 0) { return src; }
	var out = '';
	var at = 0;
	pieces.forEach(function (pc) { out += src.slice(at, pc.from) + pc.text; at = pc.to; });
	out += src.slice(at);
	if (messages) { messages.push({ level: 'info', text: split + ' global declaration(s) with several variables split into one declaration per variable.' }); }
	return out;
}

// Is there a closing parenthesis between the start of a statement and a brace, as in  float f(float x) {  ?
function sawParenBeforeBrace(tokens, start, braceIdx)
{
	for (var q = start; q < braceIdx; q++) { if (tokens[q].type === 'punct' && tokens[q].text === ')') { return true; } }
	return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// array.length()
//
//   a.length()  →  3        for  float a[3]  and for  float a[] = {1.0, 2.0, 3.0}
//
// ReShade FX has no methods. The size is read from where the array is declared: the number in the
// brackets, or else the number of elements of the braced initialiser. A name declared more than once
// with different sizes is ambiguous, and a name that is not an array (a vector, say) has no size to
// read; in both cases the call is left as it is and reported.
// ─────────────────────────────────────────────────────────────────────────────

function rewriteArrayLength(src, messages)
{
	if (!/\.\s*length\s*\(\s*\)/.test(src)) { return src; }
	var cache = {}, definitions = {}, lengthNames = {}, replacements = {}, insertions = [];
	var arrayDecls = null;

	// the number of top-level elements in the text between a pair of braces
	function countElements(text)
	{
		var depth = 0;
		var count = 0;
		var any = false;
		for (var i = 0; i < text.length; i++)
		{
			var c = text[i];
			if (c === '(' || c === '[' || c === '{') { depth++; any = true; }
			else if (c === ')' || c === ']' || c === '}') { depth--; }
			else if (c === ',' && depth === 0) { count++; }
			else if (!/\s/.test(c)) { any = true; }
		}
		if (!any) { return 0; }
		return /,\s*$/.test(text) ? count : count + 1;
	}

	// every size the name is declared with: a number, or null when it cannot be told
	function sizesOf(name)
	{
		if (cache[name]) { return cache[name]; }
		var sizes = [];
		definitions[name] = [];
		var re = new RegExp('(?:^|[;{}(,\\s])(?!(?:return|else|case|do|goto|in|out|inout)\\b)[A-Za-z_]\\w*\\s+' + name + '\\s*\\[\\s*([^\\[\\]]*?)\\s*\\]\\s*(=\\s*\\{)?', 'g');
		var m;
		while ((m = re.exec(src)) !== null)
		{
			var size = m[1].trim() || null;
			var end = m.index + m[0].length, braces = m[2] ? 1 : 0, parens = 0;
			while (end < src.length)
			{
				var ch = src[end];
				if (ch === ';' && braces === 0 && parens === 0) { end++; break; }
				if (ch === '{') { braces++; } else if (ch === '}') { braces--; }
				if (ch === '(') { parens++; } else if (ch === ')') { parens--; }
				end++;
			}
			if (m[2])
			{
				// an unsized array: count what is between the braces
				var from = m.index + m[0].length;
				var depth = 1;
				var to = from;
				while (to < src.length && depth > 0) { if (src[to] === '{') { depth++; } else if (src[to] === '}') { depth--; } to++; }
				if (size === null) { size = countElements(src.slice(from,to-1)); }
			}
			sizes.push(size);
			definitions[name].push({start:m.index+m[0].search(/[A-Za-z_]/),end:end,size:size});
		}
		cache[name] = sizes;
		return sizes;
	}

	var replaced = 0;
	var unresolved = {};
	var lengthPattern = /(^|[^.\w])([A-Za-z_]\w*)\s*\.\s*length\s*\(\s*\)/g;
	src.replace(lengthPattern, function (match, before, name)
	{
		var sizes = sizesOf(name);
		var distinct = sizes.filter(function (v, i) { return sizes.indexOf(v) === i; });
		if (distinct.length === 1 && distinct[0] !== null) { replaced++; replacements[name] = /^\d+$/.test(String(distinct[0])) ? String(distinct[0]) : '(' + distinct[0] + ')'; return match; }
		if (distinct.length > 1 && distinct.indexOf(null) < 0)
		{
			if (!arrayDecls) { arrayDecls = analyzeSource(src).decls; }
			var declarations = arrayDecls.filter(function (d) { return d.name === name; });
			var globalOffsets = fileScopeTokenOffsets(src);
			if (declarations.length && declarations.every(function (d) { return d.global && /\[\]$/.test(d.type); }) && definitions[name].every(function (d) { return globalOffsets[d.start]; }))
			{
				if (!lengthNames[name])
				{
					// Keep a definition beside each conditional declaration. The real preprocessor
					// selects its length, so editing a feature/song define still selects valid data.
					var macro = 'ST_ARRAY_LENGTH_' + name;
					while (src.indexOf(macro) >= 0) { macro += '_'; }
					lengthNames[name] = macro;
					definitions[name].forEach(function (d) { insertions.push({at:d.end,text:'\n#define ' + macro + ' (' + d.size + ')\n'}); });
				}
				replaced++; replacements[name] = lengthNames[name]; return match;
			}
		}
		unresolved[name] = true;
		return match;
	});
	insertions.sort(function (a,b) { return b.at-a.at; }).forEach(function (entry) { src=src.slice(0,entry.at)+entry.text+src.slice(entry.at); });
	var out = src.replace(lengthPattern,function (match,before,name) { return replacements[name] === undefined ? match : before+replacements[name]; });

	if (messages && replaced > 0)
	{
		messages.push({ level: 'info', text: replaced + ' array length() call(s) replaced with the size of the array.' });
	}
	var names = Object.keys(unresolved);
	if (messages && names.length > 0)
	{
		messages.push({ level: 'warn', text: 'length() of ' + names.join(', ') + ' could not be replaced: ReShade FX has no methods, and the size of the array is not clear from its declaration. Write the size instead.' });
	}
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lookups in a channel that is not connected to anything.
//
//   tex2Dlod(iChannel3, float4(uv, 0.0, 0.0)).x   →   float4(0.0, 0.0, 0.0, 0.0).x
//
// A channel with no texture (the keyboard, a microphone, one left on None) has no sampler to read, and
// a shader that still reads it would not compile. Direct lookups become zero: black, or no key pressed.
// If a channel is passed to a helper, the assembler provides a 1x1 texture with an explicit clear pass.
// ─────────────────────────────────────────────────────────────────────────────

function rewriteEmptyChannels(src, emptySamplers, messages)
{
	if (!emptySamplers || emptySamplers.length === 0) { return src; }
	if (!/\btex2D(?:lod|fetch|grad|bias)?\s*\(/.test(src)) { return src; }
	var count = 0;
	var LOOKUPS = { 'tex2D': true, 'tex2Dlod': true, 'tex2Dfetch': true, 'tex2Dgrad': true, 'tex2Dbias': true };
	var result = rewriteExpressions(src, function (node, render)
	{
		if (node.kind !== 'call' || !LOOKUPS[node.name] || node.args.length === 0) { return null; }
		if (node.args[0].kind !== 'ident' || emptySamplers.indexOf(node.args[0].name) < 0) { return null; }
		count++;
		return 'float4(0.0, 0.0, 0.0, 0.0)';
	});
	if (messages && count > 0)
	{
		messages.push({ level: 'info', text: count + ' lookup(s) in a channel that is not connected to anything were replaced with zero.' });
	}
	return result.src;
}

// ─────────────────────────────────────────────────────────────────────────────
// Code after a return in the same block.
//
//   { return a; return b; }   →   { return a; }
//
// ReShade FX rejects every statement that cannot be reached (error: unreachable code). A return that
// stands on its own in a block, after  {  ;  or  }  , ends the block: what follows, up to the closing
// brace, is dropped. A return that is the body of an if, else or loop (after  )  or  else ) is not
// unconditional and is left alone. A return right after a case or default label is unconditional too.
// In a switch the next case or default label is reachable and ends what is dropped. Comments stay, each on a line of its own, so none can swallow a brace. Nothing
// is dropped if a preprocessor line lies in the way.
// ─────────────────────────────────────────────────────────────────────────────

function removeCodeAfterReturn(src)
{
	if (src.indexOf('return') < 0) { return src; }
	var tokens = tokenizeSource(src);
	var n = tokens.length;
	var cuts = [];
	var prev = '';
	var i = 0;

	function skippable(t) { return t.type === 'ws' || t.type === 'comment' || t.type === 'placeholder'; }

	while (i < n)
	{
		var t = tokens[i];
		if (skippable(t)) { i++; continue; }
		if (t.type === 'ident' && t.text === 'return' && (prev === '{' || prev === ';' || prev === '}' || prev === ':'))
		{
			// the end of the return statement: the first ; outside any parentheses
			var depth = 0;
			var j = i + 1;
			while (j < n)
			{
				var u = tokens[j];
				if (u.type === 'punct')
				{
					if (u.text === '(' || u.text === '[' || u.text === '{') { depth++; }
					else if (u.text === ')' || u.text === ']' || u.text === '}') { depth--; }
					else if (u.text === ';' && depth === 0) { break; }
				}
				j++;
			}
			if (j >= n) { break; }

			// what follows, up to the end of the block or the next label
			var k = j + 1;
			var level = 0;
			var preproc = false;
			var placeholders = [];
			var anything = false;
			while (k < n)
			{
				var v = tokens[k];
				if (v.type === 'preproc') { preproc = true; }
				if (v.type === 'punct')
				{
					if (v.text === '(' || v.text === '[' || v.text === '{') { level++; }
					else if (v.text === ')' || v.text === ']' || v.text === '}')
					{
						if (level === 0) { break; }
						level--;
					}
				}
				if (level === 0 && v.type === 'ident' && (v.text === 'case' || v.text === 'default')) { break; }
				if (v.type === 'placeholder') { placeholders.push(v.text); }
				else if (!skippable(v)) { anything = true; }
				k++;
			}
			if (anything && !preproc)
			{
				var from = tokens[j].end;
				var to = k < n ? tokens[k].start : src.length;
				var region = src.slice(from, to);
				var trailing = /\s*$/.exec(region)[0];
				var indent = /[ \t]*$/.exec(trailing)[0];
				// a comment is always followed by a line break, so that it cannot swallow what comes next
				var closing = trailing.indexOf('\n') >= 0 ? trailing : '\n' + trailing;
				var replacement = placeholders.length > 0 ? '\n' + indent + placeholders.join('\n' + indent) + closing : trailing;
				cuts.push({ from: from, to: to, text: replacement });
			}
			prev = ';';
			i = k;
			continue;
		}
		prev = t.text;
		i++;
	}
	if (cuts.length === 0) { return src; }
	var out = '';
	var at = 0;
	cuts.forEach(function (c) { out += src.slice(at, c.from) + c.text; at = c.to; });
	return out + src.slice(at);
}

// ─────────────────────────────────────────────────────────────────────────────
// A constructor with one literal number inside a #define.
//
//   #define camTarget vec3(0)   →   #define camTarget float3(0, 0, 0)
//
// float3(0) is not valid in HLSL (X3014), and the analyzer does not read the body of a macro as code,
// so the expansion of a scalar constructor never reaches it. With a literal the type is known without
// any analysis: it is a scalar. A constructor with a name or an expression in a macro cannot be told
// apart from one with a vector, so it is left alone.
// ─────────────────────────────────────────────────────────────────────────────

function expandLiteralConstructorsInMacros(src, messages)
{
	if (src.indexOf('#') < 0) { return src; }
	var tokens = tokenizeSource(src);
	var literal = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?[uUfF]?';
	var re = new RegExp('\\b(float|int|uint|bool)([234])\\s*\\(\\s*(' + literal + ')\\s*\\)', 'g');
	var count = 0;
	var out = '';
	tokens.forEach(function (t)
	{
		if (t.type === 'preproc' && /^#\s*define\b/.test(t.text))
		{
			out += t.text.replace(re, function (match, base, size, value)
			{
				count++;
				var parts = [];
				for (var i = 0; i < parseInt(size, 10); i++) { parts.push(value); }
				return base + size + '(' + parts.join(', ') + ')';
			});
		}
		else { out += t.text; }
	});
	if (messages && count > 0)
	{
		messages.push({ level: 'info', text: count + ' scalar constructor(s) inside #define lines were written out, as HLSL needs.' });
	}
	return out;
}

// ── Indentation normalizer ────────────────────────────────────────────────────
// Detect the indent unit used in the source (smallest non-zero space indent),
// then replace every leading indent level with a tab.

function normalizeIndentation(src)
{
	var lines = src.split('\n');

	// Detect indent unit — find smallest run of leading spaces > 0
	var unit  = 0;
	lines.forEach(function(line)
	{
	    var m = line.match(/^( +)/);
	    if (m)
	    {
	        var n = m[1].length;
	        if (unit === 0 || n < unit) { unit = n; }
	    }
	});

	if (unit === 0) { return src; } // no space indentation found

	return lines.map(function(line)
	{
	    var m = line.match(/^( *)(.*)/);
	    if (!m || m[1].length === 0) { return line; }

	    var spaces = m[1].length;
	    var level  = Math.floor(spaces / unit);
	    var rem    = spaces % unit; // leftover spaces (alignment, not indentation)
	    return '\t'.repeat(level) + ' '.repeat(rem) + m[2];
	}).join('\n');
}
