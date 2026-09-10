// ═════════════════════════════════════════════════════════════════════════════
// VERSION
// ═════════════════════════════════════════════════════════════════════════════

var PORTER_VERSION = '3.0.0';

// ═════════════════════════════════════════════════════════════════════════════
// ANALYSIS PASS  — detect issues before transformation
// ═════════════════════════════════════════════════════════════════════════════

function analyzeShader(src, messages) {
	if (!/\bmainImage\b/.test(src)) {
		messages.push({ level: 'error', text: 'No mainImage() found. Is this an Image tab shader?' });
	}
	if (/\biSampleRate\b/.test(src) || /\bmainSound\b/.test(src)) {
		messages.push({ level: 'error', text: 'Sound shader detected (iSampleRate / mainSound). Sound is not supported in ReShade.' });
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
			'iDate', 'iMouse', 'iChannelTime', 'iChannelResolution',
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

function transformGLSL(src, messages, passLabel) {
	var s = src;
	var mainImageOutVar = 'fragColor';
	var mainImageCoordVar = 'fragCoord';
	// In multipass, rename mainImage to avoid collisions between passes
	var mainImageName = passLabel ? 'mainImage_' + passLabel : 'mainImage';

	// ── Extract comments before any transforms so we never mangle them ────────
	var xComments = [];
	var xSuperDigits = '⁰¹²³⁴⁵⁶⁷⁸⁹';
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

	// ── Remove directives not valid in HLSL ──────────────────────────────────
	s = s.replace(/#version\s+\d+[^\n]*/g, '');
	s = s.replace(/\blayout\s*\([^)]*\)\s*/g, '');

	// ── Precision qualifiers ─────────────────────────────────────────────────
	s = s.replace(/\b(highp|mediump|lowp)\s+/g, '');

	// ── GLSL built-in variables ───────────────────────────────────────────────
	s = s.replace(/\bgl_FragCoord\b/g, 'fragCoord');

	// ── Remove shadertoy-style uniform re-declarations ────────────────────────
	s = s.replace(/uniform\s+\S+\s+i(Resolution|Time|TimeDelta|Frame|Date|Mouse|Channel[0-3])\s*;[^\n]*/g, '');

	// ── Strip trailing f suffix from float literals (1.0f → 1.0) ────────────
	s = s.replace(/(\d*\.\d+|\d+\.\d*)f\b/g, '$1');

	// ── Inline type replacements (no #define needed) ──────────────────────────
	s = s.replace(/\bvec([234])\b/g, 'float$1');
	s = s.replace(/\bivec([234])\b/g, 'int$1');
	s = s.replace(/\buvec([234])\b/g, 'uint$1');
	s = s.replace(/\bbvec([234])\b/g, 'bool$1');
	s = s.replace(/\bmat([234])\b/g, 'float$1x$1');

	// ── Struct constructor syntax: Name(a,b,c) → Name_ctor(a,b,c) ────────────
	// HLSL has no positional struct constructors. Generate a helper function for
	// each struct that is used as a constructor and rename all call sites.
	// Must run after type replacements so member types are already in HLSL form.
	s = rewriteStructConstructors(s, messages);

	// ── Inline intrinsic replacements ─────────────────────────────────────────
	s = s.replace(/\bmix\s*\(/g, 'lerp(');
	s = s.replace(/\bfract\s*\(/g, 'frac(');
	s = s.replace(/\binversesqrt\s*\(/g, 'rsqrt(');
	s = s.replace(/\bdFdx\s*\(/g, 'ddx(');
	s = s.replace(/\bdFdy\s*\(/g, 'ddy(');

	// ── Rename HLSL reserved keywords used as identifiers in GLSL ────────────
	// These are valid GLSL variable/parameter names but reserved in HLSL/ReShade FX.
	// Append _ to avoid syntax errors. Skip preprocessor lines.
	['point', 'line', 'linear', 'sample', 'pass'].forEach(function (kw) {
		var re = new RegExp('\\b(' + kw + ')\\b', 'g');
		s = s.replace(re, function (match, _, offset, str) {
			// Skip if on a preprocessor line
			var lineStart = str.lastIndexOf('\n', offset) + 1;
			if (/^\s*#/.test(str.slice(lineStart, offset + match.length))) { return match; }
			return kw + '_';
		});
	});

	// ── const → static const  (file scope only) ───────────────────────────────
	// Matches both line-start const and preprocessor-indented const (spaces only,
	// no tab indent which would indicate function-scope).
	s = s.replace(/^([ ]*)(const\s+)/gm, function (match, indent, kw, offset, str) {
		// If indented with tabs it's inside a function body — leave alone
		if (/\t/.test(indent)) { return match; }
		return indent + 'static ' + kw;
	});

	// ── Replace common const initialisers that use function calls (not valid in HLSL static const) ─
	s = s.replace(/\bstatic\s+const\s+float\s+(\w+)\s*=\s*acos\s*\(\s*-1\.0*\s*\)\s*;/g,
		'static const float $1 = 3.1415927;');
	s = s.replace(/\bstatic\s+const\s+float\s+(\w+)\s*=\s*sqrt\s*\(\s*0?\.5\s*\)\s*;/g,
		'static const float $1 = 0.70710678;');

	// ── Mutable file-scope globals need 'static' in HLSL ────────────────────
	// Pass 1: match type declarations at start of line
	s = s.replace(/^((float[234x]*|int[234]?|uint[234]?|bool)\s+)([a-zA-Z_]\w*)\s*(?=[,;=\s])/gm,
		function (match, typeAndSpace, type, name, offset, str) {
			var lineStart = str.lastIndexOf('\n', offset) + 1;
			var linePrefix = str.slice(lineStart, offset);
			if (/\b(static|const|uniform|return|struct)\b/.test(linePrefix)) { return match; }
			if (/^\s+/.test(linePrefix)) { return match; }
			return 'static ' + match;
		});
	// Pass 2: handle  ;type  declarations on same line (e.g. float A,D,E;vec3 B,C;)
	s = s.replace(/;(float[234x]*|int[234]?|uint[234]?|bool)(\s+)([a-zA-Z_]\w*)\s*(?=[,;=\s])/gm,
		function (match, type, space, name, offset, str) {
			var lineStart = str.lastIndexOf('\n', offset) + 1;
			if (/^\s+/.test(str.slice(lineStart, offset + 1))) { return match; } // indented
			return ';static ' + type + space + name;
		});
	// ── iTime is kept as-is; assemble.js defines it directly ─────────────────

	// ── vecN *= matN  →  vecN = mul(matN, vecN) ─────────────────────────────
	// HLSL does not allow *= with a matrix RHS on a vector variable.
	s = rewriteMatrixMulAssign(s);

	// ── Remove unreachable statements after return (ReShade FX errors on these) ─
	// Case 1: two return statements on consecutive lines
	// (handles both normal semicolon-suffix and prefix-semicolon golf style)
	s = s.replace(/(\breturn\b[^\n;{}]+;?\s*\n[\s«»⁰¹²³⁴⁵⁶⁷⁸⁹]*)\s*;?\s*\breturn\b[^\n;{}]+;?/g,
		function (match, first) {
			return first.trimEnd();
		});
	// Case 2: lone ; before } after a return, where a commented-out statement
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
	s = rewriteInlineMatrixMul(s);

	// ── Truncate over-specified vector constructors: float3(a, b, vec3) → float3(a, b, vec3.x) ─
	s = rewriteVectorConstructorArgs(s);

	// ── Broadcast constructors: vec3(x) → float3(x, x, x) ───────────────────
	// ReshadeFX does not support single-scalar-argument vector constructors.
	// We only expand when the single argument is clearly a numeric literal or
	// simple arithmetic expression (contains digits, operators, dots, parens).
	// Single bare identifiers are left alone — they may be valid same-type casts.
	s = rewriteBroadcastConstructors(s);

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

	// ── Two-argument atan(y, x) → atan2(y, x) ────────────────────────────────
	s = rewriteTwoArgAtan(s);

	// ── texture() / texture2D() → tex2D() ────────────────────────────────────
	// Uses a paren-balanced walker to split args correctly — prevents [^)]+ from
	// spanning newlines and consuming code beyond the call site.
	s = (function (src) {
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
	}(s));

	// ── textureGrad(s, uv, ddx, ddy) → tex2Dgrad(s, uv, ddx, ddy) ──────────
	s = s.replace(/\btextureGrad\s*\(/g, 'tex2Dgrad(');

	// ── textureLod(s, uv, lod) → tex2Dlod(s, float4(uv, 0, lod)) ────────────
	s = s.replace(
		/\btextureLod\s*\(\s*([^,]+),\s*([^,]+),\s*([^)]+)\)/g,
		function (_, samp, uv, lod) {
			return 'tex2Dlod(' + samp.trim() + ', float4(' + uv.trim() + ', 0.0, ' + lod.trim() + '))';
		}
	);

	// ── textureCube(s, dir) → tex2D(s, ST_cubemap_uv(dir)) ──────────────────
	// Must run before the loop-gradient rewriter so any resulting tex2D calls
	// inside loops are caught and promoted to tex2Dlod.
	s = rewriteCubemapSamples(s, messages);

	// ── clamp(x, 0.0, 1.0) → saturate(x) ────────────────────────────────────
	s = s.replace(/\bclamp\s*\(\s*([^,]+),\s*0\.0+f?\s*,\s*1\.0+f?\s*\)/g, 'saturate($1)');
	s = s.replace(/\bclamp\s*\(\s*([^,]+),\s*0\s*,\s*1\s*\)/g, 'saturate($1)');

	// ── GLSL array initializers: type[N](...) → {...} ────────────────────────
	// e.g. float[](0.3, 0.8) → {0.3, 0.8}
	s = s.replace(/\w+(?:\w+)?\s*\[\s*\]\s*\(([^)]*)\)/g, function (_, args) {
		return '{' + args + '}';
	});

	// ── mainImage signature → HLSL entry point ──────────────────────────────
	// Capture output and coord variable names for use in the PS entry wrapper.
	// In multipass, rename to avoid collision between passes.
	s = s.replace(
		/void\s+mainImage\s*\(\s*out\s+\w+4\s+(\w+)\s*,\s*(?:in\s+)?\w+2\s+(\w+)\s*\)/g,
		function (_, outVar, coordVar) {
			mainImageOutVar = outVar;
			mainImageCoordVar = coordVar;
			return 'void ' + mainImageName + '(float2 ' + coordVar + ', out float4 ' + outVar + ' : SV_Target)';
		}
	);

	// ── Rewrite mainImage body to inject output var local and return statement ──
	s = rewriteMainBody(s, messages, mainImageOutVar, mainImageCoordVar, mainImageName);

	// ── Normalize space indentation to tabs ───────────────────────────────────
	s = normalizeIndentation(s);

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
	var loopGradCount = 0;
	s = (function rewriteLoopGradientTex(src) {
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
		return result.join('');
	}(s));

	if (loopGradCount > 0) {
		messages.push({
			level: 'info', text:
				loopGradCount + ' gradient texture call(s) inside loop(s) rewritten to explicit-LOD equivalents (tex2Dlod/tex3Dlod/texCUBElod) to prevent compiler unroll errors (X3511/X3570).'
		});
	}

	// ── Restore extracted comments ────────────────────────────────────────────
	s = s.replace(/«([⁰¹²³⁴⁵⁶⁷⁸⁹]+)»/g, function (_, supIdx) {
		var idx = supIdx.split('').map(function (c) { return xSuperDigits.indexOf(c); }).join('');
		return xComments[parseInt(idx, 10)];
	});

	return { src: s, outVar: mainImageOutVar, coordVar: mainImageCoordVar, mainImageName: mainImageName };
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
	var structRe = /\bstruct\s+(\w+)\s*\{([^}]*)\}/g;
	var sm;
	while ((sm = structRe.exec(src)) !== null) {
		var structName = sm[1];
		var body = sm[2];
		var members = [];
		// Each member line: "type name;" possibly with leading whitespace
		var memberRe = /\b((?:float[234x]*|int[234]?|uint[234]?|bool[234]?|double)\s+)(\w+)\s*;/g;
		var mm;
		while ((mm = memberRe.exec(body)) !== null) {
			members.push({ type: mm[1].trim(), name: mm[2] });
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

function rewriteBroadcastConstructors(src) {
	var typePattern = /\b((?:float|vec)[234]|u?int[234])\s*\(/g;

	var sizeOf = {};
	'float2 float3 float4 vec2 vec3 vec4 int2 int3 int4 uint2 uint3 uint4'.split(' ').forEach(function (t) {
		sizeOf[t] = parseInt(t.slice(-1), 10);
	});

	// Build a set of identifiers declared as vector types (includes function params).
	// Excludes single-char names — reused heavily across functions, cause false positives.
	var vectorIdents = {};
	var declRe = /\b(float[234]|int[234]|uint[234]|vec[234])\s+([a-zA-Z_]\w*)\b/g;
	var dm;
	while ((dm = declRe.exec(src)) !== null) {
		if (dm[2].length > 1) { vectorIdents[dm[2]] = true; }
	}

	var result = [];
	var lastIndex = 0;
	var match;

	while ((match = typePattern.exec(src)) !== null) {
		var typeName = match[1];
		var parenOpen = match.index + match[0].length - 1; // index of '('

		// Walk to find the matching closing paren
		var depth = 1;
		var k = parenOpen + 1;
		var commaAt1 = 0;

		while (k < src.length && depth > 0) {
			if (src[k] === '(') { depth++; }
			else if (src[k] === ')') { depth--; }
			else if (src[k] === ',' && depth === 1) { commaAt1++; }
			k++;
		}
		// k points just past closing ')'

		// Only act on single-argument constructors
		if (commaAt1 === 0) {
			var inner = src.slice(parenOpen + 1, k - 1).trim();

			// Expand if arg looks numeric OR is a pure identifier (could be a scalar const like pi)
			// Don't broadcast if arg itself returns a vector — detect by vector swizzle or vec type inside
			var looksNumeric = /\d/.test(inner);
			var isPureIdent = /^[a-zA-Z_]\w*$/.test(inner.trim());
			var looksVector = /\.(xy|xyz|xyzw|rg|rgb|rgba)\b/.test(inner)
				|| /\b(float[234]|vec[234]|int[234])\s*\(/.test(inner);

			// For non-ident expressions: block broadcast if any identifier inside is a vector type
			if (!looksVector && !isPureIdent) {
				var identRe = /\b([a-zA-Z_]\w*)\b/g;
				var im;
				while ((im = identRe.exec(inner)) !== null) {
					if (vectorIdents[im[1]]) { looksVector = true; break; }
				}
			}

			if ((looksNumeric || isPureIdent) && !looksVector) {
				var n = sizeOf[typeName];
				var parts = [];
				for (var p = 0; p < n; p++) { parts.push(inner); }
				result.push(src.slice(lastIndex, match.index));
				result.push(typeName + '(' + parts.join(', ') + ')');
				lastIndex = k;
				typePattern.lastIndex = lastIndex;
				continue;
			}
		}
	}

	result.push(src.slice(lastIndex));
	return result.join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// Rewrite vector constructors whose args provide more components than needed.
// e.g. float3(Z.z, 0, -Z)  where -Z is a float3 → float3(Z.z, 0, -Z.x)
// Strategy: for each arg, estimate its component count:
//   • float2/3/4 constructor or swizzle .xy/.xyz/.xyzw → 2/3/4
//   • anything else → 1
// Then truncate / swizzle the last overflowing arg to fit.
// ─────────────────────────────────────────────────────────────────────────────

function rewriteVectorConstructorArgs(src) {
	var sizeOf = { float2: 2, float3: 3, float4: 4, int2: 2, int3: 3, int4: 4, uint2: 2, uint3: 3, uint4: 4 };
	var swizzleLen = { x: 1, y: 1, z: 1, w: 1, r: 1, g: 1, b: 1, a: 1, xy: 2, xz: 2, yz: 2, rg: 2, rb: 2, gb: 2, xyz: 3, xyw: 3, rgb: 3, xyzw: 4, rgba: 4 };
	var swizzleNames = ['x', 'y', 'z', 'w'];

	// Build a map of identifier → component count from declarations in source
	// Handles both  float3 Z = ...  and chained  float3 p = P(T), Z = ...
	var varSize = {};
	var declRe = /\b(float[234]|int[234]|uint[234])\s+([a-zA-Z_]\w*)\b/g;
	var dm;
	while ((dm = declRe.exec(src)) !== null) {
		var declType = dm[1];
		var declSize = sizeOf[declType];
		if (!sizeOf[dm[2]]) { varSize[dm[2]] = declSize; }

		// Walk forward past the declaration statement collecting chained names
		// Must handle balanced parens in initialisers like p = P(T), Z = ...
		var pos = dm.index + dm[0].length;
		var depth = 0;
		while (pos < src.length) {
			var ch = src[pos];
			if (ch === '(' || ch === '[') { depth++; }
			else if (ch === ')' || ch === ']') {
				depth--;
				if (depth < 0) { break; } // exited surrounding scope (e.g. function params)
			}
			else if ((ch === ';' || ch === '{' || ch === '}') && depth === 0) { break; }
			else if (ch === ',' && depth === 0) {
				// Find next real identifier after comma, skipping whitespace and placeholders
				var rest = src.slice(pos + 1);
				var ident = null;
				var restPos = 0;
				// Skip any number of placeholder tokens and whitespace
				while (restPos < rest.length) {
					var m = rest.slice(restPos).match(/^\s*(«[⁰¹²³⁴⁵⁶⁷⁸⁹]+»\s*)?([a-zA-Z_]\w*)/);
					if (!m) { break; }
					var candidate = m[2];
					restPos += m[0].length;
					if (!/«/.test(candidate)) {
						ident = candidate;
						break;
					}
				}
				if (ident && !sizeOf[ident]) { varSize[ident] = declSize; }
			}
			pos++;
		}
	}

	function estimateComponents(expr) {
		expr = expr.trim();
		// swizzle at end — most reliable indicator
		var sw = expr.match(/\.([xyzwrgba]+)$/);
		if (sw && swizzleLen[sw[1]] !== undefined) { return swizzleLen[sw[1]]; }
		// vector constructor at start (after optional unary)
		var stripped = expr.replace(/^[\s\-+!]+/, '');
		var ct = stripped.match(/^(float[234]|int[234]|uint[234])\s*\(/);
		if (ct) { return sizeOf[ct[1]]; }
		// swizzle on stripped
		var sw2 = stripped.match(/\.([xyzwrgba]+)$/);
		if (sw2 && swizzleLen[sw2[1]] !== undefined) { return swizzleLen[sw2[1]]; }
		// bare identifier lookup — ONLY if expression is just an identifier
		// (no operators that would reduce it to a scalar)
		if (/^[a-zA-Z_]\w*$/.test(stripped)) {
			if (varSize[stripped] !== undefined) { return varSize[stripped]; }
		}
		return 1;
	}

	function splitArgs(inner) {
		var args = [];
		var depth = 0;
		var start = 0;
		for (var i = 0; i < inner.length; i++) {
			if (inner[i] === '(' || inner[i] === '[') { depth++; }
			else if (inner[i] === ')' || inner[i] === ']') { depth--; }
			else if (inner[i] === ',' && depth === 0) {
				args.push(inner.slice(start, i).trim());
				start = i + 1;
			}
		}
		args.push(inner.slice(start).trim());
		return args;
	}

	var typePattern = /\b(float[234]|int[234]|uint[234])\s*\(/g;
	var result = [];
	var lastIndex = 0;
	var match;

	while ((match = typePattern.exec(src)) !== null) {
		var typeName = match[1];
		var target = sizeOf[typeName];
		var parenOpen = match.index + match[0].length - 1;

		// Skip if this match is on a #define line
		var lineStart = src.lastIndexOf('\n', match.index) + 1;
		if (/^\s*#define\b/.test(src.slice(lineStart, match.index + match[0].length))) { continue; }
		var depth = 1;
		var k = parenOpen + 1;

		while (k < src.length && depth > 0) {
			if (src[k] === '(') { depth++; }
			else if (src[k] === ')') { depth--; }
			k++;
		}

		var inner = src.slice(parenOpen + 1, k - 1);
		var args = splitArgs(inner);

		// Count total components — skip comment placeholders
		// A placeholder may have been merged with a real arg via newline — split them
		var total = 0;
		var realArgs = [];
		args.forEach(function (a) {
			// If arg contains a placeholder, split on newline and take the non-placeholder parts
			if (/«/.test(a)) {
				a.split('\n').forEach(function (part) {
					part = part.trim();
					if (part && !/«/.test(part)) {
						realArgs.push(part);
						total += estimateComponents(part);
					}
				});
			}
			else {
				realArgs.push(a);
				total += estimateComponents(a);
			}
		});

		if (total <= target) {
			// nothing to fix
			continue;
		}

		// Rebuild args trimming/swizzling to exactly target components
		var newArgs = [];
		var consumed = 0;

		for (var ai = 0; ai < realArgs.length && consumed < target; ai++) {
			var argExpr = realArgs[ai];
			var argSize = estimateComponents(argExpr);
			var remaining = target - consumed;

			if (argSize <= remaining) {
				newArgs.push(argExpr);
				consumed += argSize;
			}
			else {
				// Need to take only `remaining` components from this arg
				// Use swizzle if arg is multi-component, otherwise just use it
				if (argSize > 1) {
					var sw = swizzleNames.slice(0, remaining).join('');
					newArgs.push(argExpr + '.' + sw);
				}
				else {
					newArgs.push(argExpr);
				}
				consumed += remaining;
			}
		}

		result.push(src.slice(lastIndex, match.index));
		result.push(typeName + '(' + newArgs.join(', ') + ')');
		lastIndex = k;
		typePattern.lastIndex = lastIndex;
	}

	result.push(src.slice(lastIndex));
	return result.join('');
}
// Only when the RHS contains a matrix constructor or matrix-type macro call.
// Matches: mat2(...), mat3(...), mat4(...), float2x2(...), float3x3(...),
//          float4x4(...), and single-identifier macros that expand to matrices
//          (heuristic: uppercase single-letter calls like R(...), M(...)).
// ─────────────────────────────────────────────────────────────────────────────

function rewriteMatrixMulAssign(src) {
	// Build set of identifiers declared as matrix types
	var matIdents = {};
	var declRe = /\b(?:static\s+)?(float[234]x[234]|mat[234])\s+([a-zA-Z_]\w*)\b/g;
	var dm;
	while ((dm = declRe.exec(src)) !== null) { matIdents[dm[2]] = true; }

	var matRhsPattern = /\b([\w.]+)\s*\*=\s*([^;]+);/g;
	return src.replace(matRhsPattern, function (match, lhs, rhs) {
		var trimmed = rhs.trim();
		var looksLikeMatrix = /\b(mat[234]|float[234]x[234])\b/.test(trimmed)
			|| /^(float[234]x[234])\s*\(/.test(trimmed)
			|| (matIdents[trimmed] === true);
		if (looksLikeMatrix) {
			return lhs + ' = mul(' + trimmed + ', ' + lhs + ');';
		}
		return match;
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Rewrite  expr * matNxN(...)  →  mul(expr, matNxN(...))
// Handles inline matrix multiplies (not just *=).
// ─────────────────────────────────────────────────────────────────────────────

function rewriteInlineMatrixMul(src) {
	// Pass 1: v * floatNxN(...) → mul(floatNxN(...), v)
	var pattern = /(\)|\b\w+)\s*\*\s*(float[234]x[234])\s*\(/g;
	var result = [];
	var last = 0;
	var match;

	while ((match = pattern.exec(src)) !== null) {
		var mulPos = match.index + match[1].length;
		while (mulPos < src.length && src[mulPos] !== '*') { mulPos++; }

		var lhsEnd = mulPos - 1;
		while (lhsEnd >= 0 && src[lhsEnd] === ' ') { lhsEnd--; }

		var lhsStart;
		if (src[lhsEnd] === ')') {
			var depth = 1;
			var k = lhsEnd - 1;
			while (k >= 0 && depth > 0) {
				if (src[k] === ')') { depth++; }
				else if (src[k] === '(') { depth--; }
				k--;
			}
			while (k >= 0 && /[\w.]/.test(src[k])) { k--; }
			lhsStart = k + 1;
		}
		else {
			var k = lhsEnd;
			while (k >= 0 && /[\w.]/.test(src[k])) { k--; }
			lhsStart = k + 1;
		}

		var rhsTypeStart = mulPos + 1;
		while (rhsTypeStart < src.length && src[rhsTypeStart] === ' ') { rhsTypeStart++; }
		var parenPos = src.indexOf('(', rhsTypeStart);
		var depth2 = 1;
		var j = parenPos + 1;
		while (j < src.length && depth2 > 0) {
			if (src[j] === '(') { depth2++; }
			else if (src[j] === ')') { depth2--; }
			j++;
		}
		var lhs = src.slice(lhsStart, lhsEnd + 1).trim();
		var rhs = src.slice(rhsTypeStart, j).trim();

		result.push(src.slice(last, lhsStart));
		result.push('mul(' + rhs + ', ' + lhs + ')');  // flip: GLSL v*M = HLSL mul(M,v)
		last = j;
		pattern.lastIndex = last;
	}

	result.push(src.slice(last));
	src = result.join('');

	// Pass 2: floatNxN(...) * expr  →  mul(floatNxN(...), expr)
	// M*v in GLSL column-major = mul(M, v) in HLSL
	var result2 = [];
	var last2 = 0;
	var pattern2 = /\b(float[234]x[234])\s*\(/g;

	while ((match = pattern2.exec(src)) !== null) {
		// Skip #define lines
		var lineStart2 = src.lastIndexOf('\n', match.index) + 1;
		if (/^\s*#define\b/.test(src.slice(lineStart2, match.index + match[0].length))) { continue; }

		// Walk forward to end of matrix constructor
		var parenOpen = match.index + match[0].length - 1;
		var depth3 = 1;
		var k2 = parenOpen + 1;
		while (k2 < src.length && depth3 > 0) {
			if (src[k2] === '(') { depth3++; }
			else if (src[k2] === ')') { depth3--; }
			k2++;
		}
		// k2 points past closing ) of matrix constructor
		// Check if followed by * 
		var afterClose = src.slice(k2).match(/^(\s*\*\s*)/);
		if (!afterClose) { continue; }

		var starEnd = k2 + afterClose[1].length;

		// Walk forward to find end of RHS — either a paren expression or identifier chain
		var rhsStart = starEnd;
		var rhsEnd;
		if (src[rhsStart] === '(') {
			// parenthesised expression — walk to matching )
			var depth4 = 1;
			var k3 = rhsStart + 1;
			while (k3 < src.length && depth4 > 0) {
				if (src[k3] === '(') { depth4++; }
				else if (src[k3] === ')') { depth4--; }
				k3++;
			}
			rhsEnd = k3;
		}
		else {
			// identifier or member chain
			var k3 = rhsStart;
			while (k3 < src.length && /[\w.]/.test(src[k3])) { k3++; }
			rhsEnd = k3;
		}

		var matExpr = src.slice(match.index, k2).trim();
		var rhsExpr = src.slice(rhsStart, rhsEnd).trim();

		result2.push(src.slice(last2, match.index));
		result2.push('mul(' + matExpr + ', ' + rhsExpr + ')');
		last2 = rhsEnd;
		pattern2.lastIndex = last2;
	}

	result2.push(src.slice(last2));
	return result2.join('');
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

function rewriteMainBody(src, messages, outVar, coordVar, fnName) {
	if (!outVar) { outVar = 'fragColor'; }
	if (!coordVar) { coordVar = 'fragCoord'; }
	if (!fnName) { fnName = 'mainImage'; }

	var fnEsc = fnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

	// Move the opening { to its own line if it isn't already (Allman style).
	src = src.replace(
		new RegExp('(void\\s+' + fnEsc + '\\s*\\([^)]*\\))\\s*\\{'),
		'$1\n{'
	);

	var sigRegex = new RegExp('void\\s+' + fnEsc + '\\s*\\([^)]*\\)\\s*\\n\\{');
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

	// Helper: walk balanced parens from position of '(' and return { samp, args[], end }
	// where args[] are the top-level comma-separated arguments after the sampler.
	function splitCubeArgs(s, parenPos)
	{
		var depth = 1;
		var k = parenPos + 1;
		var sampEnd = -1;
		// collect top-level comma positions
		var commas = [];
		while (k < s.length && depth > 0)
		{
			if (s[k] === '(') { depth++; }
			else if (s[k] === ')') { depth--; }
			else if (s[k] === ',' && depth === 1) { commas.push(k); }
			k++;
		}
		// k is now just past closing ')'
		if (commas.length === 0) { return null; } // malformed
		var samp = s.slice(parenPos + 1, commas[0]).trim();
		var rest  = [];
		for (var ci = 0; ci < commas.length; ci++)
		{
			var from = commas[ci] + 1;
			var to   = ci + 1 < commas.length ? commas[ci + 1] : k - 1;
			rest.push(s.slice(from, to).trim());
		}
		return { samp: samp, args: rest, end: k };
	}

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
			var parsed   = splitCubeArgs(src, parenPos);
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
			var parsed   = splitCubeArgs(src, parenPos);
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

	// Inject ST_cubemap_uv() helper at the top of the source (before any user code).
	// The helper maps a direction vector to a 2D UV in a horizontal 6-face strip.
	var helper =
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

	src = helper + '\n' + src;

	messages.push({ level: 'info', text: 'textureCube() rewritten to tex2D() + ST_cubemap_uv() helper (horizontal 6-face strip, +X/-X/+Y/-Y/+Z/-Z order).' });
	return src;
}