// Loads the real porter scripts into a Node vm context, so tests exercise exactly the code that ships.
// The assemble, lexer, analyzer and transform files are DOM-free; only ShaderBridge_ui.js needs a browser.
const vm = require('vm');
const fs = require('fs');
const SB = require('./sb_dir.js');

module.exports = function loadPorter()
{
	const ctx = vm.createContext({ console: console });
	['ShaderBridge_assemble.js', 'ShaderBridge_lexer.js', 'ShaderBridge_analyzer.js', 'ShaderBridge_transform.js'].forEach(function (f)
	{
		vm.runInContext(fs.readFileSync(SB + '/' + f, 'utf8'), ctx, { filename: f });
	});
	return ctx;
};
