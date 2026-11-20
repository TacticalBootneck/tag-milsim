import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextTrainingOccurrence } from '../bot/training-repeat.mjs';

const london = new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/London',dateStyle:'short',timeStyle:'short'});
function parse(day,time) {
  const utc=Date.parse(day+'T'+time+':00Z');
  const valid=[utc,utc-3_600_000].filter(start=>london.format(start)===day+' '+time);
  return valid.length===1?valid[0]:null;
}
const next=(repeat,previous,now,time='19:00',repeatAnchor)=>nextTrainingOccurrence({
  repeat,repeatDay:previous,repeatTime:time,repeatAnchor,
},Date.parse(now),parse);

test('repeat options advance exactly one occurrence and preserve UK local time',()=>{
  const previous='2026-03-27';
  const now='2026-03-27T23:00:00Z';
  for (const [repeat,day] of [['daily','2026-03-28'],['weekly','2026-04-03'],['fortnightly','2026-04-10'],['four-weekly','2026-04-24']]) {
    const occurrence=next(repeat,previous,now);
    assert.equal(occurrence.day,day);
    assert.equal(london.format(occurrence.start),day+' 19:00');
  }
  assert.equal(next('none',previous,now),null);
});

test('monthly repeats retain the original day after a shorter month',()=>{
  const feb=next('monthly','2026-01-31','2026-01-31T23:00:00Z','19:00',31);
  assert.equal(feb.day,'2026-02-28');
  assert.equal(next('monthly',feb.day,'2026-02-28T23:00:00Z','19:00',31).day,'2026-03-31');
});

test('long downtime skips elapsed occurrences and invalid DST start times',()=>{
  assert.equal(next('weekly','2026-03-01','2026-03-29T20:00:00Z').day,'2026-04-05');
  assert.equal(next('daily','2026-03-28','2026-03-28T07:00:00Z','01:30').day,'2026-03-30');
});
