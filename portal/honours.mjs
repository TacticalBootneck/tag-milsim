export const commanderRole = process.env.TAG_HONOURS_COMMANDER_ROLE_ID || '';

export const honours = Object.freeze({
  'medal-of-honor': {title:'TAG Medal of Honor', criteria:'An exceptional in-game act beyond assigned duty with a decisive effect on the mission or the survival of teammates.'},
  'service-cross': {title:'Distinguished Service Cross', criteria:'Exceptional in-game valor by a member serving with a TAG Army element.'},
  'navy-cross': {title:'Navy Cross', criteria:'Exceptional in-game valor by a member serving with a TAG Navy element.'},
  'silver-star': {title:'Silver Star', criteria:'A specific act of conspicuous gallantry during an operation.'},
  'bronze-valor': {title:'Bronze Star with Valor', criteria:'A clearly documented act of heroism during an operation.'},
  'flying-cross': {title:'Distinguished Flying Cross', criteria:'Exceptional heroism or achievement in flight, open to pilots and crew.'},
  'air-medal': {title:'Air Medal', criteria:'A notable achievement in flight that materially contributed to the mission.'},
  commendation: {title:'TAG Commendation Medal', criteria:'Outstanding leadership, instruction, Game Master work or sustained contribution.'},
});

export const ribbonUrl = key => Object.hasOwn(honours,key) && key !== 'commendation'
  ? '/assets/honours/'+key+'.png' : null;

const londonDay = new Intl.DateTimeFormat('en-GB',{weekday:'short',timeZone:'Europe/London'});

export function decorationsView(state,campaigns,events) {
  const registers = Object.values(state.registers).filter(row=>row.closedAt &&
    !(row.key.startsWith('sunday:') && events[row.key.slice(7)]?.cancelledAt));
  const service = registers.filter(row=>row.counts &&
    (row.kind === 'operation' || row.kind === 'training' && londonDay.format(row.start) === 'Sun'));
  const byKey = new Map(registers.map(row=>[row.key,row]));
  const campaignRolls = campaigns.flatMap(campaign=>{
    if (!campaign.archivedAt) return [];
    const operations = Object.entries(events).filter(([,event])=>event.type === 'operation' && !event.cancelledAt &&
      event.start >= campaign.createdAt && event.start < campaign.archivedAt);
    const roll = operations.map(([key])=>byKey.get('sunday:'+key));
    return roll.length && roll.every(Boolean) ? [{campaign,roll}] : [];
  });
  const approved = Object.values(state.honourNominations??{}).filter(row=>row.status === 'approved');
  return (member,probationAt) => {
    const completed = service.filter(row=>probationAt && row.start > probationAt && row.marks[member] === 'attended');
    const operations = completed.filter(row=>row.kind === 'operation').length;
    const training = completed.length - operations;
    const earned = Math.floor(Math.min(operations,training)/10);
    const items = [
      ...approved.filter(row=>row.member === member).map(row=>({
        kind:'honour',title:honours[row.award].title,image:ribbonUrl(row.award),citation:row.citation,
      })),
      ...campaignRolls.flatMap(({campaign,roll})=>{
        const attended=roll.filter(row=>row.marks[member] === 'attended').length;
        return attended*5 > roll.length*4 ? [{
          kind:'campaign',title:campaign.title+' Campaign Medal',citation:attended+' of '+roll.length+' main operations attended.',
        }] : [];
      }),
      ...Array.from({length:earned},(_,index)=>({
        kind:'service',title:'Deployment Ribbon · '+(index+1)*10,tier:index+1,
        citation:(index+1)*10+' main operations and '+(index+1)*10+' Sunday platoon training sessions after probation.',
      })),
    ];
    return {items,service:{operations,training,next:(earned+1)*10,tracking:Boolean(probationAt)}};
  };
}
