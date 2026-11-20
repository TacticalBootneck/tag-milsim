import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';

const website=resolve(process.argv[2]??resolve(homedir(),'tag-website'));
const installedBot=resolve(process.argv[3]??resolve(homedir(),'tag-bot'));
const update=fileURLToPath(new URL('../',import.meta.url));
const root=mkdtempSync(resolve(tmpdir(),'tag-stack-'));
const bot=resolve(root,'bot');
mkdirSync(bot,{recursive:true});
mkdirSync(resolve(root,'portal'),{recursive:true});
cpSync(resolve(website,'dist'),resolve(root,'dist'),{recursive:true});
for (const name of ['ranks.mjs','roster.mjs']) cpSync(resolve(website,'portal',name),resolve(root,'portal',name));
for (const name of ['ranks.mjs','participation.mjs']) cpSync(resolve(installedBot,name),resolve(bot,name));
cpSync(resolve(update,'portal'),resolve(root,'portal'),{recursive:true});
cpSync(resolve(update,'bot'),bot,{recursive:true});
cpSync(resolve(update,'dist'),resolve(root,'dist'),{recursive:true});
const discordPackage=resolve(bot,'node_modules/discord.js');
mkdirSync(discordPackage,{recursive:true});
writeFileSync(resolve(discordPackage,'package.json'),'{"type":"module","exports":"./index.mjs"}');
writeFileSync(resolve(discordPackage,'index.mjs'),`
import { EventEmitter } from 'node:events';
const data=globalThis.tagFixture;
const builder=new Proxy({},{
  get(_,key) {
    if (key==='toJSON') return ()=>({});
    return (...args)=>{ if (typeof args[0]==='function') args[0](builder); return builder; };
  },
});
function Builder() { return builder; }
export const ActionRowBuilder=Builder,ButtonBuilder=Builder,SlashCommandBuilder=Builder,ModalBuilder=Builder,
  StringSelectMenuBuilder=Builder,UserSelectMenuBuilder=Builder,RoleSelectMenuBuilder=Builder,TextInputBuilder=Builder;
export const Events=new Proxy({}, {get:(_,key)=>key});
export const ButtonStyle={},GatewayIntentBits={},MessageFlags={},TextInputStyle={};
export class Client extends EventEmitter {
  constructor() {
    super();
    data.client=this;
    this.guilds={fetch:async()=>data.guild};
    this.users={fetch:async id=>data.members.get(id)?.user};
    this.channels=data.guild.channels;
    this.user={id:data.botId};
  }
  async login() { queueMicrotask(()=>this.emit('ClientReady')); return 'fixture'; }
  destroy() {}
}
`);
const snow=n=>String(123456789000000000n+BigInt(n));
const rid={command:snow(1),cadre:snow(2),team:snow(3),squad:snow(4),gm:snow(5),t1:snow(6),t2:snow(7),heavy:snow(8),
  full:snow(9),prob:snow(10),recruit:snow(11),reserve:snow(12),seasoned:snow(13),qualification:snow(14)};
const uid={command:snow(101),alice:snow(102),bravo:snow(103),charlie:snow(104),pilot:snow(105),gm:snow(106),ordinary:snow(107),trainer:snow(108),student:snow(109)};
const everyone=snow(201), trainingChannel=snow(202), specialistChannel=snow(203), ordersChannel=snow(204), privateChannel=snow(205);
const rolesByUser={command:[rid.command,rid.full],alice:[rid.team,rid.full],bravo:[rid.team,rid.full],
  charlie:[rid.squad,rid.full],pilot:[rid.full],gm:[rid.gm,rid.full],ordinary:[rid.full],
  trainer:[rid.t1,rid.heavy,rid.cadre,rid.full],student:[rid.recruit]};
const honoursCommander=snow(29);
rolesByUser.command.push(honoursCommander);
const wall=Date.now();
const week=604800000;
const joined=wall-100*86400000;
let clock=wall;
Date.now=()=>clock;
const captures={dms:[],channels:[],edits:[],kicks:[],deleted:[]};
let sent=300;
const safeRole=id=>({id,editable:true,managed:false,permissions:{bitfield:0n,has:()=>false}});
const members=new Map();
const memberRoles=new Map(Object.values(rid).map(id=>[id,safeRole(id)]));
const channels=new Map([trainingChannel,specialistChannel,ordersChannel,privateChannel].map(id=>[id,{
  id,name:'fixture-'+id.slice(-3),type:0,guildId:everyone,isSendable:()=>true,permissionsFor:()=>({has:()=>id!==privateChannel}),
  send:async message=>{captures.channels.push({id,message}); return {id:snow(sent++),url:'https://discord.test/'+sent};},
  messages:{delete:async message=>{captures.deleted.push({id,message});},edit:async(message,value)=>{captures.edits.push({id,message,value});},fetch:async message=>({id:message,edit:async value=>{captures.edits.push({id,message,value});return value;}})},
}]));
const guild={id:everyone,name:'TAG staging',commands:{create:async()=>{}},channels:{fetch:async id=>id?channels.get(id):channels},
  roles:{everyone:safeRole(everyone),fetch:async id=>id?memberRoles.get(id):memberRoles,cache:memberRoles},
  members:{me:{id:snow(230)},cache:members,list:async()=>members,fetch:async input=>{
    if (!input) return members;
    const member=members.get(typeof input==='string'?input:input.user);
    if (!member) { const error=new Error('Unknown member');error.code=10007;throw error; }
    return member;
  }}};
