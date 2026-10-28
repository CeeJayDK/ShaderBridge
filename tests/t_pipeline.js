// transformGLSL is a list of named steps (TRANSFORM_STEPS). The order of some of them matters, and
// that knowledge is written down in the list (after / why) and checked, not left to comments.
const porter = require('./load_porter.js')();

let bad = 0, total = 0;
function check(label, ok, detail)
{
	total++;
	if (!ok) { bad++; console.log('FAIL', label, detail ? '\n' + detail : ''); }
}
const steps = porter.TRANSFORM_STEPS;
const names = steps.map(s => s.name);
const index = (n) => names.indexOf(n);

check('the list has steps', steps.length > 30, String(steps.length));
check('every step has a unique name and a function of the pass', new Set(names).size === names.length && steps.every(s => typeof s.run === 'function' && s.run.length === 1));
check('the real order has no problems', porter.checkTransformPipeline().length === 0, porter.checkTransformPipeline().join('\n'));
check('comments are taken out first and put back last', names[0] === 'extractComments' && names[names.length - 1] === 'restoreComments');

// What is known about the order, written down here independently of the list itself. Each pair is
// [earlier, later, why]. The list must agree with all of them.
const KNOWN = [
	['typeNames', 'structConstructors', 'a struct constructor helper needs member types in HLSL form'],
	['typeNames', 'matrixMul', 'the expression tree reads HLSL type names'],
	['arrayConstructors', 'matrixMul', 'the expression tree cannot read type[N](...)'],
	['arrayConstructors', 'vectorConstructorArgs', 'the expression tree cannot read type[N](...)'],
	['arrayConstructors', 'broadcastConstructors', 'the expression tree cannot read type[N](...)'],
	['arrayConstructors', 'diagonalMatrices', 'the expression tree cannot read type[N](...)'],
	['arrayConstructors', 'textureVariants', 'the expression tree cannot read type[N](...)'],
	['textureCalls', 'cubemapLookups', 'it looks for the tex2D calls texture() becomes'],
	['textureLod', 'cubemapLookups', 'it looks for the tex2Dlod calls textureLod() becomes'],
	['cubemapSamples', 'loopGradientTex', 'calls made in loops by the cubemap steps must be promoted'],
	['cubemapLookups', 'loopGradientTex', 'calls made in loops by the cubemap steps must be promoted'],
	['textureCalls', 'loopGradientTex', 'calls made in loops by texture() must be promoted'],
	['clampToSaturate', 'dropIntrinsicMacros', 'the clamp rewrite turns a saturate macro into one that calls itself'],
	['mainImageSignature', 'mainImageBody', 'the body rewrite needs the parameter names'],
	['constToStaticConst', 'hoistGlobalInits', 'it looks for static declarations'],
	['staticGlobals', 'hoistGlobalInits', 'it looks for static declarations'],
	['glslBuiltins', 'glslHelpers', 'helpers are added for what the finished source calls'],
	['glFragCoord', 'fragCoordDeclaration', 'it reads the flag that step sets'],
	['typeNames', 'reorderFunctions', 'the analysis reads HLSL type names'],
	['extractComments', 'splitGlobalDeclarators', 'it moves comment placeholders'],
	['splitGlobalDeclarators', 'constToStaticConst', 'it looks for one variable per declaration'],
	['splitGlobalDeclarators', 'constInitialisers', 'it looks for one variable per declaration'],
	['splitGlobalDeclarators', 'staticGlobals', 'it looks for one variable per declaration'],
	['arrayConstructors', 'arrayLength', 'it counts the braced initialisers that step produces'],
	['textureCalls', 'emptyChannels', 'it looks for the tex2D calls texture() becomes'],
	['textureLod', 'emptyChannels', 'it looks for the tex2Dlod calls textureLod() becomes'],
	['texelFetch', 'emptyChannels', 'it looks for the tex2Dfetch calls texelFetch() becomes'],
	['typeNames', 'vectorEquality', 'the expression tree reads HLSL type names'],
	['arrayConstructors', 'vectorEquality', 'the expression tree cannot read type[N](...)'],
	['vectorEquality', 'glslBuiltins', 'equal() becomes a component-wise == on purpose; only the shader\'s own comparisons may be wrapped']
];
KNOWN.forEach(function (k)
{
	check('"' + k[0] + '" runs before "' + k[1] + '" (' + k[2] + ')', index(k[0]) >= 0 && index(k[1]) >= 0 && index(k[0]) < index(k[1]));
});
check('every known pair is also declared in the list, with a reason', KNOWN.every(function (k)
{
	const later = steps[index(k[1])];
	return later && (later.after || []).indexOf(k[0]) >= 0 && later.why;
}), KNOWN.filter(k => !((steps[index(k[1])].after || []).indexOf(k[0]) >= 0)).map(k => k.join(' < ')).join(', '));

