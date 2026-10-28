const fs = require('fs');
const path = require('path');
const JSON_DIR = process.env.SHADER_JSON_DIR || path.join(__dirname, 'shaders');
if (!fs.existsSync(JSON_DIR) || !fs.readdirSync(JSON_DIR).some(f => f.endsWith('.json')))
{
	console.log('SKIP roundtrip: no Shadertoy .json files in ' + JSON_DIR + ' (set SHADER_JSON_DIR)');
	process.exit(0);
}
const {tokenizeSource} = require(require('./sb_dir.js') + '/shadertoy_lexer.js');
let bad = 0, total = 0;
const files = fs.readdirSync(JSON_DIR).filter(f => f.endsWith('.json'));
for (const f of files)
{
	const d = JSON.parse(fs.readFileSync(JSON_DIR + '/' + f, 'utf8'));
	for (const rp of d.renderpass)
	{
		const t = tokenizeSource(rp.code);
		total++;
		const ok = t.map(x => x.text).join('') === rp.code;
		if (!ok)
		{
			bad++;
			console.log('ROUNDTRIP FAIL', f, rp.name);
		}
		const kinds = {};
		t.forEach(x => kinds[x.type] = (kinds[x.type] || 0) + 1);
		console.log(f.padEnd(14), rp.name.padEnd(9), String(rp.code.length).padStart(6), 'chars ->', String(t.length).padStart(6), 'tokens', JSON.stringify(kinds));
	}
}
console.log(total - bad + '/' + total + ' round-trip OK');
process.exit(bad ? 1 : 0);
