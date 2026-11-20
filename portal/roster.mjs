const lineSlots = [
  'Squad Leader', 'Alpha Fire Team Leader', 'Grenadier', 'Rifleman', 'Automatic Rifleman',
  'Bravo Fire Team Leader', 'Grenadier', 'Rifleman / ARFR', 'Automatic Rifleman',
];
const rosterGroups = {
  '1-1': { label: '11', slots: lineSlots },
  '1-2': { label: '12', slots: lineSlots },
  '1-3': { label: '13', slots: lineSlots },
  '1-4': { label: '14', slots: [
    'Squad Leader', 'Alpha Team Leader', 'Alpha Machine Gunner', 'Bravo Team Leader',
    'Bravo Machine Gunner', 'Charlie Team Leader', 'Charlie Machine Gunner', 'HAT Team Leader', 'HAT Gunner',
  ] },
  '1-5': { label: '15', slots: lineSlots },
  '1-6': { label: '16', slots: [
    'Platoon Commander (16)', 'Platoon Sergeant (17)', 'CCT (18)', 'JTAC (18A)',
    'Platoon Medic (19)', 'UAV Operator (Panther)', 'RTO', 'Ammo Bearer', 'Ammo Bearer',
  ] },
  soar: { label: '160th SOAR', slots: [
    'Lead Pilot', ...Array.from({ length: 7 }, () => 'Pilot'),
    ...Array.from({ length: 8 }, () => 'Crew'),
  ] },
};
const lineSlotLetters = 'SAAAABBBB';
const slotLetters = { '1-4': 'SAABBCCDD', '1-6': 'CSCJMPRAA' };

function rosterSlotCode(groupKey, slot, groups = rosterGroups) {
  if (groups[groupKey]?.codes) return groups[groupKey].codes[slot - 1];
  if (!Object.hasOwn(rosterGroups, groupKey) || !Number.isInteger(slot) || slot < 1 || slot > rosterGroups[groupKey].slots.length) return '';
  if (groupKey === 'soar') return slot <= 8 ? `${slot}SP` : `${slot - 8}SC`;
  return `${slot}${(slotLetters[groupKey] ?? lineSlotLetters)[slot - 1]}${groupKey.at(-1)}`;
}


export { rosterGroups, rosterSlotCode };

function withRtoSlot(data) {
  if (data.layoutVersion === 2) return data;
  const shiftAmmoBearers = seats => {
    const next = { ...seats };
    delete next['1-6:7'];
    delete next['1-6:8'];
    if (Object.hasOwn(seats, '1-6:7')) next['1-6:8'] = seats['1-6:7'];
    if (Object.hasOwn(seats, '1-6:8')) next['1-6:9'] = seats['1-6:8'];
    return next;
  };
  const events = Object.fromEntries(Object.entries(data.events).map(([id, event]) => {
    if (!event.groups.includes('1-6')) return [id, event];
    return [id, { ...event, seats: { ...shiftAmmoBearers(event.seats), '1-6:7': { status: 'open' } } }];
  }));
  return { ...data, layoutVersion: 2, standing: shiftAmmoBearers(data.standing), events };
}

function withSoarSlots(data) {
  if (data.soarLayoutVersion === 2) return data;
  const shift = records => {
    const mapped = {};
    const retired = {};
    for (const [key, value] of Object.entries(records ?? {})) {
      const match = /^soar:(\d+)$/.exec(key);
      const slot = match ? Number(match[1]) : 0;
      if (slot > 14) retired[key] = value;
      else mapped[slot >= 7 ? `soar:${slot + 2}` : key] = value;
    }
    return { mapped, retired };
  };
  const standing = shift(data.standing);
  const qualifications = shift(data.qualifications);
  const events = Object.fromEntries(Object.entries(data.events).map(([id, event]) => {
    if (!event.groups.includes('soar')) return [id, event];
    const { mapped, retired } = shift(event.seats);
    return [id, { ...event, retiredSoarSeats: retired,
      seats: { ...snapshotSeats(event.groups, {}), ...mapped } }];
  }));
  return { ...data, soarLayoutVersion: 2, standing: standing.mapped, qualifications: qualifications.mapped,
    retiredSoarStanding: standing.retired, retiredSoarQualifications: qualifications.retired, events };
}

function withCorrectedHqSlots(data) {
  if (data.hqLayoutVersion === 2) return data;
  const positions = { '1-6:3': '1-6:5', '1-6:4': '1-6:3', '1-6:5': '1-6:4' };
  const relocate = key => positions[key] ?? key;
  const remap = entries => Object.fromEntries(Object.entries(entries ?? {}).map(([key, value]) => [relocate(key), value]));
  const events = Object.fromEntries(Object.entries(data.events).map(([id, event]) => {
    if (!event.groups.includes('1-6')) return [id, event];
    const responses = event.responses && Object.fromEntries(Object.entries(event.responses).map(([member, response]) =>
      [member, { ...response, seat: relocate(response.seat) }]));
    return [id, { ...event, seats: remap(event.seats), responses }];
  }));
  return { ...data, hqLayoutVersion: 2, standing: remap(data.standing),
    qualifications: remap(data.qualifications), events };
}

function withRrcQualification(data) {
  const legacy = data.courses?.['recon operator'];
  if (!legacy) return data;
  const courses = { ...data.courses };
  courses['rrc operator'] ??= { ...legacy, name: 'RRC Operator' };
  delete courses['recon operator'];
  return { ...data, courses };
}


function snapshotSeats(groups, standing) {
  return Object.fromEntries(groups.flatMap(group => rosterGroups[group].slots.map((_, index) => {
    const key = `${group}:${index + 1}`;
    const memberId = standing[key];
    return [key, memberId ? { memberId, status: 'awaiting_confirmation' } : { status: 'open' }];
  })));
}


export function migrateRoster(data) { return withRrcQualification(withCorrectedHqSlots(withSoarSlots(withRtoSlot({ standing: {}, events: {}, courses: {}, ...data })))); }
