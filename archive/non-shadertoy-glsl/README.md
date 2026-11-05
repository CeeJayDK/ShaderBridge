# Non-Shadertoy GLSL support (archived)

ShaderBridge ports Shadertoy shaders, and Shadertoy compiles WebGL2's GLSL ES 3.00
through ANGLE. The code here handled GLSL that Shadertoy rejects, so in the porter
it did nothing. It is kept for a future port of other GLSL dialects (desktop GLSL
4.x, GLSL ES 3.10+), or a separate tool for them. Nothing here is loaded by
`index.html` or the tests.

Each item was checked with glslang's ES 3.00 profile and, for reserved words,
against ANGLE's lexer (`src/compiler/translator/glslang.l`), which decides what
Shadertoy accepts.

| File | What | GLSL version that has it | Was in |
|---|---|---|---|
| `glsl_helpers.js` | `bitCount`, `findLSB`, `findMSB`, `bitfieldReverse`, `bitfieldExtract`, `bitfieldInsert`, `uaddCarry` helpers; `pack/unpack[US]norm4x8`; `fma` and `dFdx/dFdyFine/Coarse` renames; their analyzer result types | ES 3.10 / 3.20, GLSL 4.00+ (derivatives: 4.50) | `injectGlslHelpers`, `GLSL_RENAMED_BUILTINS` (transform), `anBuiltinType` (analyzer) |
| `vector_length.js` | `.length()` on vectors (components) and matrices (columns) | GLSL 4.30, ES 3.10 | `rewriteArrayLength` (transform) |
| `reserved_words.js` | 27 HLSL/ReShade reserved words that GLSL ES 3.00 reserves itself (`half`, `sample`, `extern`, `union` ...) | names in desktop GLSL (some) | `RESERVED_IDENTIFIERS` (transform) |
| `scalar_first_min_max.js` | analyzer typing of `min/max/clamp/pow/mod(scalar, vector)` as a vector | none: no GLSL version has these overloads; HLSL does | `anBuiltinType` (analyzer) |
| `tests.js` | the corpus snippets and unit checks for all of the above | | `tests/corpus/snippets.js`, `tests/t_glsl_compat.js`, `tests/t_types.js` |

All of it compiled with ReShade 6.8.0 when removed (ShaderBridge v3.5.13, plus the
reserved words and analyzer branch up to v3.5.14). The bit helpers were checked
against bit-by-bit references in C. Restoring an item means putting its fragment
back where the table says and its tests back in the suites.

On Linux, `bitfieldReverse` needs `reshadefx_cli_fixed` with the vkd3d
`reversebits` rewrite (ReShade-Testing-Initiative PR #4).
