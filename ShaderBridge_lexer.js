// ShaderBridge prototype lexer.
// tokenizeSource(src) splits GLSL/HLSL-like source into tokens without losing a single character:
// tokens.map(t => t.text).join('') === src, always.
//
// Token types:
//   ws        whitespace (incl. newlines)
//   comment   // line comment or /* block comment */
//   preproc   a whole preprocessor line (with \ continuations), e.g. "#define X 1"
//   placeholder  «⁰» style comment placeholder used by the porter
//   ident     identifier or keyword
//   number    1  1.  .5  1e8  1.5e-3  0x1F  1u  1.0f
//   punct     operators and punctuation (longest match first)

// Operators, longest match first: three characters, then two, then one.
var LEXER_PUNCT3 = { '<<=': true, '>>=': true };
var LEXER_PUNCT2 = {
	'&&': true, '||': true, '==': true, '!=': true, '<=': true, '>=': true, '+=': true, '-=': true, '*=': true, '/=': true,
	'%=': true, '&=': true, '|=': true, '^=': true, '<<': true, '>>': true, '++': true, '--': true
};
var LEXER_PUNCT1 = '+-*/%&|^~!<>=?:;,.()[]{}';

// character classes by code, which is much cheaper than a regular expression per character
function lexIsSpace(c) { return c === 32 || c === 10 || c === 9 || c === 13 || c === 12 || c === 11; }
function lexIsDigit(c) { return c >= 48 && c <= 57; }
function lexIsIdentStart(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95; }
function lexIsIdentPart(c) { return lexIsIdentStart(c) || lexIsDigit(c); }
function lexIsHexDigit(c) { return lexIsDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102); }

// Visit comments without mistaking delimiters in quoted text or existing comments
// for new comments. Shared by conversion, comparison, analysis and highlighting.
function replaceSourceComments(src, replace)
{
	return src.replace(/"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, function (text)
	{
		return text[0] === '/' ? replace(text) : text;
	});
}

function tokenizeSource(src)
{
	var tokens = [];
	var i = 0;
	var n = src.length;
	var atLineStart = true;

	function push(type, start, end)
	{
		tokens.push({ type: type, text: src.slice(start, end), start: start, end: end });
	}

	while (i < n)
	{
		var code = src.charCodeAt(i);
		var start = i;

		if (lexIsSpace(code))
		{
			while (i < n && lexIsSpace(src.charCodeAt(i)))
			{
				if (src.charCodeAt(i) === 10) { atLineStart = true; }
				i++;
			}
			push('ws', start, i);
			continue;
		}

		if (code === 47 && src.charCodeAt(i + 1) === 47)
		{
			while (i < n && src.charCodeAt(i) !== 10) { i++; }
			push('comment', start, i);
			continue;
		}
		if (code === 47 && src.charCodeAt(i + 1) === 42)
		{
			i += 2;
			while (i < n && !(src.charCodeAt(i) === 42 && src.charCodeAt(i + 1) === 47)) { i++; }
			i = Math.min(n, i + 2);
			push('comment', start, i);
			continue;
		}

		if (code === 35 && atLineStart)
		{
			// whole preprocessor line, honouring backslash continuations and trailing comments
			while (i < n)
			{
				var pc = src.charCodeAt(i);
				if (pc === 92 && src.charCodeAt(i + 1) === 10) { i += 2; continue; }
				if (pc === 92 && src.charCodeAt(i + 1) === 13 && src.charCodeAt(i + 2) === 10) { i += 3; continue; }
				if (pc === 10) { break; }
				if (pc === 47 && src.charCodeAt(i + 1) === 42)
				{
					i += 2;
					while (i < n && !(src.charCodeAt(i) === 42 && src.charCodeAt(i + 1) === 47)) { i++; }
					i = Math.min(n, i + 2);
					continue;
				}
				i++;
			}
			push('preproc', start, i);
			continue;
		}
		atLineStart = false;

		if (src[i] === '«')
		{
			while (i < n && src[i] !== '»') { i++; }
			i = Math.min(n, i + 1);
			push('placeholder', start, i);
			continue;
		}

		if (lexIsIdentStart(code))
		{
			while (i < n && lexIsIdentPart(src.charCodeAt(i))) { i++; }
			push('ident', start, i);
			continue;
		}

		if (lexIsDigit(code) || (code === 46 && lexIsDigit(src.charCodeAt(i + 1))))
		{
			if (code === 48 && (src.charCodeAt(i + 1) === 120 || src.charCodeAt(i + 1) === 88))
			{
				i += 2;
				while (i < n && lexIsHexDigit(src.charCodeAt(i))) { i++; }
			}
			else
			{
				while (i < n && lexIsDigit(src.charCodeAt(i))) { i++; }
				if (src.charCodeAt(i) === 46)
				{
					i++;
					while (i < n && lexIsDigit(src.charCodeAt(i))) { i++; }
				}
				var ec = src.charCodeAt(i);
				if (ec === 101 || ec === 69)
				{
					var next = src.charCodeAt(i + 1);
					if (lexIsDigit(next) || next === 43 || next === 45)
					{
						i += 2;
						while (i < n && lexIsDigit(src.charCodeAt(i))) { i++; }
					}
				}
			}
			// integer and float suffixes: u U f F l L
			while (i < n)
			{
				var sc = src.charCodeAt(i);
				if (sc === 117 || sc === 85 || sc === 102 || sc === 70 || sc === 108 || sc === 76) { i++; }
				else { break; }
			}
			push('number', start, i);
			continue;
		}

		var three = src.substr(i, 3);
		var two = three.substr(0, 2);
		if (LEXER_PUNCT3[three]) { i += 3; }
		else if (LEXER_PUNCT2[two]) { i += 2; }
		else { i += 1; } // single operators and, so the round trip still holds, any stray character
		push('punct', start, i);
	}
	return tokens;
}

// Rename identifiers: every identifier token whose text is a key of map is replaced by its value.
// Works on tokens, so comments, preprocessor lines and longer identifiers that merely contain the
// name (tex_iChannel0 for iChannel0) are left alone.
function renameIdentifiers(src, map)
{
	return tokenizeSource(src).map(function (token)
	{
		return token.type === 'ident' && Object.prototype.hasOwnProperty.call(map, token.text) ? map[token.text] : token.text;
	}).join('');
}

if (typeof module !== 'undefined') { module.exports = { tokenizeSource: tokenizeSource, renameIdentifiers: renameIdentifiers, replaceSourceComments: replaceSourceComments }; }