// the check notices what is wrong
const copy = () => steps.map(s => Object.assign({}, s));
function problemsAfter(edit)
{
	const list = copy();
	edit(list);
	return porter.checkTransformPipeline(list);
}
function swap(list, a, b) { const i = list.findIndex(s => s.name === a), j = list.findIndex(s => s.name === b); const t = list[i]; list[i] = list[j]; list[j] = t; }
let p = problemsAfter(l => swap(l, 'typeNames', 'structConstructors'));
check('a step moved before the one it needs is reported', p.some(x => /structConstructors.*must come after "typeNames"/.test(x)), p.join('\n'));
p = problemsAfter(l => swap(l, 'cubemapLookups', 'loopGradientTex'));
check('moving the loop rewrite before the cubemap steps is reported', p.some(x => /loopGradientTex.*must come after "cubemapLookups"/.test(x)), p.join('\n'));
p = problemsAfter(l => { l.push(Object.assign({}, l[3])); });
check('a repeated step is reported', p.some(x => /appears twice/.test(x)));
p = problemsAfter(l => { l.find(s => s.name === 'matrixMul').after = ['noSuchStep']; });
check('a constraint on a step that does not exist is reported', p.some(x => /noSuchStep.*does not exist/.test(x)));
p = problemsAfter(l => { delete l.find(s => s.name === 'matrixMul').why; });
check('an order that matters without a reason is reported', p.some(x => /matrixMul.*gives no reason/.test(x)));
p = problemsAfter(l => { l.find(s => s.name === 'floatSuffix').run = null; });
check('a step with nothing to run is reported', p.some(x => /floatSuffix.*nothing to run/.test(x)));
p = problemsAfter(l => { swap(l, 'extractComments', 'removeDirectives'); });
check('comments must be taken out first', p.some(x => /first step must be "extractComments"/.test(x)));
p = problemsAfter(l => { swap(l, 'restoreComments', 'glslHelpers'); });
check('comments must be put back last', p.some(x => /last step must be "restoreComments"/.test(x)));

// the pipeline runs every step once, in the order of the list, and refuses a broken order
const SRC = 'void mainImage(out vec4 O, in vec2 U)\n{\n\tO = vec4(U, 0., 1.);\n}\n';
const ran = [];
const originals = steps.map(s => s.run);
steps.forEach(function (s, i) { s.run = function (ctx) { ran.push(s.name); return originals[i](ctx); }; });
let result = {};
let pipelineError = '';
try { result = porter.transformGLSL(SRC, [], 'Image'); }
catch (e) { pipelineError = e.message; }
finally { steps.forEach(function (s, i) { s.run = originals[i]; }); }
check('every step ran exactly once, in the order of the list', ran.join() === names.join(), pipelineError || ran.join());
check('the entry point parameters are handed back', result.outVar === 'O' && result.coordVar === 'U' && result.mainImageName === 'mainImage_Image');

const savedFirst = steps[2];
steps[2] = steps[3]; steps[3] = savedFirst;          // precision <-> glFragCoord: harmless
steps[0] = steps.splice(1, 1, steps[0])[0];          // extractComments no longer first
let message = '';
try { porter.transformGLSL(SRC, [], 'Image'); } catch (e) { message = e.message; }
steps[0] = steps.splice(1, 1, steps[0])[0];
steps[3] = steps[2]; steps[2] = savedFirst;
check('a broken order stops the pipeline with a readable message', /order of the transform steps is wrong/.test(message) && /extractComments/.test(message), message);
check('the list is back as it was', porter.checkTransformPipeline().length === 0 && steps.map(s => s.name).join() === names.join());

