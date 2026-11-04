// Check the packaging catalog against the actual FX resource declarations.
const assert = require('assert');
const catalog = require('./texture_manifest.json');
const porter = require('../tests/load_porter.js')();
for (const asset of catalog.assets) {
	const kind = asset.kind === 'volume' ? (asset.channels === 1 ? 'vol1' : 'vol4') : asset.kind;
	const fx = porter.buildSamplerBlock([kind], [0], {}, [], {}, [asset.name]);
	assert(fx.includes('source = "' + asset.filename + '"'), asset.name + ': filename');
	for (const [field, value] of [['Width',asset.width],['Height',asset.height],['Depth',asset.depth],['Format',asset.format]]) {
		if (value !== undefined) assert(new RegExp(field + '\\s*=\\s*' + value + '\\s*;').test(fx), asset.name + ': ' + field);
	}
}
console.log(catalog.assets.length + '/' + catalog.assets.length + ' texture declarations match the packaging catalog');
