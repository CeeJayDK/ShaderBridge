# ShaderBridge tests

Run with Node (no dependencies):

    node run_all.js

| Suite | What it checks |
|---|---|
| `t_types.js` | the analyzer's type inference and scoping (64 cases) |
| `t_analyzer.js` | what each phase of the analysis adds (tokens, dead branches, macros, structs, signatures, scopes, lookup, expression walk) and that the phases need each other in order (68) |
| `t_structs.js` | nested struct values, constructors, deep members, field names and comments, conditional declarations, and aliased out/inout updates (20) |
| `t_porter_mat.js` | `rewriteInlineMatrixMul`, loaded exactly as it ships, including file-scope initialisers (33) |
| `t_porter_vec.js` | `rewriteVectorConstructorArgs` (25) |
| `t_broadcast.js` | scalar broadcast constructors expand, vector conversions and copies do not (31) |
| `t_flip.js` | the `ST_FLIP_Y` / `ST_VFLIP_*` options, the mouse, no `iResolution` dependency (33) |
| `t_vflip.js` | V flip at texture sample sites, with the flag passed through sampler parameters, including offset overloads and loops with HLSL attributes (42) |
| `t_texelfetch.js` | `texelFetch` / `textureSize`, and row-mirrored fetches from Vflip textures (20) |
| `t_samplers.js` | sampler and texture names clashing across passes, macro aliases, hoisted initializers, unconnected helper inputs, and buffer mip chains (21) |
| `t_common.js` | Common declarations are shared or renamed across passes as needed; arrays stay local to each pass; macro environments, channel resolutions, indentation, comment braces, and nested else-if blocks preserve each pass's meaning; only passes contributing to Image are selected (55) |
| `t_glsl_compat.js` | output defaults and inout preservation, reserved words, `precision`, static globals, array and matrix constructors, conditional and symbolic array lengths, comparison functions, switch, macro typing, definition order and name collisions, rectangular matrix expressions, `inverse` / `outerProduct` / `matrixCompMult`, texture lookups, visual sample-rate declarations, `gl_FragCoord`, conditional fallback returns, file-scope detection, half-float unpacking, dynamic writes to vector components, and DX9 constant shifts and low-bit masks (348) |
| `t_functions.js` | ReShade FX has no forward declarations: declarations are removed and callers moved after the functions they call (21) |
| `t_pipeline.js` | the transform is a list of named steps: the order that matters is declared and checked, and every step proves on its own example that it does something (146) |
| `t_loops.js` | DX9 for-loop hints, large constant loops, nested and unbraced bodies, explicit attributes, function reordering, and specialized texture helpers reached from loops, and array-write unrolling (30) |
| `t_conditional_loops.js` | shared conditional loop bodies, preserved alternatives, balanced scopes, attributes, comments and idempotence (14) |
| `t_frames.js` | an effect-local frame counter starts at zero after loading, uses separate read/write textures, and runs before shader passes (5) |
| `t_cubemap.js` | the cubemap helper agrees with the OpenGL cube map table; generated cubemap inputs, render targets, face-local entry points and feedback are connected correctly (32) |
| `t_volume.js` | native 3D lookup types and overloads, generated volume inputs, compute dispatch bounds, voxel centers, feedback snapshots, channel dimensions and mipmaps (27) |
| `t_returns.js` | numeric fall-through returns, complete branches, loop exits, and preservation of existing returns (17) |
| `t_contrast.js` | the page is readable: every text colour has enough contrast, and the critical styles agree with the stylesheet (70) |
| `t_standalone.js` | the .fx includes nothing; author attribution precedes porter credits, metadata stays inside comments, and frame duration uses seconds (20) |
| `corpus/run.js` | 182 small GLSL idioms, each ported and compiled with the real ReShade compiler; synthetic DX9 loops and bit operations also check the instruction-slot budget on Windows |
| `t_assembly_compile.js` | 48 complete synthetic effects, including nested structs with value copies and out/inout aliases, conditional array lengths and shared tables, buffer mipmaps, unconnected helper samplers, generated cubemap feedback, multipass macro isolation, resource aliases, hoisted texture reads, channel resolutions, and metadata; every entry point compiles for DX11; 44 also compile for DX9 on Windows (two dynamic array-write cases and two compute-volume cases require a modern API) |
| `roundtrip.js` | the lexer must reproduce every shader source exactly |

## Environment

- `SB_DIR` the porter folder (default: the folder above `tests/`, i.e. the repo root).
- `SHADER_JSON_DIR` Shadertoy `.json` exports for `roundtrip.js` (default `./shaders`, which holds three small synthetic
  multipass fixtures; real exports are not included because they carry their authors' licences). Skipped if empty.
- `RESHADEFX_CLI` path to `reshadefx_cli_fixed` from the ReShade-Testing-Initiative. Without it the corpus and complete-effect compiler suites are skipped.
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

Generated Cubemap A passes use `mainCubemap` and render into a six-face horizontal atlas. Faces are
1024 by 1024 by default; `ST_CUBEMAP_SIZE` controls the face size. Feedback uses a separate previous-frame
texture. A cubemap's `iResolution` and channel resolution describe one face, not the entire atlas.

Some complex effects trigger an internal error in Microsoft's shader optimizer. To distinguish that
from a porter error, retry compilation with `-Od`. For a runtime test, add
`#pragma reshade skipoptimization` to the local effect. Record this workaround in the test report.

`shaders/CubemapViewer.json` is a Shadertoy shader (it also runs on Shadertoy as it is) that shows the cubemap on channel 0
as an unfolded cross with coloured frames and as a panorama. Port it, put the cubemap strip where ReShade finds it,
and the six faces should join without seams. Set `FACE_TINT` to 1 to tint the panorama by face.

## Generated volumes

Volume A imports as a native 3D texture. A compute pass calls `mainVolume` once per voxel,
and self-feedback uses a separate previous-frame volume. `ST_VOLUME_SIZE` controls each
axis (default 128). Generated volumes require compute support: DX11 or another compute-capable
renderer. Implicit texture samples in a volume compute pass use mip level zero; explicit
LOD and gradient samples retain their specified arguments.

ReShade 6.8 uses two-component offsets in its 3D LOD/gradient offset overloads.
Those calls produce explicit conversion errors requiring a manual rewrite. Basic 3D sampling,
ordinary texture offsets and integer fetch offsets compile for both DX9 and DX11.

Statement-level conditional expressions are lowered to `if`/`else` blocks, including
comma-expression arms and complete comma chains used as unbraced loop bodies. This
preserves selected-arm side effects in ReShade, which otherwise evaluates both ternary arms.

Numeric functions without a proven return on every path receive a zero fallback, with a
conversion warning. Existing return statements stay unchanged. Functions containing conditional
compilation or switch statements, and functions returning custom structs, are left for manual
review rather than guessing their fall-through behavior.

Alternative `for`/`while` headers that open a shared body in `#if`/`#else` branches
are normalized to complete bodies before analysis. Both alternatives stay selectable;
shared tails containing preprocessor directives are left unchanged.
