// Port a Shadertoy .json export to a ReShade .fx without a browser, by running the porter's own
// index.html in jsdom (the real, unmodified code: JSON in, the same .fx the page would produce out).
//
//   npm install jsdom            (once, in this folder)
//   node port.js <shader.json> <outdir> [--noflip]
//
// SB_DIR overrides the porter folder (default: the folder above tests/).
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const SB = require('../sb_dir.js');
const args = process.argv.slice(2);
if (args.length < 2) { console.log('usage: node port.js <shader.json> <outdir> [--noflip]'); process.exit(1); }
const input = args[0];
const outdir = args[1];
const flags = new Set(args.slice(2));

(async function ()
{
	const dom = await JSDOM.fromFile(path.join(SB, 'index.html'), {
		runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
		beforeParse: function (win) { win.document.execCommand = function () { return false; }; }
	});
	const w = dom.window;
	await new Promise(function (r) { w.addEventListener('load', r); });
	await new Promise(function (r) { setTimeout(r, 200); });
	const doc = w.document;
	if (flags.has('--noflip')) { doc.getElementById('opt-yflip').checked = false; }
	w.loadJsonFile(fs.readFileSync(input, 'utf8'), input);
	w.convert();
	const log = Array.from(doc.querySelectorAll('#log-entries > *')).map(function (e) { return e.textContent.trim(); });
	fs.mkdirSync(outdir, { recursive: true });
	const name = (w.currentShaderInfo && w.currentShaderInfo.name ? w.currentShaderInfo.name : path.basename(input, '.json')).replace(/[^A-Za-z0-9_-]+/g, '_');
	const file = path.join(outdir, name + '.fx');
	fs.writeFileSync(file, doc.getElementById('fx-output').value);
	console.log(file);
	log.forEach(function (l) { console.log('  ' + l); });
	process.exit(0);
}());
