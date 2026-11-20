'use strict';

const status=document.querySelector('#unit-status');
const content=document.querySelector('#unit-content');
const query=new URLSearchParams(location.search);
const requestedView=query.get('view')||'orders';
const view=requestedView==='honours'&&query.has('nomination')?'honours-review':requestedView;
const uk=['en-GB',{timeZone:'Europe/London',dateStyle:'medium',timeStyle:'short'}];
const day=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/London',dateStyle:'short'});
const marks={
  '':'Unmarked',attended:'Attended',absent:'Absent',loa:'Approved LOA','not-required':'Not required',
};
const outcomes={passed:'Passed',retest:'Needs retest',failed:'Failed',repeat:'Needs retest',absent:'Absent',draft:'Draft'};
const views={orders:'Orders & readiness',taskings:'Taskings',applications:'Apply for a qualification',progress:'My attendance & rewards',
  courses:'Courses',training:'Schedule training',records:'Candidate records',attendance:'Attendance & sign-off',gm:'Game Master briefs',command:'Command inbox',
  honours:'Recommend someone for an honour','honours-review':'Review honours','application-review':'Review applications'};
const specialties={t1:'Basic Training Cadre T1',t2:'Basic Training Cadre T2',heavy:'Heavy Weapons Training Cadre',tacp:'TACP Training Cadre',
  dog:'Dog Handler Training Cadre',sniper:'Sniper Training Cadre',pilot:'Pilot Training Cadre',medical:'Medical Training Cadre',
  leadership:'Leadership Training Cadre',devgru:'DEVGRU Training Cadre',rrc:'RRC Training Cadre',seasoned:'Seasoned Member',gm:'Game Master'};
const pairs=object=>Object.entries(object);
const when=time=>new Intl.DateTimeFormat(...uk).format(time);
const eventText=event=>event.title+' · '+when(event.start)+' UK';
let data;
let saving=false;
let openAssessment;
let recordFilter='';
let activeEvent=query.get('event')||'';

function el(tag,text='',klass='') {
  const node=document.createElement(tag);
  if (text) node.textContent=text;
  if (klass) node.className=klass;
  return node;
}
function link(text,href) {
  const node=el('a',text,'uo-link');
  node.href=href;
  return node;
}
function unitLink(name,extra={}) { return '/members/unit/?'+new URLSearchParams({view:name,...extra}); }
function button(text,handler,type='button') {
  const node=el('button',text,'button outline small');
  node.type=type;
  if (handler) node.onclick=handler;
  return node;
}
function heading(parent,label,level='h2') { parent.append(el(level,label)); }
function line(parent,label,value) {
  if (value===undefined || value===null || value==='') return;
  const row=el('p','','uo-text');
  row.append(el('strong',label+' '),document.createTextNode(String(value)));
  parent.append(row);
}
function card(parent,title,fold=false) {
  const node=el(fold?'details':'section','','uo-card');
  node.append(el(fold?'summary':'h3',title));
  parent.append(node);
  return node;
}
function form(parent) { const node=el('form','','uo-form'); parent.append(node); return node; }
function field(parent,label,options={}) {
  const {type='text',value='',choices,required=false,limit}=options;
  const wrapper=el('label',label,type==='checkbox'?'uo-check':'');
  const input=el(choices?'select':type==='textarea'?'textarea':'input');
  if (input.tagName==='INPUT') input.type=type;
  if (choices) for (const [key,display] of choices) input.add(new Option(display,key));
  if (type==='checkbox') input.checked=Boolean(value);
  else if (type!=='file') input.value=value??'';
  input.required=required;
  if (limit) input.maxLength=limit;
  if (type==='checkbox') wrapper.prepend(input); else wrapper.append(input);
  parent.append(wrapper);
  return input;
}
function actions(parent,...buttons) {
  const node=el('div','','uo-buttons');
  node.append(...buttons);
  parent.append(node);
  return node;
}
async function api(input) {
  const response=await fetch('/api/unit-operations?view='+encodeURIComponent(view),input?{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),
  }:{cache:'no-store'});
  const payload=response.headers.get('Content-Type')?.includes('application/json')?await response.json():{error:await response.text()};
  if (!response.ok) throw new Error(payload.error||'The website could not save this change.');
  return payload;
}
async function save(values,success='Saved.',options={}) {
  if (saving) return;
  saving=true;
  status.textContent='Saving…';
  try {
    const payload=await values();
    if (!payload) { status.textContent=''; return; }
    const result=await api(payload);
    if (options.after) options.after(result);
    const loaded=await load();
    if (!loaded) return result;
    status.textContent=typeof success==='function'?success(result):success;
    return result;
  } catch (error) {
    status.textContent=error.message;
  } finally { saving=false; }
}
function submit(parent,label,values,success,after) {
  parent.append(button(label,null,'submit'));
  parent.onsubmit=event=>{
    event.preventDefault();
    void save(()=>values(event),success,{after});
  };
}
function chooseEvent(parent,events,selected,render) {
  const controls=el('div','','uo-form');
  parent.append(controls);
  if (!events.length) { controls.append(el('p','No available events.')); return; }
  const chosen=events.find(item=>item.key===selected)?.key??events[0].key;
  const pick=field(controls,'Event',{choices:events.map(event=>[event.key,eventText(event)]),value:chosen});
  const body=el('div');
  parent.append(body);
  const show=()=>{
    body.replaceChildren();
    activeEvent=pick.value;
    const event=events.find(item=>item.key===pick.value);
    if (event) render(body,event);
  };
  pick.onchange=show;
  show();
}
function orderText(parent,event,record,personal) {
  line(parent,'Scenario',record.brief);
  line(parent,'Objectives',record.objectives);
  line(parent,'Map',record.map);
  const ordered=[...event.groups].sort((a,b)=>Number(personal.includes(b.key))-Number(personal.includes(a.key)));
  for (const group of ordered) {
    if (record.sections[group.key]) line(parent,group.label+(personal.includes(group.key)?' · Your element':''),record.sections[group.key]);
  }
  if (record.findings.length) {
    heading(parent,'Campaign references','h4');
    const links=el('ul');
    for (const item of record.findings) {
      const row=el('li');
      row.append(link(item.title,item.href));
      if (item.map || item.grid) row.append(document.createTextNode(' · '+[item.map,item.grid].filter(Boolean).join(' · ')));
      links.append(row);
    }
    parent.append(links);
  }
}
function orders() {
  chooseEvent(content,data.events??[],activeEvent,(parent,event)=>{
    const order=event.order;
    const published=order?.published;
    const draft=order?.draft;
    if (published) {
      const box=card(parent,published.title+' · v'+published.version);
      line(box,'Published',when(published.at));
      line(box,'What changed',published.changes);
      orderText(box,event,published,event.myGroups);
      if (event.canAcknowledge) {
        const current=order.acks[data.member]?.version===published.version;
        const acknowledge=button(current?'Acknowledged':'Acknowledge version '+published.version,()=>save(()=>({
          action:'order-leader',kind:'ack',event:event.key,version:published.version,group:event.leaderGroups[0],
        }),'Orders acknowledged.'));
        acknowledge.disabled=current;
        box.append(acknowledge);
      }
      if (order.history?.length) {
        const previous=card(box,'Previous versions',true);
        for (const old of order.history.toReversed()) {
          const version=card(previous,'Version '+old.version+' · '+when(old.at),true);
          line(version,'What changed',old.changes);
          orderText(version,event,old,[]);
        }
      }
    } else parent.append(el('p','Orders have not been published.'));
    if (draft && data.access.leader && !data.access.command && event.canAcknowledge) {
      const box=card(parent,'Review draft orders',true);
      orderText(box,event,draft,event.myGroups);
      const review=form(box);
      const group=field(review,'Element',{choices:event.groups.filter(item=>event.leaderGroups.includes(item.key)).map(item=>[item.key,item.label]),value:event.leaderGroups[0]});
      const note=field(review,'Review comments',{type:'textarea',required:true,limit:800});
      submit(review,'Send review to Command',()=>({action:'order-leader',kind:'review',event:event.key,
        revision:draft.revision,group:group.value,note:note.value}),'Review sent.');
    }
    if (data.access.command) {
      if (event.kind==='operation') parent.append(link('Game Master brief for this operation',unitLink('gm',{event:event.key})));
      const editor=card(parent,draft?'Continue orders draft':published?'Prepare a new version':'Create orders',true);
      const template=draft||published||{sections:{},findings:[]};
      const edit=form(editor);
      const title=field(edit,'Order title',{value:template.title??event.title,required:true,limit:140});
      line(edit,'Scheduled',when(event.start)+' UK');
      const map=field(edit,'Map',{value:template.map??data.map??'',limit:120});
      const brief=field(edit,'Scenario brief',{type:'textarea',value:template.brief,required:true,limit:6000});
      const objectives=field(edit,'Objectives',{type:'textarea',value:template.objectives,required:true,limit:6000});
      const sections=event.groups.map(group=>[group.key,field(edit,group.label+' briefing',{type:'textarea',value:template.sections[group.key],limit:3000})]);
      const references=el('fieldset');
      references.append(el('legend','Campaign findings and map pins'));
      for (const entry of data.findings??[]) {
        const choice=field(references,entry.title,{type:'checkbox',value:template.findings.some(item=>item.id===entry.id)});
        choice.value=entry.id;
      }
      edit.append(references);
      const change=field(edit,'Changes for the next published version',{type:'textarea',limit:1500});
      for (const [id,review] of pairs(order?.review??{})) {
        if (review.revision===draft?.revision) line(edit,event.expected?.find(item=>item.id===id)?.name??'Leader review',review.note);
      }
      const draftButton=button('Save draft',null,'submit');
      const reviewButton=button('Save and request review',null,'submit');
      const publish=button('Publish orders',null,'submit');
      actions(edit,draftButton,reviewButton,publish);
      if (draft) edit.append(button('Discard draft',()=>save(()=>confirm('Discard this unpublished draft?')?
        {action:'discard-orders',event:event.key,revision:order.revision}:null)));
      if (published) edit.append(button('Withdraw published orders',()=>save(()=>confirm('Withdraw the currently published orders?')?
        {action:'discard-orders',event:event.key,revision:order.revision,withdraw:true}:null)));
      edit.onsubmit=eventSubmit=>{
        eventSubmit.preventDefault();
        const publishing=eventSubmit.submitter===publish;
        if (publishing && !confirm('Publish orders and notify Discord?')) return;
        void save(()=>({action:'order',event:event.key,revision:order?.revision??0,title:title.value,brief:brief.value,
          objectives:objectives.value,map:map.value,sections:Object.fromEntries(sections.map(([key,input])=>[key,input.value])),
          findings:[...references.querySelectorAll('input:checked')].map(input=>input.value),changes:change.value,
          publish:publishing,review:eventSubmit.submitter===reviewButton}),publishing?'Orders published. Discord delivery queued.':'Draft saved.');
      };
    }
    if (event.lineup) readiness(parent,event,published);
    if (event.canNewAar||data.access.command) {
      const team=event.groups.filter(item=>event.myGroups.includes(item.key)).map(item=>item.label).join(', ');
      const params=new URLSearchParams({event:event.key.split(':')[1],...(team?{team}:{}),...(event.kind==='operation'?{type:'main'}:{})});
      parent.append(link('Start AAR','/members/aar/?'+params));
    }
  });
  if (data.access.command) followups();
}

