// Independent synthetic programs. Every rendered pixel should be green.
const item = 'struct Item{float value;vec2 offset;};struct Pair{Item a,b;int count;};\n';
const main = body => 'void mainImage(out vec4 c,vec2 p){'+body+'c=ok?vec4(0.,1.,0.,1.):vec4(1.,0.,0.,1.);}\n';
module.exports = [
	{name:'nested_struct_global_side_effects',sources:[item+'Pair state;Item make(){state.b.value=7.;return Item(3.,vec2(0.));}float amount(){state.b.value=9.;return 2.;}void edit(inout Item a,float n){a.value+=n;}\n'+main('state=Pair(Item(1.,vec2(0.)),Item(5.,vec2(0.)),8);state.a=make();bool ok=state.a.value==3.&&state.b.value==7.;edit(state.a,amount());ok=ok&&state.a.value==5.&&state.b.value==9.;')]},
	{name:'nested_struct_values',sources:[item+main('Pair v=Pair(Item(2.,vec2(3.,4.)),Item(5.,vec2(6.,7.)),8);Pair copied=v;v.a.value=9.;Item x=(v.b=v.a);bool ok=copied.a.value==2.&&v.b.value==9.&&x.offset.y==4.&&v.count==8;')]},
	{name:'nested_struct_inout_aliases',sources:[item+'float edit(inout Item a,inout Item b,inout int count){a.value+=1.;b.value+=2.;count+=3;return a.value+b.value;}\n'+main('Pair v=Pair(Item(2.,vec2(0.)),Item(5.,vec2(0.)),8);float r=edit(v.a,v.b,v.count);bool ok=v.a.value==3.&&v.b.value==7.&&v.count==11&&r==10.;')]},
	{name:'nested_struct_out',sources:[item+'void make(out Item a){a.value=12.;a.offset=vec2(13.,14.);}\n'+main('Pair v=Pair(Item(2.,vec2(0.)),Item(5.,vec2(0.)),8);make(v.a);bool ok=v.a.value==12.&&v.a.offset.y==14.&&v.b.value==5.&&v.count==8;')]},
	{name:'nested_struct_depth',sources:[item+'struct World{Pair state;float extra;};\n'+main('World w=World(Pair(Item(2.,vec2(0.)),Item(5.,vec2(0.)),8),16.);w.state.a.value+=1.;Pair v=w.state;bool ok=v.a.value==3.&&v.b.value==5.&&w.state.count==8&&w.extra==16.;')]},
	{name:'nested_struct_sibling_scalar',sources:[item+'void edit(inout Item a,inout float sibling){a.value+=1.;sibling+=2.;}\n'+main('Pair v=Pair(Item(2.,vec2(0.)),Item(5.,vec2(0.)),8);edit(v.a,v.b.value);bool ok=v.a.value==3.&&v.b.value==7.;')]},
	{name:'nested_struct_index_side_effect',shaderModels:['50'],sources:[item+'void edit(inout Item a){a.value+=1.;}\n'+main('Pair values[2];values[0]=Pair(Item(2.,vec2(0.)),Item(5.,vec2(0.)),8);values[1]=values[0];int i=0;edit(values[i++].a);bool ok=i==1&&values[0].a.value==3.&&values[1].a.value==2.;')]},
	{name:'nested_struct_collision',sources:['struct Item{float x;};struct Pair{Item a;float ST_a_x;};\n'+main('Pair v=Pair(Item(2.),5.);v.a.x+=1.;bool ok=v.a.x==3.&&v.ST_a_x==5.;')]}
];
