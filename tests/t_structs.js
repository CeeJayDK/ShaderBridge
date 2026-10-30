const porter = require('./load_porter.js')();
const cases = require('./nested_struct_cases.js');
let bad=0,total=0;
function check(name, ok)
{
	total++;
	if(!ok){bad++;console.log('FAIL '+name);}
}
cases.forEach(function(test)
{
	const messages=[];
	const result=porter.transformGLSL(test.sources[0],messages,'Image');
	const analysis=porter.analyzeSource(result.src);
	check(test.name+' has no nested struct fields',Object.values(analysis.structs).every(s=>Object.values(s.fields).every(t=>!analysis.structs[t])));
	check(test.name+' reports its lowering',messages.some(m=>/Flattened nested struct/.test(m.text)));
});
const aliases=porter.transformGLSL(cases.find(test=>test.name==='nested_struct_inout_aliases').sources[0],[],'Image').src;
check('sibling inout views share a single parent argument',/ST_nested_call_edit_\d+\(v\)/.test(aliases));
const ordinary='struct Item{float x;};void mainImage(out vec4 c,vec2 p){Item v;v.x=2.;c=vec4(v.x);}';
check('flat structs do not need view helpers',!porter.transformGLSL(ordinary,[],'Image').src.includes('ST_get_'));
const comments='struct Item{float x;};struct Pair{/* field comment */Item a;};void mainImage(out vec4 c,vec2 p){Pair v;v.a.x=1.;c=vec4(v.a.x);}';
check('field comments survive flattening',porter.transformGLSL(comments,[],'Image').src.includes('/* field comment */'));
const conditional='#if 0\nstruct Item{float x;};struct Pair{Item a;};\n#endif\nvoid mainImage(out vec4 c,vec2 p){c=vec4(1.);}';
check('inactive struct declarations do not leak helpers outside their condition',!porter.transformGLSL(conditional,[],'Image').src.includes('ST_get_'));
console.log((total-bad)+'/'+total+' nested struct tests OK');
process.exit(bad?1:0);
