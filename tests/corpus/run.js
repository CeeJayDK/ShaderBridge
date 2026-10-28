// The GLSL idiom corpus: every snippet is ported with the real porter and compiled with the real ReShade FX
// compiler (frontend, then a DXBC build of the pixel shader). It finds what the porter still gets wrong.
//
//   node corpus/run.js
//
// Environment:
//   RESHADEFX_CLI     path to reshadefx_cli_fixed from the ReShade-Testing-Initiative (the corpus is skipped without it)
//
// The effects are compiled with no include path at all: a single .fx has to work without ReShade.fxh.
//   SB_DIR            the porter folder (default: the folder above tests/)
//
// A snippet may carry a fourth element { noDxbc: 'reason' } to skip the DXBC stage when only the stand-in
// for the Direct3D compiler (vkd3d) objects and ReShade's own frontend accepts it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = process.env.RESHADEFX_CLI;
if (!CLI || !fs.existsSync(CLI)) { console.log('SKIP corpus: set RESHADEFX_CLI to reshadefx_cli_fixed (built by the ReShade-Testing-Initiative)'); process.exit(0); }
const porter = require('../load_porter.js')();
const snippets = require('./snippets.js');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shaderbridge-corpus-'));

function port(id, helpers, body, flags)
{
	const src = flags && flags.rawSource ? helpers + body : helpers + 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\t' + body.replace(/\n/g, '\n\t') + '\n}\n';
	const messages = [];
	const used = new Set();
	porter.analyzeShader(src, messages);
	porter.detectUniforms(src, used);
	const usesTex = /iChannel0/.test(src);
	const cube = !!(flags && flags.channel0 === 'cubemap');
	const screen = !!(flags && flags.channel0 === 'backbuffer');
	const none = !!(flags && flags.channel0 === 'none');
	const r = porter.transformGLSL(src, messages, 'Image', { cubemapSamplers: cube ? ['iChannel0'] : [], emptySamplers: none ? ['iChannel0'] : [] });
	const pass = { id: 'image', src: r.src, coordVar: r.coordVar, mainImageName: r.mainImageName, globalInits: r.globalInits, usedUniforms: used,
		channels: usesTex ? [cube ? 'cubemap' : (screen ? 'backbuffer' : (none ? 'none' : 'texture'))] : [], channelNames: usesTex ? [cube ? "St. Peter's Basilica" : 'London'] : [], filters: usesTex ? ['mipmap'] : [], wraps: usesTex ? ['clamp'] : [],
		vflips: usesTex ? [true] : [], format: 'RGBA32F', selfRefChannels: [] };
	return porter.assembleFxFile([pass], true, messages, { id: id, name: id, username: 'corpus', description: '' });
}

function compile(file, flags)
{
	let r = spawnSync(CLI, ['--list-entry-points', file], { encoding: 'utf8' });
	const front = r.stdout + r.stderr;
	if (r.status !== 0 || /error/.test(front)) { return { stage: 'frontend', text: front }; }
	if (flags && flags.noDxbc && process.platform !== 'win32') { return null; }
	const errFile = path.join(outDir, 'dxbc.err');
	r = spawnSync(CLI, ['--dxbc', '--shader-model', '50', '-E', 'F__PS_ShadertoyMain', '-Fe', errFile, '-Fo', path.join(outDir, 'dxbc.bin'), file], { encoding: 'utf8' });
	if (r.status !== 0) { return { stage: 'dxbc', text: fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8') : r.stdout + r.stderr }; }
	// Compilation success alone does not prove that a DX9 device can create the shader.
	// Microsoft's compiler may emit more slots than the device supports. Check a conservative
	// 512-slot budget on synthetic cases, using native D3DCompiler (vkd3d lacks SM3 support).
	if (flags && flags.dx9Budget && process.platform === 'win32')
	{
		const asmFile = path.join(outDir, 'dx9.asm');
		r = spawnSync(CLI, ['--dxbc', '--shader-model', '30', '-E', 'E__PS_ShadertoyMain', '-Fc', asmFile, '-Fo', path.join(outDir, 'dx9.bin'), file], { encoding: 'utf8' });
		if (r.status !== 0) { return { stage: 'dx9', text: r.stdout + r.stderr }; }
		const assembly = fs.readFileSync(asmFile, 'utf8');
		const slots = /approximately (\d+) instruction slots used/.exec(assembly);
		if (!slots || +slots[1] > flags.dx9Budget) { return { stage: 'dx9 budget', text: slots ? slots[1] + ' slots exceeds ' + flags.dx9Budget : 'missing instruction-slot count' }; }
	}
	return null;
}

const failures = [];
snippets.forEach(function (entry)
{
	const id = entry[0];
	let fx;
	try { fx = port(id, entry[1], entry[2], entry[3]); }
	catch (e) { failures.push({ id: id, stage: 'PORTER EXCEPTION', text: e.message }); return; }
	const file = path.join(outDir, id + '.fx');
	fs.writeFileSync(file, fx);
	const c = compile(file, entry[3]);
	if (c) { failures.push({ id: id, stage: c.stage, text: (c.text.split('\n').find(l => /error/.test(l)) || c.text.split('\n')[0] || '').replace(outDir + path.sep, '').trim() }); }
});
const ok = snippets.length - failures.length;
console.log(ok + '/' + snippets.length + ' corpus snippets compile');
failures.forEach(f => console.log('  ' + f.id.padEnd(26) + f.stage.padEnd(10) + f.text.slice(0, 110)));
fs.rmSync(outDir, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);
