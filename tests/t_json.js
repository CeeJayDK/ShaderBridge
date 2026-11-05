// Shadertoy JSON import: an API response or an array is unwrapped, buffer passes are found by name in
// every export style or by their fixed output IDs, and sampler settings are read as strings or booleans.
const vm = require('vm');
const fs = require('fs');
const porter = require('./load_porter.js')();
vm.runInContext(fs.readFileSync(require('./sb_dir.js') + '/ShaderBridge_json.js', 'utf8'), porter);
porter.makeChannel = function (type) { return { type: type }; };

let bad = 0, total = 0;
function check(label, ok, detail)
{
	total++;
	if (!ok) { bad++; console.log('FAIL', label, detail ? '\n   ' + detail : ''); }
}
const slot = (name, id) => porter.shadertoyBufferSlot({ name: name, outputs: id === undefined ? [] : [{ id: id, channel: 0 }] });
check('current export names', slot('Buffer A') === 'bufA' && slot('Buffer D') === 'bufD');
check('older "Buf A" names', slot('Buf A') === 'bufA' && slot('Buf C') === 'bufC');
check('names in another case and spacing', slot('buffer b') === 'bufB' && slot('BufB') === 'bufB');
check('an unnamed pass is found by its string output ID', slot('', 'XsXGR8') === 'bufB' && slot(undefined, 'XdfGR8') === 'bufD');
check('an unnamed pass is found by its numeric output ID', slot('', 257) === 'bufA' && slot('', '260') === 'bufD');
check('an unknown pass has no slot', slot('Something', 'abc') === null && slot('Image', '4dfGRr') === null);
const flipped = (vflip) => porter.resolveJsonInput({ type: 'texture', filepath: '', sampler: { vflip: vflip } }, {}, 'image').ch.vflip;
check('vflip as a string', flipped('true') === true && flipped('false') === false);
check('vflip as a boolean', flipped(true) === true && flipped(false) === false);

const logs = [];
porter.log = function (level, text) { logs.push(level + ': ' + text); };
const inner = { info: { name: 'x' }, renderpass: [] };
check('a shader as the Shadertoy API returns it', porter.unwrapShadertoyJson({ Shader: inner }) === inner);
check('a plain export is unchanged', porter.unwrapShadertoyJson(inner) === inner);
check('the first shader of an array, with a warning when there are more', porter.unwrapShadertoyJson([{ Shader: inner }, {}]) === inner && logs.length === 1 && /2 shaders/.test(logs[0]), JSON.stringify(logs));
check('something else stays something else', porter.unwrapShadertoyJson(null) === null && porter.unwrapShadertoyJson([]) === undefined);
console.log((total - bad) + '/' + total + ' json import tests OK');
process.exit(bad ? 1 : 0);
