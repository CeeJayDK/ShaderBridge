# ShaderBridge tests

Run with Node (no dependencies):

    node run_all.js

| Suite | What it checks |
|---|---|
| `t_types.js` | the analyzer's type inference and scoping (64 cases) |
| `t_analyzer.js` | what each phase of the analysis adds (tokens, dead branches, macros, structs, signatures, scopes, lookup, expression walk) and that the phases need each other in order (51) |
| `t_porter_mat.js` | `rewriteInlineMatrixMul`, loaded exactly as it ships, including file-scope initialisers (33) |
| `t_porter_vec.js` | `rewriteVectorConstructorArgs` (25) |
| `t_broadcast.js` | scalar broadcast constructors expand, vector conversions and copies do not (31) |
| `t_flip.js` | the `ST_FLIP_Y` / `ST_VFLIP_*` options, the mouse, no `iResolution` dependency (33) |
| `t_vflip.js` | V flip at texture sample sites, with the flag passed through sampler parameters, including the offset overloads (40) |
| `t_texelfetch.js` | `texelFetch` / `textureSize`, and row-mirrored fetches from Vflip textures (20) |
| `t_samplers.js` | sampler and texture names clashing across passes (15) |
| `t_common.js` | a Common tab reaches the assembler once per pass; structs, globals and functions that the passes define differently get names of their own, the same ones are defined once (41) |
| `t_glsl_compat.js` | reserved words, `precision`, static globals, array and diagonal-matrix constructors, comparison functions, switch, macro typing and matrix expressions, `inverse` / `outerProduct` / `matrixCompMult`, texture lookups, `gl_FragCoord`, conditional fallback returns, file-scope detection, and DX9 constant shifts and low-bit masks (280) |
| `t_functions.js` | ReShade FX has no forward declarations: declarations are removed and callers moved after the functions they call (21) |
| `t_pipeline.js` | the transform is a list of named steps: the order that matters is declared and checked, and every step proves on its own example that it does something (105) |
| `t_loops.js` | DX9 for-loop hints, nested and unbraced bodies, explicit attributes, and function reordering (12) |
| `t_cubemap.js` | the cubemap helper agrees with the OpenGL cube map table, face order and orientation (28) |
| `t_contrast.js` | the page is readable: every text colour has enough contrast, and the critical styles agree with the stylesheet (69) |
| `t_standalone.js` | the .fx includes nothing: it declares its own vertex shader and screen texture and carries its own helpers (16) |
| `corpus/run.js` | 150 small GLSL idioms, each ported and compiled with the real ReShade compiler; synthetic DX9 loops and bit operations also check the instruction-slot budget on Windows |
| `roundtrip.js` | the lexer must reproduce every shader source exactly |

## Environment

- `SB_DIR` the porter folder (default: the folder above `tests/`, i.e. the repo root).
- `SHADER_JSON_DIR` Shadertoy `.json` exports for `roundtrip.js` (default `./shaders`, which holds three small synthetic
  multipass fixtures; real exports are not included because they carry their authors' licences). Skipped if empty.
- `RESHADEFX_CLI` path to `reshadefx_cli_fixed` from the ReShade-Testing-Initiative. Without it `corpus/run.js` is skipped.
  The corpus is compiled with no include path, which also proves that a single .fx does not need ReShade.fxh.

## The corpus

`corpus/snippets.js` is the quickest way to find what the porter still gets wrong. Add an idiom, run
`node corpus/run.js`, and the real compiler says whether the port compiles. Every fix in the 3.0.16 to 3.0.20 range
began as a failing snippet. A snippet can carry `{ noDxbc: 'reason' }` to skip the DXBC stage when only vkd3d,
the stand-in for the Direct3D compiler, objects. Windows always runs the DXBC stage using Microsoft's compiler.

On Windows, `{ dx9Budget: 512 }` also compiles a snippet for shader model 3 and checks its disassembly's
instruction-slot count. DX9 drivers can reject oversized bytecode even when compilation succeeds.

## Trying new shaders

Keep real Shadertoy exports and their converted output local, outside the repository and cloud-synced
folders. Use them to diagnose failures, then add independent synthetic cases to the regression suite.
Do not upload the exports or their conversions.

`tools/check_shaders.js` ports every Shadertoy `.json` in a folder and compiles each result with the real ReShade
compiler (the frontend, then every pixel entry point through DXBC), one line per shader. It is the quickest way to
find what the porter still gets wrong: drop in some exports, run it, and fix what fails, one shader at a time.

    npm install jsdom            (once, in tools/)
    RESHADEFX_CLI=<reshadefx_cli_fixed> node tools/check_shaders.js <folder with .json files>

## Porting a real shader without the browser

`tools/port.js` runs the porter's own `index.html` in jsdom: JSON in, the same `.fx` the page produces out.
Run `npm install jsdom` once in `tools/`, then `node tools/port.js <shader.json> <outdir>`. Compile the result
with `reshadefx_cli_fixed --list-entry-points -I <shaders> <file.fx>` to see whether the real compiler accepts it.

## Checking a cubemap by eye

`shaders/CubemapViewer.json` is a Shadertoy shader (it also runs on Shadertoy as it is) that shows the cubemap on channel 0
as an unfolded cross with coloured frames and as a panorama. Port it, put the cubemap strip where ReShade finds it,
and the six faces should join without seams. Set `FACE_TINT` to 1 to tint the panorama by face.
