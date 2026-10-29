// ═════════════════════════════════════════════════════════════════════════════
// HELPER SOURCE  (GLSL compatibility helpers, written into every generated .fx)
// ═════════════════════════════════════════════════════════════════════════════

var HELPER_SOURCE =
	"// ── Intrinsic remaps ──\n"
	+ "\n"
	+ "// GLSL mod(x, y) floors toward -inf; HLSL fmod truncates toward zero.\n"
	+ "#define mod(x, y) ((x) - (y) * floor((x) / (y)))\n"
	+ "\n";


// ═════════════════════════════════════════════════════════════════════════════
// BUILD RESHADE UNIFORM DECLARATIONS
// ═════════════════════════════════════════════════════════════════════════════

function selectImageDependencies(passes)
{
	var needed = { image: true }, changed = true;
	while (changed)
	{
		changed = false;
		passes.forEach(function (p)
		{
			if (!needed[p.id]) { return; }
			(p.channels || []).forEach(function (channel)
			{
				if (!needed[channel] && passes.some(function (candidate) { return candidate.id === channel; })) { needed[channel] = true; changed = true; }
			});
		});
	}
	return passes.filter(function (p) { return needed[p.id]; });
}

function buildUniformBlock(usedUniforms) {
	var lines = [];

	// iChannelTime is stubbed to iTime, so a shader that uses only iChannelTime needs iTime declared too
	if (usedUniforms.has('iChannelTime') && !usedUniforms.has('iTime')) {
		usedUniforms = new Set(usedUniforms);
		usedUniforms.add('iTime');
	}

	function sep() { if (lines.length) { lines.push(''); } }

	if (usedUniforms.has('iResolution')) {
		lines.push('// iResolution — screen size in pixels');
		lines.push('static const float3 iResolution = float3(BUFFER_WIDTH, BUFFER_HEIGHT, 1.0);');
	}
	if (usedUniforms.has('iTime')) {
		sep();
		lines.push('// iTime — elapsed time in seconds');
		lines.push('uniform float iTimeMS < source = "timer"; >;');
		lines.push('#define iTime (iTimeMS * 0.001)');
	}
	if (usedUniforms.has('iTimeDelta')) {
		sep();
		lines.push('// iTimeDelta — time for last frame in seconds');
		lines.push('uniform float iTimeDeltaMS < source = "frametime"; >;');
		lines.push('#define iTimeDelta (iTimeDeltaMS * 0.001)');
	}
	if (usedUniforms.has('iFrameRate')) {
		sep();
		lines.push('// iFrameRate — frames per second');
		lines.push('uniform float frametime_ms < source = "frametime"; >;');
		lines.push('#define iFrameRate (1000.0 * rcp(frametime_ms))');
	}
	if (usedUniforms.has('iFrame')) {
		sep();
		lines.push('// iFrame starts at zero when this effect first renders, after shader compilation.');
		lines.push('#define iFrame int(tex2Dfetch(ST_FrameSampler, int2(0, 0)).x)');
	}
	if (usedUniforms.has('iDate')) {
		sep();
		lines.push('// iDate — float4(year, month 1-12, day 1-31, seconds since midnight)');
		lines.push('uniform float4 iDate < source = "date"; >;');
	}
	if (usedUniforms.has('iSampleRate')) {
		sep();
		lines.push('// Audio is unavailable; expose the conventional sample rate for visual shaders.');
		lines.push('static const float iSampleRate = 44100.0;');
	}
	if (usedUniforms.has('iMouse')) {
		sep();
		lines.push('// iMouse — cursor and click position in pixels');
		lines.push('uniform float2 iMousePos  < source = "mousepoint"; >;');
		lines.push('uniform bool   iMouseBtn0 < source = "mousebutton"; keycode = 0; mode = ""; >;');
		// ReShade reports the cursor from the top-left; with ST_FLIP_Y the shader works bottom-up, so Y follows it
		lines.push('#define iMousePosST float2(iMousePos.x, ST_FLIP_Y ? BUFFER_HEIGHT - iMousePos.y : iMousePos.y)');
		lines.push('#define iMouse float4(iMousePosST, iMouseBtn0 ? iMousePosST : float2(0.0, 0.0))');
	}
	if (usedUniforms.has('iChannelTime')) {
		sep();
		lines.push('// iChannelTime — stubbed to iTime (no video input support)');
		lines.push('#define iChannelTime float4(iTime, iTime, iTime, iTime)');
	}
	// iChannelResolution is emitted per-pass after samplers (see assembleFxFile)

	return lines.join('\n');
}

// ═════════════════════════════════════════════════════════════════════════════
// BUILD TEXTURE / SAMPLER DECLARATIONS
// ═════════════════════════════════════════════════════════════════════════════

