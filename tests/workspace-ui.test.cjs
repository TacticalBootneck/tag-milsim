const assert=require('node:assert/strict');
const {test}=require('node:test');
const {readFileSync}=require('node:fs');
const {randomUUID}=require('node:crypto');
const vm=require('node:vm');

class Element {
  constructor(tag) {
    this.tagName=tag.toUpperCase();
    this.children=[];
    this.dataset={};
    this.style={};
    this.attributes={};
    this.classList={remove(){}};
    this.checked=false;
    this.disabled=false;
    this.validity={valid:true};
  }
  append(...children) { for (const child of children) child.parent=this; this.children.push(...children); }
  prepend(child) { child.parent=this; this.children.unshift(child); }
  replaceChildren(...children) { for (const child of this.children) child.parent=null; this.children=[]; this.append(...children); }
  remove() { this.parent.children=this.parent.children.filter(child=>child!==this); this.parent=null; }
  add(child) { this.append(child); }
  setAttribute(key,value) { this.attributes[key]=value; }
  addEventListener() {}
  get isConnected() { return this.attached||this.parent?.isConnected||false; }
  get valueAsNumber() { return Number(this.value); }
  get childElementCount() { return this.children.length; }
  scrollIntoView() {}
  getBoundingClientRect() { return {top:100,left:100,width:200,height:400}; }
  querySelectorAll(selector) {
    if (selector==='input:checked') return descendants(this).filter(item=>item.tagName==='INPUT'&&item.checked);
    return [];
  }
}
const descendants=node=>node.children.flatMap(item=>[item,...descendants(item)]);
const all=(parent,tag)=>descendants(parent).filter(node=>node.tagName===tag.toUpperCase());
const button=(parent,label)=>all(parent,'button').find(node=>node.textContent===label);
const requireButton=(parent,label)=>{ const node=button(parent,label);assert.ok(node,'Missing button '+label);return node; };
const label=(parent,text)=>all(parent,'label').find(node=>node.textContent===text)?.children[0];
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const press=(node)=>node.onclick();
async function submit(node) {
  let parent=node.parent;
  while(parent.tagName!=='FORM') parent=parent.parent;
  parent.onsubmit({preventDefault(){},submitter:node});
  await tick();
}
function load(script,api,{path='/members/unit/',query=''}={}) {
  const root=new Element('div');
  root.attached=true;
  const status=new Element('p');
  const tabs=new Element('nav');
  const title=new Element('h1');
  const submitted=[];
  const redirects=[];
  const areas={'#unit-content':root,'#workspace-content':root,'#unit-status':status,'#workspace-status':status,'#unit-tabs':tabs,'#workspace h1':title};
  const context={
    document:{title:'',querySelector:selector=>areas[selector],createElement:tag=>new Element(tag),createTextNode:text=>Object.assign(new Element('text'),{textContent:text}),
      getElementById:id=>descendants(root).find(node=>node.id===id)},
    Option:class extends Element { constructor(name,value) { super('option'); this.textContent=name; this.value=value; } },
    Intl,Date,crypto:{randomUUID},URL,URLSearchParams,confirm:()=>true,requestAnimationFrame:fn=>fn(),
    location:{pathname:path,search:query,hash:'',assign:route=>redirects.push(route)},history:{replaceState:()=>{}},
    fetch:async(_url,options)=>{
      const payload=options.method==='POST'?JSON.parse(options.body):undefined;
      if (payload) submitted.push(payload);
      return {ok:true,headers:new Headers({'Content-Type':'application/json'}),json:async()=>api(payload)};
    },
  };
  vm.runInNewContext(readFileSync(new URL('../portal/'+script,'file://'+__filename),'utf8'),context);
  return {root,tabs,status,submitted,redirects};
}
const can={command:true,leader:true,cadre:true,gameMaster:true};
const id='123456789012345678';
const person={id,name:'Fixture member'};
const group={key:'alpha',label:'Alpha'};
const start=Date.now()-1000;
const doc={id:'document',name:'Fixture.pdf'};
const course={id:'course',name:'Game course',qualification:'jtac',formTitle:'Assess candidate',presentation:doc,guide:doc,
  version:1,canAssess:true,criteria:[{title:'Criterion one',description:'Description'}]};
const register={version:1,counts:true,rows:[{member:id,name:'Fixture member',candidate:true,mark:''},
  {member:'other',name:'Second member',candidate:true,mark:'loa'}]};
const allViews=['orders','taskings','applications','progress','courses','records','training','attendance','gm','command'];
const basics={access:can,views:allViews,member:id};
const loadView=(view,fixture)=>load('unit-operations.js',input=>input?{id:'saved',recorded:1,skipped:0}:{...basics,...fixture},{query:'?view='+view});