for (const [name,id] of Object.entries(uid)) {
  const roleSet=new Map(rolesByUser[name].map(role=>[role,memberRoles.get(role)]));
  const user={id,username:name,bot:false,send:async message=>{captures.dms.push({id,message});return {id:snow(sent++)};}};
  members.set(id,{guild,id,user,displayName:name,joinedTimestamp:joined,pending:false,kickable:true,manageable:true,
    roles:{cache:roleSet,add:async role=>roleSet.set(role.id??role,safeRole(role.id??role)),remove:async role=>roleSet.delete(role.id??role)},
    kick:async()=>{captures.kicks.push(id);members.delete(id);},setNickname:async()=>{}});
}
globalThis.tagFixture={guild,botId:snow(230),members};
const ticks=new Map();
globalThis.setInterval=(callback,ms,...args)=>{
  const list=ticks.get(ms)??[];
  list.push(callback);
  ticks.set(ms,list);
  return {unref(){}};
};
const start=wall+25*3600000;
const futureId='event-next';
const event={start,title:'Arma Sunday event',type:'operation',groups:['devgru-alpha'],postId:snow(240),postChannelId:ordersChannel,
  seats:{'devgru-alpha:1':{memberId:uid.alice,status:'confirmed'},'devgru-alpha:2':{memberId:uid.bravo,status:'awaiting_confirmation'}},attendance:{}};
const doneCourse={start:wall-week,type:'Basic Training T1',stage:'t1',messageId:snow(242),channelId:trainingChannel,
  recruitSlots:2,cadreSlots:1,bookings:{[uid.student]:'recruit'}};
const upcomingCourse={...doneCourse,start,messageId:snow(243),bookings:{[uid.alice]:'cadre',[uid.ordinary]:'recruit'}};
const t2Course={...upcomingCourse,type:'Basic Training T2',stage:'t2',start:start+3600000,messageId:snow(244),bookings:{}};
writeFileSync(resolve(bot,'basic-training-sessions.json'),JSON.stringify({t1done:doneCourse,t1next:upcomingCourse,t2next:t2Course}));
const groups={
  'devgru-alpha':{label:'DEVGRU Alpha',unit:'devgru',slots:['Team Leader','Member'],codes:['A','A2']},
  'devgru-bravo':{label:'DEVGRU Bravo',unit:'devgru',slots:['Team Leader'],codes:['B']},
  'devgru-charlie':{label:'DEVGRU Charlie',unit:'devgru',slots:['Team Leader'],codes:['C']},
};
const missedEvents=Object.fromEntries(Array.from({length:7},(_,index)=>{
  const key='closed-'+index;
  return [key,{start:wall-(6-index)*week-2*86400000,title:'Staging week '+index,type:index%2?'training':'operation',
    groups:['devgru-alpha'],seats:{'devgru-alpha:1':{memberId:uid.ordinary,status:'confirmed'}},attendance:{}}];
}));
const exemptFromRequired=Object.fromEntries(Object.keys(uid).filter(name=>name!=='ordinary').map(name=>[uid[name],{attendanceRequired:false}]));
const baseRoster={layoutVersion:2,soarLayoutVersion:2,hqLayoutVersion:2,courses:{'machine gunner':{name:'Machine Gunner',roleId:rid.qualification}},
  rosterElements:groups,rosterUnits:{devgru:{label:'DEVGRU'}},events:{[futureId]:event,...missedEvents},memberDetails:exemptFromRequired,
  discordMemberNames:{[uid.command]:'Command',[uid.alice]:'Alice',[uid.bravo]:'Bravo'},
  discordMemberRoles:{[uid.command]:rolesByUser.command},
  standing:{'devgru-alpha:1':uid.alice,'devgru-bravo:1':uid.bravo,'devgru-charlie:1':uid.charlie,'soar:1':uid.pilot},
  leaveRanges:{[uid.ordinary]:[{from:new Date(start-86400000).toISOString().slice(0,10),to:new Date(start+86400000).toISOString().slice(0,10)}]},
  directoryUpdatedAt:wall};
