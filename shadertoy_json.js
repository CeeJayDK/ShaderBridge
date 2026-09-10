// ═════════════════════════════════════════════════════════════════════════════
// SHADERTOY JSON IMPORT
// Depends on: makeChannel, makePass, passes, activePasses, activePassId,
//             activeChIdx, BUF_IDS, log, clearLog, renderTabBar,
//             renderChannelBar, syncTextareaToPass
// ═════════════════════════════════════════════════════════════════════════════

var currentShaderInfo = null;

// ── Shadertoy JSON import maps ────────────────────────────────────────────────

// Maps the numeric suffix of Shadertoy's internal buffer filepath to our pass IDs
// e.g. "/media/previz/buffer00.png" → "bufA"
var SHADERTOY_BUFFER_SLOT =
{
	'00': 'bufA',
	'01': 'bufB',
	'02': 'bufC',
	'03': 'bufD'
};

// Maps Shadertoy's SHA256 resource hashes to CH_TEXTURES names.
// Hash is the filename portion of the filepath, without extension.
// Source: https://shadertoyunofficial.wordpress.com/2019/07/23/shadertoy-media-files/
var SHADERTOY_TEXTURE_HASH_MAP =
{
	'52d2a8f514c4fd2d9866587f4d7b2a5bfa1a11a0e772077d7682deb8b3b517e5': 'Abstract 1',
	'bd6464771e47eed832c5eb2cd85cdc0bfc697786b903bfd30f890f9d4fc36657': 'Abstract 2',
	'8979352a182bde7c3c651ba2b2f4e0615de819585cc37b7175bcefbca15a6683': 'Abstract 3',
	'85a6d68622b36995ccb98a89bbb119edf167c914660e4450d313de049320005c': 'Bayer',
	'cb49c003b454385aa9975733aff4571c62182ccdda480aaba9a8d250014f00ec': 'Blue Noise',
	'08b42b43ae9d3c0605da11d0eac86618ea888e62cdd9518ee8b9097488b31560': 'Font 1',
	'0c7bf5fe9462d5bffbd11126e82908e39be3ce56220d900f633d58fb432e56f5': 'Gray Noise Medium',
	'0a40562379b63dfb89227e6d172f39fdce9022cba76623f1054a2c83d6c0ba5d': 'Gray Noise Small',
	'fb918796edc3d2221218db0811e240e72e340350008338b0c07a52bd353666a6': 'Lichen',
	'8de3a3924cb95bd0e95a443fff0326c869f9d4979cd1d5b6e94e2a01f5be53e9': 'London',
	'cbcbb5a6cfb55c36f8f021fbb0e3f69ac96339a39fa85cd96f2017a2192821b5': 'Nyancat',
	'cd4c518bc6ef165c39d4405b347b51ba40f8d7a065ab0e8d2e4f422cbc1e8a43': 'Organic 1',
	'92d7758c402f0927011ca8d0a7e40251439fba3a1dac26f5b8b62026323501aa': 'Organic 2',
	'79520a3d3a0f4d3caa440802ef4362e99d54e12b1392973e4ea321840970a88a': 'Organic 3',
	'3871e838723dd6b166e490664eead8ec60aedd6b8d95bc8e2fe3f882f0fd90f0': 'Organic 4',
	'ad56fba948dfba9ae698198c109e71f118a54d209c0ea50d77ea546abad89c57': 'Pebbles',
	'f735bee5b64ef98879dc618b016ecf7939a5756040c2cde21ccb15e69a6e1cfb': 'RGBA Noise Medium',
	'3083c722c0c738cad0f468383167a0d246f91af2bfa373e9c5c094fb8c8413e0': 'RGBA Noise Small',
	'10eb4fe0ac8a7dc348a2cc282ca5df1759ab8bf680117e4047728100969e7b43':  'Rock Tiles',
	'95b90082f799f48677b4f206d856ad572f1d178c676269eac6347631d4447258': 'Rusty Metal',
	'e6e5631ce1237ae4c05b3563eda686400a401df4548d0f9fad40ecac1659c46c': 'Stars',
	'1f7dca9c22f324751f2a5a59c9b181dfe3b5564a04b724c657732d0bf09c99db': 'Wood'
};

