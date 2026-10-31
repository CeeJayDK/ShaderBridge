// Runs every test; exits non-zero if any fails.
//   node run_all.js
// Environment:
//   SB_DIR            porter folder (default: the folder above tests/)
//   SHADER_JSON_DIR   folder of Shadertoy .json files for the lexer round-trip test (skipped if absent)
//   RESHADEFX_CLI     reshadefx_cli_fixed, to run the GLSL corpus through the real ReShade compiler (skipped if absent)
const { spawnSync } = require('child_process');
const tests = ['t_types.js', 't_analyzer.js', 't_structs.js', 't_porter_mat.js', 't_flip.js', 't_vflip.js', 't_porter_vec.js', 't_samplers.js', 't_common.js', 't_texelfetch.js', 't_broadcast.js', 't_glsl_compat.js', 't_functions.js', 't_standalone.js', 't_cubemap.js', 't_volume.js', 't_pipeline.js', 't_loops.js', 't_frames.js', 't_returns.js', 't_contrast.js', 'corpus/run.js', 't_assembly_compile.js', 'roundtrip.js'];
let failed = 0;
tests.forEach(function (t)
{
	const r = spawnSync(process.execPath, [t], { cwd: __dirname, encoding: 'utf8' });
	const lines = (r.stdout + r.stderr).trim().split('\n');
	console.log((r.status === 0 ? 'PASS ' : 'FAIL ') + t.padEnd(18) + lines[lines.length - 1]);
	if (r.status !== 0) { failed++; console.log(lines.join('\n')); }
});
process.exit(failed ? 1 : 0);
