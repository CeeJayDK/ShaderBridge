// ═════════════════════════════════════════════════════════════════════════════
// HELPER FILE CONTENT  (ShadertoyHelper.fxh)
// ═════════════════════════════════════════════════════════════════════════════

var FXH_CONTENT =
	"// ── Intrinsic remaps ──\n"
	+ "\n"
	+ "// GLSL mod(x, y) floors toward -inf; HLSL fmod truncates toward zero.\n"
	+ "#define mod(x, y) ((x) - (y) * floor((x) / (y)))\n"
	+ "\n"
	+ "// ── Component-wise comparison helpers ──\n"
	+ "float2 greaterThan(float2 a, float2 b) { return float2(a.x > b.x ? 1.0 : 0.0, a.y > b.y ? 1.0 : 0.0); }\n"
	+ "float3 greaterThan(float3 a, float3 b) { return float3(a.x > b.x ? 1.0 : 0.0, a.y > b.y ? 1.0 : 0.0, a.z > b.z ? 1.0 : 0.0); }\n"
	+ "float2 lessThan(float2 a, float2 b)    { return float2(a.x < b.x ? 1.0 : 0.0, a.y < b.y ? 1.0 : 0.0); }\n"
	+ "float3 lessThan(float3 a, float3 b)    { return float3(a.x < b.x ? 1.0 : 0.0, a.y < b.y ? 1.0 : 0.0, a.z < b.z ? 1.0 : 0.0); }\n";


// ═════════════════════════════════════════════════════════════════════════════
// BUILD RESHADE UNIFORM DECLARATIONS
// ═════════════════════════════════════════════════════════════════════════════

