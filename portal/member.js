const view = document.body.dataset.view ?? 'member';
const status = document.querySelector('#member-status');
const shortDate = new Intl.DateTimeFormat('en-GB', {timeZone: 'Europe/London', dateStyle: 'medium'});
const format = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short' });
function node(tag, value) {
  const element = document.createElement(tag);
  element.textContent = value;
  return element;
}
function row(label, value) {
  const element = node('div', '');
  element.className = 'member-row';
  element.append(node('strong', label), node('span', value));
  return element;
}
function groupRows(groups) {
  return groups.map(group => {
    const details = node('details', '');
    details.append(node('summary', group.label), ...group.seats.map(seat => row(seat.code + ' · ' + seat.role, seat.member)));
    return details;
  });
}
function list(id, rows, empty) {
  const container = document.getElementById(id);
  container.replaceChildren(...(rows.length ? rows : [node('p', empty)]));
}
async function loadDashboard(fresh = false) {
  const response = await fetch('/api/member?view='+view+(fresh?'&refresh=1':''), { credentials: 'same-origin', cache: 'no-store' });
  if (response.status === 401 || response.status === 403) {
    const nextAction = document.querySelector('#next-action');
    if (nextAction) nextAction.hidden = true;
    staffView({staff:null});
    if (view === 'staff') {
      document.querySelector('#roster-content').replaceChildren();
      refreshAccess.hidden = true;
    }
    const staffLink = document.querySelector('#staff-nav');
    if (staffLink) staffLink.hidden = true;
    if (response.status === 403 && view === 'staff') {
      status.textContent = 'Staff access is required to open this management tool.';
      return;
    }
    const link = node('a', 'Sign in with Discord');
    link.href = '/auth/discord';
    link.className = 'button outline small';
    status.replaceChildren(document.createTextNode('Your member session has expired. '), link);
    return;
  }
  if (!response.ok) {
    const error = new Error('Could not load TAG records (HTTP ' + response.status + ').');
    if (response.status === 503) error.retryAfter = Number(response.headers.get('Retry-After')) || 0;
    throw error;
  }
  const data = await response.json();
  status.textContent = 'Signed in as ' + data.displayName + ' · ' + data.access +
    (data.recordsDelayed ? ' · Some records are temporarily unavailable or delayed.' : '');
  const unitLink = document.querySelector('#staff-nav');
  if (unitLink) unitLink.hidden = !data.unitDashboard;
  if (view==='directory') {
    list('unit-directory',data.directory.map(member=>{
      const card=node('article','');
      card.className='directory-card';
      card.append(node('h2',member.name),node('p',[member.rank,member.status].filter(Boolean).join(' · ')));
      if (member.billet) card.append(node('p',member.billet));
      if (member.qualifications.length) card.append(node('p',member.qualifications.join(' · ')));
      card.append(medalDisplay(member.medals,member.streak));
      if (member.decorations?.length) card.append(decorationRack(member.decorations));
      return card;
    }),'The directory will populate after the bot’s first member sync.');
    list('roster-content',rosterCards(data),'No roster positions have been configured.');
    return;
  }
  if (view==='staff') {
    if (staffTool==='assignments' && data.access==='Command') {
      document.querySelector('#assignments').hidden=false;
      list('roster-content',rosterCards(data),'No roster positions have been configured.');
    }
    staffView(data);
    return;
  }
  renderNextAction(data.nextAction);
  list('record-content', [
    node('h3',data.myCard.name),
    ...(data.myCard.billet?[row('Standing assignment',data.myCard.billet)]:[]),
    row('Progression', data.progression),
    row('Attended main ops', String(data.mainOps)),
    row('Qualifications', data.qualifications.join(', ') || 'None recorded'),
    ...data.training.map(entry => row(entry.title, entry.result)),
    ...data.attendance.map(entry => row(entry.title, entry.status)),
  ]);
  const rewards = document.querySelector('#rewards-content');
  rewards.replaceChildren(medalDisplay(data.medals,data.streak));
  if (data.decorations) {
    const {items,service} = data.decorations;
    if (items.length) rewards.append(decorationRack(items));
    if (service.tracking) rewards.append(node('p','Next deployment ribbon · '+
      service.operations+'/'+service.next+' main operations · '+service.training+'/'+service.next+' Sunday platoon training sessions'));
    else rewards.append(node('p','Deployment ribbon progress begins after probation is recorded.'));
  }
  const rewardLink=node('a','View my attendance and redeem rewards');
  rewardLink.href='/members/unit/?view=progress';
  rewards.append(rewardLink);
  renderOwnName(data.editName);
  const eventCard = event => {
    const item = node('div', '');
    item.append(row(event.title, format.format(event.start) + ' UK · ' + event.status));
    if (event.url) {
      const link = node('a', 'Open in Discord ↗');
      link.className = 'button outline small';
      link.href = event.url;
      item.append(link);
    }
    if (event.orders) {
      const link = node('a', 'Read orders');
      link.className = 'button outline small';
      link.href = event.orders;
      item.append(link);
    }
    if (event.lineup?.length) {
      const expanded = node('details', '');
      expanded.append(node('summary', 'Event lineup'), ...groupRows(event.lineup));
      item.append(expanded);
    }
    return item;
  };
  list('events-content', data.events.map(eventCard), 'No upcoming events have been posted.');
  list('my-schedule-content', data.mySchedule.map(eventCard), 'You have no upcoming bookings or assigned slots.');
  renderLeave(data.leave);
}