// Maps Shadertoy's SHA256 cubemap hashes (face 0) to CH_CUBEMAPS names.
// Cubemap faces share the same base hash, suffixed _1 through _5 for other faces.
var SHADERTOY_CUBEMAP_HASH_MAP =
{
	'94284d43be78f00eb6b298e6d78656a1b34e2b91b34940d02f1ca8b22310e8a0': 'Forest',
	'0681c014f6c88c356cf9c0394ffe015acc94ec1474924855f45d22c3e70b5785': 'Forest Blurred',
	'488bd40303a2e2b9a71987e48c66ef41f5e937174bf316d3ed0e86410784b919': "St. Peter's Basilica",
	'550a8cce1bf403869fde66dddf6028dd171f1852f4a704a465e1b80d23955663': "St. Peter's Basilica Blurred",
	'585f9546c092f53ded45332b343144396c0b2d70d9965f585ebc172080d8aa58': 'Uffizi Gallery',
	'793a105653fbdadabdc1325ca08675e1ce48ae5f12e37973829c87bea4be3232': 'Uffizi Gallery Blurred'
};

// Maps Shadertoy's SHA256 volume hashes to CH_VOLUMES names.
var SHADERTOY_VOLUME_HASH_MAP =
{
	'27012b4eadd0c3ce12498b867058e4f717ce79e10a99568cca461682d84a4b04': 'Grey Noise 3D',
	'aea6b99da1d53055107966b59ac5444fc8bc7b3ce2d0bbb6a4a3cbae1d97f3aa': 'RGBA Noise 3D'
};

// Extract the hash (filename without extension) from a Shadertoy media filepath.
// e.g. "/media/a/52d2a8f5...e5.jpg" → "52d2a8f5...e5"
// Cubemap face filepaths append "_N" before the extension — strip that too.
function extractMediaHash(filepath)
{
	var m = filepath.match(/\/([0-9a-f]{40,64})(?:_\d+)?\.[a-z]+$/i);
	return m ? m[1] : null;
}

function resolveJsonInput(inp, outputIdMap, thisPassId)
{
	var sampler = inp.sampler || {};
	var filter  = sampler.filter || 'linear';
	var wrap    = sampler.wrap   || 'clamp';
	var vflip   = sampler.vflip  === 'true';

	// Clamp filter → linear in our model (clamp is a wrap mode on Shadertoy, not filter)
	if (filter !== 'linear' && filter !== 'nearest' && filter !== 'mipmap') { filter = 'linear'; }
	if (wrap  !== 'repeat') { wrap = 'clamp'; }

	var type = inp.type || '';
	var fp   = inp.filepath || '';

	if (type === 'buffer')
	{
		// Match by output resource ID → pass ID
		var passId = outputIdMap[inp.id] || null;
		if (!passId)
		{
			return { ch: makeChannel('none'), warn: 'Buffer input id "' + inp.id + '" not matched to any pass — set manually.', selfRef: false };
		}
		var selfRef = (passId === thisPassId);
		var ch = makeChannel(passId);
		ch.filter = filter; ch.wrap = wrap; ch.vflip = vflip;
		return { ch: ch, warn: null, selfRef: selfRef };
	}

	if (type === 'texture')
	{
		var hash    = extractMediaHash(fp);
		var texName = hash ? (SHADERTOY_TEXTURE_HASH_MAP[hash] || '') : '';
		var ch = makeChannel('texture');
		ch.name = texName; ch.filter = filter; ch.wrap = wrap; ch.vflip = vflip;
		var warn = texName ? null : 'Texture "' + fp + '" not in known list — set Name manually in channel options.';
		return { ch: ch, warn: warn, selfRef: false };
	}

	if (type === 'cubemap')
	{
		var hash     = extractMediaHash(fp);
		var cubeName = hash ? (SHADERTOY_CUBEMAP_HASH_MAP[hash] || '') : '';
		var ch = makeChannel('cubemap');
		ch.name = cubeName; ch.filter = filter; ch.wrap = wrap; ch.vflip = vflip;
		var warn = cubeName ? null : 'Cubemap "' + fp + '" not in known list — set Name manually in channel options.';
		return { ch: ch, warn: warn, selfRef: false };
	}

	if (type === 'volume')
	{
		var hash    = extractMediaHash(fp);
		var volName = hash ? (SHADERTOY_VOLUME_HASH_MAP[hash] || '') : '';
		var ch = makeChannel('volume');
		ch.name = volName; ch.filter = filter; ch.wrap = wrap; ch.vflip = vflip;
		var warn = volName ? null : 'Volume "' + fp + '" not in known list — set Name manually in channel options.';
		return { ch: ch, warn: warn, selfRef: false };
	}

	if (type === 'musicstream' || type === 'soundcloud' || type === 'music')
	{
		return { ch: makeChannel('none'), warn: 'Audio input (musicstream) on CH' + inp.channel + ' is not supported — channel left unset.', selfRef: false };
	}

	if (type === 'webcam')
	{
		return { ch: makeChannel('backbuffer'), warn: 'Webcam input on CH' + inp.channel + ' mapped to BackBuffer — apply ReShade to your webcam app to capture live feed.', selfRef: false };
	}

	if (type === 'video')
	{
		return { ch: makeChannel('backbuffer'), warn: 'Video input on CH' + inp.channel + ' mapped to BackBuffer — apply ReShade to a video player app to capture video feed.', selfRef: false };
	}

	if (type === 'keyboard' || type === 'mic')
	{
		return { ch: makeChannel('none'), warn: 'Input type "' + type + '" on CH' + inp.channel + ' is not supported — channel left unset.', selfRef: false };
	}

	// Unknown type
	return { ch: makeChannel('none'), warn: 'Unknown input type "' + type + '" on CH' + inp.channel + ' — channel left unset.', selfRef: false };
}

