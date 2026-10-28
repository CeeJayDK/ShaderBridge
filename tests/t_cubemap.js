// The cubemap helper must agree with the OpenGL cube map convention (face selection and the
// sc / tc / ma table of the OpenGL specification), and lay the faces out as a strip in the order
// +X, -X, +Y, -Y, +Z, -Z with every face upright (t grows downwards, so v needs no flip).
// The expected table below is written from the specification, not copied from the porter.
const porter = require('./load_porter.js')();

let bad = 0, total = 0;
function check(label, ok, detail)
{
	total++;
	if (!ok) { bad++; console.log('FAIL', label, detail ? '\n' + detail : ''); }
}
const src = porter.CUBEMAP_HELPER_SOURCE;
const flat = src.replace(/\s+/g, ' ');

// face index and the (sc, tc) pair divided by the major axis, per the OpenGL specification
const SPEC = [
	{ face: 0, name: '+X', cond: 'd.x > 0.0', uv: 'float2(-d.z, -d.y) / a.x' },
	{ face: 1, name: '-X', cond: 'd.x > 0.0', uv: 'float2(d.z, -d.y) / a.x' },
	{ face: 2, name: '+Y', cond: 'd.y > 0.0', uv: 'float2(d.x, d.z) / a.y' },
	{ face: 3, name: '-Y', cond: 'd.y > 0.0', uv: 'float2(d.x, -d.z) / a.y' },
	{ face: 4, name: '+Z', cond: 'd.z > 0.0', uv: 'float2(d.x, -d.y) / a.z' },
	{ face: 5, name: '-Z', cond: 'd.z > 0.0', uv: 'float2(-d.x, -d.y) / a.z' }
];
const tight = flat.replace(/\( /g, '(').replace(/ \)/g, ')').replace(/, /g, ', ').replace(/float2\(\s*/g, 'float2(').replace(/\s+/g, ' ');

SPEC.forEach(function (f)
{
	check('face ' + f.name + ': (sc, tc) / ma matches the OpenGL table', tight.indexOf(f.uv.replace(/\s+/g, ' ')) >= 0, tight);
});

// the face numbers: positive axis first, negative second, X then Y then Z
check('X faces are 0 and 1', /face = d\.x > 0\.0 \? 0\.0 : 1\.0;/.test(flat), flat);
check('Y faces are 2 and 3', /face = d\.y > 0\.0 \? 2\.0 : 3\.0;/.test(flat), flat);
check('Z faces are 4 and 5', /face = d\.z > 0\.0 \? 4\.0 : 5\.0;/.test(flat), flat);

// the positive axis picks the first expression of each pair, the negative axis the second
SPEC.forEach(function (f)
{
	const re = f.face % 2 === 0
		? new RegExp('\\? ' + f.uv.replace(/[()+\-*/.]/g, '\\$&').replace(/ /g, '\\s*'))
		: new RegExp(': ' + f.uv.replace(/[()+\-*/.]/g, '\\$&').replace(/ /g, '\\s*'));
	check('face ' + f.name + ' sits on the ' + (f.face % 2 === 0 ? 'true' : 'false') + ' side of its test', re.test(tight), tight);
});

// the major axis is chosen by the largest absolute component, X before Y before Z on ties
check('the major axis is the largest component, X then Y then Z on ties', /if \(a\.x >= a\.y && a\.x >= a\.z\)/.test(flat) && /else if \(a\.y >= a\.z\)/.test(flat));

// the strip: the face index is added to u, the sum is divided by six, v is used as it is
check('uv is mapped from -1..1 to 0..1', /uv = uv \* 0\.5 \+ 0\.5;/.test(flat));
check('the face is placed in the strip left to right', /uv\.x = \(uv\.x \+ face\) \* \(1\.0 \/ 6\.0\);/.test(flat));
check('v is not flipped', !/uv\.y\s*=/.test(flat));
check('the face order is documented in the helper', /Face order \(left to right\): \+X, -X, \+Y, -Y, \+Z, -Z/.test(src));

// the same convention evaluated numerically: opposite directions land in opposite faces, in the right order
function spec(d)
{
	const a = d.map(Math.abs);
	let face, sc, tc, ma;
	if (a[0] >= a[1] && a[0] >= a[2]) { face = d[0] > 0 ? 0 : 1; ma = a[0]; sc = d[0] > 0 ? -d[2] : d[2]; tc = -d[1]; }
	else if (a[1] >= a[2]) { face = d[1] > 0 ? 2 : 3; ma = a[1]; sc = d[0]; tc = d[1] > 0 ? d[2] : -d[2]; }
	else { face = d[2] > 0 ? 4 : 5; ma = a[2]; sc = d[2] > 0 ? d[0] : -d[0]; tc = -d[1]; }
	return { face: face, u: ((sc / ma + 1) / 2 + face) / 6, v: (tc / ma + 1) / 2 };
}
const axes = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
axes.forEach(function (d, i)
{
	const r = spec(d);
	check('the centre of face ' + i + ' is the middle of strip cell ' + i, r.face === i && Math.abs(r.u - (i + 0.5) / 6) < 1e-9 && Math.abs(r.v - 0.5) < 1e-9);
});
const up = spec([0, 0.5, 1]);
check('looking slightly up through +Z reads the upper half of its face', up.face === 4 && up.v < 0.5);
const right = spec([0.5, 0, 1]);
check('looking slightly right through +Z reads the right half of its face', right.face === 4 && right.u > (4 + 0.5) / 6);

console.log((total - bad) + '/' + total + ' cubemap tests OK');
process.exit(bad ? 1 : 0);
