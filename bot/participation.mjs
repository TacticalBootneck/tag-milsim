const day = 86_400_000;
export const week = 7 * day;
const britishDate = new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'});
const dayIndex = date => Date.parse(date+'T00:00:00Z') / day;
export const ukDate = time => britishDate.format(time);

export function monthsFrom(time, months) {
  const original = new Date(ukDate(time)+'T00:00:00Z');
  const date = new Date(Date.UTC(original.getUTCFullYear(),original.getUTCMonth()+months,1));
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();
  date.setUTCDate(Math.min(original.getUTCDate(),lastDay));
  return date.getTime();
}

export function leaveIntervals(ranges, legacy = []) {
  return [...ranges,...legacy].flatMap(range => {
    const end = Math.min(dayIndex(range.to),range.withdrawnAt ? dayIndex(ukDate(range.withdrawnAt))-1 : Infinity);
    const start = dayIndex(range.from);
    return Number.isFinite(start) && Number.isFinite(end) && end >= start ? [[start,end]] : [];
  }).sort((a,b)=>a[0]-b[0]).reduce((merged,[first,last])=>{
    const previous = merged.at(-1);
    if (previous && first <= previous[1]+1) previous[1]=Math.max(previous[1],last);
    else merged.push([first,last]);
    return merged;
  },[]);
}

export function leaveWithinLimit(ranges, now, legacy = []) {
  const today = dayIndex(ukDate(now));
  return leaveIntervals(ranges,legacy).every(([from,to])=>to < today || to-from+1 <= 42);
}

export function rollingLeaveDays(intervals, now) {
  const first = dayIndex(ukDate(monthsFrom(now,-3)));
  const last = dayIndex(ukDate(now));
  return intervals.reduce((days,[from,to])=>days+Math.max(0,Math.min(last,to)-Math.max(first,from)+1),0);
}

export function recordedSundays(events, now) {
  return events.filter(event=>!event.cancelledAt && ['operation','training','platoon-training'].includes(event.type) &&
    event.start + 12*60*60*1000 <= now && new Date(ukDate(event.start)+'T00:00:00Z').getUTCDay()===0 &&
    Object.values(event.attendance ?? {}).some(mark=>mark?.status==='attended' || mark?.status==='absent'))
    .sort((a,b)=>a.start-b.start);
}

export function sundayProgress(events, memberId, after, protectedAt) {
  const weeks = new Map();
  let streak=0;
  let medals=0;
  for (const event of events) {
    const status=event.attendance?.[memberId]?.status;
    if (status==='attended') {
      streak++;
      if (streak % 10===0) medals++;
    } else {
      streak=0;
    }
    if (event.start < after) continue;
    const hasSeat = Object.values(event.seats ?? {}).some(seat=>seat?.memberId===memberId);
    const week = ukDate(event.start);
    const previous = weeks.get(week);
    if (previous === 'attended' || status==='attended') weeks.set(week,'attended');
    else if (previous === 'missed' || (!protectedAt(event) && (status==='absent' || (!status && !hasSeat)))) weeks.set(week,'missed');
    else weeks.set(week,'skip');
  }
  let missed=0;
  let episode=0;
  for (const [date,status] of weeks) {
    if (status==='attended') { missed=0; episode=0; }
    else if (status==='missed') {
      if (!missed) episode=dayIndex(date)*day;
      missed++;
    }
  }
  return {missed,episode,streak,medals};
}

export function participationStage({type,now,base,missed=0,notice}) {
  const last=notice?.stage ?? 0;
  const since=notice?.at ?? 0;
  if (last && now-since < (type==='reserve' ? 2*week : week)) return null;
  if (type==='recruit') {
    if (!last && now-base >= 3*week) return {stage:3};
    if (last===3 && now-base >= 4*week) return {remove:true};
  } else if (type==='reserve') {
    if (!last && now>=monthsFrom(base,3)) return {stage:1};
    if (last===1) return {remove:true};
  } else {
    const next=last ? last+1 : 2;
    if (next<=4 && missed>=next) return {stage:next};
    if (last===4 && missed>=5) return {remove:true};
  }
  return null;
}