writeFileSync(resolve(bot,'sunday-rosters.json'),JSON.stringify(baseRoster));
writeFileSync(resolve(bot,'recruit-profiles.json'),'{}');
writeFileSync(resolve(bot,'.env'),'DISCORD_TOKEN=local-staging-token\n');
const freePort=()=>new Promise(done=>{const check=createServer().listen(0,'127.0.0.1',()=>{const p=check.address().port;check.close(()=>done(p));});});
const port=await freePort();
const bridgePort=await freePort();
const origin='https://unit.example';
const mediaOrigin='https://objects.example';
const mediaObjects=new Map();
let failMediaUpload=true;
Object.assign(process.env,{DISCORD_TOKEN:'local-staging-token',TAG_TEST_SERVER_ID:everyone,TAG_GUILD_ID:everyone,TAG_DATA_DIR:bot,PUBLIC_ORIGIN:origin,
  TAG_HONOURS_COMMANDER_ROLE_ID:honoursCommander,
  TAG_MEDIA_ENDPOINT:mediaOrigin,TAG_MEDIA_REGION:'eu-west-3',TAG_MEDIA_BUCKET:'tag-milsim-media',
  TAG_MEDIA_ACCESS_KEY_ID:'test-access-id',TAG_MEDIA_SECRET_ACCESS_KEY:'test-secret',
  DISCORD_CLIENT_ID:'test',DISCORD_CLIENT_SECRET:'test',COMMAND_ROLE_ID:rid.command,TRAINING_CADRE_ROLE_ID:rid.cadre,FULL_MEMBER_ROLE_ID:rid.full,
  SUNDAY_MEMBER_ROLE_ID:rid.full,PROBATIONARY_ROLE_ID:rid.prob,RECRUIT_ROLE_ID:rid.recruit,RESERVE_ROLE_ID:rid.reserve,
  TRAINING_CHANNEL_ID:trainingChannel,BASIC_TRAINING_CHANNEL_ID:trainingChannel,SPECIALIST_TRAINING_CHANNEL_ID:specialistChannel,
  SPECIALIST_CHANNEL_ID:specialistChannel,UPCOMING_OPS_CHANNEL_ID:ordersChannel,START_HERE_CHANNEL_ID:ordersChannel,
  RECRUIT_HELP_CHANNEL_ID:trainingChannel,TAG_WEB_BRIDGE_KEY:'a'.repeat(64),PORT:String(port),TAG_BOT_BRIDGE_PORT:String(bridgePort)});
