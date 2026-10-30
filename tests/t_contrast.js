// The page has to be readable: every text colour in the stylesheet must have enough contrast (WCAG) against
// the background it sits on, and the critical styles inlined in the pages must agree with the stylesheet,
// so the page does not flash the old colours before the stylesheet has loaded.
const fs = require('fs');
const path = require('path');
const SB = require('./sb_dir.js');

let bad = 0, total = 0;
function check(label, ok, detail)
{
	total++;
	if (!ok) { bad++; console.log('FAIL', label, detail ? '\n' + detail : ''); }
}

const raw = fs.readFileSync(path.join(SB, 'ShaderBridge_porter.css'), 'utf8');
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
const vars = {};
css.replace(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g, function (m, name, value) { vars[name] = value; return m; });

function rgb(hex) { const h = hex.replace('#', ''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); }
function luminance(hex)
{
	const c = rgb(hex).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
	return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a, b)
{
	const la = luminance(a), lb = luminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function resolve(value)
{
	const v = value.trim();
	const m = /^var\(--([\w-]+)\)$/.exec(v);
	if (m) { return vars[m[1]] || null; }
	return /^#[0-9a-fA-F]{6}$/.test(v) ? v : null;
}

// every dark background the stylesheet uses
const backgrounds = new Set([vars.bg, vars.panel]);
css.replace(/background(?:-color)?\s*:\s*([^;]+);/g, function (m, v) { const c = resolve(v); if (c && luminance(c) < 0.05) { backgrounds.add(c); } return m; });
const worst = (color) => (color ? Math.min.apply(null, Array.from(backgrounds).map(b => ratio(color, b))) : 0);

check('the palette was read, including --text-faint', !!(vars.bg && vars.panel && vars['text-dim'] && vars['text-faint'] && vars.text));
check('--text-dim reaches 4.5:1 on every dark background', worst(vars['text-dim']) >= 4.5, worst(vars['text-dim']).toFixed(2));
check('--text-faint reaches 3.5:1 on every dark background', worst(vars['text-faint']) >= 3.5, worst(vars['text-faint']).toFixed(2));
check('--text-faint is dimmer than --text-dim, which is dimmer than --text', !!(vars['text-faint'] && vars['text-dim']) && luminance(vars['text-faint']) < luminance(vars['text-dim']) && luminance(vars['text-dim']) < luminance(vars.text));
check('--muted is a border colour and is never used as text', !/(?<![-\w])color\s*:\s*var\(--muted\)/.test(css));

// every rule that sets a text colour: 4.5:1 against its own background, or the panel when it has none
const faint = new Set();
css.replace(/([^{}]+)\{([^{}]*)\}/g, function (m, selector, body)
{
	const cm = /(?<![-\w])color\s*:\s*([^;]+);/.exec(body);
	if (!cm) { return m; }
	const color = resolve(cm[1]);
	if (!color || color.toLowerCase() === '#000000') { return m; } // black text sits on the bright accent fills
	const bm = /background(?:-color)?\s*:\s*([^;]+);/.exec(body);
	const background = (bm && resolve(bm[1])) || vars.panel;
	const r = ratio(color, background);
	const sel = selector.trim().replace(/\s+/g, ' ');
	if (/var\(--text-faint\)/.test(cm[1])) { faint.add(sel); check('faint text ' + sel + ' reaches 3.5:1', r >= 3.5, r.toFixed(2)); }
	else { check('text colour of ' + sel + ' reaches 4.5:1', r >= 4.5, cm[1].trim() + ' on ' + background + ' = ' + r.toFixed(2)); }
	return m;
});
check('only the intended places use the faint colour', Array.from(faint).sort().join('|') === ['.indicator', '.indicator.unlit', '.tab.empty'].sort().join('|'), Array.from(faint).join(', '));

// code colours on the editor background
['hl-comment', 'hl-type', 'hl-keyword', 'hl-intrinsic', 'hl-number', 'hl-punct'].forEach(function (cls)
{
	const m = new RegExp('\\.' + cls + '\\s*\\{\\s*color:\\s*(#[0-9a-fA-F]{6})').exec(css);
	check('code colour ' + cls + ' reaches 4.5:1 on the editor background', !!m && ratio(m[1], vars.bg) >= 4.5, m ? ratio(m[1], vars.bg).toFixed(2) : 'not found');
});

// the entry page's critical styles agree with the stylesheet
const page = fs.readFileSync(path.join(SB, 'index.html'), 'utf8');
const critical = /<style[^>]*>([\s\S]*?)<\/style>/.exec(page);
const inline = [critical ? critical[1] : ''];
check('the entry page carries critical styles', !!critical);
check('no text uses the old dim grey, in the stylesheet or in the critical styles', inline.every(s => !/(?<![-\w])color:\s*#5a6070/.test(s)) && !/(?<![-\w])color\s*:\s*#5a6070/.test(css));
check('the dropdown arrows use the dim text colour', (css.match(/fill='%23([0-9a-fA-F]{6})'/g) || []).length === 2 && (css.match(/fill='%23([0-9a-fA-F]{6})'/g) || []).every(f => f.toLowerCase().indexOf((vars['text-dim'] || '').replace('#', '').toLowerCase()) >= 0 && !!vars['text-dim']));
check('the critical styles use the stylesheet\'s dim colour', !!vars['text-dim'] && inline.every(s => s.indexOf(vars['text-dim']) >= 0));
check('the critical styles use the stylesheet\'s faint colour for the indicator', inline.every(s => /\.indicator\s*\{[^}]*color:\s*#727b8f/.test(s)) && vars['text-faint'] === '#727b8f');

console.log((total - bad) + '/' + total + ' contrast tests OK');
process.exit(bad ? 1 : 0);