function renderNextAction(action) {
  const section = document.querySelector('#next-action');
  if (!section) return;
  section.hidden = !action;
  if (!action) return;
  const content = section.querySelector('#next-action-content');
  const body = node('div','');
  body.append(node('h3',action.heading));
  if (action.event) {
    body.append(node('p',action.event.title + ' · ' + format.format(action.event.start) + ' UK'));
  }
  if (Number.isFinite(action.deadline)) body.append(node('p','Confirm by ' + format.format(action.deadline) + ' UK'));
  if (action.detail) body.append(node('p',action.detail));
  content.replaceChildren(body);
  if (action.confirmationEvent) {
    const controls = node('div','');
    controls.className = 'next-action-controls';
    const confirm = button('Confirm attendance');
    const feedback = node('p','');
    feedback.setAttribute('role','status');
    confirm.onclick = () => save('confirm-standing',{event:action.confirmationEvent},confirm,feedback);
    controls.append(confirm);
    if (action.link) {
      const leave = node('a',action.link.label);
      leave.href = action.link.href;
      leave.className = 'button outline small';
      controls.append(leave);
    }
    content.append(controls,feedback);
    return;
  }
  if (action.link) {
    const link = node('a',action.link.label);
    link.className = 'button small';
    link.href = action.link.href;
    content.append(link);
  }
}

function medalDisplay(count, streak) {
  const awards=node('div','');
  awards.className='member-awards';
  if (count>0) {
    const medal=node('span','★');
    medal.className='service-medal';
    medal.setAttribute('aria-hidden','true');
    awards.append(medal,node('strong','Sunday Service Medal'+(count>1?' × '+count:'')));
  }
  awards.append(node('span','Current streak: '+streak+' Sunday events'));
  return awards;
}

function decorationRack(items) {
  const rack=node('ul','');
  rack.className='decoration-rack';
  for (const item of items) {
    const cell=node('li','');
    const details=node('details','');
    const summary=node('summary','');
    const ribbon=item.image ? node('img','') : node('span',item.tier ? String(item.tier*10) : '');
    ribbon.className=item.image?'award-ribbon':'award-ribbon tag-ribbon '+item.kind;
    if (item.image) {
      ribbon.src=item.image;
      ribbon.alt='';
      ribbon.loading='lazy';
    } else {
      ribbon.setAttribute('aria-hidden','true');
      if (item.tier) ribbon.dataset.tone=String((item.tier-1)%4);
    }
    summary.append(ribbon,node('span',item.title));
    details.append(summary,node('p',item.citation));
    cell.append(details);
    rack.append(cell);
  }
  return rack;
}

const actionStatus = document.querySelector('#action-status');
const staffContent = document.querySelector('#staff-content');
const dialog = document.querySelector('#assignment');
const staffQuery = new URLSearchParams(location.search);
const staffTool = staffQuery.get('tool') || 'attendance';
let activeRegister = staffQuery.get('event') || undefined;
let selectedSlot;

function option(value, label) {
  const element = node('option', label);
  element.value = value;
  return element;
}
function field(form, label, element) {
  const wrapper = node('label', label);
  wrapper.append(element);
  form.append(wrapper);
  return element;
}
function input(type, value = '') {
  const element = node('input', '');
  element.type = type;
  element.value = value;
  return element;
}
function button(label, outline = false) {
  const element = node('button', label);
  element.type = 'button';
  element.className = 'button small' + (outline ? ' outline' : '');
  return element;
}
async function save(action, values, control, feedback = actionStatus) {
  control.disabled = true;
  feedback.textContent = 'Saving…';
  try {
    const response = await fetch('/api/member/action', {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({action,values}),
    });
    feedback.textContent = await response.text();
    if (!response.ok) return false;
    actionStatus.textContent = feedback.textContent;
    if (!await showDashboard()) actionStatus.textContent += ' The dashboard could not refresh after saving.';
    return true;
  } catch {
    feedback.textContent = 'Could not confirm the change. Refresh before retrying.';
    return false;
  } finally {
    control.disabled = false;
  }
}
function rosterCards(data) {
  const order = [...data.roster].sort((a,b) => Number(b.label === '16') - Number(a.label === '16'));
  const cards = new Map();
  for (const group of order) {
    const card = node('article', '');
    card.className = 'roster-card' + (group.label === '16' ? ' roster-hq' : '');
    const heading = node('header', '');
    const occupied = group.seats.filter(seat => seat.occupied).length;
    heading.append(node('h3', group.label === '16' ? 'HQ · 16' : group.label),
      node('span', occupied + ' filled · ' + (group.seats.length - occupied) + ' open'));
    const seats = node('div', '');
    seats.className = 'roster-seats';
    for (const slot of group.seats) {
      const line = node(slot.key ? 'button' : 'div', '');
      line.className = 'roster-seat' + (slot.occupied ? '' : ' is-open');
      const role = node('div', '');
      role.append(node('strong', slot.member), node('small', slot.role));
      line.append(node('code', slot.code), role);
      if (slot.key) {
        line.type = 'button';
        line.onclick = async () => {
          selectedSlot = slot;
          document.querySelector('#assignment-name').textContent = slot.code + ' · ' + slot.role;
          const members = document.querySelector('#assignment-member');
          const people = [...data.staff.people];
          if (slot.assigned && !people.some(person => person.key === slot.assigned)) people.unshift({key:slot.assigned,name:slot.member});
          members.replaceChildren(option('', 'Open slot'), ...people.map(person => option(person.key, person.name)));
          members.value = slot.assigned;
          document.querySelector('#assignment-status').textContent = '';
          dialog.showModal();
          const feedback = document.querySelector('#assignment-status');
          const submit = document.querySelector('#assignment-form button[type=submit]');
          submit.disabled = true;
          feedback.textContent = 'Loading Discord members…';
          try {
            const response = await fetch('/api/member/action', {
              method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action:'members',values:{}}),
            });
            if (selectedSlot !== slot || !dialog.open) return;
            if (!response.ok) {
              feedback.textContent = 'Discord member list is unavailable. Showing members with saved profiles.';
              return;
            }
            const names = await response.json();
            if (selectedSlot !== slot || !dialog.open) return;
            const chosen = members.value;
            if (slot.assigned && !names.some(person => person.key === slot.assigned)) names.unshift({key:slot.assigned,name:slot.member});
            members.replaceChildren(option('', 'Open slot'), ...names.map(person => option(person.key,person.name)));
            members.value = chosen;
            feedback.textContent = '';
          } catch {
            if (selectedSlot === slot) feedback.textContent = 'Discord member list is unavailable. Showing members with saved profiles.';
          } finally {
            if (selectedSlot === slot) submit.disabled = false;
          }
        };
      }
      seats.append(line);
    }
    card.append(heading,seats);
    cards.set(group.key,card);
  }
  const unitSections = new Map((data.rosterUnits ?? []).map(unit=>{
    const section=node('section','');
    section.className='roster-unit';
    const grid=node('div','');
    grid.className='roster-grid';
    section.append(node('h3',unit.label),grid);
    return [unit.key,{section,grid}];
  }));
  for (const group of order) {
    const card = cards.get(group.key);
    const parent = cards.get(group.parent);
    if (parent) {
      let children = parent.querySelector(':scope > .roster-children');
      if (!children) { children = node('div',''); children.className='roster-children'; parent.append(children); }
      children.append(card);
      continue;
    }
    if (!unitSections.has(group.unit)) {
      const section=node('section','');
      section.className='roster-unit';
      const grid=node('div','');
      grid.className='roster-grid';
      section.append(node('h3',group.unitLabel),grid);
      unitSections.set(group.unit,{section,grid});
    }
    unitSections.get(group.unit).grid.append(card);
  }
  return [...unitSections.values()].map(entry=>{
    if (!entry.grid.childElementCount) entry.grid.append(node('p','No elements yet.'));
    return entry.section;
  });
}

function withdrawLeaveButton(values) {
  const withdraw = button('Withdraw LOA', true);
  withdraw.onclick = () => {
    if (window.confirm('Withdraw this LOA for upcoming events? You can sign up again where a place is available.')) {
      void save('withdraw-leave', values, withdraw);
    }
  };
  return withdraw;
}

function editLeaveButton(values, entry) {
  const edit = button('Edit LOA',true);
  edit.onclick = () => {
    const form = node('form','');
    const from = entry.from && field(form,'First day',input('date',entry.from));
    const to = entry.to && field(form,'Last day',input('date',entry.to));
    if (from && to) from.required = to.required = true;
    const reason = field(form,'Reason',node('textarea',''));
    reason.value = entry.reason;
    reason.required = true;
    reason.maxLength = 400;
    const submit = button('Save LOA');
    submit.type = 'submit';
    const back = button('Cancel',true);
    back.onclick = () => {form.remove();edit.disabled=false;};
    form.append(submit,back);
    form.onsubmit = event=>{
      event.preventDefault();
      void save('edit-leave',{...values,from:from?.value,to:to?.value,reason:reason.value},submit);
    };
    edit.after(form);
    edit.disabled=true;
  };
  return edit;
}

function renderLeave(entries) {
  const content = document.querySelector('#leave-content');
  content.replaceChildren(...entries.map(entry => {
    const item = row(entry.event ? entry.title + ' · ' + shortDate.format(entry.start) : entry.from + ' to ' + entry.to, entry.status);
    if (entry.canWithdraw) {
      const values = {event:entry.event,kind:entry.kind,index:entry.index,submittedAt:entry.submittedAt};
      item.append(withdrawLeaveButton(values));
      if (entry.reason) item.append(editLeaveButton(values,entry));
    }
    return item;
  }));
  content.append(leaveCreationForm());
}
function leaveCreationForm(members) {
  const form = node('form', '');
  const member = members && field(form,'Member',node('select',''));
  if (member) {
    member.required = true;
    member.append(option('','Select a member'),...members.map(person=>option(person.key,person.name)));
  }
  const from = field(form, 'First day of leave', input('date'));
  const to = field(form, 'Last day of leave', input('date'));
  from.required = to.required = true;
  from.onchange = () => { to.min = from.value; if (!to.value || to.value < from.value) to.value = from.value; };
  const reason = field(form, 'Reason (visible to staff)', node('textarea', ''));
  reason.maxLength = 400;
  reason.required = true;
  const submit = button('Submit LOA');
  submit.type = 'submit';
  const feedback = node('p', '');
  feedback.setAttribute('role', 'status');
  form.append(node('p', 'Both dates are included. Upcoming assigned seats and training bookings within the range are released.'), submit, feedback);
  form.onsubmit = event => {
    event.preventDefault();
    void save('leave', {member:member?.value,from:from.value,to:to.value,reason:reason.value}, submit, feedback);
  };
  return form;
}
function attendanceRegister(registers) {
  if (!registers.length) return staffContent.append(node('p', 'No events available.'));
  const chooser = node('select', '');
  chooser.setAttribute('aria-label', 'Attendance event');
  chooser.append(...registers.map(item => option(item.key, item.title + ' · ' + format.format(item.start) + (item.started ? '' : ' · Upcoming'))));
  chooser.value = registers.some(item => item.key === activeRegister) ? activeRegister : registers[0].key;
  const list = node('div', '');
  const render = () => {
    activeRegister = chooser.value;
    const register = registers.find(item => item.key === activeRegister);
    const count = register.people.filter(person => person.status !== 'pending').length;
    list.replaceChildren(row(register.title, count + ' / ' + register.people.length + ' marked'));
    if (!register.started) list.append(node('p','LOA can be recorded now. Attendance opens at the event start time.'));
    if (register.standingOptions?.length) {
      const form = node('form', '');
      const person = field(form, 'Add from standing roster', node('select', ''));
      person.append(option('', 'Choose a member with an open seat'),
        ...register.standingOptions.map((entry,index) => option(String(index), entry.label)));
      person.required = true;
      const add = button('Add to this operation');
      add.type = 'submit';
      form.append(add);
      form.onsubmit = event => {
        event.preventDefault();
        const entry = register.standingOptions[person.value];
        if (entry) void save('event-standing', {event:register.key,slot:entry.slot,member:entry.id}, add);
      };
      list.append(form);
    }
    if (register.assignments?.length) {
      const form = node('form','');
      const select = field(form,'Remove an operation assignment',node('select',''));
      select.required = true;
      select.append(option('','Choose an assigned member'),...register.assignments.map((entry,index)=>option(String(index),entry.label)));
      const remove = button('Clear event slot',true);
      remove.type = 'submit';
      form.append(remove);
      form.onsubmit = event => {
        event.preventDefault();
        const entry = register.assignments[select.value];
        if (entry && window.confirm('Clear the operation slot for '+entry.label+'?')) {
          void save('event-unassign',{event:register.key,slot:entry.slot,member:entry.id},remove);
        }
      };
      list.append(form);
    }
    const groups = new Map();
    for (const person of register.people) {
      const name = person.group || 'Participants';
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(person);
    }
    for (const [group, people] of groups) {
      list.append(node('h3', group));
      for (const person of people) {
        const line = node('div', '');
        line.className = 'register-line';
        const name = node('strong', [person.code, person.name].filter(Boolean).join(' · '));
        const controls = node('div', '');
        controls.className = 'register-actions';
        for (const [value, label] of [['attended','Attended'], ['absent','Absent'], ['loa','LOA']]) {
          const mark = button(label, true);
          mark.setAttribute('aria-pressed', String(person.status === value));
          mark.dataset.mark = value;
          mark.disabled = person.status === value || (!register.started && value !== 'loa');
          mark.onclick = async () => {
            const siblings = [...controls.querySelectorAll('button')].filter(item => item !== mark);
            const prior = siblings.map(item => item.disabled);
            siblings.forEach(item => { item.disabled = true; });
            await save('attendance',{kind:register.kind,event:register.key,member:person.id,status:value},mark);
            siblings.forEach((item,index) => { item.disabled = prior[index]; });
          };
          controls.append(mark);
        }
        if (person.status === 'pending') controls.append(node('span', 'Pending'));
        line.append(name, controls);
        list.append(line);
      }
    }
    if (!register.people.length) list.append(node('p', 'No assigned or booked participants for this event.'));
  };
  chooser.onchange = render;
  render();
  staffContent.append(chooser, list);
}
function createEvent(data, type) {
  const form = node('form', '');
  const date = field(form, 'UK date', input('date'));
  date.required = true;
  const hour = field(form, 'UK hour', node('select', ''));
  const minute = field(form, 'Minute', node('select', ''));
  hour.append(...Array.from({length:24}, (_,i) => option(String(i).padStart(2,'0'), String(i).padStart(2,'0'))));
  minute.append(...Array.from({length:12}, (_,i) => option(String(i*5).padStart(2,'0'), String(i*5).padStart(2,'0'))));
  hour.value = '18';
  const title = field(form, 'Title (optional)', input('text'));
  title.maxLength = 80;
  const groups = node('fieldset', '');
  groups.append(node('legend', 'Participating groups'));
  for (const group of data.staff.groups.filter(group=>!group.archived)) {
    const check = field(groups, group.label, input('checkbox',group.key));
    check.checked = true;
  }
  const submit = button('Publish in Discord');
  submit.type = 'submit';
  const feedback = node('p', '');
  feedback.setAttribute('role','status');
  form.append(groups, submit, feedback);
  form.onsubmit = async event => {
    event.preventDefault();
    if (!window.confirm('Publish this event to TAG MILSIM Discord?')) return;
    const selected = [...groups.querySelectorAll(':checked')].map(el => el.value);
    await save('sunday', {type,date:date.value,hour:hour.value,minute:minute.value,title:title.value,groups:selected}, submit,feedback);
  };
  staffContent.append(form);
}

function renderOwnName(name) {
  const form = node('form', '');
  form.className = 'own-name';
  const display = field(form, 'Your TAG display name', input('text', name));
  display.maxLength = 80;
  display.required = true;
  const submit = button('Save my name', true);
  submit.type = 'submit';
  form.append(submit);
  form.onsubmit = event => {
    event.preventDefault();
    if (!display.value.trim()) {
      actionStatus.textContent = 'Enter a TAG display name.';
      return;
    }
    void save('member-details', {name:display.value}, submit);
  };
  document.querySelector('#record-content').append(form);
}

function eventEditor(event, groups, events) {
  const fields = new Intl.DateTimeFormat('sv-SE', {timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).formatToParts(event.start);
  const part = type => fields.find(item=>item.type===type)?.value;
  const form = node('form','');
  form.append(node('h3','Edit ' + event.title));
  const date = field(form,'UK date',input('date',part('year')+'-'+part('month')+'-'+part('day')));
  const time = field(form,'UK start time',input('time',part('hour')+':'+part('minute')));
  date.required = time.required = true;
  const operation = event.kind === 'sunday';
  let details;
  if (operation) {
    const title = field(form,'Title',input('text',event.title));
    title.required = true;
    title.maxLength = 80;
    const choices = node('fieldset','');
    choices.append(node('legend','Roster elements'));
    for (const group of groups.filter(g=>!g.archived || event.groups.includes(g.key))) {
      field(choices,group.label,input('checkbox',group.key)).checked = event.groups.includes(group.key);
    }
    form.append(choices);
    details = () => ({title:title.value,groups:[...choices.querySelectorAll('input:checked')].map(choice=>choice.value)});
  } else {
    const recruit = field(form,'Participant places',input('number',String(event.recruitSlots ?? 0)));
    const cadre = field(form,'Cadre places',input('number',String(event.cadreSlots ?? 0)));
    for (const control of [recruit,cadre]) { control.min='0'; control.max='99'; control.required=true; }
    details = () => ({recruitSlots:recruit.valueAsNumber,cadreSlots:cadre.valueAsNumber});
  }
  const submit = button('Save event');
  submit.type = 'submit';
  const back = button('Back to events',true);
  back.onclick = () => { staffContent.replaceChildren(); managedEvents(events,groups); };
  form.append(submit,back);
  staffContent.replaceChildren(form);
  form.onsubmit = action => {
    action.preventDefault();
    const [hour,minute] = time.value.split(':');
    void save('edit-event',{event:event.key,kind:event.kind,previousStart:event.start,date:date.value,hour,minute,...details()},submit);
  };
}

async function loadMemberManagement(chooser, details) {
  const member = chooser.value;
  details.replaceChildren();
  if (!member) return;
  const feedback = node('p','Loading rank, roles and qualifications…');
  feedback.setAttribute('role','status');
  details.append(feedback);
  try {
    const response = await fetch('/api/member/action',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'member-admin',values:{member}})});
    if (!response.ok) throw new Error(await response.text());
    const [data] = await response.json();
    if (chooser.value !== member || !feedback.isConnected) return;
    const rankForm = node('form','');
    const rank = field(rankForm,'Rank',node('select',''));
    rank.append(option('','No rank'),...data.ranks.map(([title,code])=>option(title,title+' · '+code)));
    rank.value = data.rank;
    const required = field(rankForm,'Include in weekly attendance',input('checkbox'));
    required.checked = data.attendanceRequired;
    const exempt = field(rankForm,'Exempt from the 75% requirement',input('checkbox'));
    exempt.checked = data.attendanceExempt;
    const reserveExempt = field(rankForm,'Exempt from Reserve inactivity removal',input('checkbox'));
    reserveExempt.checked = data.reserveExempt;
    const exemptionReason = field(rankForm,'Exemption reason (staff only)',input('text',data.reserveExemptionReason ?? ''));
    exemptionReason.maxLength = 160;
    const rankSave = button('Save member details');
    rankSave.type = 'submit';
    rankForm.append(rankSave);
    rankForm.onsubmit = event => {event.preventDefault(); void save('member-rank',{member,rank:rank.value,attendanceRequired:required.checked,attendanceExempt:exempt.checked,reserveExempt:reserveExempt.checked,reserveExemptionReason:exemptionReason.value},rankSave);};
    details.replaceChildren(rankForm);
    for (const qualification of [false,true]) {
      const list = node('div','');
      list.append(node('h3',qualification ? 'Qualifications' : 'Discord roles'));
      for (const role of data.roles.filter(role=>role.qualification===qualification)) {
        const item = row(role.name,role.held ? 'Assigned' : 'Available');
        const change = button(role.held ? 'Remove' : 'Add',true);
        change.disabled = !role.manageable;
        change.onclick = () => save('member-role',{member,role:role.id,add:!role.held},change);
        item.append(change);
        list.append(item);
      }
      details.append(list);
    }
  } catch (error) {
    feedback.textContent = error.message;
  }
}

let activeRosterElement = '';
function rosterElementEditor(elements, units) {
  const unitForm=node('form','');
  unitForm.append(node('h3','Units'));
  const unitSelect=field(unitForm,'Unit to manage',node('select',''));
  unitSelect.append(option('','New unit'),...units.map(unit=>option(unit.key,unit.label+(unit.archived?' · Archived':''))));
  const unitName=field(unitForm,'Unit name',input('text'));
  unitName.required=true;
  unitName.maxLength=60;
  const saveUnit=button('Save unit');
  saveUnit.type='submit';
  const archiveUnit=button('Archive unit',true);
  const unitFeedback=node('p','');
  unitFeedback.setAttribute('role','status');
  const deleteUnit=button('Delete unused unit',true);
  unitForm.append(saveUnit,archiveUnit,deleteUnit,unitFeedback);
  deleteUnit.onclick=()=>{
    if (window.confirm('Permanently delete this unused unit?')) void save('roster-unit',{key:unitSelect.value,mode:'delete'},deleteUnit,unitFeedback);
  };
  unitSelect.onchange=()=>{
    const unit=units.find(item=>item.key===unitSelect.value);
    unitName.value=unit?.label ?? '';
    deleteUnit.hidden=archiveUnit.hidden=!unit || unit.key==='tag';
    archiveUnit.textContent=unit?.archived?'Restore unit':'Archive unit';
  };
  unitSelect.onchange();
  archiveUnit.onclick=()=>{
    const unit=units.find(item=>item.key===unitSelect.value);
    if (unit && window.confirm(archiveUnit.textContent+' '+unit.label+'?')) {
      void save('roster-unit',{key:unit.key,mode:unit.archived?'restore':'archive'},archiveUnit,unitFeedback);
    }
  };
  unitForm.onsubmit=event=>{
    event.preventDefault();
    void save('roster-unit',{key:unitSelect.value,label:unitName.value},saveUnit,unitFeedback);
  };

  const form=node('form','');
  form.append(node('h3','Elements and positions'));
  const select=field(form,'Element to manage',node('select',''));
  select.append(option('','New element'),...elements.map(e=>option(e.key,(units.find(unit=>unit.key===e.unit)?.label ?? 'TAG')+' · '+e.label+(e.archived?' · Archived':''))));
  const label=field(form,'Element name',input('text'));
  label.required=true;
  label.maxLength=60;
  const unit=field(form,'Unit',node('select',''));
  const parent=field(form,'Parent element',node('select',''));
  const positions=node('div','');
  const add=button('Add position',true);
  const submit=button('Save element');
  submit.type='submit';
  const archive=button('Archive element',true);
  const feedback=node('p','');
  feedback.setAttribute('role','status');
  const deleteElement=button('Delete unused element',true);
  deleteElement.onclick=()=>{
    if (window.confirm('Permanently delete this unused element?')) void save('roster-element',{key:select.value,mode:'delete'},deleteElement,feedback);
  };
  form.append(positions,add,submit,archive,deleteElement,feedback);
  const chosen=()=>elements.find(e=>e.key===select.value);
  function parents(value) {
    parent.replaceChildren(option('','Top-level element'),...elements
      .filter(e=>e.key!==select.value && e.unit===unit.value && !e.archived)
      .map(e=>option(e.key,e.label)));
    if ([...parent.options].some(item=>item.value===value)) parent.value=value;
  }
  let fields=[];
  function position(code='',role='',removed=false,existing=false) {
    const line=node('div','');
    line.className='roster-position-editor';
    const zap=field(line,'ZAP code',input('text',code));
    const billet=field(line,'Position',input('text',role));
    zap.required=billet.required=true;
    zap.maxLength=12;
    billet.maxLength=60;
    const remove=button('Remove',true);
    const entry={zap,billet,removed,existing};
    const reflect=()=>{
      line.classList.toggle('is-removed',entry.removed);
      zap.readOnly=billet.readOnly=entry.removed;
      remove.textContent=entry.removed?'Restore position':'Remove position';
    };
    remove.onclick=()=>{
      if (!entry.existing) {
        fields=fields.filter(item=>item!==entry);
        line.remove();
      } else {
        entry.removed=!entry.removed;
        reflect();
      }
    };
    line.append(remove);
    fields.push(entry);
    positions.append(line);
    reflect();
  }
  select.onchange=()=>{
    activeRosterElement=select.value;
    const element=chosen();
    label.value=element?.label ?? '';
    unit.replaceChildren(...units.filter(item=>!item.archived || item.key===element?.unit).map(item=>option(item.key,item.label)));
    unit.value=element?.unit ?? 'tag';
    parents(element?.parent ?? '');
    fields=[];
    positions.replaceChildren();
    element?.slots.forEach((role,i)=>position(element.codes[i],role,element.removed?.includes(i+1),true));
    archive.hidden=!element;
    deleteElement.hidden=!element?.key.startsWith('element-');
    archive.textContent=element?.archived?'Restore element':'Archive element';
    feedback.textContent=element ? 'Configuration key: '+element.key : '';
  };
  select.value=elements.some(e=>e.key===activeRosterElement)?activeRosterElement:'';
  select.onchange();
  unit.onchange=()=>parents('');
  add.onclick=()=>position();
  archive.onclick=()=>{
    const element=chosen();
    if (element && window.confirm(archive.textContent+' '+element.label+'?')) {
      void save('roster-element',{key:element.key,mode:element.archived?'restore':'archive'},archive,feedback);
    }
  };
  form.onsubmit=event=>{
    event.preventDefault();
    const codes=fields.map(entry=>entry.zap.value.trim().toUpperCase());
    const duplicate=codes.find((code,index)=>codes.indexOf(code)!==index);
    if (duplicate) { feedback.textContent='ZAP code '+duplicate+' is repeated. Give each position its own code.'; return; }
    void save('roster-element',{key:select.value,label:label.value,unit:unit.value,parent:parent.value,codes,
      slots:fields.map(entry=>entry.billet.value.trim()),removed:fields.flatMap((entry,index)=>entry.removed?[index+1]:[])},submit,feedback);
  };
  staffContent.append(unitForm,form);
}

function managedEvents(events, groups) {
  if (!events.length) {
    staffContent.append(node('p', 'No upcoming, cancelled, or deletable events.'));
    return;
  }
  for (const event of events) {
    const line = node('div', '');
    line.className = 'register-line';
    const label = node('div', '');
    label.append(node('strong', event.title), node('p', format.format(event.start) + ' UK' + (event.cancelled ? ' · Cancelled' : '')));
    const controls = node('div', '');
    controls.className = 'register-actions';
    const values = { event:event.key, kind:event.kind };
    if (event.canEdit) {
      const edit = button('Edit event', true);
      edit.onclick = () => eventEditor(event,groups,events);
      controls.append(edit);
    }
    if (event.canCancel) {
      const cancel = button('Cancel event', true);
      cancel.onclick = () => {
        if (window.confirm(`Cancel ${event.title}? Signups will close and booked members will be notified where DMs are available.`)) {
          void save('cancel-event', values, cancel);
        }
      };
      controls.append(cancel);
    }
    if (event.canArchive) {
      const archive = button('Archive register', true);
      archive.onclick = () => {
        if (window.confirm(`Archive ${event.title}? Attendance and results will stay in history.`)) {
          void save('archive-event', values, archive);
        }
      };
      controls.append(archive);
    }
    if (event.canDelete) {
      const remove = button('Delete test event', true);
      remove.onclick = () => {
        if (window.prompt(`Permanently delete ${event.title}? Type DELETE to confirm.`) === 'DELETE') {
          void save('delete-event', values, remove);
        }
      };
      controls.append(remove);
    }
    line.append(label, controls);
    staffContent.append(line);
  }
}

let activeManagedMember;
async function memberEditor(savedPeople = []) {
  const form = node('form', '');
  const chooser = field(form, 'Discord member', node('select', ''));
  chooser.append(option('', 'Loading Discord members…'));
  const name = field(form, 'TAG display name', input('text'));
  name.maxLength = 80;
  const submit = button('Save display name');
  submit.type = 'submit';
  submit.disabled = true;
  const reset = button('Use Discord name', true);
  reset.disabled = true;
  const controls = node('div', '');
  controls.className = 'register-actions';
  controls.append(submit, reset);
  const feedback = node('p', '');
  feedback.setAttribute('role', 'status');
  form.append(controls, feedback);
  const details = node('div','');
  staffContent.append(form,details);
  let members = savedPeople;
  try {
    const response = await fetch('/api/member/action', {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action:'members',values:{}}),
    });
    if (!response.ok) throw new Error(await response.text());
    const responseMembers = await response.json();
    if (!Array.isArray(responseMembers)) throw new Error('The bot returned an invalid member list.');
    members = responseMembers;
    if (members.some(item=>item.partial)) {
      const combined = new Map(savedPeople.map(item=>[item.key,item]));
      for (const item of members) combined.set(item.key,item);
      members = [...combined.values()].sort((a,b)=>a.name.localeCompare(b.name));
      feedback.textContent='Showing known members while Discord refreshes the list.';
    }
  } catch (error) {
    feedback.textContent = members.length ? 'Discord is unavailable. Showing saved members.' : error.message;
  }
  if (!members.length || feedback.textContent) {
    const retry = button('Retry member list', true);
    retry.onclick = () => { form.remove(); details.remove(); void memberEditor(savedPeople); };
    form.append(retry);
  }
  if (members.length) {
    chooser.replaceChildren(option('', 'Select a member'), ...members.map(item => option(item.key,item.name)));
    chooser.onchange = () => {
      activeManagedMember = chooser.value;
      name.value = members.find(item => item.key === chooser.value)?.name ?? '';
      submit.disabled = reset.disabled = !chooser.value;
      void loadMemberManagement(chooser,details);
    };
    if (members.some(item=>item.key===activeManagedMember)) { chooser.value=activeManagedMember; chooser.onchange(); }
    form.onsubmit = event => {
      event.preventDefault();
      if (!name.value.trim()) { feedback.textContent = 'Enter a name or choose Use Discord name.'; return; }
      void save('member-details', {member:chooser.value,name:name.value},submit,feedback);
    };
    reset.onclick = () => {
      void save('member-details', {member:chooser.value,name:''},reset,feedback);
    };
  } else {
    chooser.replaceChildren(option('', 'No member records available'));
  }
}

function campaignEditor(entries) {
  const form=node('form','');
  form.append(node('p','Entries saved here are public. Publish only summaries and in-game intel cleared for visitors.'));
  const chooser=field(form,'Campaign entry',node('select',''));
  chooser.append(option('','New update'),...entries.map(entry=>option(entry.key,entry.title)));
  const title=field(form,'Title',input('text'));
  const date=field(form,'Campaign date',input('date'));
  const summary=field(form,'Public summary',node('textarea',''));
  const intel=field(form,'Released intel (one item per line)',node('textarea',''));
  title.maxLength=100;
  summary.maxLength=1800;
  title.required=summary.required=true;
  const publish=button('Publish campaign update');
  publish.type='submit';
  const unpublish=button('Remove from public page',true);
  const feedback=node('p','');
  feedback.setAttribute('role','status');
  form.append(publish,unpublish,feedback);
  chooser.onchange=()=>{
    const entry=entries.find(row=>row.key===chooser.value);
    title.value=entry?.title ?? '';
    date.value=entry?.date ?? '';
    summary.value=entry?.summary ?? '';
    intel.value=entry?.intel?.join('\n') ?? '';
    unpublish.hidden=!entry;
  };
  chooser.onchange();
  form.onsubmit=event=>{
    event.preventDefault();
    if (window.confirm('Publish this update on the public campaign page?')) {
      void save('campaign-release',{key:chooser.value,title:title.value,date:date.value,
        summary:summary.value,intel:intel.value.split('\n').map(item=>item.trim()).filter(Boolean)},publish,feedback);
    }
  };
  unpublish.onclick=()=>{
    if (chooser.value && window.confirm('Remove this update from the public campaign page?')) {
      void save('campaign-release',{key:chooser.value,remove:true},unpublish,feedback);
    }
  };
  staffContent.append(form);
}

function staffView(data) {
  if (!staffContent) return;
  if (!data.staff) {
    document.querySelector('#staff').hidden = true;
    staffContent.replaceChildren();
    return;
  }
  document.querySelector('#staff').hidden = false;
  const titles={attendance:'Attendance',create:'Create an operation',platoon:'Schedule Sunday platoon training',events:'Manage events',review:'Attendance review',
    history:'Event history',leave:'Leave requests',members:'Manage members',roster:'Roster structure',
    assignments:'Standing assignments',campaign:'Public campaign updates'};
  const label=Object.hasOwn(titles,staffTool)?titles[staffTool]:null;
  document.querySelector('#staff-title').textContent=label??'Management';
  const back=document.querySelector('#management-back');
  if (staffTool==='platoon') {
    back.href='/staff/training/';
    back.textContent='Training';
  } else if (['attendance','create','events','campaign'].includes(staffTool)) {
    back.href='/staff/operations/';
    back.textContent='Operations';
  }
  if (!label || ['members','roster','assignments','campaign'].includes(staffTool) && data.access!=='Command') {
    staffContent.replaceChildren(node('p','This area is unavailable for your roles.'));
    return;
  }
  if (staffTool==='assignments') {
    document.querySelector('#staff').hidden=true;
    return;
  }
  function render() {
    staffContent.replaceChildren();
    const registers = data.staff.registers;
    if (staffTool === 'attendance') return attendanceRegister(registers.filter(item => !item.archived));
    if (staffTool === 'create' || staffTool === 'platoon') return createEvent(data,staffTool==='platoon'?'training':'operation');
    if (staffTool === 'events') return managedEvents(data.staff.managedEvents,data.staff.groups);
    if (staffTool === 'members') return memberEditor(data.staff.people);
    if (staffTool === 'campaign') return campaignEditor(data.staff.campaignReleases);
    if (staffTool === 'roster') return rosterElementEditor(data.staff.elements,data.staff.units);
    if (staffTool === 'leave') {
      if (data.access === 'Command') {
        const create = button('Record leave for a member',true);
        create.onclick = async () => {
          create.disabled=true;
          try {
            const response = await fetch('/api/member/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'members',values:{}})});
            if (!response.ok) throw new Error(await response.text());
            create.after(leaveCreationForm(await response.json()));
          } catch (error) {
            actionStatus.textContent=error.message;
            create.disabled=false;
          }
        };
        staffContent.append(create);
      }
      if (!data.staff.leaveRequests.length) staffContent.append(node('p', 'No leave requests filed.'));
      for (const leave of data.staff.leaveRequests) {
        const item = node('article', '');
        item.className = 'member-section';
        item.append(row(leave.name, leave.from ? leave.from + ' to ' + leave.to : leave.title + ' · ' + shortDate.format(leave.start)),
          node('p', leave.reason));
        if (!leave.from) item.append(node('p', leave.returnDate ? 'Expected return · ' + leave.returnDate : 'Single event'));
        if (leave.withdrawn || leave.approved) item.append(node('strong', leave.withdrawn ? 'Withdrawn' : 'Approved'));
        if (leave.canWithdraw) {
          const values = {member:leave.memberId,event:leave.key,kind:leave.kind,index:leave.index,submittedAt:leave.key ? leave.submittedAt : leave.start};
          item.append(withdrawLeaveButton(values));
          if (leave.reason) item.append(editLeaveButton(values,leave));
        }
        if (!leave.withdrawn && !leave.approved) {
          const approve = button('Approve leave', true);
          approve.onclick = () => save('approve-leave', {event:leave.key,member:leave.memberId}, approve);
          item.append(approve);
        }
        staffContent.append(item);
      }
      return;
    }
    if (staffTool === 'history') {
      for (const event of data.staff.managedEvents.filter(item => item.cancelled)) {
        staffContent.append(row(event.title + ' · ' + shortDate.format(event.start), 'Cancelled'));
      }
      for (const event of registers.filter(item => item.started)) {
        const attended = event.people.filter(person => person.status === 'attended').length;
        if (event.archived) {
          staffContent.append(row(event.title + ' · ' + shortDate.format(event.start), attended + ' attended · Archived'));
          continue;
        }
        const history = node('a',event.title + ' · ' + shortDate.format(event.start));
        history.href='/staff/operations/tools/?tool=attendance&event='+encodeURIComponent(event.key);
        const line = row('', attended + ' attended');
        line.firstChild.replaceChildren(history);
        staffContent.append(line);
      }
      if (!registers.length && !data.staff.managedEvents.some(item => item.cancelled)) staffContent.append(node('p', 'No event history yet.'));
      return;
    }
    const members = new Map();
    for (const event of registers.filter(item => item.kind === 'sunday' && item.started && item.people.some(person => ['attended','absent'].includes(person.status))).slice(0,10)) {
      for (const person of event.people.filter(item => ['attended','absent'].includes(item.status))) {
        const mark = members.get(person.id) ?? {name:person.name,attended:0,total:0,exempt:person.exempt};
        mark.total++;
        if (person.status === 'attended') mark.attended++;
        members.set(person.id,mark);
      }
    }
    staffContent.append(node('p','Last 10 Sunday registers with attendance marks. Rates use recorded Attended or Absent marks.'));
    for (const mark of [...members.values()].sort((a,b) => a.name.localeCompare(b.name))) {
      const rate = Math.round(100 * mark.attended / mark.total);
      staffContent.append(row(mark.name, rate + '% · ' + mark.attended + '/' + mark.total + (mark.exempt ? ' · Exempt' : mark.attended / mark.total < .75 ? ' · Review' : '')));
    }
  }
  render();
}
if (dialog) document.querySelector('#assignment-cancel').onclick = () => dialog.close();
if (dialog) document.querySelector('#assignment-form').onsubmit = async event => {
  event.preventDefault();
  const member = document.querySelector('#assignment-member').value;
  if (await save('standing', {slot:selectedSlot.key,member,previous:selectedSlot.assigned},
    event.submitter, document.querySelector('#assignment-status'))) dialog.close();
};
const refreshAccess = document.querySelector('#refresh-access');
const dashboardHelp = document.querySelector('#dashboard-help');
const retryStatus = document.querySelector('#dashboard-retry-status');
const retry = document.querySelector('#dashboard-retry');
let retryTimer;
let hasLoadedDashboard = false;
async function showDashboard(fresh = false) {
  if (refreshAccess) refreshAccess.disabled = true;
  retry.disabled = true;
  clearTimeout(retryTimer);
  try {
    await loadDashboard(fresh);
    hasLoadedDashboard = true;
    dashboardHelp.hidden = true;
    retryStatus.textContent = '';
    return true;
  } catch (error) {
    if (fresh) staffView({staff:null});
    console.error('TAG dashboard load failed:', error);
    if (!hasLoadedDashboard) status.textContent = '';
    dashboardHelp.hidden = false;
    retry.onclick = () => showDashboard(fresh);
    const cooldown = error.retryAfter > 0 ? error.retryAfter : 0;
    retry.disabled = cooldown > 0;
    retryStatus.textContent = cooldown
      ? 'Discord temporarily paused membership checks. Try again in ' + cooldown + ' seconds.'
      : '';
    if (cooldown > 0) {
      retryTimer = setTimeout(() => {
        retry.disabled = false;
        retryStatus.textContent = 'You can try again now.';
      }, Math.min(cooldown * 1000, 2147483647));
    }
    return false;
  } finally {
    if (refreshAccess) refreshAccess.disabled = false;
  }
}
if (refreshAccess) refreshAccess.onclick = () => showDashboard(true);
const navigation = performance.getEntriesByType('navigation')[0];
showDashboard(navigation?.type === 'reload');