function readiness(parent,event,published) {
  const box=card(parent,'Pre-event readiness');
  const classifications={confirmed:'Confirmed',awaiting_confirmation:'Awaiting confirmation',open:'Open',LOA:'Approved LOA'};
  if (!event.lineup.length) box.append(el('p','No lineup has been assigned.'));
  for (const item of event.lineup) line(box,item.group+' · '+item.slot,item.name+' · '+(classifications[item.status]??item.status??'Unconfirmed'));
  if (event.expected.length) heading(box,'Leader acknowledgements','h4');
  for (const item of event.expected) {
    const acknowledged=published&&event.order.acks[item.id]?.version===published.version;
    line(box,item.name,acknowledged?'Acknowledged v'+published.version:'Awaiting acknowledgement');
  }
  for (const [key,value] of pairs(event.ready)) line(box,event.groups.find(item=>item.key===key)?.label??key,
    (value.status==='ready'?'Ready':'Needs attention')+(value.note?' · '+value.note:''));
  if (event.canAcknowledge) {
    const update=form(box);
    const group=field(update,'Your element',{choices:event.groups.filter(item=>event.leaderGroups.includes(item.key)).map(item=>[item.key,item.label]),value:event.leaderGroups[0]});
    const state=field(update,'Readiness',{choices:[['ready','Ready'],['attention','Needs attention']],value:'ready'});
    const note=field(update,'Note',{limit:800});
    submit(update,'Update readiness',()=>({action:'order-leader',event:event.key,kind:'ready',group:group.value,status:state.value,note:note.value}));
  }
  if (event.redemptions.length) heading(box,'Extra-life redemptions','h4');
  for (const item of event.redemptions) {
    line(box,item.name,item.status==='used'?'Used':'Reserved');
    if (data.access.command && item.status==='reserved' && event.start<=Date.now()) {
      actions(box,...[['used','Record life used'],['returned','Return unused reward']].map(([result,label])=>button(label,()=>save(()=>({action:'claim-result',id:item.id,result})))));
    }
  }
}
function followups() {
  const box=card(content,'Planning follow-ups');
  for (const item of data.followups??[]) followupForm(box,item);
  followupForm(box);
}
function followupForm(parent,item) {
  const box=card(parent,item?.title??'Create follow-up',true);
  if (item) line(box,'Status',item.closedAt?'Closed':'Open');
  const editor=form(box);
  const title=field(editor,'Follow-up',{required:true,limit:600,value:item?.title});
  const due=field(editor,'Due date (UK)',{type:'date',required:true,value:item?.due??day.format(Date.now())});
  const owner=field(editor,'Owner',{choices:[['','Unassigned'],...data.owners.map(row=>[row.id,row.name])],value:item?.owner});
  const event=field(editor,'Event',{choices:[['','Unlinked'],...data.events.map(row=>[row.key,row.title])],value:item?.event});
  const finding=field(editor,'Campaign finding',{choices:[['','Unlinked'],...data.findings.map(row=>[row.id,row.title])],value:item?.finding?.id});
  const closed=field(editor,'Closed',{type:'checkbox',value:item?.closedAt});
  submit(editor,item?'Save follow-up':'Create follow-up',()=>({action:'followup',id:item?.id,title:title.value,
    due:due.value,owner:owner.value,event:event.value,finding:finding.value,closed:closed.checked}));
}

function taskEditor(parent,prior) {
    const box=card(parent,prior?'Edit tasking':'Create tasking',true);
    const editor=form(box);
    const unit=field(editor,'Unit',{choices:[['','Choose a unit'],...data.units.map(item=>[item.key,item.name])],required:true,value:prior?.unit});
    const recipientList=el('p');
    editor.append(recipientList);
    unit.onchange=()=>{
      const item=data.units.find(item=>item.key===unit.value);
      recipientList.textContent=item?item.leaders.length?'Discord DMs will go to '+item.leaders.join(', ')+'.':
        'No leadership slots are filled for this unit. The tasking will be saved without leader DMs.':'';
    };
    unit.onchange();
    const title=field(editor,'Tasking title',{required:true,limit:140,value:prior?.title});
    const strength=field(editor,'Estimated strength',{required:true,limit:140,value:prior?.strength});
    strength.placeholder='For example, one team or four players';
    const deadlines=el('div','','uo-grid');
    const deadline=field(deadlines,'Task deadline (UK date)',{type:'date',required:true,value:prior?.deadline});
    const aarDeadline=field(deadlines,'AAR deadline (same day if blank)',{type:'date',value:prior?.aarDeadline});
    editor.append(deadlines);
    const task=field(editor,'In-game task description',{type:'textarea',required:true,limit:5000,value:prior?.task});
    const intended=field(editor,'Intended outcome',{type:'textarea',required:true,limit:3000,value:prior?.intended});
    const id=prior?.id??crypto.randomUUID();
    submit(editor,prior?'Save changes and notify leads':'Issue tasking',()=>({action:'tasking',id,edit:!!prior,revision:prior?.revision,unit:unit.value,title:title.value,strength:strength.value,
      deadline:deadline.value,aarDeadline:aarDeadline.value,task:task.value,intended:intended.value}),
      'Tasking issued. Leader DMs queued.',result=>{ history.replaceState(null,'',unitLink('taskings',{task:result.id})); query.set('task',result.id); });
  }

function taskings() {
  if (data.access.command) taskEditor(content);
  if (!data.taskings?.length) content.append(el('p','There are no taskings available to you.'));
  for (const item of data.taskings??[]) {
    const box=card(content,item.title+' · '+item.unitName+(item.archivedAt?' · Archived':item.closedAt?' · Closed':''),true);
    box.id='task-'+item.id;
    if (query.get('task')===item.id) { box.open=true; requestAnimationFrame(()=>box.scrollIntoView({block:'start'})); }
    line(box,'Estimated strength',item.strength);
    line(box,'Task deadline',item.deadline+' UK');
    line(box,'AAR deadline',item.aarDeadline+' UK');
    line(box,'In-game task',item.task);
    line(box,'Intended outcome',item.intended);
    line(box,'Actual outcome',item.result);
    if (item.aar) {
      const report=data.aars.find(row=>row.id===item.aar);
      if (report) box.append(link('Read linked AAR',report.href));
    }
    line(box,'Acknowledged',pairs(item.acks).map(([,ack])=>ack.name).join(', '));
    if (data.access.command && item.deliveries) {
      const sent=item.deliveries.filter(delivery=>delivery.status==='sent').length;
      line(box,'Discord',sent+' of '+item.deliveries.length+' leader DMs delivered');
    }
    if (data.access.command) {
      taskEditor(box,item);
      actions(box,button(item.archivedAt?'Restore tasking':'Archive tasking',()=>save(()=>confirm('Change this tasking’s archive status?')?
        {action:'tasking-action',id:item.id,kind:item.archivedAt?'restore':'archive'}:null)));
      if (item.closedAt&&!item.archivedAt) box.append(button('Reopen tasking',()=>save(()=>({action:'tasking-action',id:item.id,kind:'reopen'}))));
    }
    if (item.closedAt||item.archivedAt) continue;
    const ack=button(item.acks[data.member]?'Acknowledged':'Acknowledge tasking',()=>save(()=>({action:'tasking-action',id:item.id,kind:'ack'})));
    ack.disabled=!!item.acks[data.member];
    actions(box,ack);
    if (data.canAar||data.access.command) box.append(link('Start AAR','/members/aar/?'+new URLSearchParams({team:item.unitName})));
    const report=form(box);
    const result=field(report,'Actual outcome',{type:'textarea',value:item.result,required:true,limit:5000});
    const aar=field(report,'Submitted AAR',{choices:[['','No linked report'],...data.aars.map(row=>[row.id,row.title])],value:item.aar});
    submit(report,'Save outcome',()=>({action:'tasking-action',id:item.id,kind:'report',result:result.value,aar:aar.value}));
    if (data.access.command && item.result) box.append(button('Close tasking',()=>save(()=>confirm('Close this tasking?')?
      {action:'tasking-action',id:item.id,kind:'close'}:null)));
  }
}

function documentData(input) {
  const file=input.files?.[0];
  if (!file) return null;
  if (file.size>5_000_000) throw new Error('Course documents can be up to 5 MB each.');
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve({name:file.name,data:String(reader.result).split(',')[1]});
    reader.onerror=()=>reject(new Error('The selected document could not be opened.'));
    reader.readAsDataURL(file);
  });
}
function editCourse(parent,course) {
  const box=card(parent,course?'Edit '+course.name:'Create course',true);
  const editor=form(box);
  const name=field(editor,'Course name',{required:true,value:course?.name,limit:120});
  const qualifications=data.qualifications??[];
  const qualification=field(editor,'Qualification',{choices:[['','Choose a qualification'],...qualifications.map(item=>[item.key,item.name])],
    required:true,value:course?.qualification});
  qualification.disabled=!!course;
  const fileOptions={type:'file',required:!course};
  const presentation=field(editor,'Course presentation',fileOptions);
  const guide=field(editor,'Instructor guide',fileOptions);
  presentation.accept=guide.accept='.pdf,.pptx,.docx,.odt,.odp';
  if (course) actions(editor,link('Download presentation','/members/unit-file/'+course.presentation.id),link('Download instructor guide','/members/unit-file/'+course.guide.id));
  const title=field(editor,'Assessment form title',{required:true,value:course?.formTitle,limit:120});
  line(editor,'Template fields','Candidate, training event, qualification and assessment title are included on every form.');
  const rows=el('div');
  editor.append(rows);
  const criteria=[];
  function add(initial={}) {
    const box=el('fieldset');
    const title=field(box,'Criterion title',{required:true,value:initial.title,limit:120});
    const description=field(box,'Criterion description',{type:'textarea',value:initial.description,limit:1600});
    box.append(el('p','Assessment and feedback fields appear when this form is assigned.'));
    box.append(button('Remove line',()=>box.remove()));
    rows.append(box);
    criteria.push({box,title,description});
  }
  for (const initial of course?.criteria??[{}]) add(initial);
  editor.append(button('Add assessment line',()=>add()));
  submit(editor,'Save course',async()=>({action:'course',id:course?.id,version:course?.version,
    name:name.value,qualification:qualification.value,formTitle:title.value,
    presentation:await documentData(presentation),guide:await documentData(guide),
    criteria:criteria.filter(row=>row.box.isConnected).map(row=>({title:row.title.value,description:row.description.value}))}));
}
function trainingSchedule() {
  heading(content,'Schedule training');
  if (data.squadOnly && !data.squads.length) {
    content.append(el('p','Ask Command to assign you to your Squad Leader slot on the standing roster.'));
    return;
  }
  const editor=form(card(content,'New training event'));
  const event=crypto.randomUUID();
  const training=field(editor,'Training type',{choices:[...(data.squadOnly?[]:[['','Choose a training type']]),...data.types.map(({key,name})=>[key,name])],required:true,
    value:data.squadOnly?'squad':query.get('type')??''});
  const title=field(editor,'Training name',{value:query.get('title')??'',required:true,limit:120});
  const date=field(editor,'Session date (UK)',{type:'date',required:true,value:day.format(Date.now())});
  const time=field(editor,'Session time (UK)',{type:'time',required:true});
  const frequencies=[['none','Does not repeat'],['daily','Daily'],['weekly','Weekly'],['fortnightly','Every two weeks'],
    ['four-weekly','Every four weeks'],['monthly','Monthly']];
  const channel=field(editor,'Discord posting channel',{choices:[['','Default for this training type'],...(data.channels??[]).map(({id,name})=>[id,'#'+name])]});
  if (data.channelsUnavailable) editor.append(el('p','Discord channels are temporarily unavailable. Reload to choose a different channel.'));
  const repeat=field(editor,'Repeat',{choices:frequencies,value:'none'});
  const number=(text,value,min,max)=>{
    const input=field(editor,text,{type:'number',value,required:true});
    input.min=min;
    input.max=max;
    return input;
  };
  const places=number('Standard attendee places',12,1,99);
  const cadre=number('Cadre places',1,0,99);
  const limit=number('Extra priority places',1,0,9);
  const recipients=card(editor,'Discord invitation recipients',true);
  recipients.open=true;
  recipients.append(el('p','Each person gets one invite per session. Booked attendees get the usual start reminders.'));
  const recruitGroup=el('fieldset');
  recruitGroup.append(el('legend','Discord role'));
  const recruits=field(recruitGroup,'Invite recruits by DM',{type:'checkbox'});
  recipients.append(recruitGroup);
  const sync=()=>{
    limit.disabled=['','squad','unit','t1','t2'].includes(training.value);
    recruitGroup.hidden=recruits.disabled=!['t1','t2'].includes(training.value);
  };
  training.onchange=sync;
  sync();
  const squads=el('fieldset');
  squads.append(el('legend','Squads'));
  const squadChoices=data.squads.map(({key,label})=>[key,field(squads,label,{type:'checkbox'})]);
  recipients.append(squads);
  const members=el('fieldset');
  members.append(el('legend','Individual members'));
  const search=field(members,'Filter members',{type:'search'});
  const memberChoices=data.people.map(({id,name})=>[id,name,field(members,name,{type:'checkbox'})]);
  search.oninput=()=>{
    const term=search.value.toLowerCase().trim();
    for (const [,name,input] of memberChoices) input.parentElement.hidden=!name.toLowerCase().includes(term);
  };
  if (!data.squadOnly) recipients.append(members);
  submit(editor,'Schedule and post to Discord',()=>({action:'schedule-training',id:event,training:training.value,title:title.value,
    day:date.value,time:time.value,places:places.valueAsNumber,instructors:cadre.valueAsNumber,limit:limit.disabled?0:limit.valueAsNumber,
    channel:channel.value,repeat:repeat.value,squads:squadChoices.filter(([,input])=>input.checked).map(([key])=>key),
    people:memberChoices.filter(([, ,input])=>input.checked).map(([id])=>id),inviteRecruits:!recruits.disabled&&recruits.checked}),
    'Training queued. The bot will post it and send the selected invitations.');
  const series=card(content,'Upcoming repeat schedules');
  if (!data.series.length) series.append(el('p','No recurring training is currently posted.'));
  for (const item of data.series) {
    const entry=card(series,eventText(item));
    entry.append(el('p',frequencies.find(([key])=>key===item.repeat)?.[1]??item.repeat));
    if (item.canStop) {
      const stop=form(entry);
      submit(stop,'Stop repeating',()=>confirm('Keep this session and stop future events in the series?')?
        {action:'stop-training-series',event:item.key}:null,'Stop request queued.');
    }
  }
}
function assessment(parent,course,existing,previous,correction=false) {
  if (!course) return;
  const box=card(parent,correction?'Correct recorded feedback':existing?'Continue assessment':previous?'New retest':'Assign candidate assessment');
  box.id='assessment-editor';
  const editor=form(box);
  let version=existing?.updated;
  const title=field(editor,'Title',{value:existing?.title??course.formTitle,required:true,limit:120});
  line(editor,'Qualification',data.qualifications?.find(row=>row.key===course.qualification)?.name??course.qualification);
  const who=field(editor,'Unit member',{choices:[['','Choose a unit member'],...(data.people??[]).map(item=>[item.id,item.name])],
    value:existing?.member??previous?.member,required:true});
  if (existing || previous) who.disabled=true;
  const choices=[['','Choose a course session'],...(data.events??[]).filter(item=>item.qualification===course.qualification).map(item=>[item.key,eventText(item)])];
  const event=field(editor,'Training event',{choices,value:existing?.event??'',required:true});
  if (existing) event.disabled=true;
  const route=course.qualification==='t2'?field(editor,'T2 route',{choices:[['','Use recorded profile'],['rangers','Rangers'],['pilot','Pilot']]}):null;
  const feedback=field(editor,'Feedback summary',{type:'textarea',value:existing?.summary,limit:2400});
  const criteria=(existing?.lines??course.criteria).map(item=>{
    const box=el('fieldset');
    box.append(el('legend',item.title));
    line(box,'Criterion',item.description);
    editor.append(box);
    return {
      assessment:field(box,'Assessment',{type:'textarea',value:item.assessment,limit:1200}),
      feedback:field(box,'Feedback',{type:'textarea',value:item.feedback,limit:1600}),
    };
  });
  const current=()=>({action:'assessment',id:existing?.id,updated:version,course:course.id,previous:previous?.id??existing?.previous,
    member:who.value,event:event.value,route:route?.value,title:title.value,summary:feedback.value,
    lines:criteria.map(row=>({assessment:row.assessment.value,feedback:row.feedback.value}))});
  if (correction) {
    const reason=field(editor,'Correction reason',{required:true,type:'textarea',limit:600});
    submit(editor,'Save feedback correction',()=>({...current(),action:'assessment-correction',reason:reason.value}),
      'Feedback corrected. The previous version remains in the audit history.',()=>{openAssessment=null;});
    return;
  }
  const draft=button('Save draft',null,'submit');
  const choicesResult=pairs(outcomes).filter(([key])=>['passed','retest','failed'].includes(key))
    .map(([key,label])=>[key,button('Mark '+label.toLowerCase(),null,'submit')]);
  actions(editor,draft,...choicesResult.map(([,button])=>button));
  editor.onsubmit=ev=>{
    ev.preventDefault();
    const result=choicesResult.find(([,button])=>button===ev.submitter)?.[0]??'draft';
    if (result!=='draft' && !confirm('Record '+outcomes[result].toLowerCase()+' for this candidate?')) return;
    void save(()=>({...current(),status:result}),result==='draft'?'Assessment draft saved.':'Assessment result recorded.',
      {after:response=>{ openAssessment=result==='draft'?{existing:response.id}:null; }});
  };
  box.scrollIntoView({block:'nearest'});
}
function candidateRecords() {
  const records=data.assessments??[];
  const available=data.courses??[];
  if (view==='courses') {
    heading(content,'Course library');
    if (!data.qualifications?.length) content.append(el('p','Command needs to link your cadre role to a course qualification before you can edit materials.'));
    else editCourse(content);
    for (const course of available) {
      const box=card(content,course.name+(course.archivedAt?' · Archived':''));
      line(box,'Assessment form',course.formTitle+' · '+course.criteria.length+' criteria');
      actions(box,link('Presentation','/members/unit-file/'+course.presentation.id),link('Instructor guide','/members/unit-file/'+course.guide.id),
        ...(course.canAssess&&!course.archivedAt?[button('Assign assessment',()=>{
          openAssessment={course:course.id};
          render();
        })]:[]));
      editCourse(box,course);
      if (!course.archivedAt) box.append(link('Schedule a session',unitLink('training',{type:course.qualification,title:course.name,from:'courses'})));
      box.append(button(course.archivedAt?'Restore course':'Archive course',()=>save(()=>confirm('Change this course’s archive status?')?
        {action:'course-archive',course:course.id,restore:!!course.archivedAt}:null)));
    }
  }
  if (openAssessment) {
    const existing=records.find(item=>item.id===openAssessment.existing);
    const previous=records.find(item=>item.id===openAssessment.previous);
    const course=available.find(item=>item.id===(existing?.course??previous?.course??openAssessment.course));
    assessment(content,course,existing,previous,openAssessment.correction);
  }
  heading(content,'Candidate assessments');
  if (!records.length) { content.append(el('p','No assessments are available to you.')); return; }
  const search=form(content);
  const filter=field(search,'Find a candidate or course',{type:'search',value:recordFilter});
  const list=el('div');
  content.append(list);
  function showRecords() {
    recordFilter=filter.value;
    list.replaceChildren();
    for (const item of records.toSorted((a,b)=>b.updated-a.updated)) {
      if (!(item.memberName+' '+item.courseName+' '+item.title).toLowerCase().includes(recordFilter.toLowerCase())) continue;
      const box=card(list,item.memberName+' · '+item.title+' · '+outcomes[item.status],true);
      line(box,'Course',item.courseName);
      line(box,'Training event',item.eventName);
      line(box,'Recorded',when(item.updated));
      line(box,'Feedback summary',item.summary);
      for (const criterion of item.lines) {
        const detail=card(box,criterion.title);
        line(detail,'Description',criterion.description);
        line(detail,'Assessment',criterion.assessment);
        line(detail,'Feedback',criterion.feedback);
      }
      const course=available.find(course=>course.id===item.course);
      if (item.corrections?.length) {
        const history=card(box,'Feedback corrections',true);
        for (const edit of item.corrections) {
          const original=card(history,when(edit.at)+' · '+edit.reason,true);
          line(original,'Previous title',edit.title);
          line(original,'Previous summary',edit.summary);
          for (const criterion of edit.lines) {
            line(original,criterion.title+' · Assessment',criterion.assessment);
            line(original,criterion.title+' · Feedback',criterion.feedback);
          }
        }
      }
      if (course?.canAssess && item.status!=='draft') box.append(button('Correct feedback',()=>{
        openAssessment={existing:item.id,correction:true};
        render();
      }));
      if (course?.canAssess && (item.status==='draft'||!course.archivedAt&&['retest','failed'].includes(item.status))) {
        box.append(button(item.status==='draft'?'Continue draft':'New retest',()=>{
          openAssessment=item.status==='draft'?{existing:item.id}:{previous:item.id};
          render();
        }));
      }
    }
    if (!list.children.length) list.append(el('p','No matching assessments.'));
  }
  filter.oninput=showRecords;
  search.onsubmit=event=>event.preventDefault();
  showRecords();
}

