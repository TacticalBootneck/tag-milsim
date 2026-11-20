const dayMs = 86_400_000;
const intervals = { daily:1, weekly:7, fortnightly:14, 'four-weekly':28 };

export function nextTrainingOccurrence(series, now, parseStart) {
  const previous = Date.parse(series.repeatDay+'T00:00:00Z');
  if (!Number.isFinite(previous)) return null;
  const today = Date.parse(new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/London',dateStyle:'short'}).format(now)+'T00:00:00Z');
  const interval = intervals[series.repeat];
  if (interval) {
    const steps = Math.max(1,Math.ceil((today-previous)/(interval*dayMs)));
    for (let offset=steps;offset<steps+4;offset++) {
      const date = new Date(previous+offset*interval*dayMs).toISOString().slice(0,10);
      const start = parseStart(date,series.repeatTime);
      if (start > now) return {day:date,start};
    }
  } else if (series.repeat==='monthly') {
    const first = new Date(previous);
    const current = new Date(today);
    const months = (current.getUTCFullYear()-first.getUTCFullYear())*12+current.getUTCMonth()-first.getUTCMonth();
    for (let offset=Math.max(1,months);offset<Math.max(1,months)+3;offset++) {
      const target = new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+offset,1));
      const last = new Date(Date.UTC(target.getUTCFullYear(),target.getUTCMonth()+1,0)).getUTCDate();
      target.setUTCDate(Math.min(series.repeatAnchor ?? first.getUTCDate(),last));
      const date = target.toISOString().slice(0,10);
      const start = parseStart(date,series.repeatTime);
      if (start > now) return {day:date,start};
    }
  }
  return null;
}
