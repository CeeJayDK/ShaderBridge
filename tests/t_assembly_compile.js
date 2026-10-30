// Compile complete synthetic multipass effects, including every entry point. The single-pass
// idiom corpus cannot catch collisions introduced when independently valid passes are assembled.
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const porter = require('./load_porter.js')();

const image = 'void mainImage(out vec4 c,vec2 p) { c=vec4(gain(p.x)); }';
const cases = require('./nested_struct_cases.js').concat([
	{name:'nested_struct_multipass',sources:[1,2].map(n=>'struct Item{float x;};struct Pair{Item a,b;};void change(inout Item a,inout Item b){a.x+=1.;b.x+=2.;}\nvoid mainImage(out vec4 c,vec2 p){Pair v=Pair(Item('+n+'.),Item(4.));change(v.a,v.b);c=vec4(v.a.x,v.b.x,0.,1.);}')},
	// SM3 cannot dynamically address array elements for writes, even whole vectors.
	{name:'array_component_write',shaderModels:['50'],sources:['void mainImage(out vec4 c,vec2 p){vec4 values[16];for(int j=0;j<16;j++)values[j]=vec4(0.);for(int i=0;i<int(p.x);i++)values[i&15][i&3]+=p.y;c=values[0];}']},
	{name:'large_common_arrays',sources:Array(2).fill('const float weights[128]=float[128]('+Array.from({length:128},(_,i)=>i+'.').join(',')+');\nfloat gain(float x){return weights[int(x)&127];}\n'+image)},
	{name:'conditional_array_lengths',sources:[1,2].map(pick=>'#define PICK '+pick+'\n#if PICK==1\nconst float values[]=float[](1.,2.);\n#else\nconst float values[]=float[](1.,2.,3.);\n#endif\nfloat gain(float x){return float(values.length())+values[int(x)&1];}\n'+image)},
	{name:'buffer_mipmaps',sources:[
		'void mainImage(out vec4 c,vec2 p){float value=mod(floor(p.x)+floor(p.y),2.);c=vec4(value);}',
		'void mainImage(out vec4 c,vec2 p){float value=textureLod(iChannel0,vec2(.5),5.).r;c=abs(value-.5)<.001?vec4(0.,1.,0.,1.):vec4(1.,0.,0.,1.);}'
	],channels:[[],['bufA']],filters:[[],['mipmap']]},
	{name:'indirect_empty_sampler',sources:['vec4 fetchValue(sampler2D s,vec2 p){return textureLod(s,p,0.);}\nvoid mainImage(out vec4 c,vec2 p){vec4 v=fetchValue(iChannel1,p);c=all(equal(v,vec4(0.)))?vec4(0.,1.,0.,1.):vec4(1.,0.,0.,1.);}'],channels:[['none','none']]},
	{name:'cubemap_roundtrip',ids:['cubemapA','image'],sources:[
		'void mainCubemap(out vec4 c,in vec2 p,in vec3 o,in vec3 d){vec4 old=textureLod(iChannel0,d,0.); c=vec4(d*.5+.5,iFrame==0?0.:old.a+.01);}',
		'void mainImage(out vec4 c,vec2 p){int face=int(p.x*6./iResolution.x); vec3 d=face==0?vec3(1.,.2,.3):face==1?vec3(-1.,.2,.3):face==2?vec3(.2,1.,.3):face==3?vec3(.2,-1.,.3):face==4?vec3(.2,.3,1.):vec3(.2,.3,-1.); d=normalize(d); vec4 v=textureLod(iChannel0,d,0.); bool ok=all(lessThan(abs(v.rgb-(d*.5+.5)),vec3(.002)))&&abs(v.a-float(iFrame)*.01)<.001; c=ok?vec4(0.,1.,0.,1.):vec4(1.,0.,0.,1.);}'
	],channels:[['cubemapA'],['cubemapA']],selfRefs:[[0],[]]},
	{name:'generated_cubemap',ids:['cubemapA','image'],sources:[
		'void mainCubemap(out vec4 c,in vec2 p,in vec3 o,in vec3 d){c=vec4(d*.5+.5,1.);}',
		'void mainImage(out vec4 c,vec2 p){c=texture(iChannel0,vec3(1.,0.,0.));}'
	],channels:[['cubemapA'],['cubemapA']],selfRefs:[[0],[]]},
	{name:'nested_else_if',sources:Array(2).fill('float gain(float x){if(x<0.) {return 0.;}\n else if(x>1.) {return 1.;}\n return x;}\n'+image)},
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
]);

function build(test)
{
	const passes = test.sources.map(function (src, i)
	{
		const id = test.ids ? test.ids[i] : i === test.sources.length - 1 ? 'image' : 'bufA';
		const used = new Set(); porter.detectUniforms(src, used);
		const channels=(test.channels || [])[i] || [];
		const transformed = porter.transformGLSL(src, [], id === 'image' ? 'Image' : id === 'cubemapA' ? 'CubeA' : 'BufA', {cubemapPass:id==='cubemapA',cubemapSamplers:channels.map((kind,ch)=>kind==='cubemapA'?'iChannel'+ch:null).filter(Boolean)});
		return Object.assign({id:id, usedUniforms:used, channels:channels, channelNames:(test.channelNames || [])[i] || [], filters:(test.filters || [])[i] || ['linear'], wraps:['clamp'], vflips:[true], format:'RGBA32F', selfRefChannels:(test.selfRefs || [])[i] || []}, transformed);
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
			(test.shaderModels || (process.platform === 'win32' ? ['30','50'] : ['50'])).forEach(function (sm)
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