function populateFromJson(data)
{
	clearLog();

	var info       = data.info       || {};
	var renderpasses = data.renderpass || [];

	// Store shader metadata for use in the assembler header
	var shaderId = info.id || '';
	currentShaderInfo =
	{
		id:          shaderId,
		name:        info.name        || '',
		username:    info.username    || '',
		description: info.description || '',
		url:         shaderId ? 'https://www.shadertoy.com/view/' + shaderId : ''
	};

	if (currentShaderInfo.name) { log('info', 'Loaded: "' + currentShaderInfo.name + '" by ' + (currentShaderInfo.username || 'unknown')); }
	if (currentShaderInfo.url)  { log('info', 'Source: ' + currentShaderInfo.url); }

	// Build outputIdMap: resource output ID → pass ID in our system
	// Buffer passes: detect slot from filepath suffix (buffer00 → bufA, etc.)
	var outputIdMap = {};
	renderpasses.forEach(function (rp)
	{
		if (rp.type !== 'buffer' && rp.type !== 'cubemap') { return; }
		var outputs = rp.outputs || [];
		if (!outputs.length) { return; }
		var outId = outputs[0].id;

		if (rp.type === 'cubemap')
		{
			outputIdMap[outId] = 'cubemapA';
			return;
		}

		// For buffer passes, derive slot from the filepath of any output or from pass name
		// Most reliable: the filepath on the output entry itself (not available) —
		// so we use the name field ("Buffer A" → bufA, etc.)
		var name = (rp.name || '').toLowerCase().replace(/\s/g, '');
		if      (name === 'buffera') { outputIdMap[outId] = 'bufA'; }
		else if (name === 'bufferb') { outputIdMap[outId] = 'bufB'; }
		else if (name === 'bufferc') { outputIdMap[outId] = 'bufC'; }
		else if (name === 'bufferd') { outputIdMap[outId] = 'bufD'; }
		else
		{
			// Fallback: try to extract from filepath pattern on inputs of other passes
			// The output ID on a buffer pass matches the id field on inputs of type "buffer"
			// in other passes. We can also look at the filepath on those inputs.
			// We defer this — mark as unknown and let resolveJsonInput emit a warning.
			log('warn', 'Buffer pass "' + (rp.name || outId) + '" could not be mapped to a slot by name — channel inputs referencing it may need manual correction.');
		}
	});

	// Reset pass state
	passes       = {};
	activePasses = ['common', 'image'];
	activePassId = 'image';
	activeChIdx  = null;
	passes['common'] = makePass(false);
	passes['image']  = makePass(false);

	// Separate pass types
	var commonPass  = null;
	var bufferPasses = [];
	var imagePass   = null;
	var soundPass   = null;

	renderpasses.forEach(function (rp)
	{
		var t = (rp.type || '').toLowerCase();
		if (t === 'common')  { commonPass = rp; }
		else if (t === 'buffer')  { bufferPasses.push(rp); }
		else if (t === 'image')   { imagePass = rp; }
		else if (t === 'cubemap') { bufferPasses.push(rp); }
		else if (t === 'sound')   { soundPass = rp; }
	});

	if (soundPass) { log('warn', 'Sound shader pass detected — sound output is not supported and will be skipped.'); }

	// ── Common pass ──
	if (commonPass && commonPass.code && commonPass.code.trim())
	{
		passes['common'].src = commonPass.code.trimEnd() + '\n';
	}

	// ── Buffer passes ── (add in order: A, B, C, D, cubemapA)
	var bufOrder = ['bufA', 'bufB', 'bufC', 'bufD', 'cubemapA'];

	// Sort by our slot order
	var sortedBufs = bufOrder.map(function (slot)
	{
		var found = null;
		bufferPasses.forEach(function (rp)
		{
			var t    = (rp.type || '').toLowerCase();
			var name = (rp.name || '').toLowerCase().replace(/\s/g, '');
			if (slot === 'cubemapA' && t === 'cubemap')   { found = rp; }
			else if (slot === 'bufA' && name === 'buffera') { found = rp; }
			else if (slot === 'bufB' && name === 'bufferb') { found = rp; }
			else if (slot === 'bufC' && name === 'bufferc') { found = rp; }
			else if (slot === 'bufD' && name === 'bufferd') { found = rp; }
		});
		return { slot: slot, rp: found };
	}).filter(function (e) { return e.rp !== null; });

	sortedBufs.forEach(function (entry)
	{
		var slot = entry.slot;
		var rp   = entry.rp;

		passes[slot] = makePass(true);
		passes[slot].src = (rp.code || '').trimEnd() + '\n';

		var imgIdx = activePasses.indexOf('image');
		activePasses.splice(imgIdx, 0, slot);

		// Resolve channels
		var inputs = rp.inputs || [];
		var selfRefChannels = [];
		inputs.forEach(function (inp)
		{
			var chIdx = inp.channel;
			if (chIdx < 0 || chIdx > 3) { return; }
			var result = resolveJsonInput(inp, outputIdMap, slot);
			passes[slot].channels[chIdx] = result.ch;
			if (result.selfRef)
			{
				selfRefChannels.push(chIdx);
				log('warn', '[' + slot + ' CH' + chIdx + '] Self-referencing buffer detected — a copy pass will be inserted to read the previous frame\'s output.');
			}
			else if (result.warn) { log('warn', '[' + slot + ' CH' + chIdx + '] ' + result.warn); }
		});
		if (selfRefChannels.length) { passes[slot].selfRefChannels = selfRefChannels; }

		// Default activeChIdx to first present channel
		if (activeChIdx === null)
		{
			for (var s = 0; s <= 3; s++) { if (passes[slot].channels[s]) { activeChIdx = s; break; } }
		}
	});

	// ── Image pass ──
	if (imagePass)
	{
		passes['image'].src = (imagePass.code || '').trimEnd() + '\n';

		var inputs = imagePass.inputs || [];
		inputs.forEach(function (inp)
		{
			var chIdx = inp.channel;
			if (chIdx < 0 || chIdx > 3) { return; }
			var result = resolveJsonInput(inp, outputIdMap, 'image');
			passes['image'].channels[chIdx] = result.ch;
			if (result.warn) { log('warn', '[Image CH' + chIdx + '] ' + result.warn); }
		});
	}

	// Switch to image pass for display
	activePassId = 'image';
	activeChIdx  = null;
	var imgP = passes['image'];
	if (imgP && imgP.channels)
	{
		for (var s = 0; s <= 3; s++) { if (imgP.channels[s]) { activeChIdx = s; break; } }
	}

	syncTextareaToPass();
	renderTabBar();
	renderChannelBar();

	var passCount = activePasses.filter(function (id) { return id !== 'common'; }).length;
	log('ok', 'JSON loaded: ' + passCount + ' pass(es). Review channel assignments then click Convert.');
}

function loadJsonFile(text, filename)
{
	var data;
	try { data = JSON.parse(text); }
	catch (e)
	{
		log('error', 'Failed to parse JSON: ' + e.message);
		return;
	}

	if (!data.renderpass || !Array.isArray(data.renderpass))
	{
		log('error', '"' + filename + '" does not look like a Shadertoy export — missing renderpass array.');
		return;
	}

	populateFromJson(data);
}