function buildUniformBlock(usedUniforms) {
	var lines = [];

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
		lines.push('uniform float iTimeDelta < source = "frametime"; >;');
	}
	if (usedUniforms.has('iFrameRate')) {
		sep();
		lines.push('// iFrameRate — frames per second');
		lines.push('uniform float frametime_ms < source = "frametime"; >;');
		lines.push('#define iFrameRate (1000.0 * rcp(frametime_ms))');
	}
	if (usedUniforms.has('iFrame')) {
		sep();
		lines.push('// iFrame — frame counter');
		lines.push('uniform int iFrame < source = "framecount"; >;');
	}
	if (usedUniforms.has('iDate')) {
		sep();
		lines.push('// iDate — float4(year, month 1-12, day 1-31, seconds since midnight)');
		lines.push('uniform float4 iDate < source = "date"; >;');
	}
	if (usedUniforms.has('iMouse')) {
		sep();
		lines.push('// iMouse — cursor and click position in pixels');
		lines.push('uniform float2 iMousePos  < source = "mousepoint"; >;');
		lines.push('uniform bool   iMouseBtn0 < source = "mousebutton"; keycode = 0; mode = ""; >;');
		lines.push('#define iMouse float4(iMousePos.x, iMousePos.y, iMouseBtn0 ? iMousePos.x : 0.0, iMouseBtn0 ? iMousePos.y : 0.0)');
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
			if (vflip) { lines.push('\t// Vflip: negate UV.y at sample site  e.g. tex2D(iChannel' + i + ', float2(uv.x, 1.0 - uv.y))'); }
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
			lines.push('};');
			lines.push('sampler2D iChannel' + i);
			lines.push('{');
			lines.push('\tTexture   = tex_iChannel' + i + ';');
			lines.push('\tMagFilter = ' + fTok + ';');
			lines.push('\tMinFilter = ' + fTok + ';');
			if (mip) { lines.push('\tMipFilter = LINEAR;'); }
			lines.push('\tAddressU  = ' + wTok + ';');
			lines.push('\tAddressV  = ' + wTok + ';');
			if (vflip) { lines.push('\t// Vflip: negate UV.y at sample site  e.g. tex2D(iChannel' + i + ', float2(uv.x, 1.0 - uv.y))'); }
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
			if (vflip) { lines.push('\t// Vflip: negate UV.y at sample site  e.g. tex2D(iChannel' + i + ', float2(uv.x, 1.0 - uv.y))'); }
			lines.push('};');
		}
		else {
			lines.push('// iChannel' + i + ' referenced but mapped to None — add sampler manually.');
			messages.push({ level: 'warn', text: 'iChannel' + i + ' referenced but mapped to None.' });
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

		if (cfg === 'backbuffer' || bufTexNames[cfg]) {
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
	lines.push('static const float3 iChannelResolution[4] =');
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
function assembleFxFile(transformedPasses, flipY, separateFxh, messages, shaderInfo) {
	var lines = [];

	// Merge usedUniforms across all passes
	var usedUniforms = new Set();
	transformedPasses.forEach(function (p) {
		p.usedUniforms.forEach(function (u) { usedUniforms.add(u); });
	});

	// Buffer pass ids in this file
	var bufIds = ['bufA', 'bufB', 'bufC', 'bufD'];
	var bufLabels = { bufA: 'BufA', bufB: 'BufB', bufC: 'BufC', bufD: 'BufD' };
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
	lines.push('/*');
	lines.push('\tShaderBridge v' + PORTER_VERSION + ' — Shadertoy → ReShade FX Porter');
	lines.push('\tCreated by CeeJay.dk & Claude Sonnet (Anthropic)');
	if (shaderInfo) {
		lines.push('');
		if (shaderInfo.name)     { lines.push('\tShader  : ' + shaderInfo.name); }
		if (shaderInfo.username) { lines.push('\tAuthor  : ' + shaderInfo.username); }
		if (shaderInfo.url)      { lines.push('\tSource  : ' + shaderInfo.url); }
		if (shaderInfo.description && shaderInfo.description.trim()) {
			// Emit description — indent each line, cap at ~120 chars per line for readability
			var descLines = shaderInfo.description.trim().split('\n');
			lines.push('\tDescription:');
			descLines.forEach(function (dl) { lines.push('\t  ' + dl); });
		}
	}
	else {
		lines.push('\tOriginal shader copyright belongs to its respective author.');
	}
	lines.push('*/');
	lines.push('');

	if (separateFxh) {
		lines.push('#include "ShadertoyHelper.fxh"');
	}
	else {
		lines.push(FXH_CONTENT);
	}
	lines.push('');

	lines.push('// ── Includes ──');
	lines.push('#include "ReShade.fxh"');
	lines.push('');

	// ── Uniforms ──
	var uniformBlock = buildUniformBlock(usedUniforms);
	if (uniformBlock.trim()) {
		lines.push('// ── Uniforms ──');
		lines.push(uniformBlock);
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
			lines.push('texture2D ' + texName + ' { Width = BUFFER_WIDTH; Height = BUFFER_HEIGHT; Format = ' + p.format + '; };');
			// Emit prev texture for self-referencing passes
			if (selfRefBufs[p.id]) {
				var prevTex = bufPrevTexNames[p.id];
				lines.push('// Previous-frame copy of ' + texName + ' — used for self-referencing channel(s) ' + selfRefBufs[p.id].join(', '));
				lines.push('texture2D ' + prevTex + ' { Width = BUFFER_WIDTH; Height = BUFFER_HEIGHT; Format = ' + p.format + '; };');
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
	var declaredSamplers = {}; // track sampler names already emitted
	var declaredFunctions = {}; // track top-level function signatures already emitted

	// Extract top-level function signatures from HLSL source.
	// Returns array of { sig, start, end } where start/end delimit the full definition.
	function extractTopLevelFunctions(src) {
		var fns = [];
		// Strip comments from a copy used only for scanning — so commented-out
		// function definitions are invisible to the dedup scanner.
		var stripped = src
			.replace(/\/\*[\s\S]*?\*\//g, function (m) { return ' '.repeat(m.length); })
			.replace(/\/\/[^\n]*/g, function (m) { return ' '.repeat(m.length); });

		// Match: return-type identifier ( params ) {
		var re = /^((?:[\w:*]+\s+)+)([\w]+)\s*\(([^)]*)\)\s*\n?\s*\{/gm;
		var m;
		while ((m = re.exec(stripped)) !== null) {
			var retType = m[1].trim();
			var name = m[2];
			var params = m[3].replace(/\s+/g, ' ').trim();

			// Skip PS entries and mainImage variants — never deduplicate those
			if (/^(void\s+PS_|void\s+mainImage)/.test(retType + ' ' + name)) { continue; }
			// Skip struct definitions
			if (retType === 'struct') { continue; }

			// Walk forward in the ORIGINAL src (not stripped) to find the matching closing brace
			var braceOpen = src.indexOf('{', m.index + m[0].length - 1);
			var depth = 1;
			var k = braceOpen + 1;
			while (k < src.length && depth > 0) {
				if (src[k] === '{') { depth++; }
				else if (src[k] === '}') { depth--; }
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

	// Remove function definitions from src whose signatures are in seenSet.
	// Also registers newly seen signatures into seenSet.
	function deduplicatePassFunctions(src, seenSet, messages, passLabel) {
		var fns = extractTopLevelFunctions(src);
		var removals = []; // { start, end } sorted descending
		fns.forEach(function (fn) {
			if (seenSet[fn.sig]) {
				removals.push({ start: fn.start, end: fn.end });
			}
			else {
				seenSet[fn.sig] = true;
			}
		});

		if (removals.length === 0) { return src; }

		// Sort descending so we can splice without index shifting
		removals.sort(function (a, b) { return b.start - a.start; });
		var result = src;
		removals.forEach(function (r) {
			// Also remove any preceding comment line(s)
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
		return result;
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

		var usedChannels = detectChannelUse(p.src);
		var channelAttribs = { filters: p.filters || [], wraps: p.wraps || [], vflips: p.vflips || [] };
		var samplerLines = buildSamplerBlock(effectiveChannels, usedChannels, extBufTexNames, messages, channelAttribs, p.channelNames || []).split('\n');
		var filteredSamplerLines = [];
		var currentSamplerName = null;
		var skipBlock = false;
		samplerLines.forEach(function (line) {
			var m = line.match(/^sampler[23]D\s+(\w+)/);
			if (m) {
				currentSamplerName = m[1];
				skipBlock = !!declaredSamplers[currentSamplerName];
				if (!skipBlock) { declaredSamplers[currentSamplerName] = true; }
			}
			if (!skipBlock) { filteredSamplerLines.push(line); }
			if (line.trim() === '};') { skipBlock = false; currentSamplerName = null; }
		});
		var samplerBlock = filteredSamplerLines.join('\n').trim();

		if (samplerBlock) {
			lines.push('// ── Samplers — ' + (isBuf ? bufLabels[p.id] : 'Image') + ' ──');
			lines.push(samplerBlock);
			lines.push('');
		}

		// iChannelResolution — emit per-pass with correct dimensions when used
		if (p.usedUniforms && p.usedUniforms.has('iChannelResolution')) {
			var passPrefix = transformedPasses.length > 1 ? (isBuf ? bufLabels[p.id] : 'Image') + '_' : '';
			var chanResBlock = buildChannelResolution(p.channels, p.channelNames || [], bufTexNames, usedChannels, passPrefix);
			lines.push('// iChannelResolution — per-channel dimensions');
			lines.push(chanResBlock);
			lines.push('');
		}

		lines.push('// ── Shader body' + (transformedPasses.length > 1 ? ' — ' + (isBuf ? bufLabels[p.id] : 'Image') : '') + ' ──');
		var passLabel = isBuf ? bufLabels[p.id] : 'Image';
		var dedupedSrc = deduplicatePassFunctions(p.src.trim(), declaredFunctions, messages, passLabel);
		lines.push(dedupedSrc);
		lines.push('');

		// PS entry
		if (flipY) {
			lines.push('void ' + psName + '(float4 vpos : SV_Position, float2 texcoord : TEXCOORD, out float4 output : SV_Target)');
			lines.push('{');
			lines.push('\tfloat2 ' + coordVar + ' = float2(vpos.x, iResolution.y - vpos.y);');
			lines.push('\t' + mainImgName + '(' + coordVar + ', output);');
			lines.push('}');
		}
		else {
			lines.push('void ' + psName + '(float4 vpos : SV_Position, float2 texcoord : TEXCOORD, out float4 output : SV_Target)');
			lines.push('{');
			lines.push('\t' + mainImgName + '(vpos.xy, output);');
			lines.push('}');
		}
		lines.push('');
	});

	// ── Technique ──
	lines.push('// ── Technique ──');
	lines.push('technique ' + techniqueName);
	lines.push('{');

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

	return lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}