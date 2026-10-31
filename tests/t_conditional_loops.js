// Preserve configurable preprocessor alternatives while making shared loop bodies analysable.
const porter=require('./load_porter.js')();
let total=0,bad=0;
function check(label,ok){total++;if(!ok){bad++;console.log('FAIL '+label);}}
function normalize(src){const ctx={src,messages:[]};porter.stepConditionalLoopBodies(ctx);return ctx;}
const source='float f(){float sum=0.;\n#if CHOICE\nfor(int i=0;i<3;i++){float value=1.,\n#else\nfor(int i=0;i<2;i++){float value=2.,\n#endif\nextra=0.;sum+=value+extra;}\nreturn sum;}\nfloat following;';
const result=normalize(source);
check('alternative loop headers become structurally balanced',porter.analyzeSource(result.src).ok);
check('the shared tail is copied into both alternatives',(result.src.match(/sum\+=value\+extra/g)||[]).length===2);
check('both loop bounds remain selectable',result.src.includes('#if CHOICE')&&result.src.includes('#else')&&result.src.includes('i<3')&&result.src.includes('i<2'));
check('global declarations following the function stay visible',porter.analyzeSource(result.src).decls.some(d=>d.global&&d.name==='following'));
check('normalization is idempotent',normalize(result.src).src===result.src);
check('the normalization is reported once',result.messages.length===1);
const balanced='void f(){\n#if CHOICE\nfor(;;){value++;}\n#else\nfor(;;){value--;}\n#endif\n}';
check('already complete alternatives are preserved',normalize(balanced).src===balanced);
const noElse='void f(){\n#if CHOICE\nfor(;;){\n#endif\nvalue++;}}';
check('an absent else alternative is not guessed',normalize(noElse).src===noElse);
const definition=source.replace('extra=0.;','#define LOCAL 1\nextra=0.;');
check('macro definitions are not moved into alternatives',normalize(definition).src===definition);
const whileSource='void f(){\n#if CHOICE\nwhile(a){\n#else\nwhile(b){\n#endif\nvalue++;}}';
check('while-loop alternatives are supported',(normalize(whileSource).src.match(/value\+\+/g)||[]).length===2);
const commentSource=source.replace('extra=0.;','// } is a comment\nextra=0.;');
check('braces in comments cannot terminate the shared tail',(normalize(commentSource).src.match(/sum\+=value\+extra/g)||[]).length===2);
const elif=source.replace('#else\nfor(int i=0;i<2;i++){float value=2.,','#elif SECOND\nfor(int i=0;i<4;i++){float value=3.,\n#else\nfor(int i=0;i<2;i++){float value=2.,');
check('elif alternatives retain the shared body',(normalize(elif).src.match(/sum\+=value\+extra/g)||[]).length===3);
const attributes=source.replace(/for\(int/g,'[unroll] for(int');
check('explicit loop attributes remain in their alternatives',(normalize(attributes).src.match(/\[unroll\]/g)||[]).length===2);
const ifSource=source.replace(/for\(int i=0;i<[23];i\+\+\)/g,'if(flag)');
check('other partial-block constructs are left unchanged',normalize(ifSource).src===ifSource);
console.log((total-bad)+'/'+total+' conditional-loop tests OK');
process.exit(bad?1:0);
