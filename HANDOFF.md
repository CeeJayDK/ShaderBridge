# ShaderBridge — Handoff Document
**Date:** 2026-04-12
**Current version:** v3.0.0
**Product name:** ShaderBridge (previously "Shadertoy → ReShade FX Porter")

**Working files (dev split):**
- `shadertoy_dev.html` — shell (loads CSS + 4 JS files)
- `shadertoy_porter.css`
- `shadertoy_transform.js` — GLSL→HLSL pipeline + `PORTER_VERSION`
- `shadertoy_assemble.js` — uniform/sampler/technique assembly
- `shadertoy_json.js` — Shadertoy JSON import (NEW in v3.x)
- `shadertoy_ui.js` — pass management, UI, highlighter

**Auxiliary files:**
- `rename_shadertoy_textures.sh` — renames SHA256-hashed Shadertoy media files to human-readable names. Run from the folder containing downloaded files.

**Output:** `/mnt/user-data/outputs/`

---

## Coding Conventions (STRICT)

- **Tabs** for indentation everywhere (all files clean)
- **Allman** braces throughout
- **No trailing `f`** on float literals; floats must have `.`
- **Version bumped** in exactly **one place**: `PORTER_VERSION` at top of `shadertoy_transform.js`
- **No double blank lines** in generated output
- **No unsolicited improvements** to shader code

---

## Architecture

### File split
```
shadertoy_dev.html         Shell: <link> CSS, <script> assemble/transform/json/ui
shadertoy_porter.css       All CSS
shadertoy_assemble.js      FXH_CONTENT, buildUniformBlock, buildSamplerBlock,
                           buildChannelResolution, assembleFxFile
shadertoy_transform.js     PORTER_VERSION, analyzeShader, detectUniforms,
                           detectChannelUse, transformGLSL, rewrite*,
                           normalizeIndentation
shadertoy_json.js          currentShaderInfo, hash maps, extractMediaHash,
                           resolveJsonInput, populateFromJson, loadJsonFile
shadertoy_ui.js            Pass/channel data, renderTabBar, renderChannelBar,
                           renderChannelOptions, convert(), UI, highlighter
```

### Script load order in HTML
`assemble.js` → `transform.js` → `json.js` → `ui.js`

---

## Layout Structure

```
<header>
  "ShaderBridge" logo + tagline (version from PORTER_VERSION via JS on load)
  [header-right]
    header-opts 2×2 grid: Flip Y | Separate .fxh | Highlighting | Tabs
    sep
    indicators 2×2 grid: Matrix Math | Custom Textures | Audio Input | Multipass

<div class="main">  (CSS grid, 2 columns)
  [row 1: pane headers]
    .pane-header  "◈ Shadertoy Input (GLSL)"  [Load File / Clear / Load Example]
    .pane-header  "◈ ReShade FX Output (.fx)"  [Copy / Download .fx / Download .fxh]

  [row 2: pass tab bar — full width]
    .tab-bar.full-width
      "Passes:" label | Common | BufA? | ... | Image | + | [spacer] | Format▾ (buffer only)

  [row 3: channel bar — full width]
    .channel-bar.full-width
      "Channels:" label | CH0▾ | CH1▾ | ... | + | [spacer] | Type▾ Name▾ info Filter▾ Wrap▾ Vflip

  [row 4: editors — 2 columns]
    .editor-wrap  |  .editor-wrap
    .editor-hscroll  |  .editor-hscroll

  .convert-row (sticky bottom, full width)
  .log-bar (full width, grows with content)
```

**Tooltips:** All static controls use `data-tip` attribute; CSS `[data-tip]::after` renders them. Dynamically-created channel controls use `.title` property.

---

## Pass Management (ui.js)

### Data model
```javascript
passes      = { id: { src, channels: {0: chObj, 2: chObj}, format, selfRefChannels? } }
activePasses = ['common', 'bufA'?, ..., 'image']  // ordered
activePassId = 'image'   // currently visible pass tab
activeChIdx  = 0         // currently visible channel tab (null = none)
currentShaderInfo = null | { id, name, username, description, url }
```

