// Loads the real porter scripts into a Node vm context, so tests exercise exactly the code that ships.
// The assemble, lexer, analyzer and transform files are DOM-free; only shadertoy_ui.js needs a browser.
const vm = require('vm');
const fs = require('fs');
const SB = require('./sb_dir.js');

module.exports = function loadPorter()
{
	const ctx = vm.createContext({ console: console });
	['shadertoy_assemble.js', 'shadertoy_lexer.js', 'shadertoy_analyzer.js', 'shadertoy_transform.js'].forEach(function (f)
	{
		vm.runInContext(fs.readFileSync(SB + '/' + f, 'utf8'), ctx, { filename: f });
	});
	return ctx;
};
