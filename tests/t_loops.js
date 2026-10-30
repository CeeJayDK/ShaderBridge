// Synthetic loop cases only; real Shadertoy exports and conversions stay outside the repository.
const porter = require('./load_porter.js')();
let bad = 0, total = 0;
function check(label, ok)
{
	total++;
	if (!ok) { bad++; console.log('FAIL ' + label); }
}
function hint(src)
{
	const ctx = { src: src };
	porter.stepD3D9ForLoops(ctx);
	return ctx.src;
}
const directive = '\n#if __RENDERER__ == 0x9000\n[loop]\n#endif\n';
const count = src => (src.match(/\[loop\]/g) || []).length;
check('braced for loop is guarded for DX9', hint('for (int k = 0; k < 8; k++) { x += k; }') === directive + 'for (int k = 0; k < 8; k++) { x += k; }');
check('an unbraced comma-expression body stays intact', hint('for (int k = 0; k < 8; k++) x += k, y *= x;') === directive + 'for (int k = 0; k < 8; k++) x += k, y *= x;');
check('nested for loops both receive hints', count(hint('for (;;) for (;;) x++;')) === 2);
check('a for loop used as an if body stays a single statement', hint('if (x) for (;;) x--; else x++;') === 'if (x) ' + directive + 'for (;;) x--; else x++;');
const comments = '// for (;;)\n/* for (;;) */\n#define NAME before\nfloat before;';
check('comments, macro lines and substrings stay unchanged', hint(comments) === comments);
check('a comment between for and its header is accepted', count(hint('for /* counter */ (int k = 0; k < 8; k++) x++;')) === 1);
check('an explicit unroll attribute is respected', hint('[unroll] for (;;) x++;') === '[unroll] for (;;) x++;');
check('an explicit loop attribute is respected', hint('[loop] for (;;) x++;') === '[loop] for (;;) x++;');
check('constant loops exceeding SM3 limits are left available for unrolling', hint('for (int k = 0; k < 256; k++) x++;') === 'for (int k = 0; k < 256; k++) x++;');
check('running the hint step twice does not duplicate attributes', hint(hint('for (;;) x++;')) === hint('for (;;) x++;'));
check('a do-while tail never gets a for-loop hint', hint('do { x++; } while (x < 8);') === 'do { x++; } while (x < 8);');
const messages = [];
const src = 'float f(float x);\nvoid mainImage(out vec4 c, vec2 p) { for (int k = 0; k < 8; k++) p.x = f(p.x); c = vec4(p, 0., 1.); }\nfloat f(float x) { return x * 0.5; }';
const result = porter.transformGLSL(src, messages, 'Image').src;
check('function dependencies are resolved before hints are inserted', result.indexOf('float f(float x)\n') < result.indexOf('void mainImage_Image') && !messages.some(m => m.level === 'warn' && /#if/.test(m.text)));
check('the pipeline adds a guarded hint', result.indexOf(directive) >= 0);
const sampling = 'float4 leaf(float2 p){return tex2D(iChannel0,p);}\nfloat4 middle(float2 p){return leaf(p);}\nvoid mainImage(float2 p,out float4 c){c=middle(p);for(int k=0;k<8;k++){c+=middle(p+float(k));}}';
const sampled = porter.rewriteLoopGradientTex(sampling, []);
check('loop helper calls use a specialized version', sampled.includes('c+=ST_loop_middle(p+float(k))'));
check('calls outside loops retain implicit derivatives', sampled.includes('c=middle(p);') && sampled.includes('float4 leaf(float2 p){return tex2D(iChannel0,p);}'));
check('nested helpers are specialized transitively', sampled.includes('float4 ST_loop_middle(float2 p){return ST_loop_leaf(p);}'));
check('only specialized texture helpers use explicit LOD', sampled.includes('float4 ST_loop_leaf(float2 p){return tex2Dlod(iChannel0, float4(p, 0.0, 0.0));}'));
const collision = porter.rewriteLoopGradientTex('float ST_loop_leaf;\n'+sampling, []);
check('specialized helper names avoid existing identifiers', collision.includes('float4 ST_loop_leaf_(float2 p)'));
const overloads = porter.rewriteLoopGradientTex('float4 leaf(float2 p){return tex2D(iChannel0,p);}\nfloat4 leaf(float p){return leaf(float2(p,p));}\nvoid mainImage(float2 p,out float4 c){for(int k=0;k<8;k++){c+=leaf(p.x);}}', []);
check('all overloads remain available to specialized callers', overloads.includes('float4 ST_loop_leaf(float2 p)') && overloads.includes('float4 ST_loop_leaf(float p){return ST_loop_leaf(float2(p,p));}'));
const explicit = 'float4 leaf(float2 p){return tex2Dgrad(iChannel0,p,float2(1.,0.),float2(0.,1.));}\nvoid mainImage(float2 p,out float4 c){for(int k=0;k<8;k++){c+=leaf(p);}}';
check('explicit gradients do not require helper specialization', porter.rewriteLoopGradientTex(explicit, []) === explicit);
check('running the gradient rewrite twice adds no more helpers', porter.rewriteLoopGradientTex(sampled, []) === sampled);
check('dynamic array writes allow the compiler to unroll', count(hint('void f(){float a[4];for(int k=0;k<4;k++){a[k]=float(k);}}')) === 0);
check('enclosing loops also allow dynamic array writes', count(hint('void f(){float a[4];for(int j=0;j<2;j++){for(int k=0;k<4;k++){a[k]=float(j+k);}}}')) === 0);
check('array parameter writes allow unrolling', count(hint('void f(out float a[4]){for(int k=0;k<4;k++){a[k]=float(k);}}')) === 0);
check('component writes within array elements allow unrolling', count(hint('void f(out float4 a[4]){for(int k=0;k<4;k++){a[k].xy=float2(k,k);}}')) === 0);
check('array increments allow unrolling', count(hint('void f(){float a[4];for(int k=0;k<4;k++){a[k]++;}}')) === 0);
check('unbraced array writes allow unrolling', count(hint('void f(){float a[4];for(int k=0;k<4;k++)a[k]=float(k);}')) === 0);
check('writes in an else arm are included in the loop', count(hint('void f(){float a[4];for(int k=0;k<4;k++)if(k<2){}else{a[k]=float(k);}}')) === 0);
check('unrelated loops keep their DX9 hint', count(hint('void f(){float a[4];for(int k=0;k<4;k++){a[k]=float(k);}float x=0.;for(int j=0;j<4;j++){x+=j;}}')) === 1);
check('array reads keep the rolled-loop hint', count(hint('float f(float a[4]){float x=0.;for(int k=0;k<4;k++){x+=a[k];}return x;}')) === 1);
console.log((total - bad) + '/' + total + ' loop tests OK');
process.exit(bad ? 1 : 0);
