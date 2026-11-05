# ShaderBridge

Convert Shadertoy exports to ReShade FX locally. Open `index.html`, import your
export, convert it, and save the `.fx` file in `reshade-shaders/Shaders`.

## Texture assets

Selecting a texture in ShaderBridge selects its expected filename; it does not
embed that image in the `.fx` download. External images are required separately.
Generated buffer, cubemap and volume outputs are created at runtime. Any external
images sampled by those passes still need installation.

The local `Textures` folder holds the prepared standard assets. They are excluded
from Git, so a GitHub source download does not include them. `dist` holds generated
installation ZIPs. Test shader exports and conversions are not part of these packs.

To package an already prepared texture set:

```powershell
python -m pip install Pillow
python tools/build_texture_pack.py --prepared-dir "D:/Downloads/textures_reshade_kontrolleret"
```

The builder writes all 30 mapped assets to `Textures` and creates
`dist/ShaderBridge_Textures_<version>.zip`. Prepared files are copied unchanged,
including the existing cubemap strips and DDS volumes. The supplied control report
is included when present. Alternatively, use `--media-dir` with a local copy of the
[Shadertoy media archive](https://github.com/brisingre/shadertoy-media) to assemble
cubemap strips and convert volumes from their original files.
The pack includes a source/checksum manifest and installation instructions.
It reads only the catalogued standard assets and does not access shader exports.
Maintainers can run `node tools/check_texture_catalog.js` to check filenames,
dimensions and formats against the actual emitted FX declarations.

Extract the ZIP into the game/application directory. Files go into
`reshade-shaders/Textures`; ensure that directory is listed in ReShade's
**Settings > Texture search paths**. Keep the filenames unchanged. A shader using
custom assets still needs those files separately.

### Redistribution status

ShaderBridge's code is MIT-licensed. That does not license third-party images.
The source archive's notice only tentatively identifies CC BY-NC-SA 3.0 and does
not establish each asset's terms or attribution. The generated texture ZIP is a
local package pending confirmation of redistribution rights and credits; it is
not currently a public release asset. The builder does not upload anything.

## Scope

ShaderBridge accepts what Shadertoy accepts: WebGL2's GLSL ES 3.00. Code that handled
newer GLSL versions, or names GLSL ES reserves, is kept in
[archive/non-shadertoy-glsl](archive/non-shadertoy-glsl/README.md) for a future port
of other dialects; the converter does not load it.

## Validation

See [tests/README.md](tests/README.md) for conversion and compiler checks.
Compilation and capture inspection do not establish full visual equivalence.
Audio and keyboard inputs are currently stubbed, and DX9 has additional shader
model limits. Private real-world test shaders and their conversions stay local.
