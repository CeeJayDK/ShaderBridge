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
check('running the hint step twice does not duplicate attributes', hint(hint('for (;;) x++;')) === hint('for (;;) x++;'));
check('a do-while tail never gets a for-loop hint', hint('do { x++; } while (x < 8);') === 'do { x++; } while (x < 8);');
const messages = [];
const src = 'float f(float x);\nvoid mainImage(out vec4 c, vec2 p) { for (int k = 0; k < 8; k++) p.x = f(p.x); c = vec4(p, 0., 1.); }\nfloat f(float x) { return x * 0.5; }';
const result = porter.transformGLSL(src, messages, 'Image').src;
check('function dependencies are resolved before hints are inserted', result.indexOf('float f(float x)\n') < result.indexOf('void mainImage_Image') && !messages.some(m => m.level === 'warn' && /#if/.test(m.text)));
check('the pipeline adds a guarded hint', result.indexOf(directive) >= 0);
console.log((total - bad) + '/' + total + ' loop tests OK');
process.exit(bad ? 1 : 0);