test('Orders workspace, GM editor and tasking controls render and send the expected buttons',async()=>{
  const order={title:'Fixture orders',brief:'Overview',sections:{alpha:'Assignment'},objectives:'Game objective',findings:[],version:1};
  const common={title:'Event',start,key:'sunday:event',kind:'operation',groups:[group],myGroups:['alpha'],canAcknowledge:true,
    leaderGroups:['alpha'],expected:[],lineup:[],ready:{},redemptions:[]};
  const orders=loadView('orders',{events:[{...common,order:{published:order,acks:{},history:[],revision:1,review:{}}}],
    findings:[],followups:[],owners:[]});
  await tick();
  press(requireButton(orders.root,'Acknowledge version 1'));
  await tick();
  assert.equal(orders.submitted[0].version,1);
  await submit(requireButton(orders.root,'Update readiness'));
  assert.equal(orders.submitted.at(-1).kind,'ready');
  await submit(requireButton(orders.root,'Publish orders'));
  assert.equal(orders.submitted.at(-1).publish,true);
  assert.ok(all(orders.root,'a').some(node=>node.href.includes('view=gm&event=sunday%3Aevent')));

  const tasks=loadView('taskings',{units:[{key:'devgru',name:'DEVGRU',leaders:['Alpha lead','Bravo lead','Charlie lead']}],aars:[],taskings:[]});
  await tick();
  const unit=label(tasks.root,'Unit');
  unit.value='devgru';
  unit.onchange();
  assert.ok(all(tasks.root,'p').some(node=>String(node.textContent).includes('Charlie lead')));
  label(tasks.root,'Tasking title').value='Fixture task';
  label(tasks.root,'Estimated strength').value='One team';
  await submit(requireButton(tasks.root,'Issue tasking'));
  assert.equal(tasks.submitted.at(-1).unit,'devgru');

  const publication={revision:1,assignees:[id],branches:[{id:'1',title:'Branch one'},{id:'2',title:'Branch two'}],
    discretion:'Private scope',findings:[],combinations:true};
  const gm=loadView('gm',{events:[{...common,closed:true,brief:{published:publication,revision:1,choices:{}}}],
    gameMasters:[person],findings:[]});
  await tick();
  label(gm.root,'Branch one').checked=true;
  label(gm.root,'Branch two').checked=true;
  await submit(requireButton(gm.root,'Save private choices'));
  assert.deepEqual(gm.submitted.at(-1).selection,['1','2']);
  assert.equal(gm.submitted.at(-1).share,false);
  await submit(requireButton(gm.root,'Share outcome with Command'));
  assert.equal(gm.submitted.at(-1).share,true);
  press(requireButton(gm.root,'Add permitted branch'));
  assert.equal(all(gm.root,'label').filter(node=>node.textContent==='Permitted scenario branch').length,3);
});

test('Bulk attendance preserves LOA, candidate sign-off submits all edits, and course editor adds criteria',async()=>{
  const event={key:'training:course',title:'Game course session',start,kind:'course',register,
    qualification:'jtac',canSignoff:true};
  const attendance=loadView('attendance',{events:[event],courseTemplates:[course]});
  await tick();
  press(requireButton(attendance.root,'Mark all unmarked attended'));
  assert.equal(label(attendance.root,'Attendance for Fixture member').value,'attended');
  assert.equal(label(attendance.root,'Attendance for Second member').value,'loa');
  await submit(requireButton(attendance.root,'Confirm attendance'));
  assert.deepEqual(attendance.submitted.at(-1).marks,{[id]:'attended',other:'loa'});
  const bulk=all(attendance.root,'form')[1];
  press(requireButton(bulk,'Select all'));
  press(requireButton(bulk,'Apply to selected'));
  await submit(requireButton(attendance.root,'Review and confirm results'));
  assert.equal(attendance.submitted.at(-1).rows.length,2);
  const courses=loadView('courses',{courses:[course],qualifications:[{key:'jtac',name:'JTAC'}],assessments:[],people:[person],events:[event]});
  await tick();
  press(requireButton(courses.root,'Add assessment line'));
  assert.ok(all(courses.root,'label').filter(item=>item.textContent==='Criterion title').length>=3);
  press(requireButton(courses.root,'Assign assessment'));
  label(courses.root,'Unit member').value=id;
  label(courses.root,'Training event').value=event.key;
  await submit(requireButton(courses.root,'Save draft'));
  assert.equal(courses.submitted.at(-1).status,'draft');
  assert.equal(courses.submitted.at(-1).member,id);
});

