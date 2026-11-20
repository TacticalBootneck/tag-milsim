const qualifications = [
  ['JTAC', 'Air & fires', 'Coordinates in-game air support with the ground element and crew during TAG events.'],
  ['FO', 'Air & fires', 'Forward Observer. Relays observations and coordinates simulated indirect support within the event’s procedures.'],
  ['CCT', 'Air & fires', 'Combat Controller. Helps coordinate the ground element with aviation and in-game landing arrangements.'],
  ['Medic', 'Ground', 'Provides in-game casualty care using TAG’s medical system and works with the squad on recovery.'],
  ['Machine Gunner', 'Ground', 'Fills a machine gunner billet and works with a weapons team leader during TAG events.'],
  ['HAT Gunner', 'Ground', 'Qualifies for the Heavy Weapons Anti-Tank gunner seat in the Rangers weapons squad.'],
  ['Team Leader', 'Ground', 'Leads a fireteam and coordinates its assignments, comms and readiness with the squad lead.'],
  ['Squad Leader', 'Ground', 'Leads a standing squad, briefs its event assignments and works with Command on roster and attendance.'],
  ['RRC Operator', 'Specialist', 'Qualifies for RRC reconnaissance slots and contributes in-game observations and imagery to the brief.'],
  ['DEVGRU Operator', 'Specialist', 'Qualifies for DEVGRU slots after the unit’s selection and Green Team pathway.'],
  ['Rotary Pilot', 'Aviation', 'Qualifies for helicopter pilot slots after TAG’s in-game rotary-wing assessment.'],
  ['Fixed Wing Pilot', 'Aviation', 'Qualifies for fixed-wing pilot seats on scenarios where those aircraft are available.'],
  ['CAS Pilot', 'Aviation', 'Qualifies for in-game close air support seats and coordination with TAG’s air support staff.'],
  ['UAV Operator', 'Air & fires', 'Qualifies for in-game drone roles, including the Panther seat in platoon headquarters.'],
  ['Training Cadre T1', 'Cadre', 'Supports delivery and assessment of TAG Basic Training T1.'],
  ['Training Cadre T2', 'Cadre', 'Supports delivery and assessment of TAG Basic Training T2.'],
  ['Training Cadre GT', 'Cadre', 'Supports DEVGRU Green Team training and assessment.'],
  ['Training Cadre RRC', 'Cadre', 'Supports RRC training and assessment.'],
  ['Designated Marksman', 'Ground', 'Fills a squad marksman slot where the event offers one.'],
  ['Sniper', 'Specialist', 'Qualifies for dedicated sniper billets on scenarios that use them.'],
  ['Mortar Gunner', 'Air & fires', 'Qualifies for simulated mortar support positions on events that include them.'],
  ['Spotter', 'Specialist', 'Supports an assigned in-game observation element with reporting and coordination.'],
  ['Dog Handler', 'Specialist', 'Qualifies for the simulated working-dog handler slot when supported by the scenario.'],
];
const qualificationDetails = {
  JTAC: ['Complete 10 TAG operations and demonstrate leadership and clear radio communication.', 'Take the TAG JTAC qualification run by TACP alongside pilots. Assessment covers coordinating the game’s ground and aviation roles and maintaining clear comms under pressure.'],
  FO: ['Be comfortable reporting observations clearly and following the event’s radio procedures. Ask Cadre about current course entry rules.', 'Practise making accurate in-game reports, relaying changes, and coordinating simulated support with the staff running the event.'],
  CCT: ['Demonstrate clear radio communication and familiarity with TAG ground and aviation coordination.', 'Work through a joint scenario with ground players and aircrew. Cadre assesses clear handovers and coordination of in-game movements.'],
  Medic: ['Be familiar with TAG’s medical system and able to communicate casualty status to a team lead.', 'Demonstrate the in-game medical workflow in a scenario with other players. This is also the qualification for Rifleman / ARFR.'],
  'Machine Gunner': ['Be comfortable working within a weapons team and taking direction from its lead.', 'Show that you can handle the game’s weapon, work with the team and communicate readiness during an exercise.'],
  'HAT Gunner': ['Know the responsibilities of the Rangers weapons squad and work reliably with a team lead.', 'Demonstrate the game’s assigned HAT equipment and coordination in a weapons-team assessment.'],
  'Team Leader': ['Show reliable attendance, clear communications and the ability to guide a fireteam.', 'Lead a small element during a supervised session. Cadre reviews briefing, communication and how you respond to changes.'],
  'Squad Leader': ['Show experience coordinating a team and communicating with Command.', 'Lead a squad exercise, brief its assignments, coordinate subordinate teams and review the result with Cadre.'],
  'RRC Operator': ['Complete Ranger probation, then pursue RRC selection.', 'Demonstrate in-game observation, reliable reporting and the ability to turn findings into a useful campaign brief.'],
  'DEVGRU Operator': ['Complete Ranger probation, then enter DEVGRU selection and Green Team.', 'Demonstrate teamwork, communication and adaptability through the Green Team assessment before taking a qualified seat.'],
  'Rotary Pilot': ['Complete TAG Basic Training T1 and T2, then enter the 160th SOAR Basic Pilot Training pathway.', 'Demonstrate safe in-game aircraft handling, clear comms and coordination with crew and ground players during an assessment.'],
  'Fixed Wing Pilot': ['Speak to 160th SOAR Cadre about the current aircraft and course entry rules.', 'Demonstrate in-game handling and coordination on a supported fixed-wing scenario. The qualification applies where the event offers a seat.'],
  'CAS Pilot': ['Coordinate with 160th SOAR Cadre on the aviation experience expected for the current assessment.', 'Work with TAG air-support staff in a supervised game scenario. Assessment focuses on clear communication and coordination with the ground team.'],
  'UAV Operator': ['Be comfortable with the event’s in-game UAV interface and concise reporting.', 'Demonstrate operating the scenario’s UAV and passing useful observations to platoon HQ. This can qualify you for Panther.'],
  'Training Cadre T1': ['Speak to Cadre about eligibility to teach TAG Basic Training T1.', 'Demonstrate that you can explain the T1 material, run a session and record fair, consistent assessments.'],
  'Training Cadre T2': ['Speak to Cadre about eligibility to teach TAG Basic Training T2.', 'Demonstrate that you can run a T2 session, give actionable feedback and record the results correctly.'],
  'Training Cadre GT': ['Ask DEVGRU Cadre about instructor selection for Green Team.', 'Show that you can supervise a Green Team exercise and assess participants against the criteria set by DEVGRU Cadre.'],
  'Training Cadre RRC': ['Ask RRC Cadre about instructor selection for its training pathway.', 'Demonstrate that you can supervise a reconnaissance exercise and assess the quality of in-game reporting.'],
  'Designated Marksman': ['Be comfortable operating as part of a squad and communicating with the squad lead.', 'Demonstrate the game’s assigned marksman equipment, observation and team coordination in a supervised session.'],
  Sniper: ['Ask the specialist training staff about intake and any scenario-specific entry requirements.', 'Demonstrate the in-game sniper role and coordination with the observation element in a supervised scenario.'],
  'Mortar Gunner': ['Be comfortable taking clear instructions and working with the other players assigned to simulated support.', 'Demonstrate the game’s mortar interface and clear acknowledgement of instructions in a supervised exercise.'],
  Spotter: ['Show that you can observe and report clearly in an in-game team environment.', 'Demonstrate accurate reporting and coordination with the element you support in an assessed scenario.'],
  'Dog Handler': ['Check whether the current server configuration supports the working-dog role and whether Cadre is scheduling assessments.', 'Demonstrate the scenario’s in-game handler controls and communication with the element you support.'],
};
const detailed = window.location.pathname.startsWith('/qualifications');
const search = document.querySelector('#qualification-search');
const categoryFilters = document.querySelector('#category-filters');
const catalogue = document.querySelector('#qualification-list');
const count = document.querySelector('#qualification-count');
let active = 'All';
function element(tag, value) {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
}
function updateQualifications() {
  const query = search.value.trim().toLowerCase();
  const matches = qualifications.filter(([name, category, description]) =>
    (active === 'All' || category === active) && [name, category, description].join(' ').toLowerCase().includes(query));
  count.textContent = matches.length === 1 ? '1 qualification' : matches.length + ' qualifications';
  catalogue.replaceChildren(...matches.map(([name, category, description]) => {
    const item = document.createElement('article');
    item.className = 'qualification';
    item.append(element('span', category), element('h3', name), element('p', description));
    if (detailed) {
      const details = document.createElement('details');
      const descriptionList = document.createElement('dl');
      const [preparation, assessment] = qualificationDetails[name];
      descriptionList.append(element('dt', name === 'JTAC' ? 'Requirements' : 'Preparation'),
        element('dd', preparation), element('dt', 'Assessment'), element('dd', assessment));
      details.append(element('summary', 'Requirements and assessment'), descriptionList);
      item.append(details);
    }
    return item;
  }));
  if (!matches.length) catalogue.append(element('p', 'No qualifications match your search.'));
}
for (const category of ['All', ...new Set(qualifications.map(([, category]) => category))]) {
  const button = element('button', category);
  button.type = 'button';
  button.setAttribute('aria-pressed', String(category === active));
  button.addEventListener('click', () => {
    active = category;
    for (const item of categoryFilters.children) item.setAttribute('aria-pressed', String(item === button));
    updateQualifications();
  });
  categoryFilters.append(button);
}
search.addEventListener('input', updateQualifications);
updateQualifications();