function checkTable(parent,rows,columns,makeRow) {
  const outer=el('div','','uo-scroll');
  const table=el('table','','uo-table');
  const head=el('thead');
  const title=el('tr');
  for (const column of columns) {
    const label=el('th',column);
    label.scope='col';
    title.append(label);
  }
  head.append(title);
  const body=el('tbody');
  const displayed=rows.map(item=>{
    const tr=el('tr');
    const cell=()=>{ const item=el('td'); tr.append(item); return item; };
    const values=makeRow(item,cell);
    body.append(tr);
    return {item,...values};
  });
  table.append(head,body);
  outer.append(table);
  parent.append(outer);
  return displayed;
}
function batchControls(parent,rows,choiceLabel,choices,{allLabel,unmarked}={}) {
  const panel=el('div','','uo-buttons');
  parent.prepend(panel);
  panel.append(button('Select all',()=>{ for (const item of rows) if (!item.picked.disabled) item.picked.checked=true; }),
    button('Clear selection',()=>{ for (const item of rows) item.picked.checked=false; }));
  const choice=field(panel,choiceLabel,{choices,value:choices[0][0]});
  panel.append(button('Apply to selected',()=>{
    for (const row of rows) if (row.picked.checked&&!row.value.disabled) row.value.value=choice.value;
  }));
  if (allLabel) panel.append(button(allLabel,()=>{
    for (const row of rows) if (!row.value.disabled && unmarked(row)) row.value.value=choices[0][0];
  }));
}
function attendance() {
  chooseEvent(content,data.events??[],activeEvent,(parent,event)=>{
    if (event.register) {
      const box=card(parent,event.register.closedAt?'Confirmed attendance':'Attendance register');
      const staffCanEdit=!event.register.closedAt||data.access.command;
      const editor=form(box);
      const counts=field(editor,'Count this as the weekly attendance and reward event',{type:'checkbox',value:event.register.counts});
      counts.disabled=!staffCanEdit||!['operation','training'].includes(event.kind);
      const rows=checkTable(editor,event.register.rows,['Select','Member','Attendance'],(item,cell)=>{
        const picked=field(cell(),'Select '+item.name,{type:'checkbox'});
        picked.disabled=!staffCanEdit;
        cell().append(el('strong',item.name));
        const value=field(cell(),'Attendance for '+item.name,{choices:pairs(marks),value:item.mark});
        value.disabled=!staffCanEdit;
        return {picked,value};
      });
      if (staffCanEdit && rows.length) {
        batchControls(editor,rows,'Bulk attendance choice',pairs(marks).slice(1),
          {allLabel:'Mark all unmarked attended',unmarked:row=>!row.value.value});
        const state=()=>{
          const summary=rows.reduce((counts,row)=>{ const status=marks[row.value.value]; counts[status]=(counts[status]??0)+1; return counts; },{});
          return Object.entries(summary).map(([label,total])=>label+' '+total).join(' · ');
        };
        const saveDraft=button('Save attendance draft',null,'submit');
        const finalize=button(event.register.closedAt?'Confirm correction':'Confirm attendance',null,'submit');
        actions(editor,...(event.register.closedAt?[]:[saveDraft]),finalize);
        editor.onsubmit=ev=>{
          ev.preventDefault();
          const confirmed=ev.submitter===finalize;
          if (confirmed && !confirm('Confirm this register? '+state())) return;
          void save(()=>({action:'register',event:event.key,version:event.register.version,counts:counts.checked,confirm:confirmed,
            marks:Object.fromEntries(rows.map(row=>[row.item.member,row.value.value]))}),
            confirmed?'Attendance confirmed. Discord synchronisation queued.':'Attendance draft saved.');
        };
      }
      if (event.canSignoff) bulkResults(parent,event);
    } else {
      parent.append(el('p','Attendance opens when the event starts.'));
      if (event.canSignoff || data.access.command && event.kind==='operation') {
        const box=card(parent,'Rewards for this event');
        const editor=form(box);
        const limit=event.qualification?field(editor,'Extra priority course places',{type:'number',value:event.priorityLimit,required:true}):null;
        if (limit) { limit.min=0; limit.max=9; }
        const life=!limit?field(editor,'Allow extra-life redemptions',{type:'checkbox',value:event.life}):null;
        submit(editor,'Save reward rules',()=>({action:'limit',event:event.key,limit:limit?.valueAsNumber,life:life?.checked}));
      }
    }
  });
}
function bulkResults(parent,event) {
  const box=card(parent,'Bulk candidate results');
  const candidates=event.register.rows.filter(row=>row.candidate);
  if (!candidates.length) { box.append(el('p','There are no booked candidates.')); return; }
  const editor=form(box);
  const courses=(data.courseTemplates??[]).filter(row=>row.qualification===event.qualification);
  const course=field(editor,'Assessment template',{choices:[['',event.basicStage?'Use existing Basic Training sign-off':'Choose a course'],
    ...courses.map(row=>[row.id,row.name])],required:!event.basicStage});
  const feedback=field(editor,'Shared feedback (optional)',{type:'textarea',limit:2400});
  const rows=checkTable(editor,candidates,['Select','Candidate','Result',...(event.basicStage==='t2'?['Route']:[])],(item,cell)=>{
    const picked=field(cell(),'Select '+item.name,{type:'checkbox'});
    cell().append(el('strong',item.name));
    const value=field(cell(),'Result for '+item.name,{choices:[['','No change'],['passed','Passed'],['retest','Needs retest'],
      ['failed','Failed'],['repeat','Needs retest (recorded)'],['absent','Absent (recorded)']],value:item.result});
    const route=event.basicStage==='t2'?field(cell(),'T2 route for '+item.name,{choices:[['','Use recorded profile'],['rangers','Rangers'],['pilot','Pilot']]}):null;
    picked.disabled=value.disabled=!!item.result;
    if (route) route.disabled=!!item.result;
    return {picked,value,route};
  });
  batchControls(editor,rows,'Bulk result choice',[['passed','Passed'],['retest','Needs retest'],['failed','Failed']]);
  submit(editor,'Review and confirm results',()=>{
    const results=rows.filter(row=>!row.value.disabled&&row.value.value).map(row=>({member:row.item.member,status:row.value.value,route:row.route?.value}));
    if (!results.length) throw new Error('Mark at least one candidate result.');
    const totals=Object.fromEntries(['passed','retest','failed'].map(key=>[outcomes[key],results.filter(row=>row.status===key).length]));
    if (!confirm('Confirm '+Object.entries(totals).map(([label,count])=>label+': '+count).join(' · ')+'?')) return;
    return {action:'bulk-results',event:event.key,course:course.value,feedback:feedback.value,rows:results};
  },result=>result.recorded+' recorded or queued · '+result.skipped+' already recorded.');
}

