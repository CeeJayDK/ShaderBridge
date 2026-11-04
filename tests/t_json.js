// Shadertoy JSON import: buffer passes are found by name in every export style, or by their fixed
// output IDs, and sampler settings are read whether they are strings or booleans.
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

console.log((total - bad) + '/' + total + ' json import tests OK');
process.exit(bad ? 1 : 0);
