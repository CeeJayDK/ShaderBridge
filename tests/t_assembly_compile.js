// Compile complete synthetic multipass effects, including every entry point. The single-pass
// idiom corpus cannot catch collisions introduced when independently valid passes are assembled.
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const porter = require('./load_porter.js')();

const image = 'void mainImage(out vec4 c,vec2 p) { c=vec4(gain(p.x)); }';
const cases = [
	{name:'macro_context', sources:[
		'#define GAIN 0.25\nfloat gain(float x) { return GAIN; }\n'+image,
		'#define GAIN 0.75\nfloat gain(float x) { return GAIN; }\n'+image]},
	{name:'indented_common', sources:Array(2).fill('  float first;\n  float value;\n  float gain(float x) { return x; }\nvoid mainImage(out vec4 c,vec2 p) { value=gain(p.x); c=vec4(value); }')},
	{name:'comment_braces', sources:Array(2).fill('float gain(float x) { // } is a comment\n return x;\n}\n'+image)},
	{name:'channel_resolution', sources:Array(2).fill('vec2 extent=normalize(iChannelResolution[0].xy);\nvec2 dimensions() { return iChannelResolution[0].xy; }\nvoid mainImage(out vec4 c,vec2 p) { c=vec4(dimensions()+extent,0.,1.); }'), channels:[['texture'],['texture']], channelNames:[['London'],['Blue Noise']]},
	{name:'global_texture_initializer', sources:Array(2).fill('vec4 initial=texture(iChannel0,vec2(0.));\nvoid mainImage(out vec4 c,vec2 p) { c=initial; }'), channels:[['texture'],['texture']], channelNames:[['London'],['Blue Noise']]},
	{name:'sampler_macro_alias', sources:Array(2).fill('#define INPUT iChannel0\nvoid mainImage(out vec4 c,vec2 p) { c=texture(INPUT,p); }'), channels:[['texture'],['texture']], channelNames:[['London'],['Blue Noise']]},
	{name:'header_comment', sources:['void mainImage(out vec4 c,vec2 p) { c=vec4(1.); }'], info:{name:'Synthetic */ title',username:'Synthetic */ artist',description:'Description with */ inside.'}},
	// Expected render: solid green. Tests macro isolation, initializer resource renaming,
	// per-pass resolution arrays, definition order, and milliseconds-to-seconds conversion.
	{name:'semantic_probe', sources:[
		'#define GAIN 0.25\nfloat gain(float x) { return GAIN; }\nvec2 dimensions() { return iChannelResolution[0].xy; }\nvoid mainImage(out vec4 c,vec2 p) { c=vec4(gain(p.x)+0.*dimensions().x); }',
		'vec2 MAKE(float x) { return vec2(x,x+1.); }\nvec2 before(float x) { return MAKE(x); }\n#define MAKE(x) vec2(x)\n#define GAIN 0.75\nfloat gain(float x) { return GAIN; }\nvec2 dimensions() { return iChannelResolution[0].xy; }\nvec4 initial=texture(iChannel0,vec2(0.5));\nvoid mainImage(out vec4 c,vec2 p) { vec2 q=before(p.x); float error=abs(gain(p.x)-0.75)+abs(initial.x-0.25)+abs((q.y-q.x)-1.)+abs(iTimeDelta*iFrameRate-1.)+abs(dimensions().x-iResolution.x); c=error<0.001?vec4(0.,1.,0.,1.):vec4(1.,0.,0.,1.); }'
	],channels:[['backbuffer'],['bufA']]}
];

function build(test)
{
	const passes = test.sources.map(function (src, i)
	{
		const id = i === test.sources.length - 1 ? 'image' : 'bufA';
		const used = new Set(); porter.detectUniforms(src, used);
		const transformed = porter.transformGLSL(src, [], id === 'image' ? 'Image' : 'BufA');
		return Object.assign({id:id, usedUniforms:used, channels:(test.channels || [])[i] || [], channelNames:(test.channelNames || [])[i] || [], filters:['linear'], wraps:['clamp'], vflips:[true], format:'RGBA32F', selfRefChannels:[]}, transformed);
	});
	return porter.assembleFxFile(passes, true, [], test.info || {name:test.name,username:'Synthetic regression'});
}

function run()
{
	const cli = process.env.RESHADEFX_CLI;
	if (!cli || !fs.existsSync(cli)) { console.log('SKIP assembly compiler: set RESHADEFX_CLI'); return; }
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shaderbridge-assembly-'));
	let failures = 0;
	cases.forEach(function (test)
	{
		try
		{
			const file = path.join(directory, test.name + '.fx');
			fs.writeFileSync(file, build(test));
			(process.platform === 'win32' ? ['30','50'] : ['50']).forEach(function (sm)
			{
				const front = spawnSync(cli, ['--shader-model',sm,'--list-entry-points',file], {encoding:'utf8',timeout:60000});
				if (front.status !== 0) { throw new Error(front.stdout + front.stderr); }
				const entries = Array.from(front.stdout.matchAll(/^\s+(\w+) \((?:pixel|vertex)\)/gm), m=>m[1]);
				if (!entries.length) { throw new Error('Compiler returned no entry points'); }
				entries.forEach(function (entry)
				{
					const result = spawnSync(cli, ['--dxbc','--shader-model',sm,'-E',entry,'-Fo',path.join(directory,'shader.bin'),file], {encoding:'utf8',timeout:60000});
					if (result.status !== 0) { throw new Error('SM'+sm+' '+entry+': '+result.stdout+result.stderr); }
				});
			});
		}
		catch (error) { failures++; console.log('FAIL '+test.name+': '+error.message); }
	});
	console.log((cases.length-failures)+'/'+cases.length+' complete effects compile for every entry point');
	if (failures) { console.log('Failed effects kept at '+directory); process.exitCode=1; }
	else { fs.rmSync(directory, {recursive:true,force:true}); }
}

module.exports = {cases,build};
if (require.main === module) { run(); }
