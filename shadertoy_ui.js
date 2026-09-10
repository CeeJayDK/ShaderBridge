// ═════════════════════════════════════════════════════════════════════════════
// PASS MANAGEMENT
// ═════════════════════════════════════════════════════════════════════════════

var PASS_ORDER  = ['common', 'bufA', 'bufB', 'bufC', 'bufD', 'cubemapA', 'image'];
var PASS_LABELS = { common: 'Common', bufA: 'Buffer A', bufB: 'Buffer B', bufC: 'Buffer C', bufD: 'Buffer D', cubemapA: 'Cubemap A', image: 'Image' };
var PASS_PLACEHOLDERS =
{
	common:   '// Common tab: shared functions and #defines.\n// Prepended verbatim to all passes.\n// No mainImage() here.\n',
	bufA:     '// Buffer A: void mainImage( out vec4 fragColor, in vec2 fragCoord )\n',
	bufB:     '// Buffer B: void mainImage( out vec4 fragColor, in vec2 fragCoord )\n',
	bufC:     '// Buffer C: void mainImage( out vec4 fragColor, in vec2 fragCoord )\n',
	bufD:     '// Buffer D: void mainImage( out vec4 fragColor, in vec2 fragCoord )\n',
	cubemapA: '// Cubemap A: void mainImage( out vec4 fragColor, in vec2 fragCoord )\n',
	image:    '// ─────────────────────────────────────────────────────────────────────────\n'
	        + '// ShaderBridge — Shadertoy → ReShade FX Porter\n'
	        + '// ─────────────────────────────────────────────────────────────────────────\n'
	        + '//\n'
	        + '// HOW TO USE:\n'
	        + '//\n'
	        + '//   Option A — Load from JSON (recommended)\n'
	        + '//     1. Install the "Shadertoy Unofficial Plugin" by Patu for Firefox.\n'
	        + '//        (Search: "Shadertoy Unofficial Plugin Patu Firefox")\n'
	        + '//     2. Open the shader on shadertoy.com and export it as JSON.\n'
	        + '//     3. Click "Load File" and select the exported .json file.\n'
	        + '//        All passes and channel settings are populated automatically.\n'
	        + '//\n'
	        + '//   Option B — Paste GLSL directly\n'
	        + '//     Paste the shader code from the Shadertoy editor into this pane.\n'
	        + '//     Set up channel inputs manually using the Channels bar above.\n'
	        + '//\n'
	        + '// ⚠  LICENSE NOTICE\n'
	        + '//     Only port shaders whose license permits copying and modification.\n'
	        + '//     Many shaders on Shadertoy are All Rights Reserved by default.\n'
	        + '//     Always credit the original author in your ported shader.\n'
	        + '//\n'
	        + '// When ready, click  ⟶ Convert Shader  at the bottom.\n'
	        + '// ─────────────────────────────────────────────────────────────────────────\n'
};

// Pass IDs that render to a texture target (can be used as channel inputs)
var BUF_IDS = ['bufA', 'bufB', 'bufC', 'bufD', 'cubemapA'];

// Current shader metadata loaded from a .json file (null when loading raw GLSL)
// ── Channel resource data ─────────────────────────────────────────────────────

var CH_TEXTURES = [
	{ name: 'Abstract 1',                   w: 1024, h: 1024, fmt: 'RGBA8',  ch: 3 },
	{ name: 'Abstract 2',                   w: 512,  h: 512,  fmt: 'RGBA8',  ch: 3 },
	{ name: 'Abstract 3',                   w: 1024, h: 1024, fmt: 'RGBA8',  ch: 3 },
	{ name: 'Bayer',                        w: 8,    h: 8,    fmt: 'R8',     ch: 1 },
	{ name: 'Blue Noise',                   w: 1024, h: 1024, fmt: 'RGBA8',  ch: 4 },
	{ name: 'Font 1',                       w: 1024, h: 1024, fmt: 'RGBA8',  ch: 4 },
	{ name: 'Gray Noise Medium',            w: 256,  h: 256,  fmt: 'R8',     ch: 1 },
	{ name: 'Gray Noise Small',             w: 64,   h: 64,   fmt: 'R8',     ch: 1 },
	{ name: 'Lichen',                       w: 1024, h: 1024, fmt: 'RGBA8',  ch: 3 },
	{ name: 'London',                       w: 512,  h: 512,  fmt: 'RGBA8',  ch: 3 },
	{ name: 'Nyancat',                      w: 256,  h: 32,   fmt: 'RGBA8',  ch: 4 },
	{ name: 'Organic 1',                    w: 1024, h: 1024, fmt: 'RGBA8',  ch: 3 },
	{ name: 'Organic 2',                    w: 1024, h: 1024, fmt: 'RGBA8',  ch: 3 },
	{ name: 'Organic 3',                    w: 1024, h: 1024, fmt: 'RGBA8',  ch: 3 },
	{ name: 'Organic 4',                    w: 1024, h: 1024, fmt: 'RGBA8',  ch: 3 },
	{ name: 'Pebbles',                      w: 512,  h: 512,  fmt: 'R8',     ch: 1 },
	{ name: 'RGBA Noise Medium',            w: 256,  h: 256,  fmt: 'RGBA8',  ch: 4 },
	{ name: 'RGBA Noise Small',             w: 64,   h: 64,   fmt: 'RGBA8',  ch: 4 },
	{ name: 'Rock Tiles',                   w: 512,  h: 512,  fmt: 'RGBA8',  ch: 3 },
	{ name: 'Rusty Metal',                  w: 512,  h: 512,  fmt: 'RGBA8',  ch: 3 },
	{ name: 'Stars',                        w: 512,  h: 512,  fmt: 'RGBA8',  ch: 3 },
	{ name: 'Wood',                         w: 1024, h: 1024, fmt: 'RGBA8',  ch: 3 }
];

var CH_CUBEMAPS = [
	{ name: 'Forest',                       w: 256, h: 256, fmt: 'RGBA8', ch: 3 },
	{ name: 'Forest Blurred',               w: 64,  h: 64,  fmt: 'RGBA8', ch: 3 },
	{ name: "St. Peter's Basilica",         w: 256, h: 256, fmt: 'RGBA8', ch: 3 },
	{ name: "St. Peter's Basilica Blurred", w: 64,  h: 64,  fmt: 'RGBA8', ch: 3 },
	{ name: 'Uffizi Gallery',               w: 512, h: 512, fmt: 'RGBA8', ch: 3 },
	{ name: 'Uffizi Gallery Blurred',       w: 64,  h: 64,  fmt: 'RGBA8', ch: 3 }
];

