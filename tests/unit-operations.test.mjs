import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createUnitOperations, attendanceProgress, weekOf } from '../portal/unit-operations.mjs';
import { decorationsView } from '../portal/honours.mjs';

const DAY = 86400000;
const WEEK = 7*DAY;
test('Campaign eligibility is strictly above 80% and service tiers require ten of each kind',()=>{
  const start=Date.parse('2026-01-04T19:00:00Z');
  const events={};
  const registers={};
  for (let i=0;i<40;i++) {
    const kind=i%2===0?'operation':'training';
    const time=start+i*WEEK;
    const key='sunday:'+i;
    events[i]={type:kind,start:time};
    registers[key]={key,start:time,kind,closedAt:time+1,counts:true,marks:{
      eligible:'attended',exact:i===0?'absent':'attended',
    }};
  }
  const campaigns=[{id:'test',title:'Test Campaign',createdAt:start,archivedAt:start+9*WEEK}];
  const view=decorationsView({registers},campaigns,events);
  assert.equal(view('eligible',start-1).items.filter(row=>row.kind==='campaign').length,1);
  assert.equal(view('exact',start-1).items.filter(row=>row.kind==='campaign').length,0);
  assert.deepEqual(view('eligible',start-1).items.filter(row=>row.kind==='service').map(row=>row.tier),[1,2]);
  assert.equal(view('exact',start-1).items.filter(row=>row.kind==='service').length,1);
  assert.equal(view('eligible',0).items.filter(row=>row.kind==='service').length,0);
  registers['sunday:8'].closedAt=null;
  assert.equal(decorationsView({registers},campaigns,events)('eligible',start-1).items.some(row=>row.kind==='campaign'),false);
});
const at = Date.parse('2026-11-23T20:00:00Z');
const snow = number => String(100000000000000000n+BigInt(number));
const roles = {
  command:snow(1), cadre:snow(2), team:snow(3), squad:snow(4), gm:snow(5), seasoned:snow(6),
  t1:snow(7), t2:snow(8), heavy:snow(9), tacp:snow(10),
};
const people = {command:snow(20),candidate:snow(21),candidate2:snow(33),other:snow(22),staff:snow(23),heavy:snow(24),cadre1:snow(25),
  cadre2:snow(26),alpha:snow(27),bravo:snow(28),charlie:snow(29),pilot:snow(30),gm:snow(31),gmOther:snow(32),tacp:snow(34)};