const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,options)=>{
  if (String(url).startsWith(mediaOrigin+'/')) {
    const target=new URL(url);
    assert.equal(options.method,'PUT');
    assert.equal(options.headers['Content-Type'],'image/jpeg');
    assert.equal(options.headers['Cache-Control'],'private, no-store');
    assert.match(target.pathname,/^\/tag-milsim-media\/campaign-images\/[a-f0-9-]{36}\.jpg$/);
    assert.match(target.searchParams.get('X-Amz-Signature'),/^[a-f0-9]{64}$/);
    if (failMediaUpload) {
      failMediaUpload=false;
      return new Response(null,{status:503});
    }
    mediaObjects.set(target.pathname,Buffer.from(options.body));
    return new Response(null,{status:200});
  }
  if (String(url).endsWith('/oauth2/token')) return Response.json({access_token:options.body.get('code'),expires_in:3600});
  if (String(url).endsWith('/member')&&String(url).startsWith('https://discord.com')) {
    const name=options.headers.Authorization.split(' ')[1];
    const person=members.get(uid[name]);
    return Response.json({user:{id:person.id,username:name},roles:[...person.roles.cache.keys()],joined_at:new Date(joined).toISOString()});
  }
  if (String(url).startsWith('https://discord.com')) throw new Error('Test attempted a live Discord request');
  return originalFetch(url,options);
};
const endpoint='/api/unit-operations';
const baseUrl='http://127.0.0.1:'+port;
const delay=ms=>new Promise(done=>setTimeout(done,ms));
const get=(path,cookie)=>originalFetch(baseUrl+path,{redirect:'manual',headers:cookie?{Cookie:cookie}:{}});
const post=(cookie,input,path=endpoint)=>originalFetch(baseUrl+path,{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(input)});
async function verify(response,code=200) {
  assert.equal(response.status,code,await response.clone().text());
  return response.headers.get('Content-Type')?.includes('application/json')?response.json():response.text();
}
async function login(who,next='') {
  const stateResponse=await get('/auth/discord'+(next?'?next='+encodeURIComponent(next):''));
  const oauth=new URL(stateResponse.headers.get('Location'));
  const saved=stateResponse.headers.getSetCookie().map(cookie=>cookie.split(';')[0]).join('; ');
  const callback=await get('/auth/discord/callback?state='+oauth.searchParams.get('state')+'&code='+who,saved);
  assert.equal(callback.status,303,await callback.clone().text());
  assert.equal(callback.headers.get('Location'),next||'/members/');
  return callback.headers.getSetCookie().find(cookie=>cookie.startsWith('__Host-tag-session=')).split(';')[0];
}
async function deliveries(rounds=8) {
  const job=ticks.get(5000).at(-1);
  for(let i=0;i<rounds;i++) { job(); await delay(70); }
}
try {
  await import(resolve(bot,'bot.mjs'));
  await import(resolve(root,'portal/server.mjs'));
  await delay(150);
  const [command,trainer,ordinary,gm]=await Promise.all(['command','trainer','ordinary','gm'].map(name=>login(name)));
  const student=await login('student');
  const nominationId=randomUUID();
  const nomination={id:nominationId,action:'honour-nomination',member:uid.alice,award:'silver-star',event:'sunday:closed-0',
    detail:'A private recommendation for the commander'};
  await verify(await post(ordinary,nomination));
  await verify(await post(ordinary,nomination));
  await verify(await post(trainer,{action:'honour-review',id:nominationId,status:'declined'}),403);
  const visibleToStaff=await verify(await get(endpoint+'?view=honours',trainer));
  assert.equal(visibleToStaff.nominations,undefined);
  assert.equal((await verify(await get(endpoint+'?view=honours-review',command))).nominations[0].id,nominationId);
  await verify(await post(command,{action:'honour-review',id:nominationId,status:'approved',award:'silver-star',citation:'Approved game citation'}));
  const memberApi='/api/member?view=member';
  assert.equal((await verify(await get(memberApi,student))).nextAction.heading,'Book Basic Training T1');
  assert.equal((await verify(await get(memberApi,ordinary))).nextAction.heading,'You’re all caught up');
  assert.match(await verify(await get('/members/',student)),/id="next-action-heading">My Next Action/);
  await verify(await get(memberApi),401);
  const setting=await verify(await post(command,{action:'settings',roles:{gm:rid.gm,t1:rid.t1,t2:rid.t2,heavy:rid.heavy,seasoned:rid.seasoned},
    channel:privateChannel,policy:false}));
  assert.deepEqual(setting,{});
  await verify(await post(command,{action:'bulk-results',event:'training:t1done',rows:[{member:uid.student,status:'passed'}]}),403);
  await verify(await post(trainer,{action:'bulk-results',event:'training:t1done',rows:[{member:uid.student,status:'passed'}]}));
  const attachment={name:'Brief.pdf',data:Buffer.from('%PDF-1.4 staging').toString('base64')};
  const {id:course}=await verify(await post(trainer,{action:'course',name:'Game course fixture',qualification:'machine gunner',
    formTitle:'Assessment',criteria:[{title:'Recorded criterion'}],presentation:attachment,guide:attachment}));
  const schedule=randomUUID();
  await verify(await post(trainer,{action:'schedule-course',id:schedule,course,day:new Date(wall+2*86400000).toISOString().slice(0,10),
    time:'19:00',places:3,instructors:1,limit:1}));
  const scheduleOptions=await verify(await get(endpoint+'?view=training',trainer));
  assert.ok(scheduleOptions.channels.some(channel=>channel.id===ordersChannel));
  assert.ok(scheduleOptions.channels.every(channel=>channel.id!==privateChannel));
  const series=randomUUID();
  const recurring={action:'schedule-training',id:series,training:'squad',title:'Alpha Communications Practice',
    day:new Date(wall+4*86400000).toISOString().slice(0,10),time:'19:00',places:8,instructors:1,repeat:'weekly',
    squads:['devgru-alpha'],people:[uid.alice,uid.pilot],channel:ordersChannel};
  await verify(await post(ordinary,recurring),403);
  await verify(await post(trainer,{...recurring,squads:['missing-squad']}),400);
  await verify(await post(trainer,{...recurring,inviteRecruits:true}),400);
  await verify(await post(trainer,recurring));
  const basicSeries=randomUUID();
  await verify(await post(trainer,{...recurring,id:basicSeries,training:'t1',title:'Recruit DM Basic Training',
    squads:[],people:[uid.student],inviteRecruits:true}));
  const taskId=randomUUID();
  const taskLink='/members/unit/?view=taskings&task='+taskId;
  await verify(await post(command,{action:'tasking',id:taskId,title:'DEVGRU game task',unit:'devgru',strength:'One team',
    deadline:new Date(start+86400000).toISOString().slice(0,10),task:'Win a game scenario',intended:'Record the outcome'}));
  await verify(await post(command,{action:'tasking',id:randomUUID(),title:'SOAR game task',unit:'soar',strength:'One crew',
    deadline:new Date(start+86400000).toISOString().slice(0,10),task:'Play a scenario',intended:'Record the outcome'}));
  assert.match(await verify(await get(taskLink)),/auth\/discord\?next=%2Fmembers%2Funit/);
  const alpha=await login('alice',taskLink);
  assert.deepEqual((await verify(await get(memberApi,alpha))).decorations.items,[{
    kind:'honour',title:'Silver Star',image:'/assets/honours/silver-star.png',citation:'Approved game citation',
  }]);
  const ribbon=await get('/assets/honours/silver-star.png');
  assert.equal(ribbon.headers.get('Content-Type'),'image/png');
  await ribbon.body.cancel();
  assert.match(await verify(await get('/')),/Recognising service in TAG/);
  const bravo=await login('bravo');
  assert.equal((await verify(await get(memberApi,bravo))).nextAction.confirmationEvent,futureId);
  const confirmStanding={action:'confirm-standing',values:{event:futureId}};
  await verify(await post(gm,confirmStanding,'/api/member/action'),409);
  assert.equal((await verify(await get(memberApi,alpha))).nextAction.heading,'Your place is confirmed');
  const campaignApi='/api/campaign-workspace';
  await verify(await post(command,{action:'roles',team:rid.team,squad:rid.squad},campaignApi));
  const commanderHub=await verify(await get('/staff/',command));
  for (const area of ['administration','training','operations']) {
    assert.ok(commanderHub.includes('href="/staff/'+area+'/"'));
    await verify(await get('/staff/'+area+'/',command));
  }
  assert.match(await verify(await get('/staff/training/',trainer)), /Courses & assessment forms/);
  for (const tool of ['members','roster','assignments']) {
    assert.match(await verify(await get('/staff/administration/tools/?tool='+tool,command)), /id="staff-title"/);
  }
  const leaderHub=await verify(await get('/staff/',alpha));
  assert.ok(leaderHub.includes('href="/staff/operations/"'));
  assert.ok(!leaderHub.includes('href="/staff/administration/"'));
  assert.match(await verify(await get('/staff/operations/',alpha)), /Create an AAR/);
  await verify(await get('/staff/administration/',alpha),403);
  await verify(await get('/staff/administration/tools/?tool=members',alpha),403);
  await verify(await get('/staff/',ordinary),403);
  await verify(await get('/members/aar/',ordinary),403);
  assert.ok((await verify(await get('/staff/operations/'))).includes('auth/discord?next=%2Fstaff%2Foperations%2F'));
  const backChecks=[
    ['/staff/',command,'/members/','Members Dashboard'],
    ['/staff/administration/',command,'/staff/','Unit Dashboard'],
    ['/staff/administration/tools/?tool=members',command,'/staff/administration/','Administration'],
    ['/members/unit/?view=command',command,'/staff/administration/','Administration'],
    ['/staff/operations/tools/?tool=attendance&from=history',command,'/staff/administration/tools/?tool=history','Event history'],
    ['/staff/training/tools/?tool=platoon',trainer,'/staff/training/','Training'],
    ['/members/unit/?view=courses',trainer,'/staff/training/','Training'],
    ['/members/unit/?view=training&from=courses',trainer,'/members/unit/?view=courses','Courses &amp; assessment forms'],
    ['/members/unit/?view=orders',alpha,'/staff/operations/','Operations'],
    ['/members/unit/?view=orders&from=schedule',alpha,'/members/#my-schedule','My schedule'],
    ['/members/unit/?view=orders&from=events',ordinary,'/members/#events','Upcoming events'],
    ['/members/aar/',alpha,'/staff/operations/','Operations'],
    ['/members/campaign/?manage=1',alpha,'/staff/operations/','Operations'],
    ['/members/campaign/',ordinary,'/members/','Members Dashboard'],
    ['/members/unit/?view=applications',ordinary,'/members/','Members Dashboard'],
    ['/members/directory/',ordinary,'/members/','Members Dashboard'],
    ['/members/',ordinary,'/','home'],
  ];
  for (const [page,session,target,label] of backChecks) {
    const html=await verify(await get(page,session));
    assert.ok(html.includes('href="'+target+'">← Back to '+label+'</a>'),page);
    assert.ok(!html.includes('__TAG_BACK_BUTTON__'),page);
  }
  const memberDashboard=await verify(await get(memberApi,ordinary));
  assert.equal(memberDashboard.unitDashboard,false);
  assert.ok(memberDashboard.myCard.name);
  assert.ok(memberDashboard.mySchedule.every(item=>item.status!=='View available seats'));
  assert.equal((await verify(await get(memberApi,alpha))).unitDashboard,true);
  const personalHonours=await verify(await get(endpoint+'?view=honours',command));
  assert.equal(personalHonours.nominations,undefined);
  assert.equal((await verify(await get(endpoint+'?view=honours-review',alpha))).nominations,undefined);

  const jpeg=Buffer.from([255,216,255,255,217]).toString('base64');
  await verify(await post(command,{action:'create',title:'Staging game campaign',mapName:'Test map',map:jpeg,backstory:'Test',goal:'Test'},campaignApi));
  const campaignView=await verify(await get(campaignApi,alpha));
  const active=campaignView.active;
  const map=campaignView.campaign.map;
  const localImage=randomUUID();
  const campaignDb=new DatabaseSync(resolve(bot,'campaign-workspace.sqlite'));
  campaignDb.prepare('INSERT INTO images(id,bytes,public) VALUES(?,?,1)').run(localImage,Buffer.from(jpeg,'base64'));
  campaignDb.close();
  const draftId=randomUUID();
  const content={action:'draft',id:draftId,campaign:active,type:'recon',date:'',event:'',team:'Alpha',summary:'Private notes',
    outcome:'',publicSummary:'',findings:[],incidents:[],images:[jpeg],selected:[]};
  const draft=await verify(await post(alpha,content,campaignApi));
  assert.equal((await verify(await get(campaignApi+'?drafts=1',bravo))).drafts.length,0);
  await verify(await get(campaignApi+'?drafts=1&draft='+draftId,bravo),404);
  await verify(await post(bravo,{action:'delete-draft',id:draftId},campaignApi),404);
  assert.equal((await verify(await get(campaignApi+'?drafts=1&draft='+draftId,alpha))).draft.images[0],jpeg);
  assert.deepEqual(await verify(await get('/api/public-campaign')),[]);
  await verify(await post(alpha,{...content,updated:draft.updated,summary:'Updated private notes'},campaignApi));
  await verify(await post(alpha,{...content,updated:draft.updated},campaignApi),409);
  const latest=(await verify(await get(campaignApi+'?drafts=1&draft='+draftId,alpha))).draft;
  const report={...content,action:'submit',updated:latest.updated,date:new Date(wall).toISOString().slice(0,10),
    publicSummary:'Public in-game recap',images:[jpeg,jpeg],selected:[0]};
  await verify(await post(alpha,{...report,selected:[2]},campaignApi),400);
  await verify(await post(alpha,report,campaignApi));
  const [publicId,privateId]=(await verify(await get(campaignApi,alpha))).campaign.reports[0].images;
  assert.deepEqual((await verify(await get('/api/public-campaign')))[0].images,[publicId]);
  const mapPath='/members/campaign-image/'+map;
  const publicPath='/campaign-images/'+publicId;
  const privatePath='/members/campaign-image/'+privateId;
  await verify(await get('/campaign-images/'+privateId),404);
  await verify(await get(privatePath),401);
  const legacy=await get('/campaign-images/'+localImage);
  assert.equal(legacy.status,200);
  assert.deepEqual(Buffer.from(await legacy.arrayBuffer()),Buffer.from(jpeg,'base64'));
  assert.deepEqual(Buffer.from(await (await get(publicPath)).arrayBuffer()),Buffer.from(jpeg,'base64'));
  const mediaTick=ticks.get(5000).at(-2);
  mediaTick();
  await delay(25);
  assert.equal(mediaObjects.size,0);
  const beforeRetry=await get(mapPath,alpha);
  assert.equal(beforeRetry.status,200);
  assert.deepEqual(Buffer.from(await beforeRetry.arrayBuffer()),Buffer.from(jpeg,'base64'));
  const savedClock=clock;
  clock+=16_000;
  for (let index=0; index<3; index++) { mediaTick(); await delay(25); }
  clock=savedClock;
  assert.equal(mediaObjects.size,3);
  for (const [path,cookie] of [[mapPath,alpha],[privatePath,alpha],[publicPath,undefined]]) {
    const image=await get(path,cookie);
    assert.equal(image.status,302);
    assert.equal(image.headers.get('Cache-Control'),'no-store');
    const target=new URL(image.headers.get('Location'));
    assert.equal(target.origin,mediaOrigin);
    assert.equal(target.searchParams.get('X-Amz-Expires'),'300');
    assert.deepEqual(mediaObjects.get(target.pathname),Buffer.from(jpeg,'base64'));
  }
  await verify(await get('/campaign-images/'+privateId),404);
  await verify(await get(privatePath),401);
  for (const [page,cookie] of [['/campaign/',undefined],['/members/aar/',alpha]]) {
    const response=await get(page,cookie);
    assert.equal(response.status,200);
    assert.ok(response.headers.get('Content-Security-Policy').includes('img-src') &&
      response.headers.get('Content-Security-Policy').includes(mediaOrigin));
    await response.body.cancel();
  }

  assert.equal((await verify(await get(endpoint+'?view=taskings',alpha))).taskings[0].id,taskId);
  const posted=await verify(await post(command,{action:'order',event:'sunday:'+futureId,revision:0,title:'Game orders',
    brief:'Background',objectives:'Game objective',findings:[],sections:{},publish:true}));
  assert.deepEqual(posted,{});
  const nextOrders=(await verify(await get(memberApi,alpha))).nextAction;
  assert.equal(nextOrders.heading,'Read your orders');
  assert.equal(new URL(nextOrders.link.href,origin).searchParams.get('event'),'sunday:'+futureId);
  await verify(await post(command,{action:'game-brief',event:'sunday:'+futureId,revision:0,assignees:[uid.gm],
    discretion:'Private GM constraints',branches:[{title:'Branch A'}],findings:[],publish:true}));
  assert.equal((await verify(await get(endpoint+'?view=gm',gm))).events.length,1);
  assert.equal((await verify(await get(endpoint+'?view=gm',ordinary))).events,undefined);
  await verify(await post(command,{action:'member-adjustment',member:uid.ordinary,kind:'seasoned',mode:'grant',reason:'Verified operations'}));
  await deliveries();
  assert.equal(captures.dms.filter(item=>item.id===uid.command&&item.message.content?.includes('&nomination='+nominationId)).length,1);
  const file=JSON.parse(readFileSync(resolve(bot,'basic-training-sessions.json'),'utf8'));
  assert.equal(file.t1done.results[uid.student].result,'passed');
  await delay(1200);
  assert.equal((await verify(await get(memberApi,student))).nextAction.heading,'Book Basic Training T2');
  assert.equal(file[schedule].unitQualification,'machine gunner');
  assert.equal(file[schedule].recruitSlots,3);
  assert.ok(captures.dms.some(item=>item.id===uid.student&&item.message.embeds?.[0]?.title.includes('Passed')));
  assert.deepEqual(captures.dms.filter(item=>item.message.content?.includes(taskLink)).map(item=>item.id).sort(),
    [uid.alice,uid.bravo,uid.charlie].sort());
  assert.equal(captures.dms.filter(item=>item.message.content?.includes('SOAR game task')).at(0).id,uid.pilot);
  assert.ok(captures.dms.some(item=>item.id===uid.gm&&item.message.content?.includes('view=gm&event=')));
  assert.ok(captures.channels.some(item=>item.id===ordersChannel&&item.message.content?.includes('Orders v1')));
  assert.ok(captures.channels.some(item=>item.id===privateChannel&&item.message.content?.includes('Tasking issued')));
  assert.ok(members.get(uid.ordinary).roles.cache.has(rid.seasoned));
  const queue=new DatabaseSync(resolve(bot,'unit-operations.sqlite'),{readOnly:true});
  assert.deepEqual(queue.prepare("SELECT id,error FROM unit_jobs WHERE status='failed'").all(),[]);
  // Enable enforcement only against the fake Discord connection, confirm each week, and observe the real bridge.
  await verify(await post(command,{action:'settings',roles:{gm:rid.gm,t1:rid.t1,t2:rid.t2,heavy:rid.heavy,seasoned:rid.seasoned},
    channel:privateChannel,policy:true}));
  for (let index=0;index<7;index++) {
    await verify(await post(command,{action:'register',event:'sunday:closed-'+index,version:0,counts:true,confirm:true,
      marks:{[uid.ordinary]:'absent'}}));
    if (index===5) assert.equal(captures.kicks.length,0);
  }
  await deliveries(16);
  assert.deepEqual(captures.kicks,[uid.ordinary]);
  const removed=JSON.parse(readFileSync(resolve(bot,'sunday-rosters.json'),'utf8')).participation[uid.ordinary];
  assert.ok(removed.removedAt);
  assert.ok(captures.dms.some(item=>item.id===uid.ordinary&&item.message.content?.includes('formal warning')||
    item.id===uid.ordinary&&item.message.content?.includes('Formal warning')));

  // All six event reminder phases, repeated tick, and exclusion of LOA/awaiting confirmation.
  const remind=ticks.get(20000).at(-1);
  for (const minutes of [1440,720,360,60,15,5]) {
    clock=start-minutes*60000;
    remind(); await delay(50); remind(); await delay(30);
  }
  const reminders=captures.dms.filter(item=>item.message.content?.includes('(reminder '));
  assert.equal(reminders.filter(item=>item.id===uid.alice).length,12);
  assert.equal(reminders.filter(item=>item.id===uid.ordinary||item.id===uid.bravo).length,0);
  assert.deepEqual(new Set(reminders.map(item=>item.message.content.match(/\(reminder ([^)]+)/)[1])),new Set(['24h','12h','6h','1h','15m','5m']));
  const reminderClock=clock;
  clock=wall;
  await verify(await post(bravo,confirmStanding,'/api/member/action'));
  await verify(await post(bravo,confirmStanding,'/api/member/action'));
  assert.equal((await verify(await get(memberApi,bravo))).nextAction.heading,'Read your orders');
  clock=reminderClock;
  const upkeep=ticks.get(30000)[1];
  assert.equal(upkeep.name,'runMaintenance');
  const readSessions=()=>JSON.parse(readFileSync(resolve(bot,'basic-training-sessions.json'),'utf8'));
  const first=readSessions()[series];
  assert.equal(first.channelId,ordersChannel);
  assert.equal(first.trainingTrack,'squad');
  members.get(uid.pilot).roles.cache.set(rid.recruit,safeRole(rid.recruit));
  upkeep(); await delay(50); upkeep(); await delay(30);
  const invites=()=>captures.dms.filter(item=>item.message.content?.includes('Training invitation · Alpha Communications Practice'));
  assert.deepEqual(invites().map(item=>item.id).sort(),[uid.alice,uid.pilot].sort());
  const recruitInvites=()=>captures.dms.filter(item=>item.message.content?.includes('Training invitation · Recruit DM Basic Training'));
  assert.deepEqual(recruitInvites().map(item=>item.id).sort(),[uid.student,uid.pilot].sort());
  const actor=members.get(uid.alice);
  await globalThis.tagFixture.client.listeners('InteractionCreate')[0]({
    customId:'bt:recruit:'+series,isButton:()=>true,isChatInputCommand:()=>false,isStringSelectMenu:()=>false,isAutocomplete:()=>false,isModalSubmit:()=>false,
    guildId:everyone,member:actor,user:actor.user,message:{id:first.messageId,edit:async()=>{}},
    deferReply:async()=>{},editReply:async()=>{},
  });
  assert.equal(readSessions()[series].bookings[uid.alice],'recruit');
  clock=first.start+4*3600000-1;
  upkeep(); await delay(50);
  assert.ok(!readSessions()[series].repeatNext);
  clock++;
  members.get(uid.pilot).roles.cache.delete(rid.recruit);
  upkeep(); await delay(50); upkeep(); await delay(30);
  const completed=readSessions()[series];
  assert.ok(completed.cardRemoved);
  assert.equal(completed.bookings[uid.alice],'recruit');
  assert.ok(captures.deleted.some(item=>item.id===ordersChannel&&item.message===first.messageId));
  const repeat=readSessions()[completed.repeatNext];
  assert.equal(repeat.start-first.start,week);
  assert.equal(repeat.channelId,ordersChannel);
  assert.deepEqual(repeat.bookings,{});
  assert.deepEqual(invites().map(item=>item.id).sort(),[uid.alice,uid.alice,uid.pilot,uid.pilot].sort());
  assert.equal(readSessions()[readSessions()[basicSeries].repeatNext].inviteRecruits,true);
  assert.deepEqual(recruitInvites().map(item=>item.id).sort(),[uid.student,uid.student,uid.pilot].sort());
  const currentTrainer=await login('trainer');
  await verify(await post(currentTrainer,{action:'stop-training-series',event:'training:'+completed.repeatNext}));
  await deliveries();
  assert.equal(readSessions()[completed.repeatNext].repeatStopped,true);
  clock=repeat.start+4*3600000;
  upkeep(); await delay(50);
  assert.equal(readSessions()[completed.repeatNext].repeatNext,undefined);
  // Deleted announcement cards remain as attendance registers.
  const register=await verify(await get(endpoint+'?view=attendance',await login('trainer')));
  assert.ok(register.events.some(item=>item.key==='training:'+series&&item.register?.rows.some(row=>row.member===uid.alice)));
  const html=await verify(await get('/members/unit/?view=gm',await login('gm')));
  for(const route of [...html.matchAll(/(?:href|src)="([^"#?]+)(?:\?[^"]*)?"/g)].map(match=>match[1])) {
    assert.equal((await get(route,await login('gm'))).status,200,route);
  }
  console.log('Full stack passed: My Next Action, website and bot bridge, GM/tasking DMs, training result, role sync, channel delivery, OAuth deep links, six reminders, repeat training rollover, and campaign media upload, retry and access.');
  process.exit(0);
} catch(error) { console.error(error,captures);process.exit(1); }