var CH_VOLUMES = [
	{ name: 'Grey Noise 3D',  w: 32, h: 32, d: 32, fmt: 'R8',    ch: 1 },
	{ name: 'RGBA Noise 3D',  w: 32, h: 32, d: 32, fmt: 'RGBA8', ch: 4 }
];

// Which channel types get a name sub-dropdown
var CH_HAS_NAME   = { texture: true, cubemap: true, volume: true };
// Which types support Mipmap filter option (static resources only)
var CH_HAS_MIPMAP = { texture: true, volume: true };
// Which types support Vflip
var CH_HAS_VFLIP  = { texture: true, cubemap: true, cubemapA: true, volume: true };

// Look up resource info by type+name
function chResourceInfo(type, name)
{
	var list = type === 'texture' ? CH_TEXTURES : type === 'cubemap' ? CH_CUBEMAPS : CH_VOLUMES;
	for (var i = 0; i < list.length; i++) { if (list[i].name === name) { return list[i]; } }
	return null;
}

// ── Pass state ────────────────────────────────────────────────────────────────

// passes: map of id → { src, channels, format }
// channels: sparse object { 0: chObj, 1: chObj, ... } — keys only for added channels
// chObj: { type, name, filter, wrap, vflip }
// activePasses: ordered list of active pass ids
var passes      = {};
var activePasses = ['image'];
var activePassId = 'image';
var activeChIdx  = null; // currently selected channel index (null = none)

function makeChannel(type)
{
	return { type: type || 'none', name: '', filter: 'linear', wrap: 'repeat', vflip: false };
}

function makePass(isBuffer)
{
	return {
		src:      '',
		channels: {},
		format:   'RGBA32F'
	};
}

function initPasses()
{
	passes['common'] = makePass(false);
	passes['image']  = makePass(false);
	// Image starts with backbuffer on CH0
	passes['image'].channels[0] = makeChannel('backbuffer');
	activePasses = ['common', 'image'];
	activePassId = 'image';
	activeChIdx  = 0;
	renderTabBar();
	renderChannelBar();
	syncTextareaToPass();
}

function getActivePass() { return passes[activePassId]; }

// Set textarea value in a way that preserves the browser undo stack.
// Falls back to direct assignment if execCommand is unavailable.
function setTextarea(ta, value)
{
	ta.focus();
	ta.select();
	if (!document.execCommand('insertText', false, value))
	{
		ta.value = value;
	}
	// Blur + re-focus to reset selection without losing undo history
	ta.setSelectionRange(0, 0);
}

function switchPass(id)
{
	saveActivePassSrc();
	activePassId = id;
	// Select first existing channel for new pass, or null
	var p = passes[id];
	activeChIdx = null;
	if (p && p.channels)
	{
		for (var i = 0; i <= 3; i++)
		{
			if (p.channels[i]) { activeChIdx = i; break; }
		}
	}
	syncTextareaToPass();
	renderTabBar();
	renderChannelBar();
	updateInputPaneTitle();
}

function saveActivePassSrc()
{
	if (passes[activePassId])
	{
	    passes[activePassId].src = document.getElementById('glsl-input').value;
	}
}

function syncTextareaToPass()
{
	var ta = document.getElementById('glsl-input');
	var p  = passes[activePassId];
	ta.placeholder = PASS_PLACEHOLDERS[activePassId] || '';
	setTextarea(ta, p ? p.src : '');
	syncHighlight('glsl-input', 'glsl-highlight');
}

function onPassInput()
{
	if (passes[activePassId])
	{
	    passes[activePassId].src = document.getElementById('glsl-input').value;
	    // Re-render tab bar to update empty/filled state
	    renderTabBar();
	}
}

function addNextBuffer()
{
	for (var i = 0; i < BUF_IDS.length; i++)
	{
	    var id = BUF_IDS[i];
	    if (activePasses.indexOf(id) === -1)
	    {
	        passes[id] = makePass(true);
	        // Insert before 'image' in activePasses
	        var imgIdx = activePasses.indexOf('image');
	        activePasses.splice(imgIdx, 0, id);
	        switchPass(id);
	        return;
	    }
	}
}

function removePass(id)
{
	var p = passes[id];
	var hasContent = p && p.src.trim().length > 0;
	if (hasContent && !confirm('Delete ' + PASS_LABELS[id] + '? This will discard its code.'))
	{
	    return;
	}
	delete passes[id];
	var idx = activePasses.indexOf(id);
	if (idx !== -1) { activePasses.splice(idx, 1); }
	// Switch to nearest tab
	if (activePassId === id)
	{
	    var newId = activePasses[Math.min(idx, activePasses.length - 1)];
	    activePassId = newId;
	    syncTextareaToPass();
	}
	renderTabBar();
	renderChannelBar();
	updateInputPaneTitle();
}

function renderTabBar()
{
	var bar = document.getElementById('pass-tab-bar');
	bar.innerHTML = '';

	// "Passes:" label
	var lbl = document.createElement('span');
	lbl.className   = 'bar-label';
	lbl.textContent = 'Passes:';
	bar.appendChild(lbl);

	activePasses.forEach(function(id)
	{
	    var p        = passes[id];
	    var isEmpty  = !p || !p.src.trim();
	    var isActive = id === activePassId;
	    var canClose = id !== 'image' && id !== 'common';

	    var tab = document.createElement('div');
	    tab.className = 'tab' + (isActive ? ' active' : '') + (isEmpty ? ' empty' : '');

	    var label = document.createElement('span');
	    label.textContent = PASS_LABELS[id];
	    tab.appendChild(label);

	    if (canClose)
	    {
	        var x = document.createElement('span');
	        x.className   = 'tab-close';
	        x.textContent = '×';
	        x.title       = 'Remove ' + PASS_LABELS[id];
	        x.onclick = (function(pid) { return function(e) { e.stopPropagation(); removePass(pid); }; }(id));
	        tab.appendChild(x);
	    }

	    tab.onclick = (function(pid) { return function() { switchPass(pid); }; }(id));
	    bar.appendChild(tab);
	});

	// "+" button — only if not all buffer slots used
	var allBuffersAdded = BUF_IDS.every(function(id) { return activePasses.indexOf(id) !== -1; });
	if (!allBuffersAdded)
	{
	    var add = document.createElement('div');
	    add.className   = 'tab-add';
	    add.textContent = '+';
	    add.title       = 'Add next buffer pass';
	    add.onclick     = addNextBuffer;
	    bar.appendChild(add);
	}

	// Format selector on far right — only for buffer passes
	if (BUF_IDS.indexOf(activePassId) !== -1)
	{
	    var spacer = document.createElement('div');
	    spacer.className = 'tab-spacer';
	    bar.appendChild(spacer);

	    var fmt = document.createElement('div');
	    fmt.className = 'tab-format-group';

	    var fmtLbl = document.createElement('span');
	    fmtLbl.textContent = 'Format';
	    fmt.appendChild(fmtLbl);

	    var fmtSel = document.createElement('select');
	    fmtSel.title = 'Texture format for this buffer pass. RGBA32F = full float precision (default). Use RGBA16F to halve memory, RGBA8 for LDR-only content.';
	    var p = passes[activePassId];
	    ['RGBA8', 'RGB10A2', 'RGBA16F', 'RGBA32F'].forEach(function(f)
	    {
	        var o = document.createElement('option');
	        o.value = f; o.textContent = f;
	        if (p && p.format === f) { o.selected = true; }
	        fmtSel.appendChild(o);
	    });
	    fmtSel.onchange = function() { if (passes[activePassId]) { passes[activePassId].format = fmtSel.value; } };
	    fmt.appendChild(fmtSel);
	    bar.appendChild(fmt);
	}
}