### chObj structure
```javascript
{ type, name, filter, wrap, vflip }
// type:   'none' | 'backbuffer' | 'bufA'..'cubemapA' | 'texture' | 'cubemap' | 'volume'
// name:   resource name string (for texture/cubemap/volume)
// filter: 'linear' | 'nearest' | 'mipmap'
// wrap:   'repeat' | 'clamp'
// vflip:  bool
```

### channels is SPARSE — keys are indices 0–3 only for added channels

### selfRefChannels
Array of channel indices (0–3) where the pass feeds from its own output (ping-pong).
Stored on `passes[id].selfRefChannels`. Propagated through `convert()` → assembler.
Assembler inserts a `tex_BufX_Prev` texture + `PS_Copy_BufX` copy pass per self-referencing buffer.

### Pass IDs and labels
```
PASS_ORDER  = ['common', 'bufA', 'bufB', 'bufC', 'bufD', 'cubemapA', 'image']
PASS_LABELS = { common:'Common', bufA:'Buffer A', ..., cubemapA:'Cubemap A', image:'Image' }
BUF_IDS     = ['bufA', 'bufB', 'bufC', 'bufD', 'cubemapA']
```

### currentShaderInfo lifecycle
- Set by `populateFromJson()` when loading a .json file
- Cleared by `clearAll()`, `loadExample()`, and non-JSON file loads
- Passed to `assembleFxFile()` as 5th argument
- Used for: output file header (name/author/URL/description), technique name, download filename

---

## Shadertoy JSON Import (shadertoy_json.js)

### Data maps
- `SHADERTOY_TEXTURE_HASH_MAP` — 22 entries, SHA256 hash → CH_TEXTURES name (fully verified)
- `SHADERTOY_CUBEMAP_HASH_MAP` — 6 entries, SHA256 hash → CH_CUBEMAPS name (from reference page)
- `SHADERTOY_VOLUME_HASH_MAP` — 2 entries, SHA256 hash → CH_VOLUMES name (from reference page)
- `extractMediaHash(filepath)` — extracts hash from `/media/a/<hash>[_N].<ext>`

### Input type mapping
| Shadertoy type | Porter result |
|---|---|
| `buffer` | matched to bufA..cubemapA via outputIdMap; self-ref detected |
| `texture` | `texture` + hash lookup for name |
| `cubemap` | `cubemap` + hash lookup for name |
| `volume` | `volume` + hash lookup for name |
| `musicstream` / `soundcloud` / `music` | `none` + warning |
| `webcam` | `backbuffer` + warning (apply ReShade to webcam app) |
| `video` | `backbuffer` + warning (apply ReShade to video player) |
| `keyboard` / `mic` | `none` + warning |
| unknown | `none` + warning |

### Buffer slot mapping
Buffer passes identified by `rp.name`: "Buffer A"→bufA, "Buffer B"→bufB, etc.
Output resource IDs mapped to pass IDs via `outputIdMap`.

### populateFromJson flow
1. Extract `info` → `currentShaderInfo`
2. Build `outputIdMap` (buffer output resource ID → pass ID)
3. Reset passes to Common + Image
4. Sort buffer passes into PASS_ORDER order, add each, resolve channels
5. Detect self-referencing channels (input.id matches own output ID)
6. Populate image pass channels
7. Switch to image tab, render UI

---

## Transform Pipeline (transformGLSL)

Signature: `transformGLSL(src, messages, passLabel)`
Returns: `{ src, outVar, coordVar, mainImageName }`

