// Archived from ShaderBridge_transform.js, rewriteArrayLength (v3.5.13).
// GLSL 4.30 / ES 3.10 give vectors and matrices a length() (components, columns); GLSL ES 3.00
// and so Shadertoy only allow it on arrays. See README.md.
//
// Inside the lengthPattern callback, right after `var sizes = sizesOf(name);`:
//
//		if (sizes.length === 0)
//		{
//			// GLSL also gives vectors (components) and matrices (columns) a length(). A GLSL
//			// matrix column is a stored row, so both are the first dimension of the HLSL type.
//			if (!arrayDecls) { arrayDecls = analyzeSource(src).decls; }
//			var counts = arrayDecls.filter(function (d) { return d.name === name; }).map(function (d)
//			{
//				var parsed = anParseType(d.type);
//				return parsed && parsed.kind !== 'scalar' ? parsed.rows : null;
//			});
//			if (counts.length && counts.every(function (c) { return c !== null && c === counts[0]; }))
//			{
//				replaced++; replacements[name] = String(counts[0]); return match;
//			}
//		}
//
// The info message then read: replaced + ' length() call(s) replaced with the size of the array, vector or matrix.'