// state that steps share through the pass
const messages = [];
let r2 = { src: '', globalInits: [] };
try { r2 = porter.transformGLSL('// vec3 mix(a, b) stays as it is\n/* and so does vec2 */\nfloat tau = atan(1.0) * 8.0;\nvoid mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = vec4(gl_FragCoord.xy, 0., 1.);\n}\n', messages, 'Image'); }
catch (e) { check('the shared-state example runs', false, e.message); }
check('comments come back exactly as they were', r2.src.indexOf('// vec3 mix(a, b) stays as it is') >= 0 && r2.src.indexOf('/* and so does vec2 */') >= 0, r2.src);
check('a function call in a global initialiser is handed back for the entry point', r2.globalInits.length === 1 && /^tau = atan\(1\.0\) \* 8\.0;$/.test(r2.globalInits[0]), JSON.stringify(r2.globalInits));
check('the gl_FragCoord flag reaches the declaration step', /^static float4 ST_FragCoord;/.test(r2.src));
let names2 = '';
try { names2 = porter.transformGLSL(SRC, [], 'BufA').mainImageName + ' ' + porter.transformGLSL(SRC, [], '').mainImageName; }
catch (e) { names2 = e.message; }
check('two passes do not share anything', names2 === 'mainImage_BufA mainImage', names2);