function renderChannelBar()
{
	var bar = document.getElementById('pass-channel-bar');
	bar.innerHTML = '';
	var p = passes[activePassId];

	// "Channels:" label — always shown
	var lbl = document.createElement('span');
	lbl.className   = 'bar-label';
	lbl.textContent = 'Channels:';
	bar.appendChild(lbl);

	// Common pass — no channels, blank bar
	if (!p || activePassId === 'common') { return; }

	if (!p.channels) { p.channels = {}; }

	// Count active channels and find which slots are used
	var usedSlots = [];
	for (var s = 0; s <= 3; s++) { if (p.channels[s]) { usedSlots.push(s); } }

	// Channel tabs
	usedSlots.forEach(function(idx)
	{
		var ch      = p.channels[idx];
		var isActive = idx === activeChIdx;

		// Build tab label: "CH0" or "CH0: Name"
		var tabLabel = 'CH' + idx;
		if (ch.name) { tabLabel += ': ' + ch.name; }
		else if (ch.type && ch.type !== 'none') { tabLabel += ': ' + ch.type; }

		var tab = document.createElement('div');
		tab.className = 'tab ch-tab' + (isActive ? ' active' : '');

		var labelEl = document.createElement('span');
		labelEl.textContent = tabLabel;
		tab.appendChild(labelEl);

		// × to remove channel
		var x = document.createElement('span');
		x.className   = 'tab-close';
		x.textContent = '×';
		x.title       = 'Remove CH' + idx;
		x.onclick = (function(i) { return function(e)
		{
			e.stopPropagation();
			delete p.channels[i];
			if (activeChIdx === i)
			{
				// Switch to nearest remaining channel
				activeChIdx = null;
				for (var s = 0; s <= 3; s++) { if (p.channels[s]) { activeChIdx = s; break; } }
			}
			renderChannelBar();
		}; }(idx));
		tab.appendChild(x);

		tab.onclick = (function(i) { return function() { activeChIdx = i; renderChannelBar(); }; }(idx));
		bar.appendChild(tab);
	});

	// "+" to add next available slot (up to 4, allows gaps)
	var nextSlot = -1;
	for (var s = 0; s <= 3; s++) { if (!p.channels[s]) { nextSlot = s; break; } }
	if (nextSlot !== -1)
	{
		var add = document.createElement('div');
		add.className   = 'tab-add';
		add.textContent = '+';
		add.title       = 'Add CH' + nextSlot;
		add.onclick     = function()
		{
			// Find first free slot
			for (var s = 0; s <= 3; s++)
			{
				if (!p.channels[s])
				{
					p.channels[s] = makeChannel('none');
					activeChIdx   = s;
					renderChannelBar();
					return;
				}
			}
		};
		bar.appendChild(add);
	}

	// Options panel for active channel — on far right
	if (activeChIdx !== null && p.channels[activeChIdx])
	{
		var spacer = document.createElement('div');
		spacer.className = 'tab-spacer';
		bar.appendChild(spacer);

		renderChannelOptions(bar, p, activeChIdx);
	}
}