function applications() {
  if (view==='applications') {
    heading(content,'Apply for a qualification');
    line(content,'Seasoned Member',data.seasoned?'Earned':Math.min(10,data.operations??0)+' of 10 operations after probation');
    const available=(data.qualifications??[]).filter(row=>!row.seasoned||data.seasoned);
    if (available.length) {
      const editor=form(card(content,'New application'));
      const qualification=field(editor,'Qualification',{choices:[['','Choose a qualification'],...available.map(row=>[row.key,row.name])],required:true});
      const note=field(editor,'Why are you applying?',{type:'textarea',required:true,limit:1800});
      submit(editor,'Submit application',()=>({action:'application',qualification:qualification.value,note:note.value}),
        'Application submitted. Discord notification queued.');
    } else content.append(el('p','No qualifications are currently open to you.'));
    const locked=(data.qualifications??[]).filter(item=>item.seasoned&&!data.seasoned);
    if (locked.length) line(content,'Unlocks at Seasoned Member',locked.map(item=>item.name).join(', '));
  }
  if (view==='application-review' && !data.applications?.length) content.append(el('p','No applications are available to review.'));
  for (const item of (data.applications??[]).toSorted((a,b)=>b.at-a.at)) {
    const box=card(content,item.qualificationName+' · '+item.status,true);
    line(box,'Candidate',item.name);
    line(box,'Application',item.note);
    line(box,'Decision',item.decision);
    if (item.canReview && (item.status==='pending'||data.access.command)) {
      const editor=form(box);
      const note=field(editor,'Decision note',{type:'textarea',limit:1200});
      const approve=button('Approve',null,'submit');
      const decline=button('Decline',null,'submit');
      const reopen=button('Reopen application',null,'submit');
      actions(editor,approve,decline,...(item.status!=='pending'?[reopen]:[]));
      editor.onsubmit=ev=>{
        ev.preventDefault();
        if (![approve,decline,reopen].includes(ev.submitter)) return;
        void save(()=>({action:'review-application',id:item.id,status:ev.submitter===approve?'approved':ev.submitter===reopen?'pending':'declined',note:note.value}),
          'Decision saved. The member will be notified privately.');
      };
    }
  }
}
function attendanceHistory(parent,list) {
  for (const entry of list.weeks??[]) line(parent,entry.title,day.format(entry.start)+' UK · '+(marks[entry.mark]??entry.mark));
  if (!list.weeks?.length) parent.append(el('p','No confirmed attendance in the rolling window.'));
}
function progress() {
  const award=card(content,'Attendance reward');
  line(award,'Operations',Math.min(5,data.rewards.operations)+' / 5');
  line(award,'Training',Math.min(5,data.rewards.training)+' / 5');
  line(award,'Reward available',data.rewards.available?'Yes':'Keep attending scheduled events');
  if (data.rewards.available && data.options.length) {
    const editor=form(award);
    const event=field(editor,'Use a reward',{choices:[['','Choose an event'],...data.options.map(item=>[
      item.key,(item.kind==='life'?'Extra in-game life':'Priority course place')+' · '+eventText(item),
    ])],required:true});
    submit(editor,'Reserve reward',()=>confirm('Reserve your attendance reward for this event?')?{action:'claim',event:event.value}:null,
      'Reward request saved. Check this page for the result.');
  }
  for (const claim of data.rewards.claims.toSorted((a,b)=>b.created-a.created)) {
    line(award,claim.eventName,(claim.kind==='life'?'Extra life':'Priority place')+' · '+claim.status);
    if (claim.status==='reserved' && claim.start>Date.now()) award.append(button('Cancel '+claim.eventName+' reservation',()=>save(()=>({
      action:'claim-result',id:claim.id,result:'cancel',
    }))));
  }
  const window=card(content,'Last ten weeks');
  line(window,'Unexcused misses',data.attendance.absent);
  line(window,'Approved LOA weeks',data.attendance.loa);
  if (data.held) window.append(el('p','The attendance case is under review or exempt.'));
  attendanceHistory(window,data.attendance);
  if (data.warnings.length) {
    heading(window,'Attendance history','h4');
    for (const warning of data.warnings) {
      const row=el('p',when(warning.at)+' · '+warning.title,warning.staff?'':'uo-warning');
      window.append(row);
    }
  }
  if (data.canRequestReserves && data.reserveRequest?.status!=='pending') {
    const request=form(card(window,'Request a move to Reserves',true));
    const note=field(request,'Reason for your request',{type:'textarea',required:true,limit:500});
    submit(request,'Send Reserve request to Command',()=>({action:'reserve-request',note:note.value}),
      'Reserve request sent to Command.');
  }
  if (data.reserveRequest) line(window,'Reserve request',data.reserveRequest.status);
  const progression=card(content,'Post-probation progress');
  line(progression,'Seasoned Member',data.seasoned?'Earned':data.operations+' / 10 confirmed operations');
  if (data.qualifications.length) line(progression,'Qualifications earned',data.qualifications.join(', '));
}
function command() {
  const box=card(content,'Needs attention');
  actions(box,link(data.inbox.applications+' pending applications',unitLink('application-review')),
    link(data.inbox.taskings+' overdue tasking AARs',unitLink('taskings')),
    link(data.inbox.overdue.length+' overdue follow-ups',unitLink('orders')),
    link(data.inbox.vacancies.length+' roster vacancies','/staff/administration/tools/?tool=assignments'));
  if (data.inbox.overdue.length) for (const row of data.inbox.overdue) line(box,row.title,row.due);
  const management=card(content,'Attendance cases');
  for (const item of data.cases) {
    const details=card(management,item.name+(item.review?' · LOA review':item.hold?' · On hold':' · Warning level '+item.stage),true);
    line(details,'Exemption',item.exemption?'Through '+day.format(item.exemption.end-1)+' UK':'');
    line(details,'Missed weeks',item.attendance.absent);
    line(details,'LOA weeks',item.attendance.loa);
    attendanceHistory(details,item.attendance);
    for (const row of item.history) line(details,when(row.at),row.title+(row.reason?' · '+row.reason:''));
    if (item.reserveRequest?.status==='pending') {
      line(details,'Reserve request',item.reserveRequest.reason);
      const reject=form(details);
      const reason=field(reject,'Reason for declining this request',{required:true,limit:500});
      submit(reject,'Decline Reserve request',()=>confirm('Decline the request to move to Reserves?')?
        {action:'intervene',kind:'decline-reserve',member:item.id,reason:reason.value}:null);
    }
    intervention(details,item.id);
  }
  intervention(card(management,'Intervene for a member',true),'');
  memberAdjustments();
  configuration();
  const queue=card(content,'Discord and bot delivery');
  if (!data.delivery.length) queue.append(el('p','No pending deliveries or errors.'));
  for (const row of data.delivery) {
    const details=card(queue,row.id+' · '+row.status,true);
    line(details,'Attempts',row.attempts);
    line(details,'Latest message',row.error);
    if (row.status==='failed') details.append(button('Retry delivery',()=>save(()=>({action:'retry',id:row.id}),'Delivery queued again.')));
  }
}
function intervention(parent,member) {
  const editor=form(parent);
  const candidate=field(editor,'Member',{choices:[['','Choose a member'],...data.people.map(item=>[item.id,item.name])],
    required:true,value:member});
  if (member) candidate.disabled=true;
  const action=field(editor,'Command action',{choices:[
    ['hold','Put attendance action on hold'],['resume','Review LOA and resume policy'],['exempt','Set dated exemption'],
    ['clear','Clear dated exemption'],['reserve','Approve move to Reserves'],
  ],value:'hold'});
  const end=field(editor,'Exemption ends after (UK date)',{type:'date'});
  function sync() { end.disabled=action.value!=='exempt'; end.required=!end.disabled; }
  sync();
  action.onchange=sync;
  const reason=field(editor,'Reason',{type:'textarea',required:true,limit:500});
  submit(editor,'Apply intervention',()=>confirm('Apply this Command intervention to the selected member?')
    ? {action:'intervene',kind:action.value,member:candidate.value,reason:reason.value,until:end.value}:null);
}
function memberAdjustments() {
  const box=card(content,'Member qualifications and reward adjustments',true);
  const editor=form(box);
  const member=field(editor,'Member',{choices:[['','Choose a member'],...data.people.map(row=>[row.id,row.name])],required:true});
  const type=field(editor,'Change',{choices:[['seasoned','Seasoned Member'],['qualification','Qualification'],['credits','Reward balance']],value:'seasoned'});
  const qualification=field(editor,'Qualification',{choices:[['','Choose qualification'],...data.qualifications.map(item=>[item.key,item.name])]});
  const mode=field(editor,'Access',{choices:[['grant','Grant'],['revoke','Revoke'],['automatic','Restore automatic rules']],value:'grant'});
  const credit=field(editor,'Reward adjustment (positive or negative)',{type:'number',value:0});
  credit.min=-100;
  credit.max=100;
  const reason=field(editor,'Reason',{required:true,type:'textarea',limit:500});
  const previous=el('div');
  editor.append(previous);
  function sync() {
    const current=data.adjustments[member.value];
    qualification.disabled=type.value!=='qualification';
    qualification.required=!qualification.disabled;
    mode.disabled=type.value==='credits';
    credit.disabled=!mode.disabled;
    if (mode.disabled) credit.value=current?.credits??0;
    previous.replaceChildren();
    for (const row of (current?.history??[]).slice(-10).toReversed()) line(previous,when(row.at),[row.kind,row.qualification,row.mode,row.credits,row.reason].filter(value=>value!==undefined).join(' · '));
  }
  member.onchange=type.onchange=sync;
  sync();
  submit(editor,'Save member adjustment',()=>confirm('Apply this change to the member’s record?')?
    {action:'member-adjustment',member:member.value,kind:type.value,mode:mode.value,qualification:qualification.value,
      credits:credit.valueAsNumber,reason:reason.value}:null);
}
function configuration() {
  const settings=card(content,'Role and attendance settings',true);
  const editor=form(settings);
  const roles=pairs(specialties).map(([key,label])=>[key,field(editor,label+' Discord role ID',{value:data.settings.roles[key],limit:20})]);
  const channel=field(editor,'Private Command Discord channel ID',{value:data.settings.channel,limit:20});
  const enabled=field(editor,'Enable rolling attendance warnings, roster release and removal',{type:'checkbox',value:data.settings.policy});
  submit(editor,'Save settings',()=>enabled.checked && !data.settings.policy && !confirm('Enable the rolling policy on confirmed registers? When the removal threshold is met, the TAG bot can remove a member.')
    ? null : {action:'settings',roles:Object.fromEntries(roles.map(([key,input])=>[key,input.value.trim()])),channel:channel.value.trim(),policy:enabled.checked});
  const qualifications=card(content,'Qualification access and reviewers',true);
  const selectorForm=form(qualifications);
  const chosen=field(selectorForm,'Qualification',{choices:[['','Create qualification'],...data.qualifications.map(item=>[item.key,item.name])]});
  const body=el('div');
  selectorForm.append(body);
  selectorForm.onsubmit=event=>event.preventDefault();
  function show() {
    body.replaceChildren();
    const current=data.qualifications.find(item=>item.key===chosen.value);
    const fieldset=el('div');
    body.append(fieldset);
    const key=field(fieldset,'Qualification key',{value:current?.key,required:true,limit:80});
    key.disabled=!!current;
    const name=field(fieldset,'Qualification name',{value:current?.name,required:true,limit:100});
    const specialty=field(fieldset,'Assessor specialty',{choices:[['','Choose specialty'],...pairs(specialties).filter(([key])=>key!=='seasoned')],
      value:current?.specialty,required:true});
    const discord=field(fieldset,'Discord award role ID (optional)',{value:current?.discordRole,limit:20});
    const reviewer=field(fieldset,'Application reviewer role ID (optional)',{value:current?.reviewer,limit:20});
    const apply=field(fieldset,'Open applications',{type:'checkbox',value:current?.applications});
    const seasoned=field(fieldset,'Require Seasoned Member',{type:'checkbox',value:current?.seasoned});
    const saveButton=button('Save qualification',null,'submit');
    fieldset.append(saveButton);
    selectorForm.onsubmit=event=>{
      event.preventDefault();
      void save(()=>({action:'qualification',key:key.value,name:name.value,specialty:specialty.value,
        reviewer:reviewer.value.trim(),discordRole:discord.value.trim(),applications:apply.checked,seasoned:seasoned.checked}));
    };
  }
  chosen.onchange=show;
  show();
}

