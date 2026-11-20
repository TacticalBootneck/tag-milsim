'use strict';

const root = document.querySelector('#workspace-content');
const status = document.querySelector('#workspace-status');
const params=new URLSearchParams(location.search);
const aarPage=location.pathname==='/members/aar/';
if (aarPage) {
  document.querySelector('#workspace h1').textContent='After-action reports';
  document.title='AARs | TAG MILSIM';
}
const types = {recon:'Reconnaissance',shaping:'Shaping Operation',main:'Main Operation'};
const day = new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'});
const eventDate = new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',dateStyle:'medium',timeStyle:'short'});
const imagePath = id => '/members/campaign-image/'+id;
let workspace;
let urls = [];

function element(tag, text = '', className = '') {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(label, click) {
  const node = element('button',label,'button outline small');
  node.type = 'button';
  if (click) node.onclick = click;
  return node;
}
function link(label,href) {
  const node = element('a',label);
  node.href = href;
  return node;
}
function line(parent,title,text) {
  if (!text) return;
  const row = element('p','','cw-text');
  row.append(element('strong',title+' '),document.createTextNode(text));
  parent.append(row);
}
function field(parent,label,{type='text',value='',limit,required=false,options}={}) {
  const wrapper = element('label',label);
  const input = element(options ? 'select' : type === 'textarea' ? 'textarea' : 'input');
  if (input.tagName === 'INPUT') input.type = type;
  if (options) for (const [key,name] of options) input.add(new Option(name,key));
  if (type !== 'file') input.value = value;
  if (limit) input.maxLength = limit;
  input.required = required;
  wrapper.append(input);
  parent.append(wrapper);
  return input;
}
function section(parent,title) {
  const node = element('section','','cw-section');
  node.append(element('h2',title));
  parent.append(node);
  return node;
}
function formIn(parent) {
  const form = element('form','','cw-form');
  parent.append(form);
  return form;
}
async function request(input,id) {
  const query=new URLSearchParams();
  if (id) query.set('id',id);
  if (aarPage) {
    query.set('drafts','1');
    if (params.get('draft')) query.set('draft',params.get('draft'));
  }
  const response = await fetch('/api/campaign-workspace?'+query, input ? {
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),
  } : {cache:'no-store'});
  if (!response.ok) {
    const message = response.headers.get('Content-Type')?.includes('application/json')
      ? (await response.json()).error : (await response.text()).trim();
    throw new Error(message || 'The campaign workspace is temporarily unavailable.');
  }
  return response.json();
}
function submit(form,label,values,after,skipReload=false) {
  const control = button(label);
  control.type = 'submit';
  control.classList.remove('outline');
  const feedback = element('p');
  feedback.setAttribute('role','status');
  form.append(control,feedback);
  form.onsubmit = async event => {
    event.preventDefault();
    if (control.disabled) return;
    control.disabled = true;
    feedback.textContent = 'Saving…';
    try {
      const payload = await values();
      if (!payload) { feedback.textContent = ''; return; }
      const result = await request(payload);
      if (!skipReload) await load();
      after?.(result);
    } catch (error) {
      feedback.textContent = error.message;
    } finally {
      control.disabled = false;
    }
  };
}
async function load(archiveId=params.get('campaign')) {
  try {
    workspace = await request(null,archiveId);
    for (const url of urls) URL.revokeObjectURL(url);
    urls = [];
    render();
    status.textContent = '';
    if (!aarPage && location.hash.startsWith('#report-')) {
      const report=document.getElementById(location.hash.slice(1));
      if (report) { report.open=true; report.scrollIntoView(); }
    }
  } catch (error) {
    status.replaceChildren(document.createTextNode(error.message+' '),button('Try again',()=>load(archiveId)));
  }
}
async function jpeg(file,maxSide) {
  if (!file || !['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 12_000_000) {
    throw new Error('Choose a JPEG, PNG or WebP image under 12 MB.');
  }
  const bitmap = await createImageBitmap(file).catch(()=>{ throw new Error('The selected image could not be opened.'); });
  const scale = Math.min(1,maxSide/Math.max(bitmap.width,bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1,Math.round(bitmap.width*scale));
  canvas.height = Math.max(1,Math.round(bitmap.height*scale));
  const paint = canvas.getContext('2d',{alpha:false});
  paint.drawImage(bitmap,0,0,canvas.width,canvas.height);
  bitmap.close();
  const data = canvas.toDataURL('image/jpeg',.84).split(',')[1];
  if (!data || data.length > 2_666_668) throw new Error('This image is too large after resizing. Choose a smaller image.');
  return data;
}
function photo(src,alt) {
  const img = element('img');
  img.src = src;
  img.alt = alt;
  img.loading = 'lazy';
  return img;
}
function gallery(parent,ids) {
  if (!ids.length) return;
  const group = element('div','','cw-photos');
  ids.forEach((id,index)=>{
    const image = photo(imagePath(id),'AAR screenshot '+(index+1));
    const anchor = link('',imagePath(id));
    anchor.append(image);
    group.append(anchor);
  });
  parent.append(group);
}
function map(parent,campaign,pins=[],pickable=false) {
  const controls = element('div','','cw-actions');
  const frame = element('div','','cw-map-frame');
  const surface = element('div','','cw-map');
  const image = photo(imagePath(campaign.map),'Arma Reforger campaign map of '+campaign.mapName);
  if (pickable) image.className = 'cw-map-pick';
  let width = 100;
  const zoom = step => {
    width = Math.min(400,Math.max(100,width+step));
    surface.style.width = width+'%';
  };
  function marker(point,label,kind,click) {
    const mark = button(label,click);
    mark.className = 'cw-marker';
    mark.dataset.kind = kind;
    mark.style.left = (point.x*100)+'%';
    mark.style.top = (point.y*100)+'%';
    surface.append(mark);
    return mark;
  }
  controls.append(button('Zoom in',()=>zoom(50)),button('Zoom out',()=>zoom(-50)),button('Reset zoom',()=>zoom(100-width)));
  parent.append(controls,frame);
  frame.append(surface);
  surface.append(image);
  const details = element('p','','cw-text');
  if (!pickable) {
    details.setAttribute('role','status');
    parent.append(details);
  }
  pins.forEach((entry,index)=>{
    const mark = marker(entry.pin,String(index+1),entry.kind,()=>{
      details.replaceChildren(element('strong',entry.title+' '),document.createTextNode(entry.description+' '));
      if (entry.report) {
        const anchor = link('Open linked report','#report-'+entry.report);
        anchor.onclick = () => { document.getElementById('report-'+entry.report).open = true; };
        details.append(anchor);
      }
    });
    mark.setAttribute('aria-label',entry.title);
  });
  return {image,marker};
}
function picker(parent,campaign,initial=null) {
  const details = element('details','','cw-card');
  details.append(element('summary','Map pin'));
  parent.append(details);
  let value = initial;
  const coords = element('div','','cw-coordinates');
  const x = field(coords,'Across map (%)',{type:'number'});
  const y = field(coords,'Down map (%)',{type:'number'});
  for (const input of [x,y]) { input.min = 0; input.max = 100; input.step = .01; }
  function update(point) {
    value = point;
    if (!mapView) return;
    mark?.remove();
    mark = point ? mapView.marker(point,'×','location') : null;
    if (mark) { mark.disabled = true; mark.setAttribute('aria-label','Selected point'); }
  }
  const mapView = map(details,campaign,[],true);
  let mark;
  details.append(coords,button('Clear pin',()=>set(null)));
  function set(point) {
    x.value = point ? (point.x*100).toFixed(2) : '';
    y.value = point ? (point.y*100).toFixed(2) : '';
    update(point);
  }
  mapView.image.onclick = event => {
    const box = mapView.image.getBoundingClientRect();
    set({x:(event.clientX-box.left)/box.width,y:(event.clientY-box.top)/box.height});
  };
  x.oninput = y.oninput = () => {
    if (x.value && y.value && x.validity.valid && y.validity.valid) update({x:x.valueAsNumber/100,y:y.valueAsNumber/100});
    else update(null);
  };
  set(initial);
  return () => {
    if (!!x.value !== !!y.value) throw new Error('Enter both map coordinates or clear the pin.');
    return value;
  };
}
const locationOptions = campaign => [['','No linked location'],...campaign.entities.filter(item=>item.type==='location').map(item=>[item.id,item.title])];
const reportOptions = campaign => [['','No linked report'],...campaign.reports.toReversed().map(item=>[item.id,item.date+' · '+types[item.type]+' · '+item.team])];
function addObservation(parent,campaign,incident,initial={}) {
  const card = element('fieldset','','cw-card');
  card.append(element('legend',incident ? 'Incident' : 'Finding'));
  parent.append(card);
  const title = field(card,incident ? 'What happened?' : 'Finding title',{limit:100,required:true,value:initial.title});
  const description = field(card,incident ? 'Incident details' : 'What did you observe in-game?',{type:'textarea',required:true,limit:2000,value:initial.description});
  const result = incident && field(card,'Team response, outcome and impact on the task',{type:'textarea',required:true,limit:1200,value:initial.result});
  const time = incident && field(card,'Approximate in-game time',{limit:30,value:initial.time});
  const assessment = field(card,'Unconfirmed assessment',{type:'textarea',limit:1000,value:initial.assessment});
  const grid = field(card,'In-game grid reference',{limit:40,value:initial.grid});
  const location = field(card,'Link to existing location',{options:locationOptions(campaign),value:initial.location});
  const subject = field(card,'Link to an existing person or faction',{value:initial.subject,options:[['','No linked person or faction'],
    ...campaign.entities.filter(entry=>entry.type!=='location').map(entry=>[entry.id,entry.title])]});
  const pin = picker(card,campaign,initial.pin);
  card.append(button('Remove '+(incident?'incident':'finding'),()=>card.remove()));
  return {card,values:()=>({title:title.value,description:description.value,result:result?.value,time:time?.value,
    assessment:assessment.value,grid:grid.value,location:location.value,subject:subject.value,pin:pin()})};
}

function aar(parent,campaign) {
  const draft=workspace.draft ?? {};
  const requestedEvent=workspace.events.find(item=>item.key===params.get('event'));
  const requestedType=params.get('type');
  const sectionNode = section(parent,'Submit an AAR');
  const form = formIn(sectionNode);
  const type = field(form,'Report type',{options:workspace.types.map(key=>[key,types[key]]),value:draft.type ?? (workspace.types.includes(requestedType)?requestedType:workspace.types[0])});
  const date = field(form,'Session date (UK)',{type:'date',value:draft.date ?? day.format(requestedEvent?.start??new Date()),required:true});
  const team = field(form,'Team',{required:true,limit:100,value:draft.team??params.get('team')??''});
  const event = field(form,'TAG event (optional)',{value:draft.event??requestedEvent?.key??'',options:[['','No linked event'],...workspace.events.map(item=>[item.key,item.title+' · '+eventDate.format(item.start)])]});
  event.onchange = () => {
    const match = workspace.events.find(item=>item.key===event.value);
    if (match) date.value = day.format(match.start);
  };
  const summary = field(form,'Internal summary',{type:'textarea',required:true,limit:3000,value:draft.summary});
  const outcome = field(form,'Objectives and outcome',{type:'textarea',limit:2400,value:draft.outcome});
  function syncType() {
    outcome.required = type.value !== 'recon';
    outcome.placeholder = type.value === 'shaping' ? 'What changed in the scenario and what was the effect?'
      : type.value === 'main' ? 'Which objectives were achieved, partially achieved or missed?' : 'What was completed or left open?';
  }
  type.onchange = syncType;
  syncType();
  const rows = [false,true].map(incident=>{
    const list = element('div');
    const records = (incident?draft.incidents:draft.findings)?.map(item=>addObservation(list,campaign,incident,item))??[];
    form.append(element('h3',incident ? 'Incidents' : 'Findings'),list,button(incident?'Add incident':'Add finding',()=>{
      if (records.filter(entry=>entry.card.isConnected).length < 16) records.push(addObservation(list,campaign,incident));
    }));
    return () => records.filter(entry=>entry.card.isConnected).map(entry=>entry.values());
  });

  form.append(element('h3','Campaign update'));
  const publicSummary = field(form,'Public recap (required)',{type:'textarea',required:true,limit:1200,value:draft.publicSummary});
  form.append(element('p','This recap publishes to the public Campaign page and #campaign_update. Select up to two screenshots if you want to include them.'));
  const upload = field(form,'AAR screenshots (up to six)',{type:'file'});
  upload.accept = 'image/jpeg,image/png,image/webp';
  upload.multiple = true;
  const photos = element('div','','cw-photos');
  const preview = element('article','','cw-card');
  form.append(photos,preview);
  let uploads = [];
  function renderPreview() {
    preview.replaceChildren(element('h4','Public update preview'),
      element('p',types[type.value]+' · '+date.value),element('p',publicSummary.value || 'Your recap will appear here.','cw-text'));
    const selected = element('div','','cw-photos');
    for (const item of uploads.filter(item=>item.share.checked)) selected.append(photo(item.url,'Selected public screenshot'));
    preview.append(selected);
  }
  function addPhoto(file,encoded,checked=false) {
    const blob=file ?? new Blob([Uint8Array.from(atob(encoded),char=>char.charCodeAt(0))],{type:'image/jpeg'});
    const url=URL.createObjectURL(blob);
    urls.push(url);
    const share=element('input');
    share.type='checkbox';
    share.checked=checked;
    return {file,encoded,url,share};
  }
  function showPhotos() {
    photos.replaceChildren(...uploads.map(item=>{
      const {file,url,share}=item;
      const box=element('div');
      const label=element('label','Include publicly','cw-checkbox');
      label.prepend(share);
      share.onchange=()=>{
        if (uploads.filter(entry=>entry.share.checked).length>2) share.checked=false;
        renderPreview();
      };
      box.append(photo(url,file?.name??'Saved screenshot'),label,button('Remove screenshot',()=>{
        uploads=uploads.filter(entry=>entry!==item);
        URL.revokeObjectURL(url);
        showPhotos();
      }));
      return box;
    }));
    renderPreview();
  }
  uploads=(draft.images??[]).map((encoded,index)=>addPhoto(null,encoded,draft.selected?.includes(index)));
  upload.onchange=()=>{
    const files=[...upload.files];
    if (files.length+uploads.length>6) {
      status.textContent='Choose no more than six screenshots in total.';
      upload.value='';
      return;
    }
    uploads.push(...files.map(file=>addPhoto(file,null)));
    upload.value='';
    showPhotos();
  };
  showPhotos();
  form.addEventListener('input',renderPreview);
  form.addEventListener('change',renderPreview);
  renderPreview();
  const id=draft.id??crypto.randomUUID();
  let updated=draft.updated;
  async function values(action) {
    return {action,campaign:campaign.id,id,updated,type:type.value,date:date.value,team:team.value,event:event.value,
      summary:summary.value,outcome:outcome.value,publicSummary:publicSummary.value,
      findings:rows[0](),incidents:rows[1](),selected:uploads.flatMap((item,index)=>item.share.checked?[index]:[]),
      images:await Promise.all(uploads.map(item=>item.encoded??jpeg(item.file,1400)))};
  }
  const saveDraft=button('Save draft',async()=>{
    saveDraft.disabled=true;
    try {
      const result=await request(await values('draft'));
      updated=result.updated;
      params.set('draft',id);
      history.replaceState(null,'','/members/aar/?'+params);
      status.textContent='Private draft saved.';
    } catch (error) { status.textContent=error.message; }
    finally { saveDraft.disabled=false; }
  });
  form.append(saveDraft);
  submit(form,'Submit AAR & publish campaign update',async()=>{
    if (!publicSummary.value.trim()) throw new Error('Write the public recap before submitting.');
    return values('submit');
  }, result=>{
    location.assign('/members/campaign/#report-'+result.id);
  },true);

}

function createCampaign(parent) {
  const details = element('details','','cw-card');
  details.append(element('summary','New campaign'));
  parent.append(details);
  const form = formIn(details);
  const title = field(form,'Campaign name',{required:true,limit:100});
  const mapName = field(form,'Arma map name',{required:true,limit:100});
  const image = field(form,'Map image',{type:'file',required:true});
  image.accept = 'image/jpeg,image/png,image/webp';
  const backstory = field(form,'Backstory',{type:'textarea',required:true,limit:5000});
  const goal = field(form,'End goal',{type:'textarea',required:true,limit:2000});
  submit(form,'Start campaign',async()=>{
    if (workspace.active && !confirm('Archive the active campaign and start a new one?')) return;
    return {action:'create',previous:workspace.active,title:title.value,mapName:mapName.value,
      map:await jpeg(image.files[0],2400),backstory:backstory.value,goal:goal.value};
  });
}
function configureRoles(parent) {
  const details = element('details','','cw-card');
  details.append(element('summary','AAR permissions'));
  parent.append(details);
  const form = formIn(details);
  form.append(element('p','Paste the Discord role IDs used for Team Leaders and Squad Leaders. Command already has access to all report types.'));
  const team = field(form,'Team Leader role ID',{value:workspace.roles.team || '',limit:20});
  const squad = field(form,'Squad Leader role ID',{value:workspace.roles.squad || '',limit:20});
  submit(form,'Save AAR permissions',()=>({action:'roles',team:team.value.trim(),squad:squad.value.trim()}));
}
function entityForm(parent,campaign,existing) {
  const details = element('details','','cw-card');
  details.append(element('summary',existing ? 'Edit '+existing.title : 'Add a person, faction or location'));
  parent.append(details);
  const form = formIn(details);
  const type = field(form,'Record type',{options:[['person','Person'],['faction','Faction'],['location','Location']],value:existing?.type ?? 'location'});
  type.disabled = !!existing;
  const title = field(form,'Name',{required:true,limit:120,value:existing?.title});
  const description = field(form,'Description',{type:'textarea',limit:2500,value:existing?.description});
  const grid = field(form,'In-game grid reference',{limit:40,value:existing?.grid});
  const point = picker(form,campaign,existing?.pin);
  submit(form,'Save campaign record',()=>({action:'entity',campaign:campaign.id,id:existing?.id,
    type:type.value,title:title.value,description:description.value,grid:grid.value,pin:point()}));
}
function review(parent,campaign,report,entry) {
  const details = element('details');
  details.append(element('summary','Review this entry'));
  parent.append(details);
  const form = formIn(details);
  const status = field(form,'Finding status',{options:[['reported','Reported'],['confirmed','Confirmed'],['unconfirmed','Unconfirmed']],value:entry.status});
  const location = field(form,'Campaign location',{options:locationOptions(campaign),value:entry.reviewLocation || entry.location || ''});
  const note = field(form,'Command review note',{type:'textarea',limit:1200,value:entry.reviewNote});
  submit(form,'Save review',()=>({action:'review',campaign:campaign.id,report:report.id,entry:entry.id,status:status.value,location:location.value,note:note.value}));
}
function followups(parent,campaign,canEdit) {
  const events = [['','No linked event'],...workspace.events.map(item=>[item.key,item.title+' · '+eventDate.format(item.start)])];
  const wrapper = section(parent,'Planning follow-ups');
  if (!campaign.followups.length) wrapper.append(element('p','No follow-ups recorded.'));
  for (const item of campaign.followups.toSorted((a,b)=>Number(!!a.closedAt)-Number(!!b.closedAt))) {
    const card = element('article','','cw-card');
    card.append(element('strong',item.closedAt?'Closed':'Open'),element('p',item.text,'cw-text'));
    for (const [id,label] of [[item.source,'Source report'],[item.resolution,'Resolving report']]) {
      if (!id) continue;
      const anchor = link(label,'#report-'+id);
      anchor.onclick = () => { document.getElementById('report-'+id).open = true; };
      card.append(anchor,document.createTextNode(' '));
    }
    line(card,'Scheduled event',item.event?.title);
    if (canEdit) {
      if (!item.closedAt) {
        const eventForm = formIn(card);
        const knownEvents = item.event && !events.some(([key])=>key===item.event.key)
          ? [...events,[item.event.key,item.event.title+' · Previously linked']] : events;
        const event = field(eventForm,'Scheduled TAG event',{options:knownEvents,value:item.event?.key});
        submit(eventForm,'Update event link',()=>({action:'followup',campaign:campaign.id,id:item.id,linkEvent:true,event:event.value}));
      }
      const form = formIn(card);
      const report = !item.closedAt && field(form,'Resolving report (optional)',{options:reportOptions(campaign)});
      submit(form,item.closedAt?'Reopen':'Close follow-up',()=>({action:'followup',campaign:campaign.id,id:item.id,close:!item.closedAt,report:report?.value}));
    }
    wrapper.append(card);
  }
  if (canEdit) {
    const form = formIn(wrapper);
    const text = field(form,'New follow-up',{type:'textarea',limit:600,required:true});
    const report = field(form,'Source report (optional)',{options:reportOptions(campaign)});
    const event = field(form,'Scheduled event (optional)',{options:events});
    submit(form,'Add follow-up',()=>({action:'followup',campaign:campaign.id,text:text.value,report:report.value,event:event.value}));
  }
}
function decisions(parent,campaign,canEdit) {
  const wrapper = section(parent,'Planning decisions');
  for (const item of campaign.assessments.toReversed()) {
    const card = element('article','','cw-card');
    card.append(element('h3',item.title),element('p',item.note,'cw-text'));
    const delivery = workspace.outbox.find(row=>row.id===item.id);
    if (delivery) {
      card.append(link('Public campaign update','/campaign/#update-'+item.id));
      line(card,'Discord',delivery.message?'Posted':delivery.attempts?'Queued for retry':'Queued');
    }
    if (item.report) {
      const anchor = link('Source report','#report-'+item.report);
      anchor.onclick = () => { document.getElementById('report-'+item.report).open = true; };
      card.append(anchor);
    }
    wrapper.append(card);
  }
  if (!canEdit) return;
  const details = element('details','','cw-card');
  details.append(element('summary','Record a planning decision'));
  wrapper.append(details);
  const form = formIn(details);
  const title = field(form,'Decision title',{required:true,limit:100});
  const note = field(form,'Internal planning decision',{type:'textarea',required:true,limit:2400});
  const report = field(form,'Source report (optional)',{options:reportOptions(campaign)});
  const summary = field(form,'Public recap (optional for planning decisions)',{type:'textarea',limit:1200});
  const id = crypto.randomUUID();
  submit(form,'Save decision',()=>({action:'decision',id,campaign:campaign.id,title:title.value,note:note.value,report:report.value,
    publicSummary:summary.value,date:day.format(new Date())}));
}
function reports(parent,campaign,canEdit) {
  const wrapper = section(parent,'Campaign timeline');
  if (!campaign.reports.length) wrapper.append(element('p','No AARs have been submitted.'));
  for (const report of campaign.reports.toSorted((a,b)=>b.date.localeCompare(a.date) || b.submittedAt-a.submittedAt)) {
    const details = element('details','','cw-card cw-report');
    details.id = 'report-'+report.id;
    details.append(element('summary',report.date+' · '+types[report.type]+' · '+report.team));
    line(details,'Submitted by',report.author);
    line(details,'TAG event',report.event?.title);
    line(details,'Summary',report.summary);
    line(details,'Objectives and outcome',report.outcome);
    for (const [heading,items] of [['Findings',report.findings],['Incidents',report.incidents]]) {
      if (!items.length) continue;
      details.append(element('h3',heading));
      for (const item of items) {
        const card = element('article','','cw-card');
        card.append(element('h4',item.title),element('p',item.description,'cw-text'));
        line(card,'Status',item.status);
        line(card,'Approximate time',item.time);
        line(card,'Response and impact',item.result);
        line(card,'In-game grid',item.grid);
        line(card,'Location',campaign.entities.find(entry=>entry.id===(item.reviewLocation || item.location))?.title);
        line(card,'Person or faction',campaign.entities.find(entry=>entry.id===item.subject)?.title);
        line(card,'Unconfirmed assessment',item.assessment);
        line(card,'Command review',item.reviewNote);
        if (canEdit) review(card,campaign,report,item);
        details.append(card);
      }
    }
    gallery(details,report.images);
    details.append(link('Public campaign update','/campaign/#update-'+report.id));
    const delivery = workspace.outbox.find(item=>item.id===report.id);
    if (delivery) line(details,'Discord',delivery.message?'Posted':delivery.attempts?'Queued for retry':'Queued');
    wrapper.append(details);
  }
}
function render() {
  const {campaign,active,archive} = workspace;
  const operational=aarPage || params.get('manage')==='1';
  const command=workspace.command && operational;
  const back=document.querySelector('#campaign-operations-back');
  if (back) back.hidden=!(operational && (workspace.command || workspace.types.length));
  const current = campaign && active === campaign.id;
  root.replaceChildren();
  if (aarPage) {
    const myDrafts=section(root,'My drafts');
    if (!workspace.drafts?.length) myDrafts.append(element('p','You have no saved AAR drafts.'));
    for (const item of workspace.drafts??[]) {
      const card=element('div','','cw-actions');
      const archived=item.campaign!==active;
      const label=(types[item.type]??'AAR')+(item.team?' · '+item.team:'')+' · '+eventDate.format(item.updated);
      card.append(archived ? element('span',label+' · Archived campaign') : link(label,'/members/aar/?draft='+item.id));
      card.append(button('Delete draft',async()=>{
        if (!confirm('Delete this private draft?')) return;
        try {
          await request({action:'delete-draft',id:item.id});
          if (params.get('draft')===item.id) location.assign('/members/aar/');
          else await load();
        } catch (error) { status.textContent=error.message; }
      }));
      myDrafts.append(card);
    }
    if (!current || !workspace.types.length) {
      root.append(element('p',!current?'The unit needs an active campaign before you can write an AAR.':'An authorised leader or Command role is required to write an AAR.'));
    } else {
      root.append(link('New AAR','/members/aar/'));
      aar(root,campaign);
    }
    return;
  }
  if (archive.length) {
    const nav = element('div','','cw-actions');
    const options = [['','Active campaign'],...archive.map(item=>[item.id,item.title+' · Archived'])];
    const select = field(nav,'Campaign to view',{options,value:current?'':campaign?.id ?? ''});
    nav.append(button('Open campaign',()=>load(select.value)));
    root.append(nav);
  }
  if (command && (current || !campaign)) {
    createCampaign(root);
    configureRoles(root);
  }
  if (!campaign) {
    root.append(element('p','There is no active campaign.'));
    return;
  }
  const overview = section(root,campaign.title+(current?'':' · Archived'));
  line(overview,'Map',campaign.mapName);
  line(overview,'Backstory',campaign.backstory);
  line(overview,'End goal',campaign.goal);
  line(overview,'Progress',campaign.progress);
  if (command && current) {
    const details = element('details','','cw-card');
    details.append(element('summary','Edit campaign brief'));
    overview.append(details);
    const edit = formIn(details);
    const title = field(edit,'Campaign name',{required:true,limit:100,value:campaign.title});
    const backstory = field(edit,'Backstory',{type:'textarea',required:true,limit:5000,value:campaign.backstory});
    const goal = field(edit,'End goal',{type:'textarea',required:true,limit:2000,value:campaign.goal});
    const progress = field(edit,'Campaign progress',{type:'textarea',limit:2400,value:campaign.progress});
    submit(edit,'Save campaign brief',()=>({action:'brief',campaign:campaign.id,title:title.value,backstory:backstory.value,goal:goal.value,progress:progress.value}));
    const form = formIn(overview);
    submit(form,'Archive campaign',()=>confirm('Archive this campaign and keep its reports in the archive?')
      ? {action:'archive',campaign:campaign.id} : null);
  }
  const mapSection = section(root,'Campaign map');
  mapSection.id='campaign-map';
  const observations = campaign.reports.flatMap(report=>[
    ...report.findings.map(item=>({...item,kind:'finding',report:report.id})),
    ...report.incidents.map(item=>({...item,kind:'incident',report:report.id})),
  ]);
  map(mapSection,campaign,[...campaign.entities,...observations].filter(item=>item.pin));
  const known = section(root,'People, factions and locations');
  const cards = element('div','','cw-grid');
  for (const item of campaign.entities) {
    const card = element('article','','cw-card');
    card.append(element('h3',item.title),element('p',item.type));
    line(card,'In-game grid',item.grid);
    line(card,'Record',item.description);
    for (const report of campaign.reports.filter(report=>[...report.findings,...report.incidents]
      .some(entry=>(entry.reviewLocation || entry.location)===item.id || entry.subject===item.id))) {
      const anchor = link(report.date+' · '+types[report.type]+' · '+report.team,'#report-'+report.id);
      anchor.onclick = () => { document.getElementById('report-'+report.id).open = true; };
      const row = element('p');
      row.append(anchor);
      card.append(row);
    }
    if (command && current) entityForm(card,campaign,item);
    cards.append(card);
  }
  known.append(cards);
  if (command && current) entityForm(known,campaign);
  if (current && workspace.types.length) root.append(link('Open the AAR workspace','/members/aar/'));
  followups(root,campaign,command && current);
  decisions(root,campaign,command && current);
  reports(root,campaign,command && current);
}
void load();
