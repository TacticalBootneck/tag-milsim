import { defaultTitles, defaultSpecialties } from './unit-specialties.mjs';
import { commanderRole, decorationsView, honours, ribbonUrl } from './honours.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';

const day = 86400000;
const ukDay = new Intl.DateTimeFormat('sv-SE', {timeZone:'Europe/London',dateStyle:'short'});
const snowflake = /^\d{17,20}$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const eventKeys = /^(?:sunday|training):[a-zA-Z0-9-]{1,63}$/;
const statuses = ['attended','absent','loa','not-required'];
const outcomes = ['passed','retest','failed'];
export const specialties = {
  heavy:'Heavy Weapons Training Cadre', tacp:'TACP Training Cadre', dog:'Dog Handler Training Cadre',
  sniper:'Sniper Training Cadre', pilot:'Pilot Training Cadre', medical:'Medical Training Cadre',
  leadership:'Leadership Training Cadre', devgru:'DEVGRU Training Cadre', rrc:'RRC Training Cadre',
};
export class WorkflowError extends Error {
  constructor(message,status=400) { super(message); this.status=status; }
}
function check(value,message,status) { if (!value) throw new WorkflowError(message,status); }
function str(value,label,max,required=true) {
  const result = typeof value === 'string' ? value.trim() : '';
  check(result.length <= max && (!required || result),label+' '+(required?'is required and must be at most ':'must be at most ')+max+' characters.');
  return result;
}
function id(value,label) { check(typeof value==='string' && uuid.test(value),'Choose a valid '+label+'.'); return value; }
function role(value) {
  check(value==='' || typeof value==='string' && snowflake.test(value),'Enter a Discord ID or leave the field blank.');
  return value;
}
function date(value) {
  check(typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0,10)===value,'Choose a valid date.');
  return value;
}
function list(value,max,label) {
  check(Array.isArray(value) && value.length <= max,'Too many '+label+'.');
  return value;
}
export function weekOf(time) {
  const local = new Date(ukDay.format(time)+'T00:00:00Z');
  return +local - ((local.getUTCDay()+6)%7)*day;
}
const jobNonce = key => createHash('sha256').update(key).digest('hex').slice(0,25);
const unique = values => [...new Set(values)];
const olderFirst = (a,b) => a.start-b.start;
const activeMember = person => ['Full Member','Probationary'].includes(person?.status);

export function attendanceProgress(finalized,member,now,first=0) {
  const weeks = finalized.filter(event=>event.counts && event.start>=first && weekOf(event.start)>=weekOf(now)-9*7*day &&
    weekOf(event.start)<=weekOf(now) && event.marks[member] && event.marks[member]!=='not-required').sort(olderFirst);
  const absent = weeks.filter(event=>event.marks[member]==='absent').length;
  const loa = weeks.filter(event=>event.marks[member]==='loa').length;
  return {weeks:weeks.map(event=>({title:event.title,start:event.start,mark:event.marks[member]})),absent,loa,
    stage:absent>=7?4:absent>=5?3:absent>=4?2:absent>=3?1:0};
}

function extraSeatLimit(value) {
  check(Number.isInteger(value) && value >= 0 && value <= 9,'Choose zero to nine extra places.');
  return value;
}

export function createUnitOperations({dataDir,origin,context,sendJob,getChannels=async()=>[],now=Date.now}) {
  const filename=resolve(dataDir,'unit-operations.sqlite');
  let db;
  function storage() {
    if (db) return db;
    const mask=process.umask(0o077);
    try {
      db=new DatabaseSync(filename);
      db.exec(`PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS unit_state (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS unit_files (id TEXT PRIMARY KEY, name TEXT NOT NULL, bytes BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS unit_jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL, next INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', error TEXT);
        INSERT OR IGNORE INTO unit_state VALUES (1,'{"settings":{"legacyThrough":${now()},"roles":{},"policy":false,"channel":"","qualifications":{}},"courses":{},"assessments":{},"registers":{},"orders":{},"ready":{},"cases":{},"exemptions":{},"protection":{},"applications":{},"claims":{},"followups":{},"limits":{},"taskings":{},"adjustments":{},"gameBriefs":{}}');`);
      return db;
    } catch (error) { db?.close(); db=undefined; throw error; }
    finally { process.umask(mask); }
  }
  const read=()=>JSON.parse(storage().prepare('SELECT data FROM unit_state WHERE id=1').get().data);
  function transaction(fn) {
    const store=storage();
    store.exec('BEGIN IMMEDIATE');
    try {
      const state=read();
      const result=fn(state);
      store.prepare('UPDATE unit_state SET data=? WHERE id=1').run(JSON.stringify(state));
      store.exec('COMMIT');
      return result;
    } catch (error) {
      store.exec('ROLLBACK');
      throw error;
    }
  }
  function enqueue(key, type, data) {
    storage().prepare('INSERT OR IGNORE INTO unit_jobs (id,data,next) VALUES (?,?,?)')
      .run(key,JSON.stringify({type,...data}),now());
  }
  function notice(state,key,text,destination='staff',memberId,requiredRole) {
    enqueue('notice:'+key,'notify',{destination,memberId,requiredRole,channel:state.settings.channel,text:text.slice(0,1800)});
  }
  const link = (view,extra={}) => origin+'/members/unit/?'+new URLSearchParams({view,...extra});
  function charges(state,ctx,member) {
    const events=Object.values(state.registers).filter(row=>row.closedAt);
    const join=ctx.members[member]?.joined ?? 0;
    const t1 = new Set(), t2=new Set();
    for (const event of events.filter(row=>row.counts && row.start>=join && row.marks[member]==='attended')) {
      (event.kind==='operation'?t1:t2).add(event.key);
    }
    const claims=Object.values(state.claims).filter(item=>item.member===member && item.created>=join);
    const used=claims.filter(item=>!['returned','cancelled'].includes(item.status)).length;
    const manual=state.adjustments?.[member]?.credits??0;
    const operations=Math.max(0,t1.size+(manual-used)*5);
    const training=Math.max(0,t2.size+(manual-used)*5);
    return {operations,training,claims,available:operations>=5&&training>=5};
  }
  function serviceOperations(state,ctx,member) {
    let attended=ctx.members[member]?.historicalOperations??0;
    for (const event of Object.values(ctx.events)) {
      if (event.kind!=='operation' || event.start>now() || event.cancelled) continue;
      const official=state.registers[event.key];
      if ((official?.closedAt ? official.marks[member] : event.marks[member])==='attended') attended++;
    }
    return attended;
  }
  function seasonedEligible(state,ctx,member,discordRoles=[]) {
    const forced=state.adjustments?.[member]?.seasoned;
    if (forced==='grant') return true;
    if (forced==='revoke') return false;
    return Boolean(state.settings.roles.seasoned&&discordRoles.includes(state.settings.roles.seasoned)) ||
      ctx.members[member]?.status==='Full Member'&&serviceOperations(state,ctx,member)>=10;
  }
  function awardList(state,member) {
    const adjustments=state.adjustments?.[member]?.qualifications??{};
    const earned=Object.values(state.assessments).filter(item=>item.member===member && item.status==='passed').map(item=>item.qualification);
    return unique([...earned,...Object.keys(adjustments).filter(key=>adjustments[key]==='grant')]).filter(key=>adjustments[key]!=='revoke');
  }
  function qualification(state,key,ctx) {
    if (key==='t1' || key==='t2') return {name:'Basic Training '+key.toUpperCase(),...state.settings.qualifications[key],specialty:key};
    const base=ctx.qualifications[key];
    const configured=state.settings.qualifications[key];
    if (!base && !configured?.name && !Object.hasOwn(defaultTitles,key)) return null;
    return {name:base?.name??defaultTitles[key],discordRole:base?.discordRole,specialty:defaultSpecialties[key],
      applications:['jtac','devgru operator'].includes(key),seasoned:['jtac','devgru operator'].includes(key),...configured};
  }
  function qualifications(state,ctx) {
    return unique(['t1','t2',...Object.keys(defaultTitles),...Object.keys(ctx.qualifications),...Object.keys(state.settings.qualifications)])
      .map(key=>({key,...qualification(state,key,ctx)}));
  }
  function permissions(state,member,ctx) {
    const has=rid=>Boolean(rid && member.roles.includes(rid));
    const command=has(ctx.roles.command);
    const squadLeader=has(ctx.roles.squad);
    const leader=has(ctx.roles.team) || squadLeader;
    const gameMaster=has(state.settings.roles.gm);
    const instructors=state.settings.roles;
    const cadre=has(ctx.roles.cadre) || Object.keys(specialties).some(key=>has(instructors[key])) || has(instructors.t1) || has(instructors.t2);
    const assign=entry=>Boolean(entry && (['t1','t2'].includes(entry.specialty)
      ? has(instructors[entry.specialty])
      : entry.specialty && has(instructors[entry.specialty])));
    return {command,leader,squadLeader,cadre,gameMaster,assign,review:entry=>command || has(entry?.reviewer) || assign(entry) ||
      Boolean(entry && !entry.reviewer && !instructors[entry.specialty] && has(ctx.roles.cadre))};
  }
  function dashboardAccess(state,member,roles) {
    const {command,cadre,leader,squadLeader,gameMaster}=permissions(state,member,{roles});
    const reviews=command || cadre || Object.values(state.settings.qualifications).some(entry=>
      entry.reviewer && member.roles.includes(entry.reviewer));
    return {command,cadre,leader,squadLeader,gameMaster,reviews,honours:member.roles.includes(commanderRole)};
  }
  function ownsSquadSeries(event,actor,access,ctx) {
    return access.squadLeader && event.scheduleActor===actor && event.squadLeaderScope?.length>0 &&
      event.squadLeaderScope.every(key=>ctx.ledSquads?.includes(key));
  }
  function needEvent(ctx,key) {
    check(typeof key==='string' && eventKeys.test(key) && ctx.events[key] && !ctx.events[key].cancelled,'Choose an available event.',404);
    return ctx.events[key];
  }
  function needCourse(state,value) {
    const course=state.courses[id(value,'course')];
    check(course,'Course unavailable.',404);
    return course;
  }
  function addFile(upload) {
    check(upload && typeof upload==='object','Upload both course documents.');
    const name=str(upload.name,'Filename',150).replace(/[\r\n]/g,' ');
    const encoded=upload.data;
    check(/\.(pdf|pptx|docx|odt|odp)$/i.test(name) && typeof encoded==='string' && encoded.length<=7_000_004 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(encoded),'Choose a PDF, PowerPoint, Word or OpenDocument file up to 5 MB.');
    const bytes=Buffer.from(encoded,'base64');
    const matches=name.toLowerCase().endsWith('.pdf') ? bytes.subarray(0,5).toString()==='%PDF-' : bytes[0]===80 && bytes[1]===75 && bytes[2]===3 && bytes[3]===4;
    check(matches && bytes.length<=5_000_000,'The document type or size could not be verified.');
    const key=randomUUID();
    storage().prepare('INSERT INTO unit_files VALUES(?,?,?)').run(key,name,bytes);
    return {id:key,name};
  }
  function exemption(state,ctx,member,at) {
    const item=state.exemptions[member];
    return ctx.members[member]?.exempt || Boolean(item && item.start<=at && at<item.end);
  }
  function policy(state,ctx) {
    if (!state.settings.policy) return;
    const events=Object.values(state.registers).filter(row=>row.closedAt);
    for (const [member,person] of Object.entries(ctx.members)) {
      if (!activeMember(person) || person.required===false) continue;
      const progress=attendanceProgress(events,member,now(),person.activeSince || person.joined || 0);
      const caseRecord=state.cases[member] ?? {episode:randomUUID(),stage:0,history:[],joined:person.joined};
      if (caseRecord.joined && person.joined && caseRecord.joined!==person.joined) {
        state.cases[member]={episode:randomUUID(),stage:0,history:caseRecord.history,joined:person.joined};
        continue;
      }
      const covered=exemption(state,ctx,member,now()) || caseRecord.hold;
      const loas=progress.weeks.filter(item=>item.mark==='loa').map(item=>weekOf(item.start));
      const reviewed=state.protection[member] ?? [];
      const needsReview=loas.length>2 && loas.some(item=>!reviewed.includes(item));
      if (needsReview && !caseRecord.review) {
        notice(state,'loa-review:'+member+':'+loas.join(','),'An attendance case needs Command review (three or more approved LOA weeks). '+link('command'));
      }
      caseRecord.review=needsReview;
      if (!progress.stage && caseRecord.stage) {
        caseRecord.stage=0;
        caseRecord.episode=randomUUID();
      }
      if (progress.stage || caseRecord.history.length || needsReview || covered) state.cases[member]=caseRecord;
      if (covered || needsReview || !progress.stage || progress.stage<=caseRecord.stage) continue;
      const stage=progress.stage;
      const word=stage===4?'Removal threshold reached':stage===3?'Formal warning 3 · standing roster removal':'Formal warning '+stage;
      caseRecord.stage=stage;
      caseRecord.history.push({stage,title:word,at:now(),missed:progress.absent,loa:progress.loa});
      notice(state,'policy:'+member+':'+caseRecord.episode+':'+stage,
        'TAG attendance updated: '+word+'. Open your attendance record: '+link('progress'),'member',member);
      notice(state,'policy-staff:'+member+':'+caseRecord.episode+':'+stage,word+' · '+person.name+'. '+link('command'));
      if (stage>=3) enqueue('policy-slot:'+member+':'+caseRecord.episode,'policy',{member,stage:3,episode:caseRecord.episode,joined:person.joined});
      if (stage>=4) enqueue('policy-remove:'+member+':'+caseRecord.episode,'policy',{member,stage:4,episode:caseRecord.episode,joined:person.joined});
    }
  }
  function policyJobStillAllowed(state,ctx,job) {
    const person=ctx.members[job.member];
    const entry=state.cases[job.member];
    if (!state.settings.policy || !activeMember(person) || person.required===false || person.joined!==job.joined || entry?.episode!==job.episode ||
      entry.hold || entry.review || exemption(state,ctx,job.member,now())) return false;
    return attendanceProgress(Object.values(state.registers).filter(row=>row.closedAt),job.member,now(),person.activeSince || person.joined || 0).stage>=job.stage;
  }
  function progression(state,ctx) {
    for (const [member,person] of Object.entries(ctx.members)) {
      if (person.status!=='Full Member') continue;
      const operations=serviceOperations(state,ctx,member);
      const serviceKey=person.probationAt>=person.joined&&person.probationAt || person.joined || 0;
      if (operations>=10 && state.adjustments?.[member]?.seasoned!=='revoke') {
        if (state.settings.roles.seasoned) enqueue('seasoned-role:'+member+':'+serviceKey+':'+state.settings.roles.seasoned,
          'role',{member,role:state.settings.roles.seasoned,source:'seasoned'});
        notice(state,'seasoned:'+member+':'+serviceKey,'You earned Seasoned Member and can now apply for eligible qualifications. '+link('applications'),'member',member);
      }
      if (operations>=30 && state.settings.roles.veteran) {
        enqueue('veteran-role:'+member+':'+serviceKey+':'+state.settings.roles.veteran,
          'role',{member,role:state.settings.roles.veteran,source:'veteran'});
      }
      if (charges(state,ctx,member).available) {
        const progress=charges(state,ctx,member);
        const cycle=progress.claims.filter(item=>item.status==='used').length;
        notice(state,'award:'+member+':'+(person.joined??0)+':'+cycle,'You have an attendance reward available. Choose an extra in-game life or a priority course place. '+link('progress'),'member',member);
      }
    }
  }
  const registration = (event,state,ctx) => {
    const existing=state.registers[event.key];
    const people=new Set([...event.people,...Object.keys(event.marks)]);
    if (['operation','training'].includes(event.kind)) {
      for (const [id,person] of Object.entries(ctx.members)) {
        if (activeMember(person) && (person.activeSince || person.joined || Infinity)<=event.start && person.required!==false) people.add(id);
      }
    }
    return {
      key:event.key,title:event.title,start:event.start,kind:event.kind,version:existing?.version??0,closedAt:existing?.closedAt,
      counts:existing?.counts??['operation','training'].includes(event.kind),
      rows:(existing?.closedAt ? Object.keys(existing.marks) : [...people]).map(member=>({
        member,name:ctx.members[member]?.name ?? 'Member '+member.slice(-6),candidate:event.candidates.includes(member),
        mark:existing?.marks[member] || event.marks[member] || (event.onLeave(member)?'loa':''),
        result:event.results[member]?.result ?? '',
      })).sort((a,b)=>a.name.localeCompare(b.name)),
    };
  };
  function publicOrder(order,privateView) {
    return {event:order.event,revision:order.revision??order.draft?.revision??order.published?.revision??0,published:order.published,history:order.history,acks:order.acks,
      ...(privateView?{draft:order.draft,review:order.review}: {})};
  }
  function overview(state,ctx,member,access,view) {
    const self=member.user.id;
    const all=qualifications(state,ctx);
    const approved=key=>Object.values(state.applications).some(item=>item.member===self && item.qualification===key && item.status==='approved');
    const eligible = key => {
      const qual=qualification(state,key,ctx);
      return qual && !['t1','t2'].includes(key) && (!qual.seasoned || seasonedEligible(state,ctx,self,member.roles)) &&
        (!qual.applications || approved(key));
    };
    const events=Object.values(ctx.events).filter(event=>!event.cancelled).sort((a,b)=>b.start-a.start);
    const canStaff=access.command || access.cadre;
    const protectedAssessments=Object.values(state.assessments).filter(item=>item.member!==self &&
      ((access.cadre && access.assign(qualification(state,item.qualification,ctx))) || (access.leader || access.cadre) && item.status!=='draft'));
    const memberCase=state.cases[self];
    const navigation=dashboardAccess(state,member,ctx.roles);
    const payload={access:navigation,
      views:[...new Set(['orders','taskings','applications','progress','honours',...(access.leader?['records']:[]),...(access.cadre?['courses','records']:access.command?['courses']:[]),
        ...(canStaff||access.squadLeader?['training']:[]),...(canStaff?['attendance']:[]),...(access.command||access.gameMaster?['gm']:[]),...(access.command?['command','application-forms']:[]),
        ...(navigation.reviews?['application-review']:[]),...(navigation.honours?['honours-review']:[])])],
      member:member.user.id};
    if (view==='honours' || view==='honours-review' && navigation.honours) {
      const commander = view==='honours-review';
      payload.honours = Object.entries(honours).map(([key,value])=>({key,...value,image:ribbonUrl(key)}));
      payload.nominees = Object.values(ctx.members).filter(person=>person.id!==self)
        .map(({id,name})=>({id,name})).sort((a,b)=>a.name.localeCompare(b.name));
      payload.operations = events.filter(event=>event.kind==='operation' && event.start<=now()).slice(0,100)
        .map(({key,title,start})=>({key,title,start}));
      payload.honoursReview = commander;
      if (commander) {
        payload.nominations = Object.values(state.honourNominations??{}).reverse().map(item=>({
          ...item,memberName:ctx.members[item.member]?.name??'Former member',submittedBy:ctx.members[item.actor]?.name??'Former member',
          operation:ctx.events[item.event]?.title??null,
        }));
      }
    }
    if (view==='orders') {
      payload.events=events.filter(event=>['operation','training'].includes(event.kind) &&
        (canStaff || access.leader || event.start>=now()-14*day || state.orders[event.key]?.published)).map(event=>({
          key:event.key,title:event.title,start:event.start,kind:event.kind,groups:event.groups,
          order:state.orders[event.key] ? publicOrder(state.orders[event.key],access.command||access.leader&&event.leaderMembers[self]?.length>0) : null,
          ...(access.command||access.leader?{
            lineup:event.lineup.map(item=>({...item,status:event.onLeave(item.member)?'LOA':item.status})),
            ready:state.ready[event.key]??{},
            redemptions:Object.values(state.claims).filter(claim=>claim.event===event.key && claim.kind==='life' && ['reserved','used'].includes(claim.status))
              .map(({id,member,status})=>({id,name:ctx.members[member]?.name ?? 'Member',status,member})),
            expected:event.leads,
          }:{}),
          myGroups:event.memberships[self]??[],canAcknowledge:access.leader&&(event.leaderMembers[self]?.length??0)>0,leaderGroups:event.leaderMembers[self]??[],
          canNewAar:ctx.canAar,
        }));
      payload.findings=access.command?ctx.findings:[];
      payload.map=ctx.map;
      payload.followups=access.command||access.leader?Object.values(state.followups):[];
      payload.owners=access.command?Object.values(ctx.members).map(({id,name})=>({id,name})):[];
    }
    if (['courses','records'].includes(view) && (access.cadre||access.leader||access.command)) {
      payload.courses=access.cadre||access.command?Object.values(state.courses).filter(course=>
        access.command||access.assign(qualification(state,course.qualification,ctx))).map(course=>({...course,
          canAssess:access.cadre&&access.assign(qualification(state,course.qualification,ctx))})):[];
      payload.qualifications=all.filter(row=>access.command||access.assign(row)).map(({key,name})=>({key,name}));
      payload.assessments=protectedAssessments;
      payload.events=access.cadre?events.filter(event=>event.qualification && access.assign(qualification(state,event.qualification,ctx)))
        .map(event=>({key:event.key,title:event.title,start:event.start,qualification:event.qualification,candidates:event.candidates})): [];
      payload.people=Object.values(ctx.members).filter(person=>person.id!==self).map(({id,name})=>({id,name}));
    }
    if (view==='gm' && (access.command||access.gameMaster)) {
      payload.gameMasters=access.command?Object.values(ctx.members).filter(person=>state.settings.roles.gm&&
        person.roleIds?.includes(state.settings.roles.gm)).map(({id,name})=>({id,name})):[];
      payload.events=events.filter(event=>event.kind==='operation' && (access.command ||
        state.gameBriefs?.[event.key]?.published?.assignees.includes(self))).map(event=>{
        const brief=state.gameBriefs?.[event.key];
        return {key:event.key,title:event.title,start:event.start,closed:Boolean(state.registers[event.key]?.closedAt),order:state.orders[event.key]?.published?.title,
          brief:brief?{revision:brief.revision,published:brief.published,...(access.command?{draft:brief.draft}:{}),
            choices:Object.fromEntries(Object.entries(brief.choices).filter(([id,row])=>id===self||access.command&&row.sharedAt))}:null};
      });
      payload.findings=access.command?ctx.findings:[];
    }
    if (view==='taskings') {
      payload.units=access.command?Object.entries(ctx.units).map(([key,name])=>({key,name,leaders:(ctx.unitLeaders[key]??[]).map(id=>ctx.members[id]?.name??'Roster lead')})):[];
      payload.taskings=Object.values(state.taskings??{}).filter(task=>access.command ||
        !task.archivedAt && (task.recipients.includes(self) || ctx.unitLeaders[task.unit]?.includes(self))).sort((a,b)=>b.created-a.created)
        .map(task=>({...task,deliveries:access.command?task.recipients.map(id=>storage().prepare('SELECT status FROM unit_jobs WHERE id=?').get('notice:task:'+task.id+':'+task.revision+':'+id)).filter(Boolean):undefined}));
      payload.aars=ctx.reports;
      payload.canAar=ctx.canAar;
      payload.canViewCampaign=Boolean(ctx.campaign);
    }
    if (view==='application-forms' && access.command) {
      payload.qualifications=all.filter(item=>!['t1','t2'].includes(item.key)).map(({key,name,applications,seasoned,reviewer})=>({
        key,name,applications,seasoned,reviewer,form:state.settings.applicationForms?.[key],
      })).sort((a,b)=>a.name.localeCompare(b.name));
    }
    if (view==='applications' || view==='application-review' && navigation.reviews) {
      const reviewing=view==='application-review';
      const ops=serviceOperations(state,ctx,self);
      payload.seasoned=seasonedEligible(state,ctx,self,member.roles);
      payload.operations=ops;
      payload.qualifications=all.filter(item=>item.applications&&!['t1','t2'].includes(item.key))
        .map(({key,name,seasoned})=>({key,name,seasoned,form:state.settings.applicationForms?.[key]}))
        .sort((a,b)=>a.name.localeCompare(b.name));
      payload.applications=Object.values(state.applications).filter(item=>reviewing
        ? (access.command||item.member!==self) && access.review(qualification(state,item.qualification,ctx)) : item.member===self)
        .map(item=>({...item,canReview:reviewing&&item.member!==self,
          name:ctx.members[item.member]?.name ?? 'Former member',qualificationName:qualification(state,item.qualification,ctx)?.name ?? item.qualification}));
    }
    if (view==='progress') {
      payload.operations=serviceOperations(state,ctx,self);
      payload.seasoned=seasonedEligible(state,ctx,self,member.roles);
      payload.veteran=Boolean(state.settings.roles.veteran&&member.roles.includes(state.settings.roles.veteran)) ||
        ctx.members[self]?.status==='Full Member'&&payload.operations>=30;
      payload.rewards=charges(state,ctx,self);
      payload.qualifications=awardList(state,self).map(key=>qualification(state,key,ctx)?.name??key);
      payload.attendance=attendanceProgress(Object.values(state.registers).filter(row=>row.closedAt),self,now(),ctx.members[self]?.activeSince||ctx.members[self]?.joined||0);
      payload.warnings=memberCase?.history ?? [];
      payload.reserveRequest=memberCase?.reserveRequest;
      payload.canRequestReserves=activeMember(ctx.members[self]);
      payload.held=Boolean(memberCase?.hold||memberCase?.review||exemption(state,ctx,self,now()));
      payload.options=events.filter(event=>event.start>now()&&!(event.onLeave(self))).flatMap(event=>{
        if (event.kind==='operation' && (state.limits[event.key]??0)>0 && event.confirmed.includes(self)) return [{key:event.key,title:event.title,start:event.start,kind:'life'}];
        if (event.qualification && eligible(event.qualification) && event.standardFull && !event.candidates.includes(self) &&
          event.priorityCount < (state.limits[event.key] ?? event.priorityLimit ?? 1)) return [{key:event.key,title:event.title,start:event.start,kind:'course'}];
        return [];
      });
    }
    if (view==='training' && (canStaff||access.squadLeader)) {
      payload.squadOnly=!canStaff;
      payload.types=[{key:'squad',name:'Squad training'},...(canStaff?[{key:'unit',name:'Unit training'},
        ...all.filter(qual=>access.command||access.assign(qual)).map(({key,name})=>({key,name}))]:[])];
      payload.squads=(ctx.squads??[]).filter(item=>canStaff||ctx.ledSquads?.includes(item.key));
      payload.people=canStaff?Object.values(ctx.members).map(({id,name})=>({id,name})).sort((a,b)=>a.name.localeCompare(b.name)):[];
      payload.series=events.filter(event=>event.kind==='course'&&event.repeat&&event.start>now()&&!event.repeatStopped&&
        (canStaff||ownsSquadSeries(event,self,access,ctx)))
        .map(event=>{
          const {id,key,title,start,repeat,qualification}=event;
          return {id,key,title,start,repeat,canStop:access.command||ownsSquadSeries(event,self,access,ctx)||
            (qualification?access.assign(all.find(item=>item.key===qualification)):access.cadre)};
        });
    }
    if (view==='attendance' && canStaff) {
      payload.courseTemplates=Object.values(state.courses).filter(course=>access.assign(qualification(state,course.qualification,ctx)))
        .map(({id,name,qualification})=>({id,name,qualification}));
      payload.events=events.map(event=>({key:event.key,title:event.title,start:event.start,kind:event.kind,
        qualification:event.qualification,basicStage:event.basicStage,canSignoff:access.assign(qualification(state,event.qualification,ctx)),
        ...(event.start<=now()?{register:registration(event,state,ctx)}:{priorityLimit:state.limits[event.key] ?? event.priorityLimit ?? 1,life:(state.limits[event.key]??0)>0})}));
    }
    if (view==='command' && access.command) {
      payload.settings=state.settings;
      payload.adjustments=state.adjustments??{};
      payload.qualifications=all;
      payload.people=Object.values(ctx.members).map(({id,name})=>({id,name}));
      payload.cases=Object.entries(state.cases).filter(([id,row])=>ctx.members[id]&&(row.stage||row.review||row.hold||row.reserveRequest?.status==='pending'))
        .map(([id,row])=>({id,name:ctx.members[id].name,...row,exemption:state.exemptions[id],
          attendance:attendanceProgress(Object.values(state.registers).filter(row=>row.closedAt),id,now(),ctx.members[id].activeSince||ctx.members[id].joined||0)}));
      payload.inbox={
        vacancies:ctx.vacancies,
        applications:Object.values(state.applications).filter(item=>item.status==='pending').length,
        overdue:Object.values(state.followups).filter(item=>!item.closedAt&&item.due<ukDay.format(now())),
        taskings:Object.values(state.taskings??{}).filter(item=>!item.closedAt&&!item.archivedAt&&item.aarDeadline<ukDay.format(now())).length,
      };
      payload.delivery=storage().prepare("SELECT id,status,attempts,error FROM unit_jobs WHERE status IN ('pending','failed') ORDER BY next LIMIT 75").all();
    }
    payload.views=unique(payload.views);
    return payload;
  }
  function saveAssessment(state,ctx,access,actor,input) {
    const existing = input.id ? state.assessments[id(input.id,'assessment')] : null;
    check(!input.id || existing,'Assessment unavailable.',404);
    const course=needCourse(state,input.course ?? existing?.course);
    check(existing||!course.archivedAt,'Restore the course before assigning an assessment.',409);
    const qualificationKey=course.qualification;
    check(!existing || existing.course===course.id,'An existing assessment keeps its original course.');
    check(access.cadre&&access.assign(qualification(state,qualificationKey,ctx)),'The matching Training Cadre role is required.',403);
    check(!existing || existing.status==='draft','Completed assessments are kept as history. Create another attempt.',409);
    const candidate=existing?.member??input.member;
    check(ctx.members[candidate] && candidate!==actor,'Choose another screened TAG member.');
    const event=needEvent(ctx,existing?.event??input.event);
    check(event.qualification===qualificationKey,'Choose a session for this qualification.');
    check(event.start<=now() || input.status==='draft','Sign off a session after it has started.');
    check(['draft',...outcomes].includes(input.status),'Choose an assessment result.');
    const previous=existing?.previous??input.previous;
    if (previous) {
      const attempt = state.assessments[id(previous,'previous assessment')];
      check(attempt?.member===candidate && attempt.qualification===qualificationKey && ['retest','failed'].includes(attempt.status),'Choose a completed retest or failed attempt for this candidate.');
    }
    const form=existing?.lines??course.criteria;
    const values=list(input.lines??[],form.length,'assessment lines');
    check(values.every(item=>item&&typeof item==='object'),'Enter valid assessment lines.');
    const entry={
      id:existing?.id??randomUUID(),course:course.id,courseName:course.name,qualification:qualificationKey,
      member:candidate,memberName:ctx.members[candidate].name,event:event.key,eventName:event.title,
      title:str(input.title??existing?.title??course.formTitle,'Assessment title',120),previous,
      author:existing?.author??actor,assessor:actor,created:existing?.created??now(),updated:now(),status:input.status,
      summary:str(input.summary,'Feedback summary',2400,false),
      lines:form.map(({title,description},index)=>({title,description,
        assessment:str(values[index]?.assessment,'Assessment',1200,false),feedback:str(values[index]?.feedback,'Feedback',1600,false)})),
    };
    check(!Object.values(state.assessments).some(item=>item.id!==entry.id && item.member===candidate &&
      item.event===event.key && item.qualification===qualificationKey && item.status!=='draft' && !previous)
      || input.status==='draft','A result already exists. Use New retest for another attempt.',409);
    if (!existing || existing.updated===(input.updated??existing.updated)) state.assessments[entry.id]=entry;
    else throw new WorkflowError('The draft changed. Reopen it before saving.',409);
    if (entry.status!=='draft') {
      const qual=qualification(state,qualificationKey,ctx);
      if (event.basicStage) {
        check(event.candidates.includes(candidate),'Only a booked candidate can be signed off for Basic Training.');
        if (event.basicStage==='t2' && entry.status==='passed') {
          check(Object.values(ctx.events).some(item=>item.basicStage==='t1' && item.results[candidate]?.result==='passed'),
            'The candidate needs a completed T1 pass first.');
          check(['','rangers','pilot'].includes(input.route??''),'Choose the Rangers or Pilot route.');
        }
        enqueue('basic:'+entry.id,'basic',{actor,member:candidate,event:event.id,result:entry.status,route:input.route??''});
      } else {
        enqueue('specialist:'+entry.id,'specialist',{actor,member:candidate,event:event.id,result:entry.status,qualification:qualificationKey,
          assessment:entry.id,recordedAt:entry.updated});
        if (qual.discordRole && entry.status==='passed') enqueue('qualification:'+entry.id,'role',
          {member:candidate,role:qual.discordRole,source:'qualification',qualification:qualificationKey});
      }
      notice(state,'assessment:'+entry.id,'A candidate assessment has been completed. Authorised instructors and leaders can review it on the website. '+link('records'));
    }
    return entry.id;
  }

  function mutate(state,ctx,member,input) {
    const access=permissions(state,member,ctx);
    const actor=member.user.id;
    const staff=access.command||access.cadre;
    const getOrder=event=>state.orders[event.key]??={event:event.key,history:[],acks:{},review:{}};
    switch (input.action) {
      case 'honour-nomination': {
        const key=id(input.id,'nomination');
        const nominations=state.honourNominations??={};
        if (nominations[key]?.actor===actor) return {id:key};
        check(!nominations[key],'This nomination already exists.',409);
        check(input.member!==actor && snowflake.test(input.member??'') && Object.hasOwn(ctx.members,input.member),'Choose another TAG member.');
        check(Object.hasOwn(honours,input.award),'Choose a TAG honour.');
        const detail=str(input.detail,'Recommendation',3000);
        const event=input.event ? needEvent(ctx,input.event) : null;
        check(event ? event.kind==='operation' && event.start<=now() : input.award==='commendation',
          'Choose a completed main operation for this honour.');
        const commanders=Object.values(ctx.members).filter(person=>person.roleIds?.includes(commanderRole));
        check(commanders.length,'The TAG Commander role has not appeared in the Discord member sync yet.',503);
        nominations[key]={id:key,member:input.member,actor,suggested:input.award,event:event?.key??null,
          detail,evidence:str(input.evidence,'Witness or clip',600,false),submittedAt:now(),status:'pending'};
        for (const commander of commanders) {
          notice(state,'honour:'+key+':'+commander.id,'A TAG member has been recommended for an honour. Review it privately: '+
            link('honours-review')+'&nomination='+key,'member',commander.id,commanderRole);
        }
        return {id:key};
      }
      case 'honour-review': {
        check(member.roles.includes(commanderRole),'TAG Commander access required.',403);
        const nomination=state.honourNominations?.[id(input.id,'nomination')];
        check(nomination?.status==='pending','This nomination has already been reviewed or is unavailable.',409);
        check(['approved','declined'].includes(input.status),'Choose a decision.');
        if (input.status==='approved') {
          check(Object.hasOwn(honours,input.award),'Choose the honour to award.');
          nomination.award=input.award;
          nomination.citation=str(input.citation,'Award citation',2000);
        }
        Object.assign(nomination,{status:input.status,reviewer:actor,reviewedAt:now()});
        return {id:nomination.id};
      }
      case 'settings': {
        check(access.command,'Command access required.',403);
        const roles={};
        for (const key of ['t1','t2','seasoned','veteran','gm',...Object.keys(specialties)]) roles[key]=role(input.roles?.[key]??(key==='veteran'?state.settings.roles.veteran??'':''));
        check(!roles.t1 || !roles.t2 || roles.t1!==roles.t2,'Configure separate T1 and T2 roles.');
        check(!Object.values(roles).some(value=>value&&[ctx.roles.command,ctx.roles.cadre,ctx.guild].includes(value)),'Use distinct Discord roles for specialist cadre and Seasoned Member.');
        check(!roles.seasoned || !Object.entries(roles).some(([key,value])=>key!=='seasoned'&&value===roles.seasoned),
          'Seasoned Member must have a separate role.');
        check(!roles.veteran || !Object.entries(roles).some(([key,value])=>key!=='veteran'&&value===roles.veteran),
          'Veteran Member must have a separate role.');
        check(!roles.gm || !Object.entries(roles).some(([key,value])=>key!=='gm'&&value===roles.gm),'Game Master must have a separate role.');
        check(!input.policy || input.channel,'Set a private Command channel before enabling enforcement.');
        const previousChannel=state.settings.channel;
        Object.assign(state.settings,{roles,channel:role(input.channel??''),policy:input.policy===true});
        if (state.settings.channel && previousChannel!==state.settings.channel) {
          storage().prepare("UPDATE unit_jobs SET status='pending',error=NULL,next=? WHERE status='failed' AND error='CHANNEL_REQUIRED'").run(now());
        }
        notice(state,'settings:'+randomUUID(),'Training and attendance settings updated. '+link('command'));
        return {};
      }
      case 'qualification': {
        check(access.command,'Command access required.',403);
        const key=str(input.key,'Qualification key',80).toLowerCase();
        check(/^[a-z0-9][a-z0-9 _-]*$/.test(key),'Use letters, numbers, spaces or hyphens for the qualification key.');
        check(['','t1','t2',...Object.keys(specialties)].includes(input.specialty),'Choose a cadre specialty.');
        check((key==='t1'||key==='t2') ? input.specialty===key : !['t1','t2'].includes(input.specialty),'Basic Training stages use their own cadre roles.');
        const discordRole=role(input.discordRole??'');
        check(!discordRole || ![ctx.guild,ctx.roles.command,ctx.roles.cadre,ctx.roles.team,ctx.roles.squad,
          ...Object.values(state.settings.roles)].includes(discordRole),'Choose a qualification role separate from staff or leadership access.');
        state.settings.qualifications[key]={name:str(input.name,'Qualification name',100),
          specialty:input.specialty,reviewer:role(input.reviewer??''),discordRole,
          applications:input.applications===true,seasoned:input.seasoned===true};
        return {};
      }
      case 'course': {
        const qualificationKey=str(input.qualification,'Qualification',80);
        check(access.command||access.cadre&&access.assign(qualification(state,qualificationKey,ctx)),'The matching Training Cadre role is required.',403);
        const prior=input.id ? needCourse(state,input.id) : null;
        check(!prior||prior.qualification===qualificationKey,'A course’s qualification cannot be changed.');
        const criteria=list(input.criteria,50,'criteria').map(row=>{
          check(row&&typeof row==='object','Enter valid criteria.');
          return {title:str(row.title,'Criterion title',120),description:str(row.description,'Criterion description',1600,false)};
        });
        check(criteria.length,'Add at least one assessment criterion.');
        check(!prior || prior.version===input.version,'The course changed. Reopen it before saving.',409);
        const course={id:prior?.id??randomUUID(),qualification:qualificationKey,
          name:str(input.name,'Course name',120),formTitle:str(input.formTitle,'Assessment form title',120),criteria,
          presentation: input.presentation ? addFile(input.presentation) : prior?.presentation ?? addFile(null),
          guide: input.guide ? addFile(input.guide) : prior?.guide ?? addFile(null),
          version:(prior?.version??0)+1,archivedAt:prior?.archivedAt??null,updated:now()};
        state.courses[course.id]=course;
        const referenced=new Set(Object.values(state.courses).flatMap(item=>[item.presentation.id,item.guide.id]));
        for (const document of prior?[prior.presentation,prior.guide]:[]) {
          if (!referenced.has(document.id)) storage().prepare('DELETE FROM unit_files WHERE id=?').run(document.id);
        }
        notice(state,'course:'+course.id+':'+course.version,'Course materials updated: '+course.name+'. '+link('courses'));
        return {id:course.id};
      }
      case 'course-archive': {
        const course=needCourse(state,input.course);
        check(access.command||access.assign(qualification(state,course.qualification,ctx)),'The matching Training Cadre role is required.',403);
        course.archivedAt=input.restore===true?null:now();
        return {};
      }
      case 'stop-training-series': {
        const event=needEvent(ctx,input.event);
        const qual=qualification(state,event.qualification,ctx);
        check(event.repeat && !event.repeatStopped,'This training has no active repeat schedule.',409);
        check(access.command||ownsSquadSeries(event,actor,access,ctx)||access.cadre&&(!event.qualification||access.assign(qual)),
          'Only the Squad Leader who scheduled the session or authorised training staff can stop the repeat.',403);
        enqueue('stop-training:'+event.id,'stop-training',{actor,event:event.id});
        return {};
      }
      case 'schedule-training':
      case 'schedule-course': {
        const course=input.action==='schedule-course'?needCourse(state,input.course):null;
        const key=course?.qualification??str(input.training,'Training type',80);
        const generic=['squad','unit'].includes(key);
        const qual=qualification(state,key,ctx);
        check(generic||qual,'Choose a training type.');
        const canStaff=access.command||access.cadre&&(generic||access.assign(qual));
        const squadOnly=!canStaff&&access.squadLeader&&key==='squad'&&!course;
        check(canStaff||squadOnly,'Only Squad Leaders can schedule their squad training. Other training requires matching Cadre access.',403);
        check(!course?.archivedAt,'Restore the course before scheduling a session.',409);
        const title=str(input.title??course?.name,'Training name',120);
        const repeat=input.repeat??'none';
        check(['none','daily','weekly','fortnightly','four-weekly','monthly'].includes(repeat),'Choose a repeat option.');
        const channel=role(input.channel??'');
        const squads=unique(list(input.squads??[],50,'selected squads'));
        const people=unique(list(input.people??[],500,'selected members'));
        const inviteRecruits=input.inviteRecruits===true;
        const ledSquads=ctx.ledSquads??[];
        if (squadOnly) {
          check(ledSquads.length && squads.every(key=>ledSquads.includes(key)) && !people.length && !inviteRecruits,
            'Squad Leaders must have an active Squad Leader roster slot and can only invite their own squad.',403);
        }
        check(!inviteRecruits||['t1','t2'].includes(key),'Recruit role invitations are available for Basic Training.');
        check(squads.every(key=>ctx.squads?.some(item=>item.key===key))&&people.every(key=>Object.hasOwn(ctx.members,key)),
          'Choose existing squads and TAG members.');
        const event=id(input.id,'event');
        const [hours,minutes]=String(input.time??'').split(':').map(Number);
        check(/^\d{2}:\d{2}$/.test(input.time??'') && hours>=0&&hours<24&&minutes>=0&&minutes<60,'Choose a valid UK time.');
        const eventDay=date(input.day);
        const utc=Date.parse(eventDay+'T'+input.time+':00Z');
        const london = new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/London',dateStyle:'short',timeStyle:'short'});
        const choices=[utc,utc-3_600_000].filter(start=>london.format(start)===eventDay+' '+input.time);
        check(choices.length===1 && choices[0]>now(),'Choose a future, unambiguous UK start time.');
        check(Number.isInteger(input.places)&&input.places>=1&&input.places<=99&&
          Number.isInteger(input.instructors)&&input.instructors>=0&&input.instructors<=99,'Choose valid attendee and cadre capacities.');
        state.limits['training:'+event]=extraSeatLimit(input.limit??(generic?0:1));
        enqueue('schedule:'+event,'schedule',{actor,event,title,qualification:generic?null:key,trainingTrack:generic?key:null,
          day:eventDay,time:input.time,places:input.places,instructors:input.instructors,channel,repeat,squads,people,inviteRecruits,
          ...(squadOnly?{squadLeaderScope:squads.length?squads:[ledSquads[0]]}:{})});
        return {id:event};
      }
      case 'assessment':
        return {id:saveAssessment(state,ctx,access,actor,input)};
      case 'assessment-correction': {
        const entry=state.assessments[id(input.id,'assessment')];
        check(entry && entry.member!==actor && entry.status!=='draft' &&
          access.cadre && access.assign(qualification(state,entry.qualification,ctx)), 'That assessment is unavailable to you.',403);
        check(input.updated===entry.updated,'The assessment changed. Reopen it before editing.',409);
        const lines=list(input.lines,entry.lines.length,'assessment lines');
        check(lines.length===entry.lines.length&&lines.every(line=>line&&typeof line==='object'),'Enter a value for each existing assessment line.');
        const reason=str(input.reason,'Correction reason',600);
        entry.corrections??=[];
        entry.corrections.push({at:now(),actor,reason,title:entry.title,summary:entry.summary,lines:entry.lines});
        entry.title=str(input.title,'Assessment title',120);
        entry.summary=str(input.summary,'Feedback summary',2400,false);
        entry.lines=entry.lines.map(({title,description},index)=>({title,description,
          assessment:str(lines[index].assessment,'Assessment',1200,false),feedback:str(lines[index].feedback,'Feedback',1600,false)}));
        entry.updated=Math.max(now(),entry.updated+1);
        notice(state,'assessment-edit:'+entry.id+':'+entry.updated,'An assessment’s feedback was corrected and logged. '+link('records'));
        return {};
      }
      case 'bulk-results': {
        const event=needEvent(ctx,input.event);
        const qual=qualification(state,event.qualification,ctx);
        check(access.cadre&&access.assign(qual),'The matching Training Cadre role is required.',403);
        check(event.start<=now(),'Sign off a session after it starts.');
        const rows=list(input.rows,1000,'candidate results');
        check(rows.length && new Set(rows.map(row=>row?.member)).size===rows.length,'Choose unique candidate rows.');
        const recorded=[];
        const skipped=[];
        for (const row of rows) {
          check(row && event.candidates.includes(row.member) && ctx.members[row.member] && row.member!==actor &&
            outcomes.includes(row.status),'Choose booked candidates and valid outcomes.');
          if (event.results[row.member] || Object.values(state.assessments).some(item=>item.member===row.member &&
            item.event===event.key && item.status!=='draft')) { skipped.push(row.member); continue; }
          const pending=storage().prepare('SELECT status FROM unit_jobs WHERE id=?').get('bulk:'+event.id+':'+row.member);
          if (pending) { skipped.push(row.member); continue; }
          const existing=Object.values(state.assessments).find(item=>item.member===row.member&&item.event===event.key&&item.status==='draft');
          const course = existing ? state.courses[existing.course] : input.course ? needCourse(state,input.course) : null;
          check(!course || course.qualification===event.qualification,'Choose a template for this qualification.');
          if (course) {
            check(existing||!course.archivedAt,'Choose an active course template.');
            saveAssessment(state,ctx,access,actor,{id:existing?.id,course:course.id,event:event.key,member:row.member,
              status:row.status,lines:existing?.lines,summary:existing?.summary||input.feedback,route:row.route??''});
          } else if (event.basicStage) {
            if (event.basicStage==='t2' && row.status==='passed') {
              check(Object.values(ctx.events).some(item=>item.basicStage==='t1' && item.results[row.member]?.result==='passed'),
                'Each T2 pass needs a completed T1 pass first.');
              check(['','rangers','pilot'].includes(row.route??''),'Choose the Rangers or Pilot route.');
            }
            enqueue('bulk:'+event.id+':'+row.member,'basic',{actor,member:row.member,event:event.id,result:row.status,route:row.route??''});
          } else {
            throw new WorkflowError('Choose a course and assessment form for this specialist session.');
          }
          recorded.push(row.member);
        }
        if (recorded.length) notice(state,'batch:'+randomUUID(),'A training session has '+recorded.length+' new result(s). '+link('attendance'));
        return {recorded:recorded.length,skipped:skipped.length};
      }
      case 'register': {
        check(staff,'Staff access required.',403);
        const event=needEvent(ctx,input.event);
        check(event.start<=now(),'Attendance opens when the event starts.');
        const existing=state.registers[event.key];
        check(!existing?.closedAt||access.command,'Only Command can correct confirmed attendance.',403);
        check(input.confirm!==true || input.counts!==true || ctx.directoryFresh,
          'The member roster needs a fresh Discord sync before a weekly register can be confirmed.',503);
        const form=registration(event,state,ctx);
        check(input.version===form.version,'The register changed. Reload before saving.',409);
        check(form.rows.length,'There are no members in this register.');
        const counts=input.counts===true && ['operation','training'].includes(event.kind);
        if (counts && input.confirm) check(!Object.values(state.registers).some(row=>row.key!==event.key&&row.closedAt&&row.counts&&weekOf(row.start)===weekOf(event.start)),
          'Another operation or training event already counts for this week.');
        check(!existing?.closedAt || input.confirm===true,'Confirm the correction to update a closed register.');
        const marks={};
        for (const row of form.rows) {
          const mark=input.marks?.[row.member]??row.mark;
          check(mark==='' || statuses.includes(mark),'Choose a valid mark for each member.');
          check(input.confirm!==true || mark,'Complete every row before confirming attendance.');
          marks[row.member]=mark;
        }
        const row={key:event.key,title:event.title,start:event.start,kind:event.kind,counts,marks,actor,
          version:form.version+1,closedAt:input.confirm===true?now():null};
        state.registers[event.key]=row;
        if (row.closedAt) {
          enqueue('attendance:'+event.key+':'+row.version,'attendance',{actor,event:event.id,kind:event.kind,
            key:event.key,version:row.version,marks});
          for (const claim of Object.values(state.claims).filter(item=>item.event===event.key)) {
            if (claim.kind==='course' && claim.status==='reserved') claim.status=marks[claim.member]==='attended'?'used':'returned';
            if (claim.kind==='life' && claim.status==='reserved') claim.status='returned';
          }
          notice(state,'closeout:'+event.key+':'+row.version,'Attendance confirmed for '+event.title+'. '+link('attendance'));
          if (ctx.directoryFresh) policy(state,ctx);
          progression(state,ctx);
        }
        return {version:row.version};
      }
      case 'order': {
        check(access.command,'Command access required.',403);
        const event=needEvent(ctx,input.event);
        check(['operation','training'].includes(event.kind),'Choose an operation or scheduled training event.');
        const orders=getOrder(event);
        check((orders.revision??orders.draft?.revision??orders.published?.revision??0)===input.revision,'The orders changed. Reload before saving.',409);
        const attachments=unique(list(input.findings,30,'findings'));
        check(attachments.every(key=>ctx.findings.some(entry=>entry.id===key)),'One or more campaign links are unavailable.');
        const sections={};
        for (const group of event.groups) sections[group.key]=str(input.sections?.[group.key],'Element briefing',3000,false);
        orders.draft={title:str(input.title,'Order title',140),brief:str(input.brief,'Scenario brief',6000),
          objectives:str(input.objectives,'Objectives',6000),map:str(input.map,'Map',120,false),sections,
          findings:ctx.findings.filter(entry=>attachments.includes(entry.id)),
          revision:input.revision+1,at:now(),by:actor};
        orders.revision=orders.draft.revision;
        if (input.publish===true) {
          const version=Math.max(orders.published?.version??0,...orders.history.map(item=>item.version),0)+1;
          if (orders.published) orders.history.push(orders.published);
          orders.published={...orders.draft,version,changes:str(input.changes,'What changed',1500,version>1)};
          delete orders.draft;
          notice(state,'orders:'+event.key+':'+version,'Orders v'+version+' are available for '+event.title+'. '+link('orders')+'&event='+encodeURIComponent(event.key),'orders');
        } else if (input.review===true) {
          notice(state,'review:'+event.key+':'+orders.draft.revision+':'+orders.draft.at,'Command has requested an orders review for '+event.title+'. '+link('orders'));
        }
        return {};
      }
      case 'discard-orders': {
        check(access.command,'Command access required.',403);
        const event=needEvent(ctx,input.event);
        const order=state.orders[event.key];
        check(order && (order.revision??0)===input.revision,'The orders changed. Reload first.',409);
        if (input.withdraw===true) {
          check(order.published,'There are no published orders to withdraw.',409);
          order.history.push({...order.published,withdrawnAt:now()});
          delete order.published;
          notice(state,'orders-withdraw:'+event.key+':'+now(),'Orders for '+event.title+' have been withdrawn. '+link('orders'),'orders');
        } else delete order.draft;
        order.revision++;
        return {};
      }
      case 'order-leader': {
        const event=needEvent(ctx,input.event);
        check(access.leader&&event.leaderMembers[actor]?.includes(input.group),'Only event leaders can update their assigned element.',403);
        const order=state.orders[event.key];
        if (input.kind==='ack') {
          check(order?.published && order.published.version===input.version,'Open the latest orders to acknowledge them.',409);
            if (order.acks[actor]?.version===input.version) return {};
          order.acks[actor]={version:input.version,at:now()};
        } else if (input.kind==='review') {
          check(order?.draft && order.draft.revision===input.revision,'Open the current draft to review it.',409);
          order.review[actor]={group:input.group,revision:input.revision,at:now(),note:str(input.note,'Review note',800)};
        } else if (input.kind==='ready') {
          check(['ready','attention'].includes(input.status),'Choose a readiness state.');
          const ready=state.ready[event.key]??={};
          ready[input.group]={status:input.status,note:str(input.note,'Readiness note',800,false),actor,at:now()};
        } else throw new WorkflowError('Unknown leader action.');
        notice(state,'leader:'+event.key+':'+input.kind+':'+actor+':'+now(),'A leader updated '+event.title+' ('+input.kind+'). '+link('orders'));
        return {};
      }
      case 'followup': {
        check(access.command,'Command access required.',403);
        const prior=input.id ? state.followups[id(input.id,'follow-up')] : null;
        check(!input.id||prior,'Follow-up unavailable.',404);
        const event=input.event ? needEvent(ctx,input.event) : null;
        const finding=input.finding ? ctx.findings.find(item=>item.id===input.finding) : null;
        check(!input.finding||finding,'Find the campaign entry again.');
        check(!input.owner||ctx.members[input.owner],'Choose a current TAG member.');
        const item={id:prior?.id??randomUUID(),title:str(input.title,'Follow-up',600),due:date(input.due),
          owner:input.owner||null,ownerName:ctx.members[input.owner]?.name,event:event?.key,eventName:event?.title,finding,
          closedAt:input.closed===true?prior?.closedAt??now():null};
        state.followups[item.id]=item;
        notice(state,'followup:'+item.id+':'+now(),'An operation follow-up was '+(item.closedAt?'closed':'updated')+'. '+link('orders'));
        if (item.owner && !item.closedAt && item.owner!==prior?.owner) notice(state,'followup-owner:'+item.id+':'+now(),
          'Command assigned you an operation follow-up. '+link('orders'),'member',item.owner);
        return {};
      }
      case 'game-brief': {
        check(access.command,'Command access required.',403);
        const event=needEvent(ctx,input.event);
        check(event.kind==='operation','Choose an operation.');
        state.gameBriefs??={};
        const record=state.gameBriefs[event.key]??={revision:0,choices:{}};
        check(record.revision===input.revision,'The GM brief changed. Reopen it before saving.',409);
        if (input.withdraw===true) {
          check(record.published,'No GM brief is currently published.',409);
          const recipients=record.published.assignees;
          delete record.published;
          record.revision++;
          for (const gm of recipients) notice(state,'gm-withdraw:'+event.key+':'+record.revision+':'+gm,
            'The GM brief for '+event.title+' has been withdrawn. '+link('gm'),'member',gm);
          return {};
        }
        const assignees=unique(list(input.assignees,30,'Game Masters'));
        const enabled=state.settings.roles.gm;
        check(assignees.every(member=>enabled&&ctx.members[member]?.roleIds?.includes(enabled)),
          'Choose members who hold the configured Game Master role.');
        const attachments=unique(list(input.findings,30,'campaign links'));
        check(attachments.every(key=>ctx.findings.some(item=>item.id===key)),'Choose current campaign references.');
        const branches=list(input.branches,30,'scenario branches').map((entry,index)=>({
          id:String(index+1),title:str(entry?.title,'Scenario branch',150),
          description:str(entry?.description,'Branch details',2200,false),
        }));
        const draft={revision:++record.revision,assignees,branches,
          previous:str(input.previous,'Previous operation and campaign context',6000,false),
          recon:str(input.recon,'Reconnaissance and AAR summary',6000,false),
          discretion:str(input.discretion,'GM decision space and limits',6000),
          findings:ctx.findings.filter(item=>attachments.includes(item.id)),combinations:input.combinations===true,
          at:now(),by:actor};
        if (input.publish===true) {
          check(assignees.length>0,'Assign at least one Game Master before publishing.');
          check(branches.length>0,'Add at least one permitted scenario branch.');
          record.published=draft;
          delete record.draft;
          const direct=link('gm')+'&event='+encodeURIComponent(event.key);
          for (const gm of assignees) notice(state,'gm-brief:'+event.key+':'+record.revision+':'+gm,
            'Your private GM brief for '+event.title+' is ready. '+direct,'member',gm);
        } else record.draft=draft;
        return {};
      }
      case 'gm-choice': {
        const event=needEvent(ctx,input.event);
        const record=state.gameBriefs?.[event.key];
        const brief=record?.published;
        check(access.gameMaster && brief && brief.assignees.includes(actor),'This private brief is not assigned to you.',403);
        check(input.revision===brief.revision,'Read the latest brief before recording choices.',409);
        const selection=unique(list(input.selection,brief.combinations?brief.branches.length:1,'scenario branches'));
        check(selection.every(key=>brief.branches.some(item=>item.id===key)),'Choose from the permitted branches.');
        const share=input.share===true;
        check(!share||state.registers[event.key]?.closedAt,'Share decisions after the operation attendance is confirmed.');
        record.choices[actor]={selection,note:str(input.note,'GM notes',4000,false),revision:brief.revision,at:now(),sharedAt:share?now():null};
        if (share) notice(state,'gm-outcome:'+event.key+':'+actor+':'+now(),'A Game Master shared an outcome with Command. '+link('gm')+'&event='+encodeURIComponent(event.key));
        return {};
      }
      case 'tasking': {
        check(access.command,'Command access required.',403);
        const unit=str(input.unit,'Unit',80);
        check(Object.hasOwn(ctx.units,unit),'Choose a TAG unit.',404);
        const taskId=id(input.id,'tasking');
        state.taskings??={};
        const prior=state.taskings[taskId];
        if (prior && input.edit!==true) return {id:taskId};
        check(!prior || prior.revision===input.revision,'This tasking changed. Reload before editing.',409);
        const deadline=date(input.deadline);
        const aarDeadline=date(input.aarDeadline||deadline);
        check((prior || deadline>=ukDay.format(now())) && aarDeadline>=deadline,'Choose a task deadline and an AAR deadline on or after it.');
        const recipients=unique(ctx.unitLeaders[unit]??[]);
        const task={id:taskId,unit,unitName:ctx.units[unit],title:str(input.title,'Tasking title',140),
          strength:str(input.strength,'Estimated strength',140),deadline,aarDeadline,
          task:str(input.task,'In-game task',5000),intended:str(input.intended,'Intended outcome',3000),
          author:prior?.author??actor,created:prior?.created??now(),recipients,acks:prior?.acks??{},result:prior?.result??'',
          closedAt:prior?.closedAt??null,archivedAt:prior?.archivedAt??null,reportedAt:prior?.reportedAt,reportedBy:prior?.reportedBy,
          aar:prior?.aar,revision:(prior?.revision??0)+1};
        if (prior && (prior.unit!==unit || prior.task!==task.task || prior.deadline!==deadline || prior.aarDeadline!==aarDeadline)) task.acks={};
        state.taskings[taskId]=task;
        const direct=link('taskings')+'&task='+taskId;
        for (const leader of recipients) notice(state,'task:'+taskId+':'+task.revision+':'+leader,
          (prior?'Updated TAG tasking for ':'New TAG tasking for ')+task.unitName+': '+task.title+'. Task due '+deadline+' (UK); AAR due '+aarDeadline+' (UK). '+direct,'member',leader);
        notice(state,'task-staff:'+taskId+':'+task.revision,'Tasking issued to '+task.unitName+' · '+recipients.length+' roster lead DM(s) queued. '+direct);
        return {id:taskId};
      }
      case 'tasking-action': {
        const task=state.taskings?.[id(input.id,'tasking')];
        check(task && (access.command || !task.archivedAt && (task.recipients.includes(actor) || ctx.unitLeaders[task.unit]?.includes(actor))),'Tasking unavailable.',404);
        const direct=link('taskings')+'&task='+task.id;
        if (input.kind==='ack') {
          check(!task.closedAt,'This tasking is closed.',409);
          task.acks[actor]??={at:now(),name:ctx.members[actor]?.name??'TAG lead'};
          notice(state,'task-ack:'+task.id+':'+actor,'A unit lead acknowledged a tasking for '+task.unitName+'. '+direct);
        } else if (input.kind==='report') {
          check(!task.closedAt,'This tasking is closed.',409);
          task.result=str(input.result,'Actual outcome',5000);
          if (input.aar) check(ctx.reports.some(item=>item.id===input.aar),'Choose a submitted AAR.');
          task.aar=input.aar||null;
          task.reportedAt=now();
          task.reportedBy=actor;
          notice(state,'task-outcome:'+task.id+':'+now(),'A tasking outcome was reported for '+task.unitName+'. '+direct);
        } else if (input.kind==='close') {
          check(access.command,'Only Command can close taskings.',403);
          check(task.result,'Record the actual outcome before closing this tasking.');
          task.closedAt??=now();
          notice(state,'task-closed:'+task.id,'Command closed a tasking for '+task.unitName+'. '+direct);
        } else if (['archive','restore','reopen'].includes(input.kind)) {
          check(access.command,'Only Command can manage taskings.',403);
          if (input.kind==='archive') task.archivedAt=now();
          else if (input.kind==='restore') task.archivedAt=null;
          else task.closedAt=null;
          notice(state,'task-status:'+task.id+':'+now(),'Command updated the tasking status for '+task.unitName+'. '+direct);
        } else throw new WorkflowError('Choose a tasking action.');
        return {};
      }
      case 'application-form': {
        check(access.command,'Command access required.',403);
        const key=str(input.qualification,'Qualification',80);
        check(!['t1','t2'].includes(key)&&qualification(state,key,ctx),'Choose a specialist qualification or course.');
        const reviewer=role(input.reviewer??'');
        check(reviewer!==ctx.guild,'Choose a reviewer role other than @everyone.');
        const questions=list(input.questions??[],8,'application questions').map(question=>str(question,'Question',160));
        check(new Set(questions).size===questions.length,'Use a different label for each question.');
        const forms=state.settings.applicationForms??={};
        check((forms[key]?.version??null)===(input.version??null),'This form changed. Reload it before saving.',409);
        forms[key]={version:randomUUID(),intro:str(input.intro,'Application instructions',1200,false),questions};
        state.settings.qualifications[key]={...state.settings.qualifications[key],reviewer,
          applications:input.open===true,seasoned:input.seasoned===true};
        return {};
      }
      case 'application': {
        const qualificationKey=str(input.qualification,'Qualification',80);
        const qual=qualification(state,qualificationKey,ctx);
        check(qual?.applications&&!['t1','t2'].includes(qualificationKey),'Applications are closed for this qualification.',403);
        check(!qual.seasoned || seasonedEligible(state,ctx,actor,member.roles),
          'Seasoned Member is required. Full Members qualify at ten attended operations.',403);
        check(!Object.values(state.applications).some(item=>item.member===actor&&item.qualification===qualificationKey&&
          ['pending','approved'].includes(item.status)), 'An application is already open or approved.',409);
        const form=state.settings.applicationForms?.[qualificationKey];
        check((input.version??null)===(form?.version??null),'The application form changed. Reload before submitting.',409);
        const questions=form?.questions??[];
        const answers=list(input.answers??[],8,'application answers');
        check(answers.length===questions.length,'Answer each application question.');
        const entry={id:randomUUID(),member:actor,qualification:qualificationKey,status:'pending',at:now(),
          note:str(input.note,'Application statement',1800,!questions.length),
          responses:questions.map((question,index)=>({question,answer:str(answers[index],'Answer to question '+(index+1),1800)}))};
        state.applications[entry.id]=entry;
        const reviewUrl=link('application-review',{application:entry.id});
        if (state.settings.channel) {
          notice(state,'application:'+entry.id,'A '+qual.name+' application is waiting for review. '+reviewUrl);
        }
        const reviewers=[qual.reviewer,state.settings.roles[qual.specialty]].filter(Boolean);
        if (!reviewers.length && ctx.roles.cadre) reviewers.push(ctx.roles.cadre);
        if (!state.settings.channel && ctx.roles.command) reviewers.push(ctx.roles.command);
        for (const person of Object.values(ctx.members)) {
          if (person.id!==actor && reviewers.some(role=>person.roleIds?.includes(role))) notice(state,'application-review:'+entry.id+':'+person.id,
            'A '+qual.name+' application is ready for your review. '+reviewUrl,'member',person.id);
        }
        return {id:entry.id};
      }
      case 'review-application': {
        const entry=state.applications[id(input.id,'application')];
        check(entry && (entry.status==='pending'||access.command),'That application is no longer pending.',409);
        check(entry.member!==actor && access.review(qualification(state,entry.qualification,ctx)),'Reviewer role required.',403);
        check(['approved','declined',...(access.command?['pending']:[])].includes(input.status),'Choose a decision.');
        entry.history??=[];
        if (entry.status!=='pending') entry.history.push({status:entry.status,reviewer:entry.reviewer,reviewed:entry.reviewed,decision:entry.decision});
        Object.assign(entry,{status:input.status,reviewer:actor,reviewed:now(),decision:str(input.note,'Decision note',1200,false)});
        notice(state,'application-result:'+entry.id+':'+entry.reviewed,'Your qualification application is now '+entry.status+'. Read the decision on the website. '+link('applications'),'member',entry.member);
        return {};
      }
      case 'limit': {
        const event=needEvent(ctx,input.event);
        check(access.command||access.assign(qualification(state,event.qualification,ctx)),'Event lead permissions are required.',403);
        if (event.qualification) state.limits[event.key]=extraSeatLimit(input.limit);
        else {
          check(access.command && event.kind==='operation','Choose an operation.',403);
          state.limits[event.key]=input.life===true ? 1 : 0;
        }
        return {};
      }
      case 'claim': {
        check(charges(state,ctx,actor).available,'Complete five counted operations and five counted training sessions to earn a reward.',409);
        check(!Object.values(state.claims).some(item=>item.member===actor&&['pending','reserved','cancelling'].includes(item.status)),
          'You already have a reward reserved.',409);
        const event=needEvent(ctx,input.event);
        check(event.start>now()&&!event.onLeave(actor),'Choose an upcoming eligible event.',409);
        let kind;
        if (event.kind==='operation') {
          check((state.limits[event.key]??0)>0 && event.confirmed.includes(actor),'This event has no extra-life redemption for you.',403);
          kind='life';
        } else {
          const qual=qualification(state,event.qualification,ctx);
          const approved=Object.values(state.applications).some(item=>item.member===actor&&item.qualification===event.qualification&&item.status==='approved');
          check(qual && !event.basicStage && (!qual.applications||approved) && (!qual.seasoned||seasonedEligible(state,ctx,actor,member.roles)),'An approved application and course prerequisites are required.',403);
          const cap=state.limits[event.key]??event.priorityLimit??1;
          check(event.standardFull && !event.candidates.includes(actor) && event.priorityCount<cap,'No priority place is available for this course.',409);
          kind='course';
        }
        const entry={id:randomUUID(),kind,event:event.key,eventName:event.title,start:event.start,member:actor,created:now(),
          status:kind==='life'?'reserved':'pending'};
        state.claims[entry.id]=entry;
        if (kind==='course') enqueue('priority:'+entry.id,'priority',{member:actor,event:event.id,claim:entry.id,limit:state.limits[event.key]??event.priorityLimit??1});
        if (kind==='life') notice(state,'claim:'+entry.id,'An extra in-game life was reserved for '+event.title+'. '+link('orders'));
        return {};
      }
      case 'claim-result': {
        const entry=state.claims[id(input.id,'reward')];
        check(entry?.status==='reserved','This reward is no longer reserved.',409);
        if (input.result==='cancel') {
          check(entry.member===actor && entry.start>now(),'Only the member can cancel a future redemption.',403);
          entry.status=entry.kind==='course'?'cancelling':'returned';
          if (entry.kind==='course') enqueue('priority-cancel:'+entry.id,'priority-cancel',{member:actor,event:entry.event.split(':')[1],claim:entry.id});
        } else {
          check(access.command&&entry.kind==='life'&&entry.start<=now(),'Command can record extra-life usage after kickoff.',403);
          check(['used','returned'].includes(input.result),'Choose whether the life was used.');
          entry.status=input.result;
          notice(state,'claim-outcome:'+entry.id,'Your extra-life reward was '+(entry.status==='used'?'used':'returned')+'. '+link('progress'),'member',entry.member);
        }
        return {};
      }
      case 'member-adjustment': {
        check(access.command,'Command access required.',403);
        check(ctx.members[input.member],'Choose a current TAG member.');
        const target=input.member;
        const mode=input.mode;
        const reason=str(input.reason,'Reason for the change',500);
        state.adjustments??={};
        const adjustments=state.adjustments[target]??={qualifications:{},credits:0,history:[]};
        const event=randomUUID();
        if (input.kind==='credits') {
          check(Number.isInteger(input.credits)&&input.credits>=-100&&input.credits<=100,'Choose a reward adjustment from -100 to 100.');
          adjustments.credits=input.credits;
        } else {
          check(['grant','revoke','automatic'].includes(mode),'Choose a member access action.');
          const qual=input.kind==='qualification'?qualification(state,input.qualification,ctx):null;
          check(input.kind==='seasoned'||qual,'Choose a qualification.');
          const configured=input.kind==='seasoned'?state.settings.roles.seasoned:qual.discordRole;
          if (input.kind==='seasoned') adjustments.seasoned=mode;
          else adjustments.qualifications[input.qualification]=mode;
          if (configured && mode!=='automatic') enqueue('manual-role:'+event,'manual-role',{actor,member:target,role:configured,
            kind:input.kind,qualification:input.qualification,mode});

        }
        adjustments.history.push({kind:input.kind,mode,qualification:input.qualification,credits:input.credits,reason,actor,at:now()});
        notice(state,'member-adjustment:'+event,'Command corrected a member’s qualifications, Seasoned Member status or reward balance. '+link('command'));
        if (input.kind==='seasoned'&&mode==='grant') notice(state,'manual-seasoned:'+event,
          'Command has granted Seasoned Member. You can now apply for eligible qualifications. '+link('applications'),'member',target);
        return {};
      }
      case 'reserve-request': {
        check(activeMember(ctx.members[actor]),'Only active TAG members can request a move to Reserves.',403);
        const entry=state.cases[actor]??={episode:randomUUID(),stage:0,history:[],joined:ctx.members[actor].joined};
        check(!entry.reserveRequest || entry.reserveRequest.status!=='pending','You already have a request pending.',409);
        entry.reserveRequest={at:now(),status:'pending',reason:str(input.note,'Reason for your request',500)};
        notice(state,'reserve-request:'+actor+':'+now(),'A TAG member has requested a move to Reserves. '+link('command'));
        return {};
      }
      case 'intervene': {
        check(access.command,'Command access required.',403);
        check(ctx.members[input.member],'Choose a current member.');
        const candidate=input.member;
        const entry=state.cases[candidate]??={episode:randomUUID(),stage:0,history:[],joined:ctx.members[candidate].joined};
        const reason=str(input.reason,'Reason for intervention',500);
        if (input.kind==='hold') entry.hold=true;
        else if (input.kind==='resume') {
          entry.hold=false;
          if (entry.review) state.protection[candidate]=attendanceProgress(Object.values(state.registers).filter(row=>row.closedAt),
            candidate,now(),ctx.members[candidate].activeSince||ctx.members[candidate].joined||0).weeks
            .filter(row=>row.mark==='loa').map(row=>weekOf(row.start));
          entry.review=false;
        } else if (input.kind==='exempt') {
          const end=Date.parse(date(input.until)+'T00:00:00Z')+day;
          check(end>now(),'Choose an exemption end date in the future.');
          state.exemptions[candidate]={start:now(),end,reason,actor};
        } else if (input.kind==='clear') delete state.exemptions[candidate];
        else if (input.kind==='decline-reserve') {
          check(entry.reserveRequest?.status==='pending','This member has no pending Reserve request.',409);
          entry.reserveRequest.status='declined';
          notice(state,'reserve-decline:'+candidate+':'+now(),'Command declined your Reserve request. Contact Command if you have questions. '+link('progress'),'member',candidate);
        } else if (input.kind==='reserve') {
          if (entry.reserveRequest) entry.reserveRequest.status='approved';
          entry.hold=true;
          enqueue('reserve:'+candidate+':'+now(),'reserve',{actor,member:candidate,joined:ctx.members[candidate].joined,reason});
        } else throw new WorkflowError('Choose an intervention.');
        entry.history.push({at:now(),title:'Command intervention · '+input.kind,staff:true,reason,actor});
        notice(state,'intervention:'+candidate+':'+now(),'Command has updated an attendance case. '+link('command'));
        policy(state,ctx);
        return {};
      }
      case 'retry': {
        check(access.command,'Command access required.',403);
        storage().prepare("UPDATE unit_jobs SET status='pending',next=?,error=NULL WHERE id=? AND status='failed'").run(now(),str(input.id,'Delivery ID',220));
        return {};
      }
      default: throw new WorkflowError('Unknown action.',404);
    }
  }

  async function parseBody(request) {
    check(request.headers.origin===origin,'Invalid request origin.',403);
    check(request.headers['content-type']?.split(';')[0]==='application/json','Expected a JSON form.',415);
    const chunks=[];
    let size=0;
    for await (const chunk of request.iterator({destroyOnReturn:false})) {
      size+=chunk.length;
      check(size<=14_000_000,'The request is too large.',413);
      chunks.push(chunk);
    }
    let data;
    try { data=JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new WorkflowError('Invalid form.'); }
    check(data && typeof data==='object' && !Array.isArray(data),'Invalid form.');
    return data;
  }

  async function handle(request,response,url,member) {
    const send=(status,data)=>{
      response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
      response.end(JSON.stringify(data));
    };
    try {
      const input=request.method==='POST'?await parseBody(request):null;
      const ctx=await context(member);
      if (input) {
        check(ctx.available,'Live roster records are unavailable. Refresh before saving.',503);
        return send(200,transaction(state=>mutate(state,ctx,member,input)));
      }
      const state=read();
      const access=permissions(state,member,ctx);
      const fileMatch=/^\/members\/unit-file\/([0-9a-f-]+)$/.exec(url.pathname);
      if (fileMatch) {
        const key=id(fileMatch[1],'course document');
        const course=Object.values(state.courses).find(item=>[item.presentation.id,item.guide.id].includes(key));
        check(course && (access.command || access.cadre && access.assign(qualification(state,course.qualification,ctx))),'Course document unavailable.',404);
        const file=storage().prepare('SELECT name,bytes FROM unit_files WHERE id=?').get(key);
        check(file,'Course document unavailable.',404);
        response.writeHead(200,{'Content-Type':'application/octet-stream','Cache-Control':'private, no-store',
          'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(file.name).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16))});
        return response.end(file.bytes);
      }
      const view=url.searchParams.get('view')||'orders';
      const result=overview(state,ctx,member,access,view);
      if (view==='training' && (access.command||access.cadre||access.squadLeader&&ctx.ledSquads?.length)) {
        try { result.channels=await getChannels(member.user.id); }
        catch { result.channels=[]; result.channelsUnavailable=true; }
      }
      return send(200,result);
    } catch (error) {
      if (!(error instanceof WorkflowError)) throw error;
      return send(error.status,{error:error.message});
    }
  }

  let busy=false;
  let lastCheck=-Infinity;
  async function deliver() {
    if (busy) return;
    busy=true;
    try {
      if (now()-lastCheck>=60_000) {
        lastCheck=now();
        const ctx=await context(null);
        if (ctx.available) transaction(state=>{
          for (const claim of Object.values(state.claims)) {
            const event=ctx.events[claim.event];
            if (claim.status==='reserved' && (event?.cancelled || (!event && claim.start<now()))) claim.status='returned';
            if (claim.kind==='course' && claim.status==='reserved' && event && event.start>now() && !event.candidates.includes(claim.member)) claim.status='returned';
          }
          if (ctx.directoryFresh) policy(state,ctx);
          progression(state,ctx);
        });
      }
      for (const row of storage().prepare("SELECT * FROM unit_jobs WHERE status='pending' AND next<=? ORDER BY next,id LIMIT 6").all(now())) {
        const payload=JSON.parse(row.data);
        try {
          if (payload.type==='notify' && !payload.channel && payload.destination==='staff') {
            const channel=read().settings.channel;
            if (!channel) throw new WorkflowError('CHANNEL_REQUIRED',422);
            payload.channel=channel;
          }
          if (payload.type==='role' && ['seasoned','veteran'].includes(payload.source)) {
            const ctx=await context(null);
            const state=read();
            const minimum=payload.source==='seasoned'?10:30;
            if (state.settings.roles[payload.source]!==payload.role) {
              storage().prepare("UPDATE unit_jobs SET status='superseded',error=NULL WHERE id=?").run(row.id);
              continue;
            }
            if (!ctx.available || ctx.members[payload.member]?.status!=='Full Member' ||
                serviceOperations(state,ctx,payload.member)<minimum) {
              storage().prepare('UPDATE unit_jobs SET next=?,error=? WHERE id=?').run(now()+120_000,'Waiting for service milestone eligibility',row.id);
              continue;
            }
          }
          if (['policy','attendance','priority','priority-cancel'].includes(payload.type)) {
            const state=read();
            if (payload.type==='policy') {
              const ctx=await context(null);
              if (!ctx.available || !ctx.directoryFresh || !policyJobStillAllowed(state,ctx,payload)) {
                storage().prepare('UPDATE unit_jobs SET next=?,error=? WHERE id=?').run(now()+120_000,'Waiting for attendance policy eligibility',row.id);
                continue;
              }
            } else if (payload.type==='attendance' && state.registers[payload.key]?.version!==payload.version) {
              storage().prepare("UPDATE unit_jobs SET status='superseded',error=NULL WHERE id=?").run(row.id);
              continue;
            }
          }
          await sendJob(row.id,{...payload,nonce:jobNonce(row.id)});
          transaction(state=>{
            if (payload.type==='priority' || payload.type==='priority-cancel') {
              const claim=state.claims[payload.claim];
              if (claim?.status === (payload.type==='priority'?'pending':'cancelling')) claim.status=payload.type==='priority'?'reserved':'returned';
              notice(state,payload.type+':'+payload.claim,payload.type==='priority'
                ? 'Your priority course place is confirmed. '+link('progress') : 'Your priority course reward was returned. '+link('progress'),'member',payload.member);
            }
            storage().prepare("UPDATE unit_jobs SET status='sent',error=NULL WHERE id=?").run(row.id);
          });
        } catch (error) {
          const terminal=[400,403,404,409,422].includes(error.status);
          const detail=error instanceof WorkflowError ? error.message.slice(0,240) : 'Discord or the TAG bot is unavailable.';
          transaction(state=>{
            if (terminal && payload.type==='priority') {
              const claim=state.claims[payload.claim];
              if (claim?.status==='pending') claim.status='returned';
            }
            if (terminal && payload.type==='priority-cancel') {
              const claim=state.claims[payload.claim];
              if (claim?.status==='cancelling') claim.status='reserved';
            }
            storage().prepare('UPDATE unit_jobs SET status=?,attempts=attempts+1,next=?,error=? WHERE id=?').run(
              terminal?'failed':'pending',now()+Math.max(error.retryAfter??0,Math.min(900_000,5000*2**Math.min(8,row.attempts))),detail,row.id);
          });
        }
      }
    } finally { busy=false; }
  }

  return {
    handle,deliver,
    navigationAccess(member,roles) {
      return dashboardAccess(read(),member,roles);
    },
    memberAwardsView(registry,campaigns=[],events={}) {
      const state=read();
      return {
        decorations:decorationsView(state,campaigns,events),
        hasPublishedOrders(event) {
          return Boolean(state.orders[event]?.published);
        },
        revokedRoles(member) {
          return Object.entries(state.adjustments?.[member]?.qualifications??{}).filter(([,mode])=>mode==='revoke')
            .map(([key])=>state.settings.qualifications[key]?.discordRole||registry[key]?.roleId).filter(Boolean);
        },
        names(member) {
          return awardList(state,member).map(key=>state.settings.qualifications[key]?.name||registry[key]?.name||
            ({t1:'Basic Training T1',t2:'Basic Training T2'})[key]||defaultTitles[key]||key);
        },
      };
    },
  };
}