function gm() {
  chooseEvent(content,data.events??[],activeEvent,(parent,event)=>{
    const record=event.brief;
    const published=record?.published;
    if (!published) parent.append(el('p','No GM brief has been published for this operation.'));
    else {
      const panel=card(parent,'Private GM brief · '+event.title);
      if (event.order) line(panel,'Operation orders',event.order);
      line(panel,'Previous operation and campaign context',published.previous);
      line(panel,'Reconnaissance and AAR summary',published.recon);
      line(panel,'GM decision space and limits',published.discretion);
      line(panel,'Combination rule',published.combinations?'You may combine permitted branches.':'Choose at most one permitted branch.');
      for (const finding of published.findings) {
        const row=el('p');
        row.append(link(finding.title,finding.href));
        panel.append(row);
      }
      for (const branch of published.branches) line(panel,branch.title,branch.description||'Permitted');
      for (const [id,choice] of pairs(record.choices)) {
        if (id===data.member || !choice.sharedAt) continue;
        const selected=choice.revision===published.revision?published.branches.filter(branch=>choice.selection.includes(branch.id)).map(branch=>branch.title).join(', '):'Earlier brief revision';
        line(panel,'GM outcome shared '+when(choice.sharedAt),[selected,choice.note].filter(Boolean).join(' · '));
      }
      if (data.access.gameMaster&&published.assignees.includes(data.member)) {
        const editor=form(panel);
        const prior=record.choices[data.member];
        const selected=prior?.revision===published.revision?prior.selection:[];
        const choices=published.combinations?published.branches.map(branch=>[
          branch.id,field(editor,branch.title,{type:'checkbox',value:selected.includes(branch.id)}),
        ]):null;
        const choice=!choices?field(editor,'Select a scenario branch',{choices:[['','Undecided'],...published.branches.map(branch=>[branch.id,branch.title])],
          value:selected[0]}):null;
        const note=field(editor,'GM notes',{type:'textarea',value:prior?.note,limit:4000});
        const privateButton=button('Save private choices',null,'submit');
        const shareButton=button('Share outcome with Command',null,'submit');
        shareButton.disabled=!event.closed;
        actions(editor,privateButton,shareButton);
        editor.onsubmit=ev=>{
          ev.preventDefault();
          const share=ev.submitter===shareButton;
          if (share&&!confirm('Share your chosen branches and notes with Command?')) return;
          void save(()=>({action:'gm-choice',event:event.key,revision:published.revision,
            selection:choices?choices.filter(([,input])=>input.checked).map(([id])=>id):choice.value?[choice.value]:[],
            note:note.value,share}),share?'Outcome shared with Command.':'Choices saved privately.');
        };
      }
    }
    if (!data.access.command) return;
    const editor=form(card(parent,record?.draft?'Continue GM brief draft':'Edit GM brief',true));
    const template=record?.draft||published||{assignees:[],branches:[],findings:[]};
    if (!data.gameMasters.length) line(editor,'Assignments','Configure the Game Master role in the Command inbox and assign it in Discord.');
    const assigned=data.gameMasters.map(row=>[row.id,field(editor,'Assign '+row.name,{type:'checkbox',value:template.assignees.includes(row.id)})]);
    const previous=field(editor,'Previous operation and campaign context',{type:'textarea',value:template.previous,limit:6000});
    const recon=field(editor,'Reconnaissance and AAR summary',{type:'textarea',value:template.recon,limit:6000});
    const discretion=field(editor,'GM decision space and limits',{type:'textarea',value:template.discretion,required:true,limit:6000});
    const findings=data.findings.map(item=>[item.id,field(editor,item.title,{type:'checkbox',value:template.findings.some(old=>old.id===item.id)})]);
    const combination=field(editor,'Allow any combination of the listed branches',{type:'checkbox',value:template.combinations});
    const branches=el('div');
    editor.append(branches);
    const rows=[];
    function add(initial={}) {
      const node=el('fieldset');
      branches.append(node);
      const title=field(node,'Permitted scenario branch',{value:initial.title,required:true,limit:150});
      const description=field(node,'Conditions and details',{type:'textarea',value:initial.description,limit:2200});
      node.append(button('Remove branch',()=>node.remove()));
      rows.push({node,title,description});
    }
    for (const branch of template.branches) add(branch);
    editor.append(button('Add permitted branch',()=>add()));
    const draft=button('Save GM brief draft',null,'submit');
    const publish=button('Publish and DM assigned GMs',null,'submit');
    actions(editor,draft,publish);
    if (published) editor.append(button('Withdraw GM brief',()=>save(()=>confirm('Withdraw this Game Master brief?')?
      {action:'game-brief',event:event.key,revision:record.revision,withdraw:true}:null)));
    editor.onsubmit=ev=>{
      ev.preventDefault();
      const publishing=ev.submitter===publish;
      if (publishing&&!confirm('Publish this private brief to the assigned Game Masters?')) return;
      void save(()=>({action:'game-brief',event:event.key,revision:record?.revision??0,
        assignees:assigned.filter(([,input])=>input.checked).map(([id])=>id),previous:previous.value,recon:recon.value,
        discretion:discretion.value,findings:findings.filter(([,input])=>input.checked).map(([id])=>id),
        combinations:combination.checked,branches:rows.filter(row=>row.node.isConnected).map(row=>({title:row.title.value,description:row.description.value})),
        publish:publishing}),publishing?'Private brief published. Discord DMs queued.':'Private draft saved.');
    };
  });
}

