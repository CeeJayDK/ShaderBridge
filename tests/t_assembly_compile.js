// Compile complete synthetic multipass effects, including every entry point. The single-pass
// idiom corpus cannot catch collisions introduced when independently valid passes are assembled.
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const porter = require('./load_porter.js')();

const image = 'void mainImage(out vec4 c,vec2 p) { c=vec4(gain(p.x)); }';
const cases = require('./nested_struct_cases.js').concat([
	{name:'commented_alias_object_matrix',sources:['#define V vec2 // alias comment\nV value;\nfloat count;mat2 basis=mat2(1.,2.,3.,4.);\n#define CHANGE (count+=1.,value*=basis)\n#define RESULT (CHANGE+vec2(1.,2.))\nvoid mainImage(out vec4 c,vec2 p){value=vec2(1.,2.);count=0.;V result=RESULT;bool ok=all(lessThan(abs(value-vec2(5.,11.)),vec2(.001)))&&all(lessThan(abs(result-vec2(6.,13.)),vec2(.001)))&&count==1.;c=ok?vec4(0.,1.,0.,1.):vec4(1.,0.,0.,1.);}']},
	// ReShade 6.8 mishandles bare do-while condition names/literals in HLSL.
	// Use a comparison rvalue here so this case isolates return-path handling.
	{name:'return_flow_control',sources:['float early(bool stop,bool repeat){do{if(stop)break;return .5;}while(repeat != false);}\nfloat once(bool repeat){do{return .75;}while(repeat != false);}\nfloat forever(){for(;;){return 1.;}}\nvoid mainImage(out vec4 c,vec2 p){bool selected=p.x<iResolution.x*.5;bool repeat=p.y<0.;bool ok=early(selected,repeat)==(selected?0.:.5)&&once(repeat)==.75&&forever()==1.;c=ok?vec4(0.,1.,0.,1.):vec4(1.,0.,0.,1.);}']},
	{name:'missing_scalar_return',sources:['float choose(int mode){if(mode==1)return .25;if(mode==2)return .75;}\nvoid mainImage(out vec4 c,vec2 p){int mode=int(p.x)%3;float expected=mode==1?.25:mode==2?.75:0.;bool ok=abs(choose(mode)-expected)<.001;c=ok?vec4(0.,1.,0.,1.):vec4(1.,0.,0.,1.);}']},
	{name:'missing_aggregate_return',sources:['vec3 choose(bool selected){if(selected)return vec3(.25,.5,.75);}\nmat2 basis(bool selected){if(selected)return mat2(1.,2.,3.,4.);}\nvoid mainImage(out vec4 c,vec2 p){bool selected=p.x<iResolution.x*.5;vec3 expected=selected?vec3(.25,.5,.75):vec3(0.);mat2 m=basis(selected);bool ok=all(lessThan(abs(choose(selected)-expected),vec3(.001)))&&m[0][1]==(selected?2.:0.)&&m[1][0]==(selected?3.:0.);c=ok?vec4(0.,1.,0.,1.):vec4(1.,0.,0.,1.);}']},
	{name:'conditional_statement_paths',sources:['void mainImage(out vec4 c,vec2 p){bool selected=p.x<iResolution.x*.5;float count=0.;vec2 v=vec2(1.,2.);for(int k=0;k<3;k++)count+=1.,k<2?count+=2.,v*=mat2(2.,0.,0.,2.):v,count+=1.;float value=0.;value=selected?count+=3.,5.:(count+=4.,7.);bool ok=all(lessThan(abs(v-vec2(4.,8.)),vec2(.001)))&&count==(selected?13.:14.)&&value==(selected?5.:7.);c=ok?vec4(0.,1.,0.,1.):vec4(1.,0.,0.,1.);}']},
	{name:'conditional_comma_matrix',sources:['void mainImage(out vec4 c,vec2 p){bool selected=p.x<iResolution.x*.5;vec2 q=vec2(1.,2.);float count=0.;selected?count+=1.,q*=mat2(1.,2.,3.,4.):q;float value=0.;selected?value=2.:value=3.;vec2 expected=selected?vec2(5.,11.):vec2(1.,2.);bool ok=all(lessThan(abs(q-expected),vec2(.001)))&&count==(selected?1.:0.)&&value==(selected?2.:3.);c=ok?vec4(0.,1.,0.,1.):vec4(1.,0.,0.,1.);}']},
	{name:'generated_volume_feedback',ids:['volumeA','image'],channels:[['volumeA'],['volumeA']],selfRefs:[[0],[]],shaderModels:['50'],sources:[
		'void mainVolume(out vec4 c,vec3 p){ivec3 q=ivec3(p);float count=iFrame==0?1.:texelFetch(iChannel0,q,0).w+1.;c=vec4(p,count);}',
		'void mainImage(out vec4 c,vec2 p){ivec3 size=textureSize(iChannel0,0);ivec3 q=ivec3(int(p.x)%size.x,int(p.y)%size.y,(int(p.x)/size.x)%size.z);vec4 v=texelFetch(iChannel0,q,0);bool ok=all(lessThan(abs(v.xyz-(vec3(q)+.5)),vec3(.001)))&&abs(v.w-float(iFrame+1))<.001&&all(equal(iChannelResolution[0],vec3(size)));c=ok?vec4(0.,1.,0.,1.):vec4(1.,0.,0.,1.);}'
	]},
	{name:'generated_volume_mipmaps',ids:['volumeA','image'],channels:[[],['volumeA']],filters:[[],['mipmap']],shaderModels:['50'],sources:[
		'void mainVolume(out vec4 c,vec3 p){c=vec4(.25,.5,.75,1.);}',
		'void mainImage(out vec4 c,vec2 p){vec4 v=textureLod(iChannel0,vec3(.5),1.);bool ok=all(lessThan(abs(v-vec4(.25,.5,.75,1.)),vec4(.001)));c=ok?vec4(0.,1.,0.,1.):vec4(1.,0.,0.,1.);}'
	]},
	{name:'volume_sampler_basic',channels:[['vol4']],sources:['vec4 readVolume(sampler3D s,vec3 p){ivec3 size=textureSize(s,0);return texture(s,p)+textureLod(s,p,0.)+textureGrad(s,p,vec3(.001,0.,0.),vec3(0.,.001,0.))+texelFetch(s,size/2,0);}\nvoid mainImage(out vec4 c,vec2 p){c=readVolume(iChannel0,vec3(p/iResolution.xy,.5));}']},
	{name:'volume_sampler_offsets',channels:[['vol4']],sources:['vec4 readVolume(sampler3D s,vec3 p){return textureOffset(s,p,ivec3(1,0,0))+texelFetchOffset(s,ivec3(0),0,ivec3(0,0,1));}\nvoid mainImage(out vec4 c,vec2 p){c=readVolume(iChannel0,vec3(p/iResolution.xy,.5));}']},
	{name:'array_type_declarators',sources:['const float[2] weights=float[2](.25,.75),other=float[2](.5,.5);\nvoid fill(out float[3] a,float value){for(int k=0;k<3;k++){a[k]=value*float(k);}}\nvoid mainImage(out vec4 c,vec2 p){float[3] a;fill(a,.25);vec4[2] colors=vec4[2](vec4(.125),vec4(.375));bool ok=weights[0]+weights[1]==1.&&other[0]+other[1]==1.&&a[2]==.5&&colors[0].x+colors[1].x==.5;c=ok?vec4(0.,1.,0.,1.):vec4(1.,0.,0.,1.);}']},
	{name:'array_write_loop',sources:['void fill(out vec4 a[4]){for(int k=0;k<4;k++){a[k].xyz=vec3(float(k));a[k].w=1.;}}\nvoid mainImage(out vec4 c,vec2 p){vec4 a[4];fill(a);bool ok=a[0].x==0.&&a[1].y==1.&&a[2].z==2.&&a[3].w==1.;c=ok?vec4(0.,1.,0.,1.):vec4(1.,0.,0.,1.);}']},
	{name:'loop_texture_helper',sources:['vec4 leaf(vec2 p){return texture(iChannel0,p);}\nvec4 middle(vec2 p){return leaf(p);}\nvoid mainImage(out vec4 c,vec2 p){vec2 uv=p/iResolution.xy;vec4 original=middle(uv);vec4 sum=vec4(0.);for(int k=0;k<8;k++){sum+=middle(uv);}vec4 expected=textureLod(iChannel0,uv,0.)*8.;bool ok=all(lessThan(abs(sum-expected),vec4(.001)))&&all(lessThan(abs(original-texture(iChannel0,uv)),vec4(.001)));c=ok?vec4(0.,1.,0.,1.):vec4(1.,0.,0.,1.);}'],channels:[['backbuffer']]},
	{name:'void_parameter_list',sources:['float base(void);\nfloat value(void){return base()+.25;}\nfloat base(void){return .5;}\nvoid mainImage(out vec4 c,vec2 p){c=value()==.75?vec4(0.,1.,0.,1.):vec4(1.,0.,0.,1.);}']},
	{name:'mixed_comment_delimiters',sources:Array(2).fill('// /* disabled note\nvec3 helper(vec2 p){return vec3(p,.25);}\n/* real block */\nvoid mainImage(out vec4 c,vec2 p){vec3 v=helper(vec2(.5,.75));bool ok=all(equal(v,vec3(.5,.75,.25)));c=ok?vec4(0.,1.,0.,1.):vec4(1.,0.,0.,1.);}')},
	{name:'numeric_out_path',sources:['float choose(float x,out vec4 payload){if(x<.5)return 0.;payload.x=.25;return 1.;}\nvoid mainImage(out vec4 c,vec2 p){vec4 payload;float tag=choose(fract(p.x*.01),payload);bool ok=tag==0.||payload.x==.25;c=ok?vec4(0.,1.,0.,1.):vec4(1.,0.,0.,1.);}']},
	{name:'aggregate_out_path',sources:['struct Info{vec2 offset;float gain;};bool choose(float x,inout float count,out mat2 basis,out Info data,out int label){count+=2.;if(x<.5)return false;basis=mat2(1.);data=Info(vec2(2.,3.),4.);label=7;return true;}\nvoid mainImage(out vec4 c,vec2 p){float count=3.;mat2 basis;Info data;int label;bool selected=choose(fract(p.x*.01),count,basis,data,label);bool ok=count==5.&&(!selected||(basis[0][0]==1.&&basis[0][1]==0.&&data.offset.y==3.&&data.gain==4.&&label==7));c=ok?vec4(0.,1.,0.,1.):vec4(1.,0.,0.,1.);}']},
	{name:'array_out_parameter',sources:['void fill(out vec2 values[2]){values[0]=vec2(1.,2.);values[1]=vec2(3.,4.);}\nvoid mainImage(out vec4 c,vec2 p){vec2 values[2];fill(values);bool ok=values[0].y==2.&&values[1].x==3.;c=ok?vec4(0.,1.,0.,1.):vec4(1.,0.,0.,1.);}']},
	{name:'conditional_out_struct',sources:[1,0].map(pick=>'#define PICK '+pick+'\n#if PICK\nstruct Info{float a;};\n#else\nstruct Info{float b;};\n#endif\nvoid fill(out Info data){\n#if PICK\n data.a=1.;\n#else\n data.b=2.;\n#endif\n}\nvoid mainImage(out vec4 c,vec2 p){Info data;fill(data);c=vec4(0.,1.,0.,1.);}')},
	{name:'custom_saturate_helper',sources:['float saturate(float x){return clamp(x*.25,0.0,1.0);}\nvoid mainImage(out vec4 c,vec2 p){vec3 value=vec3(-1.,.5,2.);vec3 actual=clamp(value,0.0,1.0);bool ok=all(equal(actual,vec3(0.,.5,1.)))&&saturate(2.)==.5;c=ok?vec4(0.,1.,0.,1.):vec4(1.,0.,0.,1.);}']},
	{name:'vector_component_write',sources:['float calls=0.;float nextValue(){calls+=1.;return 4.;}\nvoid mainImage(out vec4 c,vec2 p){vec4 v=vec4(0.);for(int k=0;k<4+min(iFrame,0);k++){if(k>=3)break;float t=0.;for(int j=0;j<2+min(iFrame,0);j++)t+=.5;v[k]=float(k+1)*t;}bool ok=all(equal(v,vec4(1.,2.,3.,0.)));int index=0;float value=(v[index++]=nextValue());ok=ok&&index==1&&calls==1.&&value==4.&&v.x==4.;c=ok?vec4(0.,1.,0.,1.):vec4(1.,0.,0.,1.);}']},
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
		const transformed = porter.transformGLSL(src, [], id === 'image' ? 'Image' : id === 'cubemapA' ? 'CubeA' : id === 'volumeA' ? 'VolumeA' : 'BufA', {cubemapPass:id==='cubemapA',volumePass:id==='volumeA',volumeSamplers:channels.map((kind,ch)=>['volumeA','vol1','vol4'].includes(kind)?'iChannel'+ch:null).filter(Boolean),cubemapSamplers:channels.map((kind,ch)=>kind==='cubemapA'?'iChannel'+ch:null).filter(Boolean)});
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
				const entries = Array.from(front.stdout.matchAll(/^\s+(\w+) \((?:pixel|vertex|compute)\)/gm), m=>m[1]);
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
