// Archived from ShaderBridge_analyzer.js, anBuiltinType (v3.5.14).
// HLSL has min/max/clamp/pow/fmod/atan2 with a scalar first argument and a vector second; no
// GLSL version does (only min(genType, float) and the like), so Shadertoy never sends it.
// See README.md.
//
// Inside `if (AN_SAME_AS_ARG0.indexOf(name) !== -1)`, before the mix/lerp case:
//
//		if (name === 'clamp' || name === 'min' || name === 'max' || name === 'pow' || name === 'mod' || name === 'fmod' || name === 'atan2')
//		{
//			// scalar op vector → vector
//			var p0 = t0 && anParseType(t0), p1 = t1 && anParseType(t1);
//			if (p0 && p1 && p0.kind === 'scalar' && p1.kind === 'vec') { return t1; }
//		}