test('Member, Command, and application views render the planned control surfaces',async()=>{
  const values={attendance:{weeks:[],absent:4,loa:0},rewards:{operations:5,training:5,available:true,claims:[]},
    options:[{key:'sunday:event',kind:'life',title:'Reward operation',start:Date.now()+60000}],operations:10,warnings:[{at:start,title:'Formal warning 2'}],
    qualifications:[],seasoned:true};
  const member=loadView('progress',values);
  await tick();
  assert.equal(all(member.root,'p').find(row=>row.className==='uo-warning').textContent.includes('Formal warning 2'),true);
  label(member.root,'Use a reward').value='sunday:event';
  await submit(requireButton(member.root,'Reserve reward'));
  assert.equal(member.submitted.at(-1).action,'claim');
  const applications=loadView('applications',{seasoned:true,operations:10,qualifications:[{key:'jtac',name:'JTAC',seasoned:true}],
    applications:[{id:'appt',name:'Applicant',qualificationName:'JTAC',status:'pending',canReview:true}]});
  await tick();
  await submit(requireButton(applications.root,'Approve'));
  assert.equal(applications.submitted.at(-1).status,'approved');
  const command=loadView('command',{settings:{roles:{},policy:false,channel:''},adjustments:{},people:[person],qualifications:[],
    inbox:{applications:0,taskings:0,overdue:[],vacancies:[]},cases:[],delivery:[{id:'delivery',status:'failed',attempts:1,error:'Fixture'}]});
  await tick();
  assert.ok(requireButton(command.root,'Save settings'));
  assert.ok(requireButton(command.root,'Apply intervention'));
  assert.ok(requireButton(command.root,'Save member adjustment'));
  press(requireButton(command.root,'Retry delivery'));
  await tick();
  assert.equal(command.submitted.at(-1).id,'delivery');
});

test('Separate AAR page saves incomplete drafts and only publishes with a recap',async()=>{
  const campaign={id:'campaign',title:'Game fixture',mapName:'Game map',backstory:'Brief',goal:'Goal',map:'asset',reports:[],entities:[],assessments:[],followups:[]};
  const app=load('campaign-workspace.js',input=>input?{id:input.id,updated:2}:{campaign,active:campaign.id,archive:[],drafts:[],events:[],types:['recon','shaping']},
    {path:'/members/aar/'});
  await tick();
  label(app.root,'Team').value='Alpha';
  press(requireButton(app.root,'Add finding'));
  label(app.root,'Finding title').value='Partial observation';
  const map=all(app.root,'img').find(item=>item.className==='cw-map-pick');
  map.onclick({clientX:150,clientY:300});
  await press(requireButton(app.root,'Save draft'));
  assert.equal(app.submitted.at(-1).action,'draft');
  assert.deepEqual(app.submitted.at(-1).findings[0].pin,{x:.25,y:.5});
  await submit(requireButton(app.root,'Submit AAR & publish campaign update'));
  assert.equal(app.submitted.length,1);
  label(app.root,'Public recap (required)').value='Public game recap';
  await submit(requireButton(app.root,'Submit AAR & publish campaign update'));
  assert.equal(app.submitted.at(-1).action,'submit');
  assert.match(app.redirects[0],/^\/members\/campaign\/#report-/);
});

test('Training form submits custom name, channel, cadence, squad and member selections',async()=>{
  const training=loadView('training',{
    types:[{key:'squad',name:'Squad training'},{key:'t1',name:'Basic Training T1'}],
    squads:[{key:'alpha',label:'Alpha squad'}],people:[{id,name:'Fixture member'}],
    channels:[{id:'123456789012345679',name:'training'}],series:[],
  });
  await tick();
  label(training.root,'Training type').value='squad';
  label(training.root,'Training type').onchange();
  label(training.root,'Training name').value='Alpha Practice';
  label(training.root,'Session time (UK)').value='19:00';
  label(training.root,'Discord posting channel').value='123456789012345679';
  label(training.root,'Repeat').value='fortnightly';
  label(training.root,'Alpha squad').checked=true;
  label(training.root,'Fixture member').checked=true;
  await submit(requireButton(training.root,'Schedule and post to Discord'));
  assert.equal(training.submitted[0].action,'schedule-training');
  assert.equal(training.submitted[0].title,'Alpha Practice');
  assert.equal(training.submitted[0].channel,'123456789012345679');
  assert.equal(training.submitted[0].repeat,'fortnightly');
  assert.deepEqual(training.submitted[0].squads,['alpha']);
  assert.deepEqual(training.submitted[0].people,[id]);
});
