export const ranks = Object.freeze({
  Recruit:'RCT', Private:'PVT', 'Private Second Class':'PV2', 'Private First Class':'PFC',
  Specialist:'SPC', Corporal:'CPL', Sergeant:'SGT', 'Staff Sergeant':'SSG',
  'Sergeant First Class':'SFC', 'Master Sergeant':'MSG', 'First Sergeant':'1SG',
  'Sergeant Major':'SGM', 'Command Sergeant Major':'CSM',
  'Warrant Officer 1':'WO1', 'Chief Warrant Officer 2':'CW2', 'Chief Warrant Officer 3':'CW3',
  'Chief Warrant Officer 4':'CW4', 'Chief Warrant Officer 5':'CW5',
  'Second Lieutenant':'2LT', 'First Lieutenant':'1LT', Captain:'CPT',
  Major:'MAJ', 'Lieutenant Colonel':'LTC', Colonel:'COL',
});

export function canonicalRank(value) {
  const query = String(value ?? '').trim().replace(/\.$/,'').toLowerCase();
  if (query==='ssgt') return 'Staff Sergeant';
  return Object.entries(ranks).find(([title,code])=>[title.toLowerCase(),code.toLowerCase()].includes(query))?.[0] ?? '';
}
export function baseDisplayName(name, rank) {
  const base = String(name ?? '').trim();
  if (!canonicalRank(rank)) return base;
  // Older TAG records sometimes include the rank prefix in the saved name.
  const first = /^(\S+)\s+(.+)$/.exec(base);
  return first && canonicalRank(first[1]) ? first[2] : base;
}
export function rankedName(name, rank) {
  const base = baseDisplayName(name,rank);
  const title = canonicalRank(rank);
  return title && base ? ranks[title]+' '+base : base;
}
export function discordNickname(name, rank, zap) {
  const label=rankedName(name,rank);
  const suffix=zap ? ' ['+zap+']' : '';
  const available = 32-suffix.length;
  let shortened = '';
  for (const character of label) {
    if (shortened.length + character.length > available) break;
    shortened += character;
  }
  return shortened.trimEnd()+suffix;
}
