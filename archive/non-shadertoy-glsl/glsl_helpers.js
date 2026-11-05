// Archived from ShaderBridge_transform.js and ShaderBridge_analyzer.js (v3.5.13).
// GLSL built-ins newer than GLSL ES 3.00, so not available on Shadertoy. See README.md.
// These are fragments, not a loadable module: each says where it went.

// ── ShaderBridge_transform.js: GLSL_RENAMED_BUILTINS gained these entries ───────────────────
//   fma → mad, dFdxFine / dFdyFine / dFdxCoarse / dFdyCoarse → ddx_fine / ddy_fine / ddx_coarse / ddy_coarse
var ARCHIVED_RENAMED_BUILTINS = {
	fma: 'mad', dFdxFine: 'ddx_fine', dFdyFine: 'ddy_fine', dFdxCoarse: 'ddx_coarse', dFdyCoarse: 'ddy_coarse'
};

// ── ShaderBridge_transform.js: inside injectGlslHelpers(src), after the acosh/atanh helpers ──
// Uses the local helpers that are still there:
//   needs(name)  true when src calls name and does not define it
//   sizes(make)  make('') + make('2') + make('3') + make('4')
function archivedHelpers(needs, sizes)
{
	var helpers = '';

	// GLSL's bit-counting functions return int, also for uint arguments, and findLSB/findMSB give
	// -1 when no bit is found. ReShade FX's countbits/firstbitlow/firstbithigh return uint, so an
	// int result is restored by these helpers; comparisons such as findMSB(x) < 0 then still work.
	[['bitCount', 'countbits'], ['findLSB', 'firstbitlow'], ['findMSB', 'firstbithigh'], ['bitfieldReverse', 'reversebits']].forEach(function (pair)
	{
		if (!needs(pair[0])) { return; }
		helpers += sizes(function (n)
		{
			var signedArg = pair[1] === 'firstbithigh' ? 'x' : 'uint' + n + '(x)';
			var uintResult = pair[1] === 'reversebits' ? 'uint' + n : 'int' + n;
			return 'int' + n + ' ' + pair[0] + '(int' + n + ' x)\n{\n\treturn int' + n + '(' + pair[1] + '(' + signedArg + '));\n}\n\n'
				+ uintResult + ' ' + pair[0] + '(uint' + n + ' x)\n{\n\treturn ' + uintResult + '(' + pair[1] + '(x));\n}\n\n';
		});
	});

	// The 4x8 packing functions (the 2x16 and Half ones are ES 3.00 and stay in the porter).
	// The first component goes into the lowest bits.
	var packing = {
		packUnorm4x8: 'uint packUnorm4x8(float4 v)\n{\n\tuint4 b = uint4(round(saturate(v) * 255.0));\n\treturn b.x | (b.y << 8) | (b.z << 16) | (b.w << 24);\n}\n\n',
		packSnorm4x8: 'uint packSnorm4x8(float4 v)\n{\n\tuint4 b = uint4(int4(round(clamp(v, -1.0, 1.0) * 127.0))) & 0xFFu;\n\treturn b.x | (b.y << 8) | (b.z << 16) | (b.w << 24);\n}\n\n',
		unpackUnorm4x8: 'float4 unpackUnorm4x8(uint p)\n{\n\treturn float4(uint4(p, p >> 8, p >> 16, p >> 24) & 0xFFu) / 255.0;\n}\n\n',
		unpackSnorm4x8: 'float4 unpackSnorm4x8(uint p)\n{\n\treturn clamp(float4(int4(uint4(p << 24, p << 16, p << 8, p)) >> 24) / 127.0, -1.0, 1.0);\n}\n\n'
	};
	Object.keys(packing).forEach(function (name) { if (needs(name)) { helpers += packing[name]; } });

	// bitfieldExtract sign-extends the field for int and zero-extends it for uint: shift the field
	// to the top, then back down (arithmetic for int). A field of 0 bits gives 0, which the shifts
	// cannot express (a shift by 32 is undefined).
	if (needs('bitfieldExtract'))
	{
		helpers += sizes(function (n)
		{
			return ['int', 'uint'].map(function (base)
			{
				var type = base + n;
				return type + ' bitfieldExtract(' + type + ' value, int offset, int bits)\n{\n\tif (bits <= 0)\n\t{\n\t\treturn (' + type + ')0;\n\t}\n'
					+ '\treturn (value << uint(32 - offset - bits)) >> uint(32 - bits);\n}\n\n';
			}).join('');
		});
	}

	// bitfieldInsert replaces bits [offset, offset + bits) of base with the low bits of insert.
	if (needs('bitfieldInsert'))
	{
		helpers += sizes(function (n)
		{
			var u = 'uint' + n, i = 'int' + n;
			return u + ' bitfieldInsert(' + u + ' base, ' + u + ' insert, int offset, int bits)\n{\n'
				+ '\tuint mask = (bits >= 32 ? 0xFFFFFFFFu : ((1u << uint(bits)) - 1u)) << uint(offset);\n'
				+ '\treturn (base & ~mask) | ((insert << uint(offset)) & mask);\n}\n\n'
				+ i + ' bitfieldInsert(' + i + ' base, ' + i + ' insert, int offset, int bits)\n{\n'
				+ '\treturn ' + i + '(bitfieldInsert(' + u + '(base), ' + u + '(insert), offset, bits));\n}\n\n';
		});
	}

	// uaddCarry returns the 32-bit sum and sets carry to 1 where the addition wrapped around.
	// usubBorrow, umulExtended and imulExtended (same GLSL versions) were never written.
	if (needs('uaddCarry'))
	{
		helpers += sizes(function (n)
		{
			var u = 'uint' + n;
			return u + ' uaddCarry(' + u + ' x, ' + u + ' y, out ' + u + ' carry)\n{\n\t' + u + ' sum = x + y;\n\tcarry = ' + u + '(sum < x);\n\treturn sum;\n}\n\n';
		});
	}
	return helpers;
}

// ── ShaderBridge_analyzer.js: result types ──────────────────────────────────────────────────
// AN_SAME_AS_ARG0 also listed: fma mad bitfieldReverse reversebits bitfieldExtract bitfieldInsert uaddCarry
// (ddx_fine ddy_fine ddx_coarse ddy_coarse were already there and remain.)
// anBuiltinType(name, args), after the roundEven case, had:
//
//	if (name === 'bitCount' || name === 'findLSB' || name === 'findMSB')
//	{
//		var countArg = t0 && anParseType(t0);
//		return countArg && countArg.cols === 1 ? anVec('int', countArg.rows) : null;
//	}
//	if (/^unpack[US]norm4x8$/.test(name)) { return 'float4'; }
//	(and pack[US]norm4x8 returned 'uint', in the same regex as the 2x16 packing functions)
