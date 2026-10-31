// Undefined GLSL fall-through paths need a value for FXC; defined returns stay intact.
const porter=require('./load_porter.js')();
let total=0,bad=0;
function check(label,ok){total++;if(!ok){bad++;console.log('FAIL '+label);}}
function run(src){const ctx={src,messages:[]};porter.stepFallbackReturns(ctx);return ctx;}
const direct='float f(float x){return x;}';
check('an explicit final return is preserved',run(direct).src===direct);
const complete='float f(float x){if(x>0.)return 1.;else return 2.;}';
check('complete if/else returns need no fallback',run(complete).src===complete);
const nested='float f(float x){if(x>0.){if(x>1.)return 1.;else return 2.;}else{return 3.;}}';
check('nested complete branches need no fallback',run(nested).src===nested);
const missing=run('float f(int mode){if(mode==1)return .25;if(mode==2)return .75;}');
check('independent conditional returns get a scalar fallback',missing.src.includes('return (float)0;'));
check('all existing returns remain intact',missing.src.includes('return .25;')&&missing.src.includes('return .75;'));
check('the undefined path is reported explicitly',missing.messages.length===1&&missing.messages[0].text.includes('originally undefined path'));
check('void functions do not get a value return',run('void f(){if(flag)return;}').src==='void f(){if(flag)return;}');
check('vector fallbacks use a typed zero',run('float3 f(bool selected){if(selected)return float3(1.,2.,3.);}').src.includes('return (float3)0;'));
check('matrix fallbacks supply every component',run('float2x2 f(bool selected){if(selected)return float2x2(1.,2.,3.,4.);}').src.includes('return float2x2(0.0, 0.0, 0.0, 0.0);'));
check('a loop may execute zero times',run('float f(int n){for(int i=0;i<n;i++)return 1.;}').src.includes('return (float)0;'));
const loopFinal='float f(int n){for(int i=0;i<n;i++){if(i>3)return 1.;}return 2.;}';
check('a return after a loop remains sufficient',run(loopFinal).src===loopFinal);
const conditional='float f(){\n#if MODE\nreturn 1.;\n#endif\n}';
check('conditional compilation is left for explicit review',run(conditional).src===conditional);
const switched='float f(int mode){switch(mode){case 0:return 1.;default:return 2.;}}';
check('switch return analysis is left unchanged',run(switched).src===switched);
const structure='struct Item{float value;};Item f(bool selected){Item value;if(selected)return value;}';
check('unknown aggregate fallback layouts are not invented',run(structure).src===structure);
check('a break path prevents a do-loop return proof',run('float f(bool stop){do{if(stop)break;return .5;}while(false);}').src.includes('return (float)0;'));
check('a continue path prevents a do-loop return proof',run('float f(bool stop){do{if(stop)continue;return .5;}while(false);}').src.includes('return (float)0;'));
const once='float f(){do{return .75;}while(false);}';
check('a do-loop that always returns needs no fallback',run(once).src===once);
console.log((total-bad)+'/'+total+' return-path tests OK');
process.exit(bad?1:0);