### Pipeline order
1. Extract block + line comments → `«N»` placeholders
2. Remove `#version`, `layout(...)`, precision qualifiers
3. `gl_FragCoord` → `fragCoord`
4. Strip Shadertoy uniform re-declarations
5. Strip trailing `f` from float literals
6. Type replacements: `vec→float`, `ivec→int`, `uvec→uint`, `bvec→bool`, `mat→floatNxN`
7. `rewriteStructConstructors`: `Name(a,b,c)` → `Name_ctor(a,b,c)` + emit helper
8. Intrinsic replacements: `mix→lerp`, `fract→frac`, `inversesqrt→rsqrt`, `dFdx→ddx`, `dFdy→ddy`
9. HLSL reserved keyword rename: `point→point_`, `line→line_`, `linear→linear_`, `sample→sample_`, `pass→pass_`
10. `const→static const` (file scope only)
11. Replace `acos(-1.)` and `sqrt(.5)` const initialisers with literals
12. Mutable file-scope globals → `static` (2 passes)
13. `rewriteMatrixMulAssign`: `vecN *= matN` → `vecN = mul(matN, vecN)`
14. Remove unreachable statements after `return`
15. `rewriteInlineMatrixMul`
16. `rewriteVectorConstructorArgs`: truncate over-specified constructors
17. `rewriteBroadcastConstructors`: `vec3(x)` → `float3(x, x, x)`
18. Scalar cast upgrader (anchoring)
19. `rewriteTwoArgAtan`: `atan(y, x)` → `atan2(y, x)`
20. `texture()` / `texture2D()` → `tex2D()` (paren-balanced)
21. `textureGrad` → `tex2Dgrad`
22. `textureLod` → `tex2Dlod`
23. **`rewriteCubemapSamples`**: `textureCube(s,d)` → `tex2D(s, ST_cubemap_uv(d))` + helper injection (NEW v3.0.0)
24. `clamp(x,0,1)` → `saturate(x)`
25. GLSL array initialisers → `{...}`
26. `mainImage` signature → HLSL entry point; captures outVar/coordVar
27. `rewriteMainBody`: inject `outVar = float4(0,0,0,1)` + `return`
28. `normalizeIndentation`: spaces→tabs
29. Allman brace pass
30. **Gradient texture rewrite in loops**: `tex2D/tex3D/texCUBE/tex2Dbias` inside loop bodies → explicit-LOD equivalents
31. Restore comments

### Cubemap rewrite (step 23)
`rewriteCubemapSamples` rewrites:
- `textureCube(samp, dir)` → `tex2D(samp, ST_cubemap_uv(dir))`
- `textureCubeLod(samp, dir, lod)` → `tex2Dlod(samp, float4(ST_cubemap_uv(dir), 0.0, lod))`

Injects `ST_cubemap_uv(float3 d)` helper at top of source. Face layout (horizontal strip): `+X | -X | +Y | -Y | +Z | -Z` (standard OpenGL/Shadertoy convention).

Must run **before** the loop gradient rewriter (step 30) so resulting `tex2D` calls inside loops get promoted to `tex2Dlod`.

### Placeholder systems
- Transform: `«⁰»`, `«¹»` etc. (guillemets + superscript digits)
- Highlighter: `‹§⁰›` etc.

---

## Assembly (assembleFxFile)

Signature: `assembleFxFile(transformedPasses, flipY, separateFxh, messages, shaderInfo)`

`shaderInfo` (optional): `{ id, name, username, description, url }`

`transformedPasses`: array of `{ id, src, coordVar, mainImageName, usedUniforms, channels[4], channelNames[4], filters[4], wraps[4], vflips[4], format, selfRefChannels[] }`

### Output header
When `shaderInfo` present, emits:
```
/*
    ShaderBridge v3.0.0 — Shadertoy → ReShade FX Porter
    Created by CeeJay.dk & Claude Sonnet (Anthropic)

    Shader  : <name>
    Author  : <username>
    Source  : https://www.shadertoy.com/view/<id>
    Description:
      <description lines>
*/
```

### Technique name
Derived from `shaderInfo.name` sanitized to valid identifier. Falls back to `ShadertoyPort`.

### Self-referencing buffer copy passes
For each buffer pass with `selfRefChannels.length > 0`:
1. Emits `tex_BufX_Prev` texture (same format as `tex_BufX`)
2. Emits `PS_Copy_BufX` trivial copy pixel shader
3. Redirects self-referencing channel samplers to `tex_BufX_Prev`
4. Inserts `pass Copy_BufX { RenderTarget = tex_BufX_Prev; }` **before** `pass BufX` in technique

Covers all buffer passes (bufA–bufD, cubemapA), not just bufA.

### Texture sampler block
`buildSamplerBlock(channelConfig, usedChannels, bufTexNames, messages, channelAttribs, channelNames)`