// bufTexNames: map of bufId → texture name, pre-built for the whole file
// channelAttribs: { filters, wraps, vflips } arrays parallel to channelConfig
// channelNames: array[4] of resource name strings (for texture/cubemap dimension lookup)
function buildSamplerBlock(channelConfig, usedChannels, bufTexNames, messages, channelAttribs, channelNames) {
	var lines = [];

	// Helpers to map UI values to ReShade FX sampler state tokens
	function filterToken(f) {
		if (f === 'nearest') { return 'POINT'; }
		if (f === 'mipmap') { return 'LINEAR'; } // mag/min linear, mip handled separately
		return 'LINEAR'; // default
	}
	function wrapToken(w) {
		return (w === 'clamp') ? 'CLAMP' : 'WRAP';
	}
	function hasMip(f) { return f === 'mipmap'; }

	for (var i = 0; i < 4; i++) {
		if (usedChannels.indexOf(i) === -1) { continue; }

		var cfg = channelConfig[i];
		var filter = (channelAttribs && channelAttribs.filters && channelAttribs.filters[i]) || 'linear';
		var wrap = (channelAttribs && channelAttribs.wraps && channelAttribs.wraps[i]) || 'repeat';
		var vflip = (channelAttribs && channelAttribs.vflips && channelAttribs.vflips[i]) || false;

		var fTok = filterToken(filter);
		var wTok = wrapToken(wrap);
		var mip = hasMip(filter);

		if (lines.length) { lines.push(''); }

		if (cfg === 'backbuffer') {
			lines.push('// iChannel' + i + ' — ReShade BackBuffer');
			lines.push('sampler2D iChannel' + i);
			lines.push('{');
			lines.push('\tTexture   = ReShade::BackBufferTex;');
			lines.push('\tMagFilter = ' + fTok + ';');
			lines.push('\tMinFilter = ' + fTok + ';');
			if (mip) { lines.push('\tMipFilter = LINEAR;'); }
			lines.push('\tAddressU  = ' + wTok + ';');
			lines.push('\tAddressV  = ' + wTok + ';');
			if (vflip) { lines.push('\t// Vflip: V is flipped at the sample sites (switch it with the ST_VFLIP definitions at the top)'); }
			lines.push('};');
		}
		else if (cfg === 'texture') {
			var texName = channelNames && channelNames[i] ? channelNames[i] : '';
			// Look up known dimensions for named Shadertoy textures
			var texData = [
				{ name: 'Abstract 1',        w: 1024, h: 1024, fmt: 'RGBA8',  ext: 'jpg' },
				{ name: 'Abstract 2',        w: 512,  h: 512,  fmt: 'RGBA8',  ext: 'jpg' },
				{ name: 'Abstract 3',        w: 1024, h: 1024, fmt: 'RGBA8',  ext: 'jpg' },
				{ name: 'Bayer',             w: 8,    h: 8,    fmt: 'R8',     ext: 'png' },
				{ name: 'Blue Noise',        w: 1024, h: 1024, fmt: 'RGBA8',  ext: 'png' },
				{ name: 'Font 1',            w: 1024, h: 1024, fmt: 'RGBA8',  ext: 'png' },
				{ name: 'Gray Noise Medium', w: 256,  h: 256,  fmt: 'R8',     ext: 'png' },
				{ name: 'Gray Noise Small',  w: 64,   h: 64,   fmt: 'R8',     ext: 'png' },
				{ name: 'Lichen',            w: 1024, h: 1024, fmt: 'RGBA8',  ext: 'jpg' },
				{ name: 'London',            w: 512,  h: 512,  fmt: 'RGBA8',  ext: 'jpg' },
				{ name: 'Nyancat',           w: 256,  h: 32,   fmt: 'RGBA8',  ext: 'png' },
				{ name: 'Organic 1',         w: 1024, h: 1024, fmt: 'RGBA8',  ext: 'jpg' },
				{ name: 'Organic 2',         w: 1024, h: 1024, fmt: 'RGBA8',  ext: 'jpg' },
				{ name: 'Organic 3',         w: 1024, h: 1024, fmt: 'RGBA8',  ext: 'jpg' },
				{ name: 'Organic 4',         w: 1024, h: 1024, fmt: 'RGBA8',  ext: 'jpg' },
				{ name: 'Pebbles',           w: 512,  h: 512,  fmt: 'R8',     ext: 'png' },
				{ name: 'RGBA Noise Medium', w: 256,  h: 256,  fmt: 'RGBA8',  ext: 'png' },
				{ name: 'RGBA Noise Small',  w: 64,   h: 64,   fmt: 'RGBA8',  ext: 'png' },
				{ name: 'Rock Tiles',        w: 512,  h: 512,  fmt: 'RGBA8',  ext: 'jpg' },
				{ name: 'Rusty Metal',       w: 512,  h: 512,  fmt: 'RGBA8',  ext: 'jpg' },
				{ name: 'Stars',             w: 512,  h: 512,  fmt: 'RGBA8',  ext: 'jpg' },
				{ name: 'Wood',              w: 1024, h: 1024, fmt: 'RGBA8',  ext: 'jpg' }
			];
			var td = null;
			for (var ti = 0; ti < texData.length; ti++) { if (texData[ti].name === texName) { td = texData[ti]; break; } }
			var srcFile = td ? (texName + '.' + td.ext) : ('MyTexture' + i + '.png');
			var texW    = td ? td.w   : 1024;
			var texH    = td ? td.h   : 1024;
			var texFmt  = td ? td.fmt : 'RGBA8';
			lines.push('// iChannel' + i + ' — ' + (texName || 'custom texture'));
			if (!td) { lines.push('// Supported formats: .bmp  .png  .jpg  .tga  .dds'); }
			lines.push('texture2D tex_iChannel' + i + ' < source = "' + srcFile + '"; >');
			lines.push('{');
			lines.push('\tWidth  = ' + texW + ';');
			lines.push('\tHeight = ' + texH + ';');
			lines.push('\tFormat = ' + texFmt + ';');
			// A mipmap-filtered sampler only has mips to sample if the texture declares them
			if (mip) { lines.push('\tMipLevels = ' + (Math.floor(Math.log2(Math.max(texW, texH))) + 1) + ';'); }
			lines.push('};');
			lines.push('sampler2D iChannel' + i);
			lines.push('{');
			lines.push('\tTexture   = tex_iChannel' + i + ';');
			lines.push('\tMagFilter = ' + fTok + ';');
			lines.push('\tMinFilter = ' + fTok + ';');
			if (mip) { lines.push('\tMipFilter = LINEAR;'); }
			lines.push('\tAddressU  = ' + wTok + ';');
			lines.push('\tAddressV  = ' + wTok + ';');
			if (vflip) { lines.push('\t// Vflip: V is flipped at the sample sites (switch it with the ST_VFLIP definitions at the top)'); }
			lines.push('};');
			if (!td) { messages.push({ level: 'warn', text: 'iChannel' + i + ': rename "MyTexture' + i + '.png" and adjust Width/Height/Format to match your texture.' }); }
		}
		else if (cfg === 'cubemap') {
			// Look up face size from known cubemap list; default to 256 if unknown
			var cubeName = channelNames && channelNames[i] ? channelNames[i] : '';
			var faceSize = 256;
			var cubemapData = [
				{ name: 'Forest',                       w: 256 },
				{ name: 'Forest Blurred',               w: 64  },
				{ name: "St. Peter's Basilica",         w: 256 },
				{ name: "St. Peter's Basilica Blurred", w: 64  },
				{ name: 'Uffizi Gallery',               w: 512 },
				{ name: 'Uffizi Gallery Blurred',       w: 64  }
			];
			for (var ci = 0; ci < cubemapData.length; ci++) {
				if (cubemapData[ci].name === cubeName) { faceSize = cubemapData[ci].w; break; }
			}
			var stripW = faceSize * 6;
			var stripH = faceSize;
			lines.push('// iChannel' + i + ' — Cubemap horizontal strip (' + stripW + 'x' + stripH + ', 6 faces: +X/-X/+Y/-Y/+Z/-Z)');
			lines.push('// ST_cubemap_uv() injected by porter handles the direction → UV conversion.');
			lines.push('texture2D tex_iChannel' + i + '_cube < source = "' + (cubeName || 'Cubemap') + '.png"; >');
			lines.push('{');
			lines.push('\tWidth  = ' + stripW + ';');
			lines.push('\tHeight = ' + stripH + ';');
			lines.push('\tFormat = RGBA8;');
			lines.push('};');
			lines.push('sampler2D iChannel' + i);
			lines.push('{');
			lines.push('\tTexture   = tex_iChannel' + i + '_cube;');
			lines.push('\tMagFilter = ' + fTok + ';');
			lines.push('\tMinFilter = ' + fTok + ';');
			if (mip) { lines.push('\tMipFilter = LINEAR;'); }
			lines.push('\tAddressU  = CLAMP;');
			lines.push('\tAddressV  = CLAMP;');
			lines.push('};');
			if (!cubeName) { messages.push({ level: 'warn', text: 'iChannel' + i + ': rename "Cubemap.png" to your cubemap strip image and adjust Width/Height as needed.' }); }
		}
		else if (cfg === 'vol1') {
			lines.push('// iChannel' + i + ' — Volume 32x32x32 1-channel');
			lines.push('texture3D tex_iChannel' + i + '_vol < source = "Noise3D_1ch.dds"; > { Width = 32; Height = 32; Depth = 32; Format = R8; };');
			lines.push('sampler3D iChannel' + i);
			lines.push('{');
			lines.push('\tTexture   = tex_iChannel' + i + '_vol;');
			lines.push('\tMagFilter = ' + fTok + ';');
			lines.push('\tMinFilter = ' + fTok + ';');
			if (mip) { lines.push('\tMipFilter = LINEAR;'); }
			lines.push('\tAddressU  = WRAP;');
			lines.push('\tAddressV  = WRAP;');
			lines.push('\tAddressW  = WRAP;');
			lines.push('};');
			messages.push({ level: 'warn', text: 'iChannel' + i + ': 3D volume texture — supply a matching .dds file.' });
		}
		else if (cfg === 'vol4') {
			lines.push('// iChannel' + i + ' — Volume 32x32x32 4-channel');
			lines.push('texture3D tex_iChannel' + i + '_vol < source = "Noise3D_4ch.dds"; > { Width = 32; Height = 32; Depth = 32; Format = RGBA8; };');
			lines.push('sampler3D iChannel' + i);
			lines.push('{');
			lines.push('\tTexture   = tex_iChannel' + i + '_vol;');
			lines.push('\tMagFilter = ' + fTok + ';');
			lines.push('\tMinFilter = ' + fTok + ';');
			if (mip) { lines.push('\tMipFilter = LINEAR;'); }
			lines.push('\tAddressU  = WRAP;');
			lines.push('\tAddressV  = WRAP;');
			lines.push('\tAddressW  = WRAP;');
			lines.push('};');
			messages.push({ level: 'warn', text: 'iChannel' + i + ': 3D volume texture — supply a matching .dds file.' });
		}
		else if (bufTexNames[cfg]) {
			lines.push('// iChannel' + i + ' — ' + cfg + ' output');
			lines.push('sampler2D iChannel' + i);
			lines.push('{');
			lines.push('\tTexture   = ' + bufTexNames[cfg] + ';');
			lines.push('\tMagFilter = ' + fTok + ';');
			lines.push('\tMinFilter = ' + fTok + ';');
			if (mip) { lines.push('\tMipFilter = LINEAR;'); }
			lines.push('\tAddressU  = ' + wTok + ';');
			lines.push('\tAddressV  = ' + wTok + ';');
			if (vflip) { lines.push('\t// Vflip: not applied to buffers; they keep Shadertoy\'s row order, so no flip is needed'); }
			lines.push('};');
		}
		else {
			lines.push('// iChannel' + i + ' is not mapped to anything: its lookups read as zero (black).');
			messages.push({ level: 'warn', text: 'iChannel' + i + ' is referenced but mapped to None: its lookups read as zero (black).' });
		}
	}

	return lines.join('\n');
}