const actor = (name,ids=[]) => ({user:{id:people[name]},roles:ids});
const actors = {
  command:actor('command',[roles.command]),staff:actor('staff',[roles.cadre]),candidate:actor('candidate'),
  candidate2:actor('candidate2'),other:actor('other'),heavy:actor('heavy',[roles.cadre,roles.heavy]),
  cadre1:actor('cadre1',[roles.t1]),cadre2:actor('cadre2',[roles.t2]),alpha:actor('alpha',[roles.team]),
  bravo:actor('bravo',[roles.team]),charlie:actor('charlie',[roles.squad]),pilot:actor('pilot'),
  gm:actor('gm',[roles.gm]),gmOther:actor('gmOther',[roles.gm]),tacp:actor('tacp',[roles.tacp]),
};
function event(id,kind,start,more={}) {
  const key=(kind==='course'?'training':'sunday')+':'+id;
  return {id,key,kind,title:'Fixture '+id,start,cancelled:false,groups:[{key:'alpha',label:'Alpha'}],lineup:[],
    memberships:{[people.candidate]:['alpha'],[people.alpha]:['alpha'],[people.other]:['alpha']},
    leaderMembers:{[people.alpha]:['alpha']},leads:[{id:people.alpha,name:'Alpha',groups:['alpha']}],
    people:[people.candidate,people.candidate2,people.other],confirmed:[people.other],candidates:[],results:{},marks:{},onLeave:()=>false,priorityCount:0,standardFull:false,...more};
}
function fixture() {
  let time=at;
  const context={
    available:true,directoryFresh:true,guild:snow(100),roles,events:{},members:
      Object.fromEntries(Object.entries(actors).map(([name,member])=>[member.user.id,{id:member.user.id,name,status:'Full Member',
        joined:at-150*DAY,probationAt:at-110*DAY,activeSince:at-150*DAY,roleIds:member.roles,required:false}])),
    qualifications:{'machine gunner':{name:'Machine Gunner',discordRole:snow(70)},jtac:{name:'JTAC',discordRole:snow(71)}},
    units:{tag:'TAG',devgru:'DEVGRU',soar:'160th SOAR',rrc:'RRC'},
    unitLeaders:{devgru:[people.alpha,people.bravo,people.charlie],soar:[people.pilot],rrc:[],tag:[people.charlie]},
    vacancies:[{group:'Element',slot:'Rifleman'}],findings:[{id:'game-ref',title:'Campaign note',href:'/members/campaign/#ref'}],
    reports:[{id:'report-fixture',title:'Campaign report',href:'/members/campaign/#report-fixture'}],campaign:'fixture',canAar:true,
  };
  const deliveries=[];
  let jobAction=async()=>{};
  const app=createUnitOperations({dataDir:mkdtempSync(resolve(tmpdir(),'tag-unit-test-')),origin:'https://unit.example',
    context:async()=>context,now:()=>time,sendJob:async(id,job)=>{ await jobAction(id,job); deliveries.push({id,...job}); }});
  const server=createServer((request,response)=>{
    const url=new URL(request.url,'https://unit.example');
    void app.handle(request,response,url,actors[request.headers['x-test-actor']]).catch(error=>{
      response.writeHead(500); response.end(error.stack);
    });
  });
  const ready=new Promise(done=>server.listen(0,'127.0.0.1',done));
  async function request(name,{query='',input,path='/api/unit-operations',origin='https://unit.example'}={}) {
    await ready;
    return fetch('http://127.0.0.1:'+server.address().port+path+query,input?{
      method:'POST',headers:{'x-test-actor':name,origin,'Content-Type':'application/json'},body:JSON.stringify(input),
    }:{headers:{'x-test-actor':name}});
  }
  async function checkResult(response,status) {
    assert.equal(response.status,status,await response.clone().text());
    const type=response.headers.get('content-type');
    return type?.includes('application/json') ? response.json() : response.text();
  }
  const get=async(name,view)=>checkResult(await request(name,{query:'?view='+view}),200);
  const post=async(name,input,status=200)=>checkResult(await request(name,{input}),status);
  const add=row=>{context.events[row.key]=row;return row;};
  const settings=async (policy=false)=>post('command',{action:'settings',roles,channel:snow(80),policy});
  return {request,checkResult,get,post,add,context,settings,close:()=>server.close(),move:next=>{time=next;},
    app,deliveries,job:fn=>{jobAction=fn;}};
}
test('Command, course materials, assessment privacy, bulk sign-off and retest history',async t=>{
  const f=fixture(); t.after(f.close);
  // Use only addon role IDs for the UI settings payload.
  await f.settings();
  const attachment={name:'Fixture.pdf',data:Buffer.from('%PDF-1.4 fixture').toString('base64')};
  const draft={action:'course',name:'Gunner',qualification:'machine gunner',formTitle:'Gunner candidate assessment',
    criteria:[{title:'Accuracy',description:'Measured during the game session'}],presentation:attachment,guide:attachment};
  await f.post('candidate',draft,403);
  await f.post('staff',draft,403);
  const {id}=await f.post('heavy',draft);
  const course=(await f.get('heavy','courses')).courses[0];
  assert.equal(course.id,id);
  await f.checkResult(await f.request('alpha',{path:'/members/unit-file/'+course.guide.id}),404);
  const doc=await f.request('heavy',{path:'/members/unit-file/'+course.guide.id});
  assert.match(doc.headers.get('content-disposition'),/attachment/);
  assert.match(await f.checkResult(doc,200),/%PDF/);

  const practiced=f.add(event('gunner','course',at-DAY,{qualification:'machine gunner',candidates:[people.candidate,people.candidate2]}));
  const form={action:'assessment',course:id,event:practiced.key,member:people.candidate,status:'draft',
    lines:[{assessment:'Draft note',feedback:'Private feedback'}]};
  const {id:assessment}=await f.post('heavy',form);
  assert.equal((await f.get('alpha','records')).assessments.length,0);
  const original=(await f.get('heavy','records')).assessments[0];
  assert.equal(original.id,assessment);
  await f.post('heavy',{...form,id:assessment,updated:original.updated,status:'retest'});
  assert.equal((await f.get('bravo','records')).assessments[0].lines[0].feedback,'Private feedback');
  assert.equal((await f.get('charlie','records')).assessments.length,1);
  const own=await f.get('candidate','records');
  assert.ok(!Object.hasOwn(own,'assessments'));
  await f.post('alpha',{...form,id:assessment,status:'passed'},403);
  const {id:retry}=await f.post('heavy',{...form,previous:assessment,status:'passed'});
  assert.notEqual(retry,assessment);
  assert.deepEqual((await f.get('candidate','progress')).qualifications,['Machine Gunner']);
  assert.equal((await f.get('bravo','records')).assessments.find(row=>row.id===assessment).status,'retest');
  const bulk={action:'bulk-results',event:practiced.key,course:id,rows:[
    {member:people.candidate,status:'passed'},{member:people.candidate2,status:'passed'},
  ]};
  assert.deepEqual(await f.post('heavy',bulk),{recorded:1,skipped:1});
  assert.deepEqual(await f.post('heavy',bulk),{recorded:0,skipped:2});
  assert.ok(f.app.memberAwardsView(f.context.qualifications).names(people.candidate2).includes('Machine Gunner'));
  await f.post('heavy',{...draft,id,version:course.version,criteria:[{title:'Revised criterion'}]});
  assert.equal((await f.get('alpha','records')).assessments[0].lines[0].title,'Accuracy');
  await f.post('heavy',{action:'schedule-course',id:randomUUID(),course:id,day:'2026-11-25',time:'19:00',places:3,instructors:1,limit:1});

  const basic=f.add(event('basic1','course',at-2*DAY,{qualification:'t1',basicStage:'t1',candidates:[people.candidate,people.candidate2]}));
  const basicBulk={action:'bulk-results',event:basic.key,rows:[{member:people.candidate,status:'passed'},{member:people.candidate2,status:'failed'}]};
  await f.post('cadre2',basicBulk,403);
  await f.post('command',basicBulk,403);
  assert.deepEqual(await f.post('cadre1',basicBulk),{recorded:2,skipped:0});
  assert.deepEqual(await f.post('cadre1',basicBulk),{recorded:0,skipped:2});
  for (let n=0;n<10;n++) await f.app.deliver();
  assert.equal(f.deliveries.filter(job=>job.type==='basic').length,2);
  assert.equal(f.deliveries.filter(job=>job.type==='specialist').length,3);
  assert.equal(f.deliveries.filter(job=>job.type==='schedule').length,1);
});