function renderChannelOptions(bar, p, idx)
{
	var ch = p.channels[idx];

	// Build type options: None, Backbuffer, active buffers, Texture, Cubemap, Volume
	var typeOptions = [
		{ value: 'none',       label: 'None' },
		{ value: 'backbuffer', label: 'Backbuffer' }
	];
	BUF_IDS.forEach(function(bid)
	{
		if (activePasses.indexOf(bid) !== -1 && bid !== activePassId)
		{
			typeOptions.push({ value: bid, label: PASS_LABELS[bid] });
		}
	});
	typeOptions.push(
		{ value: 'texture', label: 'Texture' },
		{ value: 'cubemap', label: 'Cubemap' },
		{ value: 'volume',  label: 'Volume'  }
	);

	// Type dropdown
	var typeGrp = document.createElement('div');
	typeGrp.className = 'ch-opt-group';
	var typeLbl = document.createElement('span');
	typeLbl.className   = 'ch-opt-label';
	typeLbl.textContent = 'Type';
	typeGrp.appendChild(typeLbl);
	var typeSel = document.createElement('select');
	typeSel.title = 'Channel input type. Buffer = output of another pass. Backbuffer = ReShade back buffer (current screen). Texture/Cubemap/Volume = static resource file.';
	typeOptions.forEach(function(opt)
	{
		var o = document.createElement('option');
		o.value = opt.value; o.textContent = opt.label;
		if (ch.type === opt.value) { o.selected = true; }
		typeSel.appendChild(o);
	});
	typeSel.onchange = function()
	{
		ch.type = typeSel.value;
		ch.name = ''; // reset name when type changes
		renderChannelBar();
		renderTabBar(); // update pass tab empty state
	};
	typeGrp.appendChild(typeSel);
	bar.appendChild(typeGrp);

	// Name dropdown — for texture, cubemap, volume
	if (CH_HAS_NAME[ch.type])
	{
		var nameList = ch.type === 'texture' ? CH_TEXTURES
		             : ch.type === 'cubemap' ? CH_CUBEMAPS
		             : CH_VOLUMES;

		var nameGrp = document.createElement('div');
		nameGrp.className = 'ch-opt-group';
		var nameLbl = document.createElement('span');
		nameLbl.className   = 'ch-opt-label';
		nameLbl.textContent = 'Name';
		nameGrp.appendChild(nameLbl);
		var nameSel = document.createElement('select');

		// Blank option
		var blankOpt = document.createElement('option');
		blankOpt.value = ''; blankOpt.textContent = '— select —';
		if (!ch.name) { blankOpt.selected = true; }
		nameSel.appendChild(blankOpt);

		nameList.forEach(function(res)
		{
			var o = document.createElement('option');
			o.value = res.name; o.textContent = res.name;
			if (ch.name === res.name) { o.selected = true; }
			nameSel.appendChild(o);
		});
		nameSel.onchange = function()
		{
			ch.name = nameSel.value;
			renderChannelBar(); // update tab label + info
		};
		nameGrp.appendChild(nameSel);
		bar.appendChild(nameGrp);

		// Info: dimensions + format
		if (ch.name)
		{
			var info = chResourceInfo(ch.type, ch.name);
			if (info)
			{
				var infoEl = document.createElement('span');
				infoEl.className   = 'ch-info';
				var dims = info.d ? (info.w + '×' + info.h + '×' + info.d)
				                  : (info.w + '×' + info.h);
				infoEl.textContent = dims + ' ' + info.fmt;
				bar.appendChild(infoEl);
			}
		}
	}

	// Filter — Linear/Nearest, plus Mipmap for texture/volume
	var filterGrp = document.createElement('div');
	filterGrp.className = 'ch-opt-group';
	var filterLbl = document.createElement('span');
	filterLbl.className   = 'ch-opt-label';
	filterLbl.textContent = 'Filter';
	filterGrp.appendChild(filterLbl);
	var filterSel = document.createElement('select');
	filterSel.title = 'Texture filtering mode. Linear = bilinear interpolation (smooth). Nearest = no interpolation (pixelated). Mipmap = linear with mipmapping (for minified textures).';
	var filterOpts = ['linear', 'nearest'];
	if (CH_HAS_MIPMAP[ch.type]) { filterOpts.push('mipmap'); }
	filterOpts.forEach(function(f)
	{
		var o = document.createElement('option');
		o.value = f; o.textContent = f.charAt(0).toUpperCase() + f.slice(1);
		if (ch.filter === f) { o.selected = true; }
		filterSel.appendChild(o);
	});
	// If current filter is mipmap but type no longer supports it, reset
	if (ch.filter === 'mipmap' && !CH_HAS_MIPMAP[ch.type]) { ch.filter = 'linear'; filterSel.value = 'linear'; }
	filterSel.onchange = function() { ch.filter = filterSel.value; };
	filterGrp.appendChild(filterSel);
	bar.appendChild(filterGrp);

	// Wrap
	var wrapGrp = document.createElement('div');
	wrapGrp.className = 'ch-opt-group';
	var wrapLbl = document.createElement('span');
	wrapLbl.className   = 'ch-opt-label';
	wrapLbl.textContent = 'Wrap';
	wrapGrp.appendChild(wrapLbl);
	var wrapSel = document.createElement('select');
	wrapSel.title = 'Texture address mode. Repeat = tile the texture. Clamp = stretch the edge pixels beyond the texture boundary.';
	['repeat', 'clamp'].forEach(function(w)
	{
		var o = document.createElement('option');
		o.value = w; o.textContent = w.charAt(0).toUpperCase() + w.slice(1);
		if (ch.wrap === w) { o.selected = true; }
		wrapSel.appendChild(o);
	});
	wrapSel.onchange = function() { ch.wrap = wrapSel.value; };
	wrapGrp.appendChild(wrapSel);
	bar.appendChild(wrapGrp);

	// Vflip — for texture, cubemap, cubemapA, volume
	if (CH_HAS_VFLIP[ch.type])
	{
		var vflipLabel = document.createElement('label');
		vflipLabel.className = 'ch-vflip';
		vflipLabel.title     = 'Flip the texture vertically at the sample site. Shadertoy textures are often stored upside-down relative to ReShade\'s UV convention.';
		var vflipCb = document.createElement('input');
		vflipCb.type    = 'checkbox';
		vflipCb.checked = !!ch.vflip;
		vflipCb.onchange = function() { ch.vflip = vflipCb.checked; };
		var vflipTxt = document.createElement('span');
		vflipTxt.textContent = 'Vflip';
		vflipLabel.appendChild(vflipCb);
		vflipLabel.appendChild(vflipTxt);
		bar.appendChild(vflipLabel);
	}
}