function honoursView() {
  const catalogue=data.honours??[];
  const title=key=>catalogue.find(item=>item.key===key)?.title??'Honour';
  const choices=catalogue.map(item=>[item.key,item.title]);
  if (view==='honours') {
    const section=card(content,'Recommend a member for honours');
    const nomination=form(section);
    const nominee=field(nomination,'Member',{required:true,choices:[['','Choose a member'],...(data.nominees??[]).map(item=>[item.id,item.name])]});
    const award=field(nomination,'Suggested honour',{required:true,choices:[['','Choose an honour'],...choices]});
    const criteria=el('p');
    award.onchange=()=>{criteria.textContent=catalogue.find(item=>item.key===award.value)?.criteria??'';};
    nomination.append(criteria);
    const operation=field(nomination,'Main operation',{choices:[['','General contribution'],...(data.operations??[]).map(item=>[item.key,eventText(item)])]});
    const detail=field(nomination,'What did they do, and what difference did it make?',{type:'textarea',required:true,limit:3000});
    const evidence=field(nomination,'Witness or clip link (optional)',{limit:600});
    const nominationId=crypto.randomUUID();
    actions(nomination,button('Send recommendation',null,'submit'));
    nomination.onsubmit=event=>{
      event.preventDefault();
      void save(()=>({action:'honour-nomination',id:nominationId,member:nominee.value,award:award.value,event:operation.value,
        detail:detail.value,evidence:evidence.value}),'Recommendation sent to TAG Commander for review.');
    };
    return;
  }
  if (!data.honoursReview) return;
  const review=card(content,'Honours review');
  const nominations=data.nominations??[];
  const requested=query.get('nomination');
  for (const item of nominations.toSorted((a,b)=>Number(b.id===requested)-Number(a.id===requested) ||
    Number(b.status==='pending')-Number(a.status==='pending'))) {
    const entry=card(review,item.memberName+' · '+title(item.suggested),true);
    line(entry,'Recommended by',item.submittedBy);
    line(entry,'Operation',item.operation);
    line(entry,'Recommendation',item.detail);
    line(entry,'Witness or clip',item.evidence);
    if (item.status!=='pending') {
      line(entry,'Decision',item.status==='approved'?'Awarded '+title(item.award):'Declined');
      line(entry,'Citation',item.citation);
      continue;
    }
    const decision=form(entry);
    const finalAward=field(decision,'Honour to award',{choices,value:item.suggested});
    const citation=field(decision,'Citation for the member card',{type:'textarea',limit:2000});
    const approve=button('Approve and publish',null,'submit');
    const decline=button('Decline',()=>save(()=>confirm('Decline this recommendation?') ?
      {action:'honour-review',id:item.id,status:'declined'} : null,'Recommendation declined.'));
    actions(decision,approve,decline);
    decision.onsubmit=event=>{
      event.preventDefault();
      void save(()=>({action:'honour-review',id:item.id,status:'approved',award:finalAward.value,citation:citation.value}),'Honour awarded.');
    };
  }
  if (!nominations.length) review.append(el('p','No recommendations yet.'));
}

function render() {
  content.replaceChildren();
  const pageTitle=document.querySelector('#unit-title');
  if (pageTitle) pageTitle.textContent=views[view]??'Unit operations';
  if (!data.views.includes(view)) {
    content.append(el('p','This area is unavailable for your roles.'));
    return;
  }
  const routes={orders,taskings,applications,progress,courses:candidateRecords,records:candidateRecords,training:trainingSchedule,attendance,gm,command,
    honours:honoursView,'honours-review':honoursView,'application-review':applications};
  routes[view]();
}
async function load() {
  try {
    data=await api();
    render();
    status.textContent='';
    return true;
  } catch (error) {
    status.replaceChildren(document.createTextNode(error.message+' '),button('Try again',load));
  }
}
void load();