// ═════════════════════════════════════════════════════════════════════════════
// BUILD iChannelResolution PER PASS
// ═════════════════════════════════════════════════════════════════════════════

// Known texture dimensions keyed by source filename prefix (name → {w,h,d})
// These match the Shadertoy built-in resource dimensions.
var CHANNEL_RES_DB =
{
	// Textures
	'Abstract 1': { w: 1024, h: 1024 },
	'Abstract 2': { w: 512, h: 512 },
	'Abstract 3': { w: 1024, h: 1024 },
	'Bayer': { w: 8, h: 8 },
	'Blue Noise': { w: 1024, h: 1024 },
	'Font 1': { w: 1024, h: 1024 },
	'Gray Noise Medium': { w: 256, h: 256 },
	'Gray Noise Small': { w: 64, h: 64 },
	'Lichen': { w: 1024, h: 1024 },
	'London': { w: 512, h: 512 },
	'Nyancat': { w: 256, h: 32 },
	'Organic 1': { w: 1024, h: 1024 },
	'Organic 2': { w: 1024, h: 1024 },
	'Organic 3': { w: 1024, h: 1024 },
	'Organic 4': { w: 1024, h: 1024 },
	'Pebbles': { w: 512, h: 512 },
	'RGBA Noise Medium': { w: 256, h: 256 },
	'RGBA Noise Small': { w: 64, h: 64 },
	'Rock Tiles': { w: 512, h: 512 },
	'Rusty Metal': { w: 512, h: 512 },
	'Stars': { w: 512, h: 512 },
	'Wood': { w: 1024, h: 1024 },
	// Cubemaps
	'Forest': { w: 256, h: 256 },
	'Forest Blurred': { w: 64, h: 64 },
	"St. Peter's Basilica": { w: 256, h: 256 },
	"St. Peter's Basilica Blurred": { w: 64, h: 64 },
	'Uffizi Gallery': { w: 512, h: 512 },
	'Uffizi Gallery Blurred': { w: 64, h: 64 },
	// Volumes
	'Grey Noise 3D': { w: 32, h: 32, d: 32 },
	'RGBA Noise 3D': { w: 32, h: 32, d: 32 }
};

// Emit iChannelResolution static const for a pass, using #defines for each channel's
// known dimensions so the compiler can use them as compile-time constants.
// channelConfig: 4-element array of channel type strings
// channelNames:  4-element array of resource name strings (for texture/cubemap/volume)
// bufTexNames:   map of bufId → texture name
// passPrefix:    e.g. 'BufA_' for multipass, '' for single pass
function buildChannelResolution(channelConfig, channelNames, bufTexNames, usedChannels, passPrefix) {
	var lines = [];
	var entries = [];

	for (var i = 0; i < 4; i++) {
		var cfg = channelConfig[i];
		var name = channelNames ? channelNames[i] : '';
		var wDef, hDef, dDef;

		if (cfg === 'cubemapA' || cfg === 'cubemapA_prev') {
			wDef = 'ST_CUBEMAP_SIZE'; hDef = 'ST_CUBEMAP_SIZE'; dDef = null;
		}
		else if (cfg === 'backbuffer' || bufTexNames[cfg]) {
			// Screen-sized: use BUFFER_WIDTH/HEIGHT macros directly (no #define needed)
			wDef = 'BUFFER_WIDTH';
			hDef = 'BUFFER_HEIGHT';
			dDef = null;
		}
		else if ((cfg === 'texture' || cfg === 'cubemap' || cfg === 'volume') && name && CHANNEL_RES_DB[name]) {
			var info = CHANNEL_RES_DB[name];
			var pre = passPrefix + 'iChannel' + i + '_';
			lines.push('#define ' + pre + 'WIDTH  ' + info.w);
			lines.push('#define ' + pre + 'HEIGHT ' + info.h);
			if (info.d) { lines.push('#define ' + pre + 'DEPTH  ' + info.d); }
			wDef = pre + 'WIDTH';
			hDef = pre + 'HEIGHT';
			dDef = info.d ? pre + 'DEPTH' : null;
		}
		else {
			// Unknown / none — fall back to screen resolution
			wDef = 'BUFFER_WIDTH';
			hDef = 'BUFFER_HEIGHT';
			dDef = null;
		}

		entries.push(dDef
			? '\tfloat3(' + wDef + ', ' + hDef + ', ' + dDef + ')'
			: '\tfloat3(' + wDef + ', ' + hDef + ', 1.0)');
	}

	if (lines.length) { lines.push(''); }
	lines.push('static const float3 ' + (passPrefix || '') + 'iChannelResolution[4] =');
	lines.push('{');
	entries.forEach(function (e, i) { lines.push(e + (i < 3 ? ',' : '')); });
	lines.push('};');

	return lines.join('\n');
}