Named Shadertoy textures emit correct filename, dimensions, and format automatically:
- e.g. `source = "Blue Noise.png"; Width = 1024; Height = 1024; Format = RGBA8;`
- Unknown textures fall back to `MyTexture0.png` placeholder + warning

Cubemaps emit correct strip dimensions per cubemap name (e.g. Uffizi = 3072×512).
`ST_cubemap_uv()` handles direction→UV; no manual UV adjustment needed.

### iChannelResolution
Moved out of `buildUniformBlock`. Emitted per-pass after samplers via `buildChannelResolution()`.

---

## Known Issues / Open Items

### Crosire inquiry pending — `[loop]` support
`[loop]` was replaced with `tex2D→tex2Dlod` rewrites. Still worth confirming with Crosire whether `[loop]` is implemented in the ReShade FX compiler frontend.

### `clearActivePass` orphaned function
`clearActivePass()` in ui.js is defined but never called. Can be removed.

### `updateInputPaneTitle` is a no-op stub
Kept for call-site compatibility. Can be removed with its call sites.

### `PASS_ORDER` variable unused
Declared at ui.js but never referenced. Can be removed.

### Cubemap A pass — assembler not fully wired
`cubemapA` is in `BUF_IDS` and can be added as a pass, but `assembleFxFile` only handles `bufA..bufD` in `bufLabels`. `cubemapA` needs a label + texture declaration + render target entry in the technique block.

### Common tab in multipass — content duplicated per pass
Common's transformed content appears once per pass in the output. Function deduplication mitigates this but doesn't eliminate redundant `#define`s and `static const` declarations.

### Ping-pong buffers — copy pass timing
The copy pass captures `tex_BufX` **at the start of the current frame** (i.e. the result from the previous frame). This is correct for most self-referencing shaders. However if a shader relies on reading mid-frame intermediate state this will not match Shadertoy's behaviour exactly.

### No way to reorder pass tabs
Fixed order. Drag-to-reorder not implemented.

### Cubemap face orientation unverified
`ST_cubemap_uv()` uses standard OpenGL face conventions. If a cubemap shader looks wrong (rotated/flipped faces), individual face UV expressions may need adjustment. +Y face in particular sometimes differs between engines.

### Unused JSON fields (future work)
`info.date`, `info.tags`, `info.likes`, `info.parentname`, `flags.mFlagVR`,
`renderpass[].description` — all present in the JSON but not yet used.
Suggested use: emit date/tags/fork-credit in output file header; VR flag → conversion log warning; pass description → comment block at top of pass source.

---

## Resource Data

### CH_TEXTURES (22 entries — all hashes verified by visual inspection)
All Shadertoy built-in 2D textures mapped by SHA256 hash in `SHADERTOY_TEXTURE_HASH_MAP` in `shadertoy_json.js` (lines 39–63).
Human-readable filenames produced by `rename_shadertoy_textures.sh`.

### CH_CUBEMAPS (6 entries)
Hashes from reference page: https://shadertoyunofficial.wordpress.com/2019/07/23/shadertoy-media-files/
Stored as separate face files; need assembly into horizontal strip for ReShade use.

### CH_VOLUMES (2 entries)
Grey Noise 3D (32×32×32 R8) → `vol1`
RGBA Noise 3D (32×32×32 RGBA8) → `vol4`
Binary format: 4-byte header "BIN\n" + 4 ints (w, h, d, channels) + raw data.

---

## Version History (recent)

| Version | Key changes |
|---------|-------------|
| v2.5.6  | Last version before this session block |
| v2.6.0  | Shadertoy JSON import; SHA256 texture hash maps; self-referencing buffer copy passes; ShaderBridge name; file split (shadertoy_json.js); `currentShaderInfo` metadata in output header |
| v3.0.0  | `textureCube` / `textureCubeLod` rewritten to `tex2D` + `ST_cubemap_uv()` helper; texture sampler block uses correct filenames/dimensions for named resources; video input → BackBuffer; tooltips on all UI controls; log tag alignment; ShaderBridge branding throughout; input pane usage guide placeholder; `loadExample` + `clearAll` clear `currentShaderInfo`; `rename_shadertoy_textures.sh` script |