test('orders versions, readiness, follow-ups, unit DMs and GM-only branch choices',async t=>{
  const f=fixture(); t.after(f.close);
  await f.settings();
  const op=f.add(event('next','operation',at+DAY));
  const order={action:'order',event:op.key,revision:0,title:'Scenario orders',brief:'Scenario history',objectives:'In-game objectives',
    map:'Takistan',sections:{alpha:'Your briefing'},findings:['game-ref'],review:true};
  await f.post('command',order);
  const read=async(name,view='orders')=>(await f.get(name,view)).events.find(item=>item.key===op.key);
  assert.ok((await read('alpha')).order.draft);
  assert.equal((await read('candidate')).order.draft,undefined);
  await f.post('alpha',{action:'order-leader',kind:'review',event:op.key,group:'alpha',revision:1,note:'Ready for review'});
  await f.post('other',{action:'order-leader',kind:'ready',event:op.key,group:'alpha',status:'ready'},403);
  await f.post('alpha',{action:'order-leader',kind:'ready',event:op.key,group:'alpha',status:'ready'});
  await f.post('command',{...order,revision:1,publish:true});
  assert.match((await read('candidate')).order.published.title,/Scenario/);
  await f.post('command',{...order,revision:1,publish:true},409);
  await f.post('alpha',{action:'order-leader',kind:'ack',event:op.key,group:'alpha',version:1});
  await f.post('command',{...order,revision:2,publish:true,changes:'Updated start plan'});
  assert.equal((await read('alpha')).order.published.version,2);
  assert.equal((await read('alpha')).order.acks[people.alpha].version,1);
  await f.post('command',{action:'followup',title:'Check game storyline',owner:people.alpha,event:op.key,due:'2026-11-24',finding:'game-ref'});
  assert.equal((await f.get('command','orders')).followups.length,1);

  const task={action:'tasking',id:randomUUID(),unit:'devgru',title:'Game task',strength:'One team, four players',
    deadline:'2026-11-24',aarDeadline:'2026-11-25',task:'Fictional event objectives',intended:'Complete the game scenario'};
  await f.post('alpha',task,403);
  await f.post('command',task);
  for (const name of ['alpha','bravo','charlie']) assert.equal((await f.get(name,'taskings')).taskings[0].id,task.id);
  assert.equal((await f.get('pilot','taskings')).taskings.length,0);
  await f.post('alpha',{action:'tasking-action',kind:'ack',id:task.id});
  await f.post('alpha',{action:'tasking-action',kind:'report',id:task.id,result:'Scenario completed',aar:'report-fixture'});
  await f.post('command',{action:'tasking-action',kind:'close',id:task.id});
  await f.post('command',{...task,id:randomUUID(),unit:'soar'});
  const gm={action:'game-brief',event:op.key,revision:0,assignees:[people.gm],discretion:'Stay within the approved game scenario',
    previous:'Prior game session',recon:'Recon AAR details',branches:[{title:'Branch one'},{title:'Branch two'}],findings:['game-ref'],combinations:true,publish:true};
  await f.post('gm',gm,403);
  await f.post('command',gm);
  assert.equal((await f.get('gmOther','gm')).events.length,0);
  assert.ok(!Object.hasOwn(await f.get('candidate','gm'),'events'));
  assert.equal((await read('gm','gm')).brief.published.branches.length,2);
  assert.ok(!JSON.stringify(await read('candidate')).includes(gm.discretion));
  const chosen={action:'gm-choice',event:op.key,revision:1,selection:['1','2'],note:'Game Master private choice'};
  await f.post('gm',chosen);
  assert.deepEqual((await read('command','gm')).brief.choices,{});
  await f.post('gm',{...chosen,share:true},400);
  f.move(at+2*DAY);
  await f.post('gm',{...chosen,share:true},400);
  await f.post('command',{action:'register',event:op.key,version:0,confirm:true,marks:{
    [people.candidate]:'attended',[people.candidate2]:'attended',[people.other]:'attended'}});
  await f.post('gm',{...chosen,share:true});
  assert.equal((await read('command','gm')).brief.choices[people.gm].selection.length,2);
  for (let n=0;n<13;n++) await f.app.deliver();
  const notices=f.deliveries.filter(job=>job.id.startsWith('notice:task:'));
  assert.deepEqual(notices.map(job=>job.memberId).sort(),[people.alpha,people.bravo,people.charlie,people.pilot].sort());
  assert.ok(notices.every(job=>job.text.includes('/members/unit/?view=taskings&task=')));
  const privateDM=f.deliveries.find(job=>job.id.startsWith('notice:gm-brief'));
  assert.equal(privateDM.memberId,people.gm);
  assert.match(privateDM.text,/view=gm&event=sunday%3Anext/);
  assert.doesNotMatch(privateDM.text,/Recon AAR details/);
});