// ═════════════════════════════════════════════════════════════════════════════
// ASSEMBLE FINAL .fx FILE
// ═════════════════════════════════════════════════════════════════════════════

// transformedPasses: array of { id, src, coordVar, usedUniforms, channels[4], format }
// shaderInfo (optional): { id, name, username, description, url }
function assembleFxFile(transformedPasses, flipY, messages, shaderInfo) {
	var lines = [];

	// Merge usedUniforms across all passes
	var usedUniforms = new Set();
	transformedPasses.forEach(function (p) {
		p.usedUniforms.forEach(function (u) { usedUniforms.add(u); });
	});

	// Buffer pass ids in this file
	var bufIds = ['bufA', 'bufB', 'bufC', 'bufD', 'cubemapA'];
	var bufLabels = { bufA: 'BufA', bufB: 'BufB', bufC: 'BufC', bufD: 'BufD', cubemapA: 'CubeA' };
	var activeBufs = transformedPasses.filter(function (p) { return bufIds.indexOf(p.id) !== -1; });

	// Build texture name map for buffer passes
	var bufTexNames = {};
	activeBufs.forEach(function (p) { bufTexNames[p.id] = 'tex_' + bufLabels[p.id]; });

	// ── Derive technique name ──
	var techniqueName = 'ShadertoyPort';
	if (shaderInfo && shaderInfo.name) {
		// Sanitize: keep only alphanumeric + underscore, collapse runs, strip leading digits
		var safeName = shaderInfo.name
			.replace(/[^A-Za-z0-9_]+/g, '_')
			.replace(/^_+|_+$/g, '')
			.replace(/^(\d)/, '_$1');
		if (safeName.length > 0) { techniqueName = safeName; }
	}

	// ── Header ──
	function commentText(value) { return String(value).replace(/\*\//g, '* /'); }
	lines.push('/*');
	if (shaderInfo) {
		if (shaderInfo.name)     { lines.push('\tShader  : ' + commentText(shaderInfo.name)); }
		if (shaderInfo.username) { lines.push('\tAuthor  : ' + commentText(shaderInfo.username)); }
		if (shaderInfo.url)      { lines.push('\tSource  : ' + commentText(shaderInfo.url)); }
		if (shaderInfo.description && shaderInfo.description.trim()) {
			// Emit description — indent each line, cap at ~120 chars per line for readability
			var descLines = shaderInfo.description.trim().split('\n');
			lines.push('\tDescription:');
			descLines.forEach(function (dl) { lines.push('\t  ' + commentText(dl)); });
		}
	}
	else {
		lines.push('\tOriginal shader copyright belongs to its respective author.');
	}
	lines.push('');
	lines.push('\tPorted using ShaderBridge v' + PORTER_VERSION + ' — Shadertoy → ReShade FX Porter');
	lines.push('\tCreated by CeeJay.dk & Claude Sonnet');
	lines.push('*/');
	lines.push('');

	lines.push(HELPER_SOURCE);
	lines.push('');
	if (bufTexNames.cubemapA)
	{
		lines.push('// Generated cubemap: six faces in +X, -X, +Y, -Y, +Z, -Z order.');
		lines.push('#ifndef ST_CUBEMAP_SIZE', '#define ST_CUBEMAP_SIZE 1024', '#endif');
		lines.push('static const float3 ST_CubeResolution = float3(ST_CUBEMAP_SIZE, ST_CUBEMAP_SIZE, 1.0);');
		lines.push('');
	}

	// The effect includes nothing, so it works wherever it is put. It declares what it needs of what
	// ReShade.fxh would have given it: the fullscreen vertex shader (the same one) and, if a channel
	// reads the screen, the back buffer texture.
	lines.push('// ── Fullscreen vertex shader ──');
	lines.push('void PostProcessVS(in uint id : SV_VertexID, out float4 position : SV_Position, out float2 texcoord : TEXCOORD)');
	lines.push('{');
	lines.push('\ttexcoord.x = (id == 2) ? 2.0 : 0.0;');
	lines.push('\ttexcoord.y = (id == 1) ? 2.0 : 0.0;');
	lines.push('\tposition = float4(texcoord * float2(2.0, -2.0) + float2(-1.0, 1.0), 0.0, 1.0);');
	lines.push('}');
	lines.push('//@ST_BACKBUFFER@');
	lines.push('');

	// ── Uniforms ──
	var uniformBlock = buildUniformBlock(usedUniforms);
	if (uniformBlock.trim()) {
		lines.push('// ── Uniforms ──');
		lines.push(uniformBlock);
		lines.push('');
	}

	var flipOptionsAt = lines.length; // the flip options are inserted here once the passes are known
	if (usedUniforms.has('iFrame'))
	{
		lines.push('// Effect-local frame counter. ReShade clears new render targets to zero.');
		lines.push('texture2D ST_FrameState { Width = 1; Height = 1; Format = RGBA32F; };');
		lines.push('texture2D ST_FramePrevious { Width = 1; Height = 1; Format = RGBA32F; };');
		lines.push('sampler2D ST_FrameSampler { Texture = ST_FrameState; MinFilter = POINT; MagFilter = POINT; };');
		lines.push('sampler2D ST_FramePreviousSampler { Texture = ST_FramePrevious; MinFilter = POINT; MagFilter = POINT; };');
		lines.push('float4 PS_ST_CopyFrame(float4 pos : SV_Position, float2 uv : TEXCOORD) : SV_Target');
		lines.push('{');
		lines.push('\treturn tex2Dfetch(ST_FrameSampler, int2(0, 0));');
		lines.push('}');
		lines.push('float4 PS_ST_UpdateFrame(float4 pos : SV_Position, float2 uv : TEXCOORD) : SV_Target');
		lines.push('{');
		lines.push('\tfloat4 previous = tex2Dfetch(ST_FramePreviousSampler, int2(0, 0));');
		lines.push('\treturn float4(previous.w > 0.5 ? previous.x + 1.0 : 0.0, 0.0, 0.0, 1.0);');
		lines.push('}');
		lines.push('');
	}

	// ── Detect self-referencing buffer passes ──
	// A buffer pass self-references when one of its input channels feeds from its own output.
	// selfRefBufs: { bufId → [chIdx, ...] }
	var selfRefBufs = {};
	transformedPasses.forEach(function (p) {
		if (bufIds.indexOf(p.id) === -1) { return; }
		var selfRefs = p.selfRefChannels || [];
		if (selfRefs.length > 0) { selfRefBufs[p.id] = selfRefs; }
	});

	// Build "prev" texture names for self-referencing buffers
	var bufPrevTexNames = {};
	Object.keys(selfRefBufs).forEach(function (id) {
		bufPrevTexNames[id] = 'tex_' + bufLabels[id] + '_Prev';
	});

	// ── Buffer textures ──
	if (activeBufs.length) {
		lines.push('// ── Buffer textures ──');
		activeBufs.forEach(function (p) {
			var texName = bufTexNames[p.id];
			var dimensions = p.id === 'cubemapA' ? 'Width = 6 * ST_CUBEMAP_SIZE; Height = ST_CUBEMAP_SIZE;' : 'Width = BUFFER_WIDTH; Height = BUFFER_HEIGHT;';
			lines.push('texture2D ' + texName + ' { ' + dimensions + ' Format = ' + p.format + '; };');
			// Emit prev texture for self-referencing passes
			if (selfRefBufs[p.id]) {
				var prevTex = bufPrevTexNames[p.id];
				lines.push('// Previous-frame copy of ' + texName + ' — used for self-referencing channel(s) ' + selfRefBufs[p.id].join(', '));
				lines.push('texture2D ' + prevTex + ' { ' + dimensions + ' Format = ' + p.format + '; };');
			}
		});
		lines.push('');

		// Emit trivial copy PS functions for self-referencing buffers
		var hasCopyPass = Object.keys(selfRefBufs).length > 0;
		if (hasCopyPass) {
			lines.push('// ── Copy shaders (self-referencing buffer ping-pong) ──');
			Object.keys(selfRefBufs).forEach(function (id) {
				var srcTex  = bufTexNames[id];
				var prevTex = bufPrevTexNames[id];
				var copyPS  = 'PS_Copy_' + bufLabels[id];
				var copySmp = 'smp_Copy_' + bufLabels[id];
				lines.push('sampler2D ' + copySmp + ' { Texture = ' + srcTex + '; MinFilter = LINEAR; MagFilter = LINEAR; };');
				lines.push('void ' + copyPS + '(float4 vpos : SV_Position, float2 texcoord : TEXCOORD, out float4 output : SV_Target)');
				lines.push('{');
				lines.push('\toutput = tex2D(' + copySmp + ', texcoord);');
				lines.push('}');
				lines.push('');
			});
		}
	}

	// ── Per-pass shader bodies + PS entries ──
	var declaredResources = {}; // texture and sampler declarations already emitted, by name
	var declaredFunctions = {};
	var declaredGlobals = {};
	var declaredStructs = {};
	var emittedFlipHelpers = { v2: false, v4: false, dir: false, fetch: false };
	var flipOptionLines = [];
	var flipOptionsHaveVflip = false;
	flipOptionLines.push('// ── Flip options (shown in ReShade\'s preprocessor definitions) ──');
	flipOptionLines.push('// ST_FLIP_Y: 1 = Shadertoy orientation on screen (y up), 0 = ReShade orientation (y down)');
	flipOptionLines.push('#ifndef ST_FLIP_Y', '\t#define ST_FLIP_Y ' + (flipY ? 1 : 0), '#endif'); // track top-level function signatures already emitted

	// Extract top-level function signatures from HLSL source.
	// Returns array of { sig, start, end } where start/end delimit the full definition.
	function extractTopLevelFunctions(src) {
		var fns = [];
		var fileScope = fileScopeTokenOffsets(src);
		// Strip comments from a copy used only for scanning — so commented-out
		// function definitions are invisible to the dedup scanner.
		var stripped = src
			.replace(/\/\*[\s\S]*?\*\//g, function (m) { return m.replace(/[^\r\n]/g, ' '); })
			.replace(/\/\/[^\n]*/g, function (m) { return ' '.repeat(m.length); });

		// Match: return-type identifier ( params ) {
		var re = /^[ \t]*((?:[\w:*]+\s+)+)([\w]+)\s*\(([^)]*)\)\s*\n?\s*\{/gm;
		var m;
		while ((m = re.exec(stripped)) !== null) {
			if (!fileScope[m.index + m[0].search(/\S/)]) { continue; }
			var retType = m[1].trim();
			var name = m[2];
			var params = m[3].replace(/\s+/g, ' ').trim();

			// Skip PS entries and mainImage variants — never deduplicate those
			if (/^(void\s+PS_|void\s+mainImage)/.test(retType + ' ' + name)) { continue; }
			// Skip struct definitions
			if (retType === 'struct') { continue; }

			// The comment-masked copy has the same offsets and ignores braces in comments.
			var braceOpen = stripped.indexOf('{', m.index + m[0].length - 1);
			var depth = 1;
			var k = braceOpen + 1;
			while (k < src.length && depth > 0) {
				if (stripped[k] === '{') { depth++; }
				else if (stripped[k] === '}') { depth--; }
				k++;
			}

			// Signature: name + normalised param types (ignore param names)
			var paramTypes = params.split(',').map(function (p) {
				return p.trim().replace(/\b\w+\s*$/, '').trim(); // strip last word (param name)
			}).join(',');
			var sig = name + '(' + paramTypes + ')';

			fns.push({ sig: sig, start: m.index, end: k });
		}
		return fns;
	}

	// A function is compared with the one of the same signature in an earlier pass:
	//   the same text  → an exact repeat (a function from the Common tab, say): drop it
	//   another text   → a different function that happens to have the same name: give it a name of its own in this pass
	// Each Shadertoy pass is its own program, so  df()  in one pass and  df()  in another are two functions even though
	// their signatures are the same; keeping only the first would give the second pass the wrong function without a word.
	// Renaming a function changes every function that calls it, so that has to be repeated until nothing new clashes.
	// Within one pass, repeated signatures are alternatives selected by #if / #else and must all be kept.
	function normaliseFunctionText(text) {
		return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
	}

	function deduplicatePassFunctions(src, seen, passTag, messages, passLabel) {
		function keysFor(source)
		{
			var names = Object.create(null), directives = [];
			tokenizeSource(source).forEach(function (t)
			{
				if (t.type !== 'preproc') { return; }
				var macro = /^#\s*(?:define|undef)\s+(\w+)/.exec(t.text);
				if (macro) { names[macro[1]] = true; }
				directives.push(normaliseFunctionText(t.text));
			});
			return function (fn)
			{
				var text = normaliseFunctionText(source.slice(fn.start, fn.end));
				// Equal text can have different meanings in separate Shadertoy programs.
				// Conservatively include the pass's directives when a helper uses its macros.
				var usesMacro = (text.match(/\b[A-Za-z_]\w*\b/g) || []).some(function (word) { return names[word]; });
				return text + (usesMacro ? '\n' + directives.join('\n') : '');
			};
		}
		var renames = {};
		for (var round = 0; round < 100 && passTag; round++) {
			var renameNow = {};
			var functionKey = keysFor(src);
			extractTopLevelFunctions(src).forEach(function (fn) {
				var name = fn.sig.slice(0, fn.sig.indexOf('('));
				if (renames[name] !== undefined || renameNow[name] !== undefined) { return; }
				if (seen[fn.sig] !== undefined && seen[fn.sig] !== functionKey(fn)) { renameNow[name] = name + passTag; }
			});
			var names = Object.keys(renameNow);
			if (names.length === 0) { break; }
			names.forEach(function (n) {
				renames[n] = renameNow[n];
				messages.push({ level: 'info', text: '[' + passLabel + '] function \'' + n + '\' is not the same as the one in an earlier pass; this pass uses ' + renameNow[n] + '.' });
			});
			src = renameNamesEverywhere(src, renameNow);
		}

		var fns = extractTopLevelFunctions(src);
		var functionKey = keysFor(src);
		var removals = []; // { start, end } sorted descending
		var newSigs = [];
		fns.forEach(function (fn) {
			var text = functionKey(fn);
			if (seen[fn.sig] !== undefined) {
				removals.push({ start: fn.start, end: fn.end });
			}
			else {
				newSigs.push({ sig: fn.sig, text: text });
			}
		});
		newSigs.forEach(function (n) { seen[n.sig] = n.text; });

		if (removals.length === 0) { return { src: src, renames: renames }; }

		// Sort descending so we can splice without index shifting
		removals.sort(function (a, b) { return b.start - a.start; });
		var result = src;
		removals.forEach(function (r) {
			var before = result.slice(0, r.start);
			var after = result.slice(r.end);
			// Trim trailing newlines from before and leading newlines from after
			before = before.replace(/\n+$/, '');
			after = after.replace(/^\n+/, '\n');
			result = before + after;
		});

		messages.push({
			level: 'info', text:
				'[' + passLabel + '] ' + removals.length + ' duplicate function definition(s) removed (already declared in an earlier pass).'
		});
		return { src: result, renames: renames };
	}

	// Sampler and texture names come from the channel index (iChannel0), so different passes
	// often use the same name for different things. For each declaration block of a pass:
	//   - new name                         → emit it
	//   - same name, identical content     → an exact repeat of an earlier pass, drop it
	//   - same name, different content     → a clash: give it a pass-specific name
	// renames collects old → new names so the pass's source can be updated to match.
	function declarePassResources(blockText, registry, passTag, renames, messages, passLabel) {
		var headerRe = /^(texture2D|texture3D|sampler2D|sampler3D)\s+(\w+)/;
		var out = [];
		var lead = [];
		var current = null;
		blockText.split('\n').forEach(function (line) {
			if (current) {
				current.push(line);
				if (line.trim() === '};') {
					finish(current);
					current = null;
				}
				return;
			}
			if (headerRe.test(line)) { current = [line]; return; }
			if (/^\/\//.test(line)) { lead.push(line); return; }
			out.push(line);
		});

		function finish(block) {
			var text = renameIdentifiers(block.join('\n'), renames);
			var name = headerRe.exec(text)[2];
			if (registry[name] === undefined) {
				registry[name] = text;
			}
			else if (registry[name] === text) {
				lead = [];
				return; // exact repeat of an earlier pass
			}
			else {
				var unique = name + '_' + passTag;
				// the block was already renamed by earlier clashes in this pass; track the original name
				var original = Object.keys(renames).filter(function (k) { return renames[k] === name; })[0] || name;
				renames[original] = unique;
				text = renameIdentifiers(text, (function () { var m = {}; m[name] = unique; return m; }()));
				registry[unique] = text;
				messages.push({ level: 'info', text: '[' + passLabel + '] ' + original + ' is declared differently in an earlier pass; this pass uses ' + unique + '.' });
			}
			lead.forEach(function (l) { out.push(l); });
			lead = [];
			text.split('\n').forEach(function (l) { out.push(l); });
		}
		return out.join('\n');
	}

	// Remove struct definitions that an earlier pass already defined identically (typically the
	// Common tab, which every pass includes). A same-named struct that differs cannot be merged: warn.
	function deduplicatePassStructs(src, seenStructs, messages, passLabel) {
		var removed = 0;
		var newStructs = {};
		var result = src.replace(structDefinitionPattern(), function (match, name) {
			var key = match.replace(/\s+/g, ' ').trim();
			// Only compare against EARLIER passes. Within one pass, repeated definitions are
			// alternatives selected by #if / #else and must all be kept.
			if (seenStructs[name] === undefined) { if (newStructs[name] === undefined) { newStructs[name] = key; } return match; }
			if (seenStructs[name] === key) { removed++; return ''; }
			messages.push({ level: 'warn', text: '[' + passLabel + '] struct \'' + name + '\' is defined differently in an earlier pass; both share one name here and will conflict.' });
			return match;
		});
		Object.keys(newStructs).forEach(function (name) { seenStructs[name] = newStructs[name]; });
		if (removed > 0) {
			messages.push({ level: 'info', text: '[' + passLabel + '] ' + removed + ' duplicate struct definition(s) removed (already defined in an earlier pass).' });
		}
		return result;
	}

	// Remove single-line file-scope variable declarations that an earlier pass already declared
	// identically. Each Shadertoy pass is its own program, so the same global (res, mouse, ...)
	// is often declared in several. A same-named global that differs cannot be merged: warn.
	function deduplicatePassGlobals(src, seenGlobals, messages, passLabel) {
		var removed = 0;
		var newGlobals = {};
		var result = src.replace(/^[ \t]*(static[ ]+(?:const[ ]+)?(?:float[234x]*|int[234]?|uint[234]?|bool)[ ]+(\w+)[ ]*(?:=[^;\n]*)?;)[ \t]*(?:\/\/[^\n]*)?(?:\n|$)/gm,
			function (match, decl, name) {
				var key = decl.replace(/\s+/g, ' ').trim();
				// Only compare against EARLIER passes. Within one pass, repeated declarations are
				// alternatives selected by #if / #else and must all be kept.
				if (seenGlobals[name] === undefined) { if (newGlobals[name] === undefined) { newGlobals[name] = key; } return match; }
				if (seenGlobals[name] === key) { removed++; return ''; }
				messages.push({ level: 'warn', text: '[' + passLabel + '] global \'' + name + '\' is declared differently in an earlier pass; both share one name here and will conflict.' });
				return match;
			});
		Object.keys(newGlobals).forEach(function (name) { seenGlobals[name] = newGlobals[name]; });
		if (removed > 0)
		{
			messages.push({ level: 'info', text: '[' + passLabel + '] ' + removed + ' duplicate global declaration(s) removed (already declared in an earlier pass).' });
		}
		return result;
	}

	// A struct or a global that an earlier pass declared differently gets a name of its own in this pass, the
	// way a function does (deduplicatePassFunctions). Each Shadertoy pass is its own program, so  float camRot = 1.4;
	// in one pass and  float camRot = 1.5;  in another are two variables, and two different  struct RayHit  are two
	// types, but here they would be one name. Every use in the pass is renamed, including the ones inside #define
	// lines and the assignments hoisted to the pass entry point. A struct or global that is declared the same in
	// the passes is not touched here: deduplicatePassStructs and deduplicatePassGlobals drop the repeat.
	function renameConflictingNames(src, seenStructs, seenGlobals, passTag, passLabel, messages) {
		var renames = {};
		if (!passTag) { return { src: src, renames: renames }; }
		function note(kind, name) {
			renames[name] = name + passTag;
			messages.push({ level: 'info', text: '[' + passLabel + '] ' + kind + ' \'' + name + '\' is declared differently in an earlier pass; this pass uses ' + renames[name] + '.' });
		}
		src.replace(structDefinitionPattern(), function (match, name) {
			var key = match.replace(/\s+/g, ' ').trim();
			if (seenStructs[name] !== undefined && seenStructs[name] !== key && renames[name] === undefined) { note('struct', name); }
			return match;
		});
		src.replace(/^[ \t]*(static[ ]+(?:const[ ]+)?(?:float[234x]*|int[234]?|uint[234]?|bool)[ ]+(\w+)[ ]*(?:=[^;\n]*)?;)[ \t]*(?:\/\/[^\n]*)?(?:\n|$)/gm,
			function (match, decl, name) {
				var key = decl.replace(/\s+/g, ' ').trim();
				if (seenGlobals[name] !== undefined && seenGlobals[name] !== key && renames[name] === undefined) { note('global', name); }
				return match;
			});
		if (Object.keys(renames).length === 0) { return { src: src, renames: renames }; }
		return { src: renameNamesEverywhere(src, renames), renames: renames };
	}

	// renameIdentifiers leaves a #define line alone; here the body of a macro has to follow, but not its name
	function renameNamesEverywhere(src, renames) {
		return tokenizeSource(src).map(function (token) {
			if (token.type === 'ident') { return Object.prototype.hasOwnProperty.call(renames, token.text) ? renames[token.text] : token.text; }
			if (token.type === 'preproc') {
				return token.text.replace(/^(#\s*define\s+\w+)([\s\S]*)$/, function (all, head, rest) { return head + renameIdentifiers(rest, renames); });
			}
			return token.text;
		}).join('');
	}

	// A struct definition wherever it stands and however its braces are laid out:  struct S { ... };  or the brace on
	// the next line, indented or not. Only the part between the braces cannot contain braces.
	function structDefinitionPattern() {
		return /^[ \t]*struct\s+(\w+)\s*\{[^{}]*\}\s*;[ \t]*(?:\n|$)/gm;
	}

	transformedPasses.forEach(function (p, pi) {
		var isBuf = bufIds.indexOf(p.id) !== -1;
		var label = isBuf ? bufLabels[p.id] : 'Main';
		var psName = 'PS_Shadertoy' + label;
		var coordVar = p.coordVar || 'fragCoord';
		var mainImgName = p.mainImageName || 'mainImage';

		// Samplers for this pass — deduplicate across passes
		// For self-referencing channels, redirect to the prev texture
		var effectiveChannels = p.channels.slice();
		var selfRefs = selfRefBufs[p.id] || [];
		selfRefs.forEach(function (ci) {
			effectiveChannels[ci] = p.id + '_prev'; // sentinel → bufPrevTexNames lookup
		});
		// Temporarily extend bufTexNames with prev entries for this call
		var extBufTexNames = {};
		Object.keys(bufTexNames).forEach(function (k) { extBufTexNames[k] = bufTexNames[k]; });
		Object.keys(bufPrevTexNames).forEach(function (k) { extBufTexNames[k + '_prev'] = bufPrevTexNames[k]; });

		// Keep hoisted initializers with their pass during resource discovery, Vflip rewriting,
		// and namespace isolation. Otherwise a texture read used only here loses its sampler.
		var initName = '', passSrc = p.src;
		if (p.globalInits && p.globalInits.length)
		{
			initName = 'ST_InitGlobals_' + label;
			while (transformedPasses.some(function (candidate) { return candidate.src.indexOf(initName) >= 0; })) { initName += '_'; }
			passSrc += '\nvoid ' + initName + '()\n{\n\t' + p.globalInits.join('\n\t') + '\n}\n';
		}
		var usedChannels = detectChannelUse(passSrc);
		var channelAttribs = { filters: p.filters || [], wraps: p.wraps || [], vflips: p.vflips || [] };

		// Texture and backbuffer channels can have V flipped at their sample sites. Each gets a
		// preprocessor definition (shown in ReShade's UI) whose default is the Vflip setting.
		var flipHelperLines = [];
		var samplerFlags = {};
		var passTag = transformedPasses.length > 1 ? '_' + (isBuf ? bufLabels[p.id] : 'Image').toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
		usedChannels.forEach(function (ci) {
			var kind = effectiveChannels[ci];
			if (kind !== 'texture' && kind !== 'backbuffer') { return; }
			var macro = 'ST_VFLIP' + passTag + '_CH' + ci;
			samplerFlags['iChannel' + ci] = macro;
			if (!flipOptionsHaveVflip) {
				flipOptionsHaveVflip = true;
				flipOptionLines.push('// ST_VFLIP_*: 1 = flip V of that texture channel at its sample sites (Shadertoy\'s Vflip)');
			}
			flipOptionLines.push('#ifndef ' + macro, '\t#define ' + macro + ' ' + (channelAttribs.vflips[ci] ? 1 : 0), '#endif');
		});
		if (Object.keys(samplerFlags).length) {
			var flipResult = rewriteTextureVFlip(passSrc, samplerFlags);
			passSrc = flipResult.src;
			flipResult.warnings.forEach(function (w) { messages.push({ level: 'warn', text: '[' + (isBuf ? bufLabels[p.id] : 'Image') + '] ' + w }); });
			if (flipResult.helpers.v2 && !emittedFlipHelpers.v2) { emittedFlipHelpers.v2 = true; flipHelperLines.push('float2 ST_flipV(float2 uv, bool flip)', '{', '\treturn float2(uv.x, flip ? 1.0 - uv.y : uv.y);', '}', ''); }
			if (flipResult.helpers.v4 && !emittedFlipHelpers.v4) { emittedFlipHelpers.v4 = true; flipHelperLines.push('float4 ST_flipV4(float4 coord, bool flip)', '{', '\treturn float4(coord.x, flip ? 1.0 - coord.y : coord.y, coord.z, coord.w);', '}', ''); }
			if (flipResult.helpers.dir && !emittedFlipHelpers.dir) { emittedFlipHelpers.dir = true; flipHelperLines.push('float2 ST_flipDir(float2 d, bool flip)', '{', '\treturn float2(d.x, flip ? -d.y : d.y);', '}', ''); }
			if (flipResult.helpers.fetch && !emittedFlipHelpers.fetch) { emittedFlipHelpers.fetch = true; flipHelperLines.push('int2 ST_flipFetch(int2 coord, int2 size, bool flip)', '{', '\treturn int2(coord.x, flip ? size.y - 1 - coord.y : coord.y);', '}', ''); }
			if (flipHelperLines.length) { flipHelperLines.unshift('// V flip for textures with a Vflip option: Shadertoy has v = 0 at the bottom row of the image, ReShade at the top'); }
		}
		var resourceRenames = {};
		var samplerBlock = declarePassResources(
			buildSamplerBlock(effectiveChannels, usedChannels, extBufTexNames, messages, channelAttribs, p.channelNames || []),
			declaredResources, (isBuf ? bufLabels[p.id] : 'Image'), resourceRenames, messages, (isBuf ? bufLabels[p.id] : 'Image')).trim();

		if (samplerBlock) {
			lines.push('// ── Samplers — ' + (isBuf ? bufLabels[p.id] : 'Image') + ' ──');
			lines.push(samplerBlock);
			lines.push('');
		}

		// iChannelResolution — emit per-pass with correct dimensions when used
		if (p.usedUniforms && p.usedUniforms.has('iChannelResolution')) {
			var passPrefix = transformedPasses.length > 1 ? (isBuf ? bufLabels[p.id] : 'Image') + '_' : '';
			if (passPrefix) { resourceRenames.iChannelResolution = passPrefix + 'iChannelResolution'; }
			var chanResBlock = buildChannelResolution(p.channels, p.channelNames || [], bufTexNames, usedChannels, passPrefix);
			lines.push('// iChannelResolution — per-channel dimensions');
			lines.push(chanResBlock);
			lines.push('');
		}
		if (Object.keys(resourceRenames).length) { passSrc = renameNamesEverywhere(passSrc, resourceRenames); }

		flipHelperLines.forEach(function (l) { lines.push(l); });
		lines.push('// ── Shader body' + (transformedPasses.length > 1 ? ' — ' + (isBuf ? bufLabels[p.id] : 'Image') : '') + ' ──');
		var passLabel = isBuf ? bufLabels[p.id] : 'Image';
		var globalRename = renameConflictingNames(passSrc.trim(), declaredStructs, declaredGlobals, passTag, passLabel, messages);
		var dedupedSrc = deduplicatePassStructs(globalRename.src, declaredStructs, messages, passLabel);
		var functionResult = deduplicatePassFunctions(dedupedSrc, declaredFunctions, passTag, messages, passLabel);
		dedupedSrc = functionResult.src;
		dedupedSrc = deduplicatePassGlobals(dedupedSrc, declaredGlobals, messages, passLabel);
		lines.push(dedupedSrc);
		lines.push('');

		// PS entry
		// ST_FLIP_Y turns ReShade's top-down SV_Position into Shadertoy's bottom-up fragCoord. Only the
		// pass that renders to the screen needs that. Buffer passes keep the row order that
		// Shadertoy has in memory (fragCoord.y == row), so a buffer that stores data by row, or feeds
		// back into itself, reads back at the same coordinates it was written to.
		if (!isBuf) {
			lines.push('void ' + psName + '(float4 vpos : SV_Position, float2 texcoord : TEXCOORD, out float4 output : SV_Target)');
			lines.push('{');
			lines.push('\tfloat2 ' + coordVar + ' = float2(vpos.x, ST_FLIP_Y ? BUFFER_HEIGHT - vpos.y : vpos.y);');
			if (/\bST_FragCoord\b/.test(p.src)) { lines.push('\tST_FragCoord = float4(' + coordVar + ', 0.0, 1.0);'); }
			if (initName) { lines.push('\t' + initName + '();'); }
			lines.push('\t' + mainImgName + '(' + coordVar + ', output);');
			lines.push('}');
		}
		else {
			lines.push('void ' + psName + '(float4 vpos : SV_Position, float2 texcoord : TEXCOORD, out float4 output : SV_Target)');
			lines.push('{');
			if (/\bST_FragCoord\b/.test(p.src)) { lines.push('\tST_FragCoord = float4(vpos.xy, 0.0, 1.0);'); }
			if (initName) { lines.push('\t' + initName + '();'); }
			lines.push('\t' + mainImgName + '(vpos.xy, output);');
			lines.push('}');
		}
		lines.push('');

		// Each Shadertoy pass is its own program, but here they share one preprocessor.
		// Undefine this pass's macros so they do not collide with the next pass's.
		if (transformedPasses.length > 1)
		{
			var passMacros = [];
			var macroRe = /^[ \t]*#[ \t]*define[ \t]+(\w+)/gm;
			var macroMatch;
			while ((macroMatch = macroRe.exec(p.src)) !== null)
			{
				if (passMacros.indexOf(macroMatch[1]) === -1) { passMacros.push(macroMatch[1]); }
			}
			if (passMacros.length)
			{
				lines.push('// ── Macros local to ' + passLabel + ' ──');
				passMacros.forEach(function (name) { lines.push('#undef ' + name); });
				lines.push('');
			}
		}
	});

	// ── Technique ──
	lines.push('// ── Technique ──');
	flipOptionLines.push('');
	lines.splice.apply(lines, [flipOptionsAt, 0].concat(flipOptionLines));

	lines.push('technique ' + techniqueName);
	lines.push('{');
	if (usedUniforms.has('iFrame'))
	{
		lines.push('\tpass ST_CopyFrame');
		lines.push('\t{');
		lines.push('\t\tVertexShader = PostProcessVS;');
		lines.push('\t\tPixelShader = PS_ST_CopyFrame;');
		lines.push('\t\tRenderTarget = ST_FramePrevious;');
		lines.push('\t}');
		lines.push('\tpass ST_UpdateFrame');
		lines.push('\t{');
		lines.push('\t\tVertexShader = PostProcessVS;');
		lines.push('\t\tPixelShader = PS_ST_UpdateFrame;');
		lines.push('\t\tRenderTarget = ST_FrameState;');
		lines.push('\t}');
	}

	transformedPasses.forEach(function (p) {
		var isBuf = bufIds.indexOf(p.id) !== -1;
		var label = isBuf ? bufLabels[p.id] : 'Main';
		var psName = 'PS_Shadertoy' + label;

		// Insert copy pass before a self-referencing buffer pass
		if (selfRefBufs[p.id]) {
			var copyLabel = 'Copy_' + bufLabels[p.id];
			var copyPS    = 'PS_' + copyLabel;
			var prevTex   = bufPrevTexNames[p.id];
			lines.push('\t// Copy pass: captures previous frame of ' + bufLabels[p.id] + ' for self-referencing channel(s)');
			lines.push('\tpass ' + copyLabel);
			lines.push('\t{');
			lines.push('\t\tVertexShader = PostProcessVS;');
			lines.push('\t\tPixelShader  = ' + copyPS + ';');
			lines.push('\t\tRenderTarget = ' + prevTex + ';');
			lines.push('\t}');
		}

		lines.push('\tpass ' + label);
		lines.push('\t{');
		lines.push('\t\tVertexShader = PostProcessVS;');
		lines.push('\t\tPixelShader  = ' + psName + ';');
		if (isBuf) {
			lines.push('\t\tRenderTarget = ' + bufTexNames[p.id] + ';');
		}
		lines.push('\t}');
	});

	lines.push('}');

	var text = lines.join('\n');
	if (/ReShade::BackBufferTex/.test(text)) {
		text = text.replace(/ReShade::BackBufferTex/g, 'ST_BackBufferTex');
		text = text.replace('//@ST_BACKBUFFER@', '\n// The screen\ntexture ST_BackBufferTex : COLOR;');
	}
	else {
		text = text.replace('//@ST_BACKBUFFER@\n', '');
	}
	return text.replace(/\n{3,}/g, '\n\n') + '\n';
}