function updateInputPaneTitle()
{
	// Title is now static "Shadertoy Input (GLSL)" — no-op kept for call-site compatibility
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN CONVERT ENTRY POINT
// ═════════════════════════════════════════════════════════════════════════════

function convert()
{
	saveActivePassSrc();
	clearLog();

	var flipY       = document.getElementById('opt-yflip').checked;
	var separateFxh = document.getElementById('opt-fxh').checked;
	var messages    = [];

	// Gather passes in execution order, skip empty non-common passes
	var commonSrc = (passes['common'] && passes['common'].src) || '';

	var passList = [];
	activePasses.forEach(function(id)
	{
	    if (id === 'common') { return; }
	    var p   = passes[id];
	    var src = (p && p.src.trim()) ? p.src : '';
	    if (!src && id !== 'image') { return; } // skip empty buffer passes

	    // Flatten sparse channel object to 4-element arrays for the assembler
	    var channels     = ['none', 'none', 'none', 'none'];
	    var channelNames = ['', '', '', ''];
	    var filters      = ['linear', 'linear', 'linear', 'linear'];
	    var wraps        = ['repeat', 'repeat', 'repeat', 'repeat'];
	    var vflips       = [false, false, false, false];
	    if (p && p.channels)
	    {
	        for (var ci = 0; ci <= 3; ci++)
	        {
	            var ch = p.channels[ci];
	            if (!ch) { continue; }
	            // Map new type model to assembler's type strings
	            if (ch.type === 'backbuffer')               { channels[ci] = 'backbuffer'; }
	            else if (ch.type === 'texture')             { channels[ci] = 'texture'; }
	            else if (ch.type === 'cubemap')             { channels[ci] = 'cubemap'; }
	            else if (ch.type === 'volume')              { channels[ci] = ch.name === 'Grey Noise 3D' ? 'vol1' : 'vol4'; }
	            else if (BUF_IDS.indexOf(ch.type) !== -1)  { channels[ci] = ch.type; }
	            else                                        { channels[ci] = 'none'; }
	            channelNames[ci] = ch.name || '';
	            filters[ci]      = ch.filter || 'linear';
	            wraps[ci]        = ch.wrap   || 'repeat';
	            vflips[ci]       = !!ch.vflip;
	        }
	    }

	    passList.push({ id: id, src: src, channels: channels, channelNames: channelNames, filters: filters, wraps: wraps, vflips: vflips, format: p ? p.format : 'RGBA32F', selfRefChannels: (p && p.selfRefChannels) ? p.selfRefChannels : [] });
	});

	if (!passList.some(function(p) { return p.src.trim(); }))
	{
	    log('error', 'No shader code provided in any pass.');
	    return;
	}

	// Transform each pass
	var multipass = passList.length > 1;
	var transformedPasses = passList.map(function(p)
	{
		var passMessages  = [];
		var usedUniforms  = new Set();
		var src           = commonSrc ? commonSrc + '\n' + p.src : p.src;
		var passLabel     = multipass ? (p.id === 'image' ? 'Image' : p.id.charAt(0).toUpperCase() + p.id.slice(1)) : null;
		analyzeShader(src, passMessages);
		detectUniforms(src, usedUniforms);
		var result = transformGLSL(src, passMessages, passLabel);
		passMessages.forEach(function(m)
		{
			messages.push({ level: m.level, text: '[' + PASS_LABELS[p.id] + '] ' + m.text });
		});
		return { id: p.id, src: result.src, coordVar: result.coordVar, mainImageName: result.mainImageName, usedUniforms: usedUniforms, channels: p.channels, channelNames: p.channelNames, filters: p.filters, wraps: p.wraps, vflips: p.vflips, format: p.format, selfRefChannels: p.selfRefChannels || [] };
	});

	var output = assembleFxFile(transformedPasses, flipY, separateFxh, messages, currentShaderInfo);

	var taOut = document.getElementById('fx-output');
	taOut.value = output;
	syncHighlight('fx-output', 'fx-highlight');

	// Indicators
	var allSrc      = passList.map(function(p) { return p.src; }).join('\n');
	var allChannels = passList.reduce(function(acc, p) { return acc.concat(p.channels); }, []);
	updateIndicators(allSrc, messages, allChannels);

	var hasMultipass = activePasses.filter(function(id) { return BUF_IDS.indexOf(id) !== -1; }).length > 0;
	setIndicator('ind-multipass', hasMultipass ? 'lit-amber' : 'unlit');

	if (messages.length)
	{
	    messages.forEach(function(m) { log(m.level, m.text); });
	}

	var hasError = messages.some(function(m) { return m.level === 'error'; });
	if (hasError)
	{
	    log('warn', 'Errors detected. The output may need manual fixes.');
	}
	else
	{
	    log('ok', 'Conversion complete. Place the .fx in your ReShade Shaders folder.');
	    var convertRow = document.querySelector('.convert-row');
	    if (convertRow) { convertRow.style.position = 'relative'; convertRow.style.bottom = 'auto'; }
	}
}

// ═════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═════════════════════════════════════════════════════════════════════════════

function log(level, text)
{
	var container   = document.getElementById('log-entries');
	var entry       = document.createElement('div');
	entry.className = 'log-entry';
	entry.innerHTML = '<span class="tag tag-' + level + '">' + level + '</span>'
	                + '<span class="msg">' + escapeHtml(text) + '</span>';
	container.appendChild(entry);
	container.parentElement.scrollTop = container.parentElement.scrollHeight;
}

function clearLog()
{
	document.getElementById('log-entries').innerHTML = '';
}

function escapeHtml(str)
{
	return str
	    .replace(/&/g, '&amp;')
	    .replace(/</g, '&lt;')
	    .replace(/>/g, '&gt;');
}

// ═════════════════════════════════════════════════════════════════════════════
// UI ACTIONS
// ═════════════════════════════════════════════════════════════════════════════

function clearActivePass()
{
	var p = passes[activePassId];
	if (p) { p.src = ''; }
	var ta = document.getElementById('glsl-input');
	ta.style.height = '';
	setTextarea(ta, '');
	document.getElementById('glsl-highlight').innerHTML = '';
	document.getElementById('glsl-gutter').textContent  = '';
	var gi = document.getElementById('glsl-hscroll-inner');
	if (gi) { gi.style.width = '0'; }
	matchPaneHeights();
	renderTabBar();
}

function clearAll()
{
	currentShaderInfo = null;
	passes       = {};
	activePasses = ['common', 'image'];
	activePassId = 'image';
	activeChIdx  = 0;
	passes['common'] = makePass(false);
	passes['image']  = makePass(false);
	passes['image'].channels[0] = makeChannel('backbuffer');

	var ta1 = document.getElementById('glsl-input');
	var ta2 = document.getElementById('fx-output');
	ta1.style.height = '';
	ta2.style.height = '';
	setTextarea(ta1, '');
	setTextarea(ta2, '');
	document.getElementById('glsl-highlight').innerHTML = '';
	document.getElementById('fx-highlight').innerHTML   = '';
	document.getElementById('glsl-gutter').textContent  = '';
	document.getElementById('fx-gutter').textContent    = '';
	var gi = document.getElementById('glsl-hscroll-inner');
	var fi = document.getElementById('fx-hscroll-inner');
	if (gi) { gi.style.width = '0'; }
	if (fi) { fi.style.width = '0'; }
	matchPaneHeights();
	resetIndicators();
	clearLog();
	renderTabBar();
	renderChannelBar();
	syncTextareaToPass();
	var convertRow = document.querySelector('.convert-row');
	if (convertRow) { convertRow.style.position = ''; convertRow.style.bottom = ''; }
}

function initFileInput()
{
	var input = document.getElementById('file-input');
	input.addEventListener('change', function()
	{
		var file = input.files[0];
		if (!file) { return; }

		var isJson = file.name.toLowerCase().endsWith('.json');

		var reader    = new FileReader();
		reader.onload = function(e)
		{
			var text = e.target.result;
			if (isJson)
			{
				currentShaderInfo = null;
				loadJsonFile(text, file.name);
			}
			else
			{
				currentShaderInfo = null;
				var src = text.trimEnd() + '\n';
				if (passes[activePassId]) { passes[activePassId].src = src; }
				setTextarea(document.getElementById('glsl-input'), src);
				clearLog();
				log('info', 'Loaded file: ' + file.name);
				syncHighlight('glsl-input', 'glsl-highlight');
				renderTabBar();
			}
		};
		reader.onerror = function() { log('error', 'Failed to read file: ' + file.name); };
		reader.readAsText(file);
		input.value = '';
	});
}

// ═════════════════════════════════════════════════════════════════════════════
// SYNTAX HIGHLIGHTER
// Approach: extract comments as placeholders → highlight code → restore comments
// ═════════════════════════════════════════════════════════════════════════════

var GLSL_TYPES = [
	'void','bool','int','uint','float','double',
	'vec2','vec3','vec4','ivec2','ivec3','ivec4',
	'uvec2','uvec3','uvec4','bvec2','bvec3','bvec4',
	'mat2','mat3','mat4','mat2x2','mat3x3','mat4x4',
	'float2','float3','float4','int2','int3','int4',
	'uint2','uint3','uint4','bool2','bool3','bool4',
	'float2x2','float3x3','float4x4',
	'sampler2D','sampler3D','sampler1D','texture2D'
];

var GLSL_KEYWORDS = [
	'if','else','for','while','do','return','break','continue','discard',
	'in','out','inout','uniform','static','const','struct','define',
	'include','pragma','ifdef','ifndef','endif',
	'technique','pass','VertexShader','PixelShader','SV_Target',
	'SV_Position','TEXCOORD','source'
];

var GLSL_INTRINSICS = [
	'sin','cos','tan','asin','acos','atan','atan2',
	'pow','exp','exp2','log','log2','sqrt','rsqrt','inversesqrt',
	'abs','sign','floor','ceil','round','fract','frac','trunc','mod','modf',
	'min','max','clamp','saturate','mix','lerp','step','smoothstep',
	'length','distance','dot','cross','normalize','reflect','refract',
	'tex2D','tex2Dlod','tex2Dgrad','tex2Dfetch','tex2Dsize',
	'texture','texture2D','textureLod',
	'ddx','ddy','dFdx','dFdy','fwidth',
	'all','any','not','isinf','isnan',
	'mul','transpose','determinant','inverse',
	'radians','degrees','sinh','cosh','tanh',
	'noise','normalize','faceforward',
	'tanh','mad','rcp','ldexp','frexp'
];

function escapeHtmlHL(str)
{
	return str
	    .replace(/&/g, '&amp;')
	    .replace(/</g, '&lt;')
	    .replace(/>/g, '&gt;');
}

function highlight(src)
{
	// ── Step 1: extract comments into placeholders ────────────────────────────
	// Placeholder uses only alphanumeric chars — survives HTML escaping intact
	// and cannot appear in valid GLSL/HLSL source code.
	var comments = [];

	var superDigits = '⁰¹²³⁴⁵⁶⁷⁸⁹';
	function makePH(idx)
	{
	    return '‹' + String(idx).split('').map(function(d) { return superDigits[+d]; }).join('') + '›';
	}

	// Block comments first, then line comments
	var s = src.replace(/\/\*[\s\S]*?\*\//g, function(m)
	{
	    var idx = comments.length;
	    comments.push('<span class="hl-comment">' + escapeHtmlHL(m) + '</span>');
	    return makePH(idx);
	});

	s = s.replace(/\/\/[^\n]*/g, function(m)
	{
	    var idx = comments.length;
	    comments.push('<span class="hl-comment">' + escapeHtmlHL(m) + '</span>');
	    return makePH(idx);
	});

	// ── Step 2: escape remaining HTML special chars ───────────────────────────
	s = escapeHtmlHL(s);

	// ── Step 3: highlight numbers ─────────────────────────────────────────────
	s = s.replace(/\b(\d+\.?\d*(?:[eE][+-]?\d+)?f?|\.\d+f?|0x[0-9a-fA-F]+)\b/g,
	    '<span class="hl-number">$1</span>');

	// ── Step 4: highlight types ───────────────────────────────────────────────
	var typeRe = new RegExp('\\b(' + GLSL_TYPES.join('|') + ')\\b', 'g');
	s = s.replace(typeRe, '<span class="hl-type">$1</span>');

	// ── Step 5: highlight keywords ────────────────────────────────────────────
	var kwRe = new RegExp('\\b(' + GLSL_KEYWORDS.join('|') + ')\\b', 'g');
	s = s.replace(kwRe, '<span class="hl-keyword">$1</span>');

	// ── Step 6: highlight intrinsics ──────────────────────────────────────────
	var intRe = new RegExp('\\b(' + GLSL_INTRINSICS.join('|') + ')\\b', 'g');
	s = s.replace(intRe, '<span class="hl-intrinsic">$1</span>');

	// ── Step 7: highlight punctuation ─────────────────────────────────────────
	// Use negative lookbehind to avoid matching ; inside HTML entities (&gt; &lt; &amp;)
	s = s.replace(/([(){}[\],:])|(?<!&\w{1,6})(;)/g, '<span class="hl-punct">$1$2</span>');

	// ── Step 8: restore comments ──────────────────────────────────────────────
	s = s.replace(/‹([⁰¹²³⁴⁵⁶⁷⁸⁹]+)›/g, function(_, supIdx)
	{
	    var idx = supIdx.split('').map(function(c) { return superDigits.indexOf(c); }).join('');
	    return comments[parseInt(idx, 10)];
	});

	return s;
}

function buildGutter(lineCount)
{
	var nums = [];
	for (var i = 1; i <= lineCount; i++) { nums.push(i); }
	return nums.join('\n');
}

function applyTabWidth()
{
	var w    = document.getElementById('opt-tabwidth').value;
	var size = parseInt(w, 10);

	// Apply to all textareas and highlight divs
	['glsl-input', 'fx-output'].forEach(function(id)
	{
	    var el = document.getElementById(id);
	    if (el) { el.style.tabSize = size; }
	});
	['glsl-highlight', 'fx-highlight'].forEach(function(id)
	{
	    var el = document.getElementById(id);
	    if (el) { el.style.tabSize = size; }
	});
	['glsl-gutter', 'fx-gutter'].forEach(function(id)
	{
	    var el = document.getElementById(id);
	    if (el) { el.style.tabSize = size; }
	});
}

function onHighlightToggle()
{
	var enabled = document.getElementById('opt-highlight').checked;
	document.body.classList.toggle('no-highlight', !enabled);
	syncHighlight('glsl-input', 'glsl-highlight');
	syncHighlight('fx-output',  'fx-highlight');
}

// ── Indentation normalizer ────────────────────────────────────────────────────
// Detect the indent unit used in the source (smallest non-zero space indent),
// then replace every leading indent level with a tab.

function normalizeIndentation(src)
{
	var lines = src.split('\n');

	// Detect indent unit — find smallest run of leading spaces > 0
	var unit  = 0;
	lines.forEach(function(line)
	{
	    var m = line.match(/^( +)/);
	    if (m)
	    {
	        var n = m[1].length;
	        if (unit === 0 || n < unit) { unit = n; }
	    }
	});

	if (unit === 0) { return src; } // no space indentation found

	return lines.map(function(line)
	{
	    var m = line.match(/^( *)(.*)/);
	    if (!m || m[1].length === 0) { return line; }

	    var spaces = m[1].length;
	    var level  = Math.floor(spaces / unit);
	    var rem    = spaces % unit; // leftover spaces (alignment, not indentation)
	    return '\t'.repeat(level) + ' '.repeat(rem) + m[2];
	}).join('\n');
}


function autoGrow(ta)
{
	if (!ta.value && ta.placeholder)
	{
	    // scrollHeight won't reflect placeholder content — compute height from line count
	    var lineCount  = ta.placeholder.split('\n').length;
	    var lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || (0.8 * 16 * 1.6);
	    var padding    = 32 + 4; // bottom + top padding from CSS
	    ta.style.height = Math.ceil(lineCount * lineHeight + padding) + 'px';
	}
	else
	{
	    ta.style.height = 'auto';
	    ta.style.height = ta.scrollHeight + 'px';
	}
}

function matchPaneHeights()
{
	var ta1 = document.getElementById('glsl-input');
	var ta2 = document.getElementById('fx-output');
	if (!ta1 || !ta2) { return; }
	// Use offsetHeight as fallback — style.height may be unset for a pane that hasn't been auto-grown yet
	var h1 = parseInt(ta1.style.height) || ta1.offsetHeight || 0;
	var h2 = parseInt(ta2.style.height) || ta2.offsetHeight || 0;
	var h  = Math.max(h1, h2);
	if (h > 0)
	{
	    ta1.style.height = h + 'px';
	    ta2.style.height = h + 'px';
	    var g1 = document.getElementById('glsl-highlight');
	    var g2 = document.getElementById('fx-highlight');
	    if (g1) { g1.style.minHeight = h + 'px'; }
	    if (g2) { g2.style.minHeight = h + 'px'; }
	    // Sync gutter heights to match
	    var gu1 = document.getElementById('glsl-gutter');
	    var gu2 = document.getElementById('fx-gutter');
	    if (gu1) { gu1.style.minHeight = h + 'px'; }
	    if (gu2) { gu2.style.minHeight = h + 'px'; }
	}
}

function syncHighlight(textareaId, highlightId)
{
	var ta        = document.getElementById(textareaId);
	var div       = document.getElementById(highlightId);
	var gutterId  = textareaId === 'glsl-input' ? 'glsl-gutter'        : 'fx-gutter';
	var hscrollId = textareaId === 'glsl-input' ? 'glsl-hscroll'       : 'fx-hscroll';
	var innerId   = textareaId === 'glsl-input' ? 'glsl-hscroll-inner' : 'fx-hscroll-inner';
	var gutter    = document.getElementById(gutterId);
	var hscroll   = document.getElementById(hscrollId);
	var inner     = document.getElementById(innerId);

	if (!ta || !div) { return; }

	var val       = ta.value;
	var lineCount = val
	    ? val.split('\n').length
	    : (ta.placeholder ? ta.placeholder.split('\n').length : 0);

	var hlEnabled = (function()
	{
	    var cb = document.getElementById('opt-highlight');
	    return cb ? cb.checked : true;
	}());
	div.style.visibility = hlEnabled ? '' : 'hidden';
	div.innerHTML = (val && hlEnabled) ? highlight(val) : '';

	// Auto-grow textarea to content height
	autoGrow(ta);

	// Update hscroll inner width — only when there is real content
	if (inner)
	{
	    if (!val)
	    {
	        inner.style.width = '0';
	    }
	    else
	    {
	    var tabWidth = 4;
	    var tabStr   = ' '.repeat(tabWidth);
	    var lines    = (val || '').split('\n');
	    var longest  = '';
	    lines.forEach(function(line)
	    {
	        var expanded = line.replace(/\t/g, tabStr);
	        if (expanded.length > longest.length) { longest = expanded; }
	    });
	    if (!syncHighlight._ruler)
	    {
	        var ruler = document.createElement('span');
	        ruler.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;'
	            + 'font-family:"Share Tech Mono",monospace;font-size:0.8rem;';
	        document.body.appendChild(ruler);
	        syncHighlight._ruler = ruler;
	    }
	    syncHighlight._ruler.textContent = longest;
	    var textW = syncHighlight._ruler.offsetWidth + 32;
	    var gutterEl = document.getElementById(gutterId);
	    var gutterW  = gutterEl ? gutterEl.offsetWidth : 0;
	    var paneW    = ta.closest('.editor-wrap').offsetWidth - gutterW;
	    inner.style.width = Math.max(textW, paneW) + 'px';
	    if (hscroll) { hscroll.style.marginLeft = gutterW + 'px'; }
	    }
	}

	var scrollX = hscroll ? hscroll.scrollLeft : 0;
	div.style.transform = 'translateX(' + (-scrollX) + 'px)';

	if (gutter) { gutter.textContent = lineCount > 0 ? buildGutter(lineCount) : ''; }
	matchPaneHeights();
}

function initHighlighters()
{
	var input  = document.getElementById('glsl-input');
	var output = document.getElementById('fx-output');
	var glslHS = document.getElementById('glsl-hscroll');
	var fxHS   = document.getElementById('fx-hscroll');

	function onInputChange()  { syncHighlight('glsl-input', 'glsl-highlight'); }
	function onOutputChange() { syncHighlight('fx-output',  'fx-highlight');   }

	function onGlslHScroll()
	{
	    requestAnimationFrame(function()
	    {
	        input.scrollLeft = glslHS.scrollLeft;
	        var div = document.getElementById('glsl-highlight');
	        if (div) { div.style.transform = 'translateX(' + (-glslHS.scrollLeft) + 'px)'; }
	    });
	}
	function onFxHScroll()
	{
	    requestAnimationFrame(function()
	    {
	        output.scrollLeft = fxHS.scrollLeft;
	        var div = document.getElementById('fx-highlight');
	        if (div) { div.style.transform = 'translateX(' + (-fxHS.scrollLeft) + 'px)'; }
	    });
	}

	input.addEventListener('input',   onInputChange);
	input.addEventListener('keyup',   onInputChange);
	input.addEventListener('keydown', onInputChange);
	input.addEventListener('paste', function()
	{
	    requestAnimationFrame(function()
	    {
	        if (input.value && !input.value.endsWith('\n'))
	        {
	            var pos = input.selectionStart;
	            input.value = input.value + '\n';
	            input.selectionStart = input.selectionEnd = pos;
	        }
	        syncHighlight('glsl-input', 'glsl-highlight');
	    });
	});

	output.addEventListener('input',   onOutputChange);
	output.addEventListener('keyup',   onOutputChange);
	output.addEventListener('keydown', onOutputChange);

	if (glslHS) { glslHS.addEventListener('scroll', onGlslHScroll); }
	if (fxHS)   { fxHS.addEventListener('scroll',   onFxHScroll);   }

	// Forward horizontal wheel on textarea to hscroll div
	input.addEventListener('wheel', function(e)
	{
	    var delta = e.deltaX !== 0 ? e.deltaX : (e.shiftKey ? e.deltaY : 0);
	    if (delta !== 0 && glslHS) { e.preventDefault(); glslHS.scrollLeft += delta; }
	}, { passive: false });
	output.addEventListener('wheel', function(e)
	{
	    var delta = e.deltaX !== 0 ? e.deltaX : (e.shiftKey ? e.deltaY : 0);
	    if (delta !== 0 && fxHS) { e.preventDefault(); fxHS.scrollLeft += delta; }
	}, { passive: false });
}

document.addEventListener('DOMContentLoaded', function()
{
	var vt = document.getElementById('version-tag');
	if (vt && typeof PORTER_VERSION !== 'undefined') { vt.textContent = 'v' + PORTER_VERSION; }
	initPasses();
	initHighlighters();
	applyTabWidth();
	initFileInput();
	requestAnimationFrame(function()
	{
	    syncHighlight('glsl-input', 'glsl-highlight');
	    syncHighlight('fx-output',  'fx-highlight');
	    autoGrow(document.getElementById('glsl-input'));
	    autoGrow(document.getElementById('fx-output'));
	    matchPaneHeights();
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// STATUS INDICATORS
// ═════════════════════════════════════════════════════════════════════════════

function setIndicator(id, state)
{
	var el = document.getElementById(id);
	if (!el) { return; }
	el.className = 'indicator ' + state;
}

function resetIndicators()
{
	setIndicator('ind-matrix',    'unlit');
	setIndicator('ind-textures',  'unlit');
	setIndicator('ind-audio',     'unlit');
	setIndicator('ind-multipass', 'unlit');
}

function updateIndicators(src, messages, channelConfig)
{
	resetIndicators();

	// Matrix math
	if (/\bmat[234]\b|\bfloat[234]x[234]\b/.test(src))
	{
	    setIndicator('ind-matrix', 'lit-amber');
	}

	// Custom textures — only when user has manually chosen Custom Texture in the UI
	var needsTexture = channelConfig.some(function(c) { return c === 'texture'; });
	if (needsTexture)
	{
	    setIndicator('ind-textures', 'lit-amber');
	}

	// Audio input — iSampleRate is the definitive Shadertoy audio uniform
	if (/\biSampleRate\b|\bmainSound\b/.test(src))
	{
	    setIndicator('ind-audio', 'lit-red');
	}
}

function copyOutput()
{
	var out = document.getElementById('fx-output').value;
	if (!out) { return; }
	navigator.clipboard.writeText(out).then(function()
	{
	    var btn         = document.getElementById('copy-btn');
	    btn.textContent = 'Copied!';
	    setTimeout(function() { btn.textContent = 'Copy'; }, 1500);
	});
}

function downloadFx()
{
	var out = document.getElementById('fx-output').value;
	if (!out) { return; }
	var filename = 'ShadertoyPort.fx';
	if (currentShaderInfo && currentShaderInfo.name)
	{
		var safeName = currentShaderInfo.name
			.replace(/[^A-Za-z0-9_]+/g, '_')
			.replace(/^_+|_+$/g, '');
		if (safeName.length > 0) { filename = safeName + '.fx'; }
	}
	downloadText(out, filename);
}

function downloadFxh()
{
	var fxhHeader =
	    '// ShadertoyHelper.fxh\n'
	  + '// GLSL compatibility helpers for ReShade FX.\n'
	  + '// Generated by Shadertoy -> ReShade FX Porter\n'
	  + '\n'
	  + '#pragma once\n'
	  + '\n';
	downloadText(fxhHeader + FXH_CONTENT, 'ShadertoyHelper.fxh');
}

function downloadText(content, filename)
{
	var blob   = new Blob([content], { type: 'text/plain' });
	var a      = document.createElement('a');
	a.href     = URL.createObjectURL(blob);
	a.download = filename;
	a.click();
	URL.revokeObjectURL(a.href);
}

// ═════════════════════════════════════════════════════════════════════════════
// EXAMPLE SHADER  — exercises most porter transforms
// ═════════════════════════════════════════════════════════════════════════════

function loadExample()
{
	var src =
'// Example: Plasma + polar coordinates\n'
+ '// Tests: iResolution, iTime, mix, clamp(x,0,1)->saturate, atan(y,x)->atan2, fract, mod\n'
+ '\n'
+ 'void mainImage( out vec4 fragColor, in vec2 fragCoord )\n'
+ '{\n'
+ '    vec2  uv    = (fragCoord * 2.0 - iResolution.xy) / iResolution.y;\n'
+ '    float t     = iTime * 0.4;\n'
+ '\n'
+ '    float angle  = atan(uv.y, uv.x);              // two-arg: porter rewrites to atan2\n'
+ '    float dist   = length(uv);\n'
+ '\n'
+ '    float rings  = sin(dist * 10.0 - t * 3.0) * 0.5 + 0.5;\n'
+ '    float spiral = fract(angle / (2.0 * 3.14159) + t * 0.1 + dist * 0.5);\n'
+ '    float bands  = mod(dist + t * 0.2, 1.0);      // mod: porter emits floor-based version\n'
+ '\n'
+ '    vec3 col = vec3(rings, spiral, bands);\n'
+ '    col      = mix(col, vec3(dist), 0.3);         // mix -> lerp (same arg order)\n'
+ '    col      = clamp(col, 0.0, 1.0);              // clamp(x,0,1) -> porter rewrites to saturate\n'
+ '\n'
+ '    fragColor = vec4(col, 1.0);\n'
+ '}\n';

	currentShaderInfo = null;
	if (passes[activePassId]) { passes[activePassId].src = src; }
	setTextarea(document.getElementById('glsl-input'), src);
	clearLog();
	log('info', 'Example shader loaded. Click Convert to port it.');
	syncHighlight('glsl-input', 'glsl-highlight');
	renderTabBar();
}