test('rolling attendance holds, exactly five-and-five rewards, priority places and Seasoned overrides',async t=>{
  const f=fixture(); t.after(f.close);
  await f.settings(true);
  f.context.members[people.candidate].required=true;
  f.context.members[people.candidate2].required=true;
  const first=at-9*WEEK;
  for (let index=0;index<10;index++) {
    const start=first+index*WEEK;
    f.move(start+5000);
    const row=f.add(event('week-'+index,index%2?'training':'operation',start));
    const marks={[people.candidate]:index<2?'loa':'absent',[people.candidate2]:index<3?'loa':'absent',[people.other]:'attended'};
    const form={action:'register',event:row.key,version:0,counts:true,confirm:true,marks};
    if (index===0) {
      await f.post('staff',{...form,confirm:false});
      assert.equal((await f.get('candidate','progress')).attendance.loa,0);
      form.version=1;
    }
    await f.post('staff',form);
    if (index===0) await f.post('staff',{...form,version:2},403);
    if (index===4) assert.equal((await f.get('candidate','progress')).warnings.at(-1).stage,1);
    if (index===5) assert.equal((await f.get('candidate','progress')).warnings.at(-1).stage,2);
    if (index===6) assert.equal((await f.get('candidate','progress')).warnings.at(-1).stage,3);
    if (index===7) assert.equal((await f.get('candidate','progress')).attendance.stage,3);
    if (index===8) assert.equal((await f.get('candidate','progress')).attendance.stage,4);
  }
  const candidate2=await f.get('candidate2','progress');
  assert.equal(candidate2.held,true);
  assert.equal(candidate2.warnings.filter(row=>row.stage===4).length,0);
  await f.post('staff',{action:'intervene',kind:'resume',member:people.candidate2,reason:'No access'},403);
  const info=await f.get('command','command');
  assert.equal(info.cases.find(item=>item.id===people.candidate2).review,true);
  await f.post('command',{action:'intervene',kind:'hold',member:people.candidate,reason:'Investigating a register issue'});
  for(let n=0;n<12;n++) await f.app.deliver();
  assert.ok(!f.deliveries.some(job=>job.type==='policy'));
  await f.post('command',{action:'intervene',kind:'resume',member:people.candidate2,reason:'Confirmed leave approval'});
  f.move(at+4*60_000);
  for(let n=0;n<15;n++) await f.app.deliver();
  assert.ok(f.deliveries.some(job=>job.type==='policy'&&job.member===people.candidate2&&job.stage===4));
  assert.equal((await f.get('other','progress')).rewards.available,true);
  const op=f.add(event('rewardop','operation',at+DAY));
  await f.post('command',{action:'limit',event:op.key,life:true});
  await f.post('other',{action:'claim',event:op.key});
  assert.equal((await f.get('other','progress')).rewards.available,false);
  const claim=(await f.get('other','progress')).rewards.claims[0];
  await f.post('other',{action:'claim-result',result:'cancel',id:claim.id});
  assert.equal((await f.get('other','progress')).rewards.available,true);

  const form={action:'application',qualification:'jtac',note:'Interested in the in-game qualification'};
  await f.post('other',form,403);
  await f.post('command',{action:'member-adjustment',member:people.other,kind:'seasoned',mode:'grant',reason:'Prior service verified'});
  assert.equal((await f.get('other','applications')).seasoned,true);
  await f.post('other',form);
  const application=(await f.get('tacp','application-review')).applications[0];
  await f.post('heavy',{action:'review-application',id:application.id,status:'approved'},403);
  await f.post('tacp',{action:'review-application',id:application.id,status:'approved'});
  const course=f.add(event('priority','course',at+DAY,{qualification:'jtac',standardFull:true}));
  await f.post('other',{action:'claim',event:course.key});
  for(let n=0;n<12;n++) await f.app.deliver();
  assert.ok(f.deliveries.some(job=>job.type==='priority'&&job.limit===1));
  assert.equal((await f.get('other','progress')).rewards.claims.at(-1).status,'reserved');
  await f.post('command',{action:'member-adjustment',member:people.other,kind:'seasoned',mode:'revoke',reason:'Audit correction'});
  assert.equal((await f.get('other','applications')).seasoned,false);
  actors.other.roles.push(roles.seasoned);
  try {
    assert.equal((await f.get('other','applications')).seasoned,false);
    await f.post('command',{action:'member-adjustment',member:people.other,kind:'seasoned',mode:'automatic',reason:'Role managed in Discord'});
    assert.equal((await f.get('other','applications')).seasoned,true);
  } finally { actors.other.roles.pop(); }
});