// Every step has to prove that it does something: on a small shader of its own it changes the source
// (or, for a step that only passes on information, changes the pass). A step that is skipped or never
// exercised is found here.
const EXAMPLES = {
	extractComments: '// a comment\nvoid mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = vec4(0.);\n}\n',
	removeDirectives: '#version 300 es\nvoid mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = vec4(0.);\n}\n',
	precision: 'precision highp float;\nvoid mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = vec4(0.);\n}\n',
	glFragCoord: 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = vec4(gl_FragCoord.xy, 0., 1.);\n}\n',
	uniformRedeclarations: 'uniform vec3 iResolution;\nvoid mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = vec4(0.);\n}\n',
	floatSuffix: 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfloat a = 1.0f;\n\tfragColor = vec4(a);\n}\n',
	typeNames: 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tvec3 c = vec3(0.);\n\tfragColor = vec4(c, 1.);\n}\n',
	structConstructors: 'struct S { float a; float b; };\nvoid mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tS s = S(1., 2.);\n\tfragColor = vec4(s.a, s.b, 0., 1.);\n}\n',
	intrinsicNames: 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = vec4(mix(0., 1., 0.5));\n}\n',
	reservedIdentifiers: 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfloat half = 1.0;\n\tfragColor = vec4(half);\n}\n',
	splitGlobalDeclarators: 'float a = 1.0, b = 2.0;\nvoid mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = vec4(a, b, 0., 1.);\n}\n',
	constToStaticConst: 'const float K = 1.0;\nvoid mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = vec4(K);\n}\n',
	constInitialisers: 'const float PI = acos(-1.0);\nvoid mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = vec4(PI);\n}\n',
	staticGlobals: 'float G = 1.0;\nvoid mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = vec4(G);\n}\n',
	unreachableCode: 'float f()\n{\n\treturn 1.0;\n\treturn 2.0;\n}\nvoid mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = vec4(f());\n}\n',
	arrayConstructors: 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfloat a[3] = float[3](1., 2., 3.);\n\tfragColor = vec4(a[0]);\n}\n',
	arrayLength: 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfloat a[3] = float[3](1., 2., 3.);\n\tfragColor = vec4(float(a.length()));\n}\n',
	matrixMul: 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tmat2 m = mat2(1., 0., 0., 1.);\n\tvec2 v = m * fragCoord;\n\tfragColor = vec4(v, 0., 1.);\n}\n',
	vectorConstructorArgs: 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tvec4 q = vec4(1., 2., 3., 4.);\n\tvec3 c = vec3(q);\n\tfragColor = vec4(c, 1.);\n}\n',
	broadcastConstructors: 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tvec3 c = vec3(0.5);\n\tfragColor = vec4(c, 1.);\n}\n',
	diagonalMatrices: 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tmat3 m = mat3(1.0);\n\tfragColor = vec4(m[0], 1.);\n}\n',
	textureVariants: 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tvec3 p = vec3(fragCoord, 1.);\n\tfragColor = textureProj(iChannel0, p);\n}\n',
	vectorEquality: 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tvec3 v = vec3(fragCoord, 1.);\n\tif (v == vec3(0.))\n\t{\n\t\tfragColor = vec4(1.);\n\t}\n\telse\n\t{\n\t\tfragColor = vec4(0.);\n\t}\n}\n',
	castsOnVectors: 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tint a = int(fragCoord.xy);\n\tfragColor = vec4(float(a));\n}\n',
	atan2: 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = vec4(atan(fragCoord.y, fragCoord.x));\n}\n',
	textureCalls: 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = texture(iChannel0, fragCoord);\n}\n',
	textureGrad: 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = textureGrad(iChannel0, fragCoord, vec2(0.), vec2(0.));\n}\n',
	textureLod: 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = textureLod(iChannel0, fragCoord, 1.0);\n}\n',
	texelFetch: 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = texelFetch(iChannel0, ivec2(fragCoord), 0);\n}\n',
	glslBuiltins: 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tbvec2 b = lessThan(fragCoord, vec2(1.));\n\tfragColor = vec4(vec2(b), 0., 1.);\n}\n',
	switchBreaks: 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tswitch (1)\n\t{\n\tcase 1:\n\t\tfragColor = vec4(1.);\n\t\tbreak;\n\tdefault:\n\t\tfragColor = vec4(0.);\n\t}\n}\n',
	cubemapSamples: 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = textureCube(iChannel0, vec3(fragCoord, 1.));\n}\n',
	cubemapLookups: 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tvec3 d = vec3(fragCoord, 1.);\n\tfragColor = texture(iChannel0, d);\n}\n',
	emptyChannels: 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = texture(iChannel3, fragCoord / iResolution.xy);\n}\n',
	clampToSaturate: 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = vec4(clamp(fragCoord.x, 0.0, 1.0));\n}\n',
	mainImageSignature: 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = vec4(0.);\n}\n',
	mainImageBody: 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = vec4(0.);\n}\n',
	indentation: 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n    fragColor = vec4(0.);\n}\n',
	allmanBraces: 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = vec4(0.);\n\tif (fragCoord.x > 1.) {\n\t\tfragColor = vec4(1.);\n\t}\n}\n',
	loopGradientTex: 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tvec4 c = vec4(0.);\n\tfor (int i = 0; i < 2; i++)\n\t{\n\t\tc += texture(iChannel0, fragCoord);\n\t}\n\tfragColor = c;\n}\n',
	dropIntrinsicMacros: '#define saturate(x) clamp(x, 0.0, 1.0)\nvoid mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = vec4(saturate(fragCoord.x));\n}\n',
	hoistGlobalInits: 'float tau = atan(1.0) * 8.0;\nvoid mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = vec4(tau);\n}\n',
	reorderFunctions: 'float f(float x);\nvoid mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = vec4(f(1.));\n}\nfloat f(float x)\n{\n\treturn x;\n}\n',
	glslHelpers: 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tmat2 i = inverse(mat2(1., 0., 0., 1.));\n\tfragColor = vec4(i[0], i[1]);\n}\n',
	fragCoordDeclaration: 'void mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = vec4(gl_FragCoord.xy, 0., 1.);\n}\n',
	restoreComments: '// a comment\nvoid mainImage(out vec4 fragColor, in vec2 fragCoord)\n{\n\tfragColor = vec4(0.);\n}\n'
};
check('there is an example for every step and for nothing else', names.every(n => EXAMPLES[n]) && Object.keys(EXAMPLES).every(n => names.indexOf(n) >= 0), names.filter(n => !EXAMPLES[n]).join(', '));
names.forEach(function (name)
{
	const example = EXAMPLES[name];
	if (!example) { return; }
	let changed = false;
	const saved = steps.map(s => s.run);
	steps.forEach(function (s, i)
	{
		if (s.name !== name) { return; }
		s.run = function (ctx)
		{
			const before = ctx.src;
			const flag = ctx.usesGlFragCoord;
			saved[i](ctx);
			changed = ctx.src !== before || ctx.usesGlFragCoord !== flag;
		};
	});
	try { porter.transformGLSL(example, [], 'Image', { cubemapSamplers: ['iChannel0'], emptySamplers: ['iChannel3'] }); }
	catch (e) { check('step ' + name + ': its example runs', false, e.message); }
	finally { steps.forEach(function (s, i) { s.run = saved[i]; }); }
	check('step ' + name + ' does something on its example', changed);
});

console.log((total - bad) + '/' + total + ' pipeline tests OK');
process.exit(bad ? 1 : 0);
