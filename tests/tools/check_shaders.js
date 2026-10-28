// Port every Shadertoy .json export in a folder and compile the result with the real ReShade compiler.
// For each shader: the frontend, then every pixel entry point through DXBC. Prints one line per shader
// and a total; the exit code is 1 when a shader does not compile. This is how a new shader is tried.
//
//   npm install jsdom            (once, in this folder; port.js needs it)
//   RESHADEFX_CLI=<path to reshadefx_cli_fixed> node check_shaders.js <folder with .json files> [output folder]
//
// SB_DIR overrides the porter folder (default: the folder above tests/).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const cli = process.env.RESHADEFX_CLI;
if (!cli || !fs.existsSync(cli)) { console.log('set RESHADEFX_CLI to reshadefx_cli_fixed (built by the ReShade-Testing-Initiative)'); process.exit(2); }
const folder = process.argv[2];
if (!folder || !fs.existsSync(folder)) { console.log('usage: node check_shaders.js <folder with .json files> [output folder]'); process.exit(2); }
const outDir = process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(), 'shaderbridge-check-'));
fs.mkdirSync(outDir, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'shaderbridge-scratch-'));

function firstError(text)
{
	const line = text.split('\n').find(l => /error/i.test(l));
	return line ? line.replace(/^.*[\\/]/, '').trim().slice(0, 150) : '';
}

const files = fs.readdirSync(folder).filter(f => f.toLowerCase().endsWith('.json')).sort();
let ok = 0;
files.forEach(function (file)
{
	let name = file;
	try { name = JSON.parse(fs.readFileSync(path.join(folder, file), 'utf8')).info.name || file; } catch (e) { /* not a Shadertoy export */ }
	const port = spawnSync(process.execPath, [path.join(__dirname, 'port.js'), path.join(folder, file), outDir], { encoding: 'utf8' });
	const fx = (port.stdout || '').split('\n').find(l => /\.fx$/.test(l));
	if (!fx) { console.log('PORT     ' + name + ' :: ' + ((port.stdout + port.stderr).trim().split('\n')[0] || '').slice(0, 150)); return; }

	const front = spawnSync(cli, ['--list-entry-points', fx], { encoding: 'utf8' });
	const text = (front.stdout || '') + (front.stderr || '');
	if (front.status !== 0 || /error/i.test(text)) { console.log('FRONTEND ' + name + ' :: ' + firstError(text)); return; }

	const entries = (text.match(/F__\w+(?= \(pixel\))/g) || []);
	const failures = [];
	entries.forEach(function (entry)
	{
		const errFile = path.join(scratch, 'dxbc.err');
		const r = spawnSync(cli, ['--dxbc', '--shader-model', '50', '-E', entry, '-Fe', errFile, '-Fo', path.join(scratch, 'dxbc.bin'), fx], { encoding: 'utf8' });
		if (r.status !== 0) { failures.push(entry + ': ' + firstError(fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8') : (r.stdout + r.stderr))); }
	});
	if (failures.length) { console.log('DXBC     ' + name + ' :: ' + failures.join(' | ')); return; }
	ok++;
	console.log('OK       ' + name);
});
console.log('\n' + ok + ' of ' + files.length + ' shaders compile (frontend, and every pixel entry point through DXBC). Output: ' + outDir);
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(ok === files.length ? 0 : 1);