test('London calendar weeks handle DST and exclude off-window records',()=>{
  assert.equal(weekOf(Date.parse('2026-10-25T23:55:00Z')),Date.parse('2026-10-19T00:00:00Z'));
  assert.equal(weekOf(Date.parse('2026-07-26T23:30:00Z')),Date.parse('2026-07-27T00:00:00Z'));
  const finalized=Array.from({length:11},(_,index)=>({key:String(index),start:at-index*WEEK,counts:true,marks:{member:index<3?'absent':'attended'}}));
  assert.equal(attendanceProgress(finalized,'member',at).weeks.length,10);
  assert.equal(attendanceProgress(finalized,'member',at).stage,1);
});

test('Seasoned counts only eligible main operations and reward progress resets only when spent',async t=>{
  const f=fixture(); t.after(f.close);
  for(let index=0;index<9;index++) f.add(event('old-op-'+index,'operation',at-(index+1)*DAY,{marks:{[people.other]:'attended'}}));
  f.add(event('unrelated','training',at-DAY,{marks:{[people.other]:'attended'}}));
  f.add(event('before-probation','operation',at-120*DAY,{marks:{[people.other]:'attended'}}));
  await f.settings();
  assert.equal((await f.get('other','applications')).operations,9);
  assert.equal((await f.get('other','applications')).seasoned,false);
  const final=f.add(event('tenth','operation',at+10_000,{marks:{[people.other]:'attended'}}));
  f.move(at+15_000);
  assert.equal((await f.get('other','applications')).operations,9);
  await f.post('staff',{action:'register',event:final.key,version:0,confirm:true,counts:true,marks:{
    [people.candidate]:'not-required',[people.candidate2]:'not-required',[people.other]:'attended'}});
  assert.equal((await f.get('other','applications')).seasoned,true);
  assert.equal((await f.get('other','progress')).rewards.available,false);
  for(let n=0;n<4;n++) await f.app.deliver();
  assert.ok(f.deliveries.some(job=>job.type==='role'&&job.source==='seasoned'&&job.member===people.other));
  await f.post('other',{action:'reserve-request',note:'Availability changed'});
  assert.equal((await f.get('command','command')).cases.find(row=>row.id===people.other).reserveRequest.status,'pending');
  await f.post('staff',{action:'intervene',kind:'reserve',member:people.other,reason:'No authority'},403);
  await f.post('command',{action:'intervene',kind:'reserve',member:people.other,reason:'Availability confirmed'});
  assert.equal((await f.get('other','progress')).reserveRequest.status,'approved');
});

test('the same warning and removal thresholds hold for any placement of two LOA weeks',()=>{
  for (let a=0;a<10;a++) for (let b=a+1;b<10;b++) {
    const rows=Array.from({length:10},(_,index)=>({start:at-index*WEEK,counts:true,marks:{id:index===a||index===b?'loa':'attended'}}));
    const available=rows.filter(row=>row.marks.id!=='loa');
    for (let misses=0;misses<=available.length;misses++) {
      const expected=misses>=7?4:misses>=5?3:misses>=4?2:misses>=3?1:0;
      const result=attendanceProgress(rows,'id',at);
      assert.equal(result.absent,misses);
      assert.equal(result.loa,2);
      assert.equal(result.stage,expected);
      if (available[misses]) available[misses].marks.id='absent';
    }
  }
});
