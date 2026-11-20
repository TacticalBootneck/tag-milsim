import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseEnv } from 'node:util';

const types = { recon:'Reconnaissance', shaping:'Shaping Operation', main:'Main Operation' };
const uuid = /^[a-f0-9-]{36}$/;
const snowflake = /^\d{17,20}$/;
const channel = '1572974593327505589';
const maxImage = 2_000_000;

class InputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
function requireInput(ok, message, status) {
  if (!ok) throw new InputError(message, status);
}
function field(value, label, max, required = true) {
  const result = typeof value === 'string' ? value.trim() : '';
  requireInput((!required || result.length > 0) && result.length <= max, label + ' must ' +
    (required ? 'contain 1 to ' : 'be no more than ') + max + ' characters.');
  return result;
}
function items(value, max, label) {
  requireInput(Array.isArray(value) && value.length <= max, 'Choose up to ' + max + ' ' + label + '.');
  return value;
}
function pin(value) {
  if (!value) return null;
  const { x, y } = value;
  requireInput(Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x <= 1 && y <= 1, 'Choose a point on the campaign map.');
  return {x,y};
}
function day(value) {
  requireInput(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), 'Choose a session date.');
  const parsed = new Date(value);
  requireInput(Number.isFinite(+parsed) && parsed.toISOString().slice(0,10) === value, 'Choose a valid session date.');
  return value;
}
async function body(request) {
  const limit = 18_000_000;
  requireInput(request.headers['content-type']?.split(';')[0] === 'application/json', 'Send JSON.', 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({destroyOnReturn:false})) {
    size += chunk.length;
    requireInput(size <= limit, 'Reduce the number or size of screenshots.', 413);
    chunks.push(chunk);
  }
  let payload;
  try { payload = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new InputError('Invalid campaign form data.'); }
  requireInput(payload && typeof payload === 'object' && !Array.isArray(payload), 'Invalid campaign form.');
  return payload;
}
function escapeMarkdown(value) {
  return value.replace(/[\\`*_{}\[\]()<>#+.!|~]/g, '\\$&');
}

export function createCampaignWorkspace({dataDir, origin, requestDiscord, mediaStore, now = Date.now}) {
  let db;
  function database() {
    if (db) return db;
    const previousMask = process.umask(0o077);
    let opened;
    try {
      opened = new DatabaseSync(resolve(dataDir,'campaign-workspace.sqlite'));
      opened.exec(`PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, bytes BLOB NOT NULL, public INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS image_storage
          (id TEXT PRIMARY KEY REFERENCES images(id), next INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, uploaded INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS image_storage_queue ON image_storage(next) WHERE uploaded=0;
        CREATE TABLE IF NOT EXISTS aar_drafts (id TEXT PRIMARY KEY, owner TEXT NOT NULL, campaign TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS aar_drafts_owner ON aar_drafts(owner,updated);
        CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, payload TEXT NOT NULL, next INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, message TEXT);
        INSERT OR IGNORE INTO state VALUES (1,'{"active":null,"campaigns":[],"roles":{},"updates":[]}');`);
      db = opened;
      return db;
    } catch (error) {
      opened?.close();
      throw error;
    } finally {
      process.umask(previousMask);
    }
  }
  const read = () => JSON.parse(database().prepare('SELECT json FROM state WHERE id=1').get().json);
  function transaction(change) {
    const store = database();
    store.exec('BEGIN IMMEDIATE');
    try {
      const state = read();
      const result = change(state);
      store.prepare('UPDATE state SET json=? WHERE id=1').run(JSON.stringify(state));
      store.exec('COMMIT');
      return result;
    } catch (error) {
      store.exec('ROLLBACK');
      throw error;
    }
  }
  function addImage(source) {
    requireInput(typeof source === 'string' && source.length <= Math.ceil(maxImage / 3) * 4 && /^[A-Za-z0-9+/]+={0,2}$/.test(source),
      'Upload a JPEG under 2 MB.');
    const bytes = Buffer.from(source,'base64');
    requireInput(bytes.length >= 4 && bytes.length <= maxImage && bytes[0] === 255 && bytes[1] === 216 &&
      bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217, 'Upload a valid JPEG under 2 MB.');
    const id = randomUUID();
    database().prepare('INSERT INTO images (id,bytes) VALUES (?,?)').run(id,bytes);
    if (mediaStore) database().prepare('INSERT INTO image_storage (id,next) VALUES (?,?)').run(id,now());
    return id;
  }
  function permissions(state, member, command) {
    if (command || (state.roles.squad && member.roles.includes(state.roles.squad))) return Object.keys(types);
    if (state.roles.team && member.roles.includes(state.roles.team)) return ['recon','shaping'];
    return [];
  }
  function update(state, campaign, key, title, date, summary, images) {
    const entry = {id:key,title,date,summary,images,campaign:campaign.title,publishedAt:now()};
    state.updates.push(entry);
    for (const image of images) database().prepare('UPDATE images SET public=1 WHERE id=?').run(image);
    database().prepare('INSERT INTO outbox (id,payload,next) VALUES (?,?,?)').run(key,JSON.stringify(entry),now());
  }
  function submission(state, campaign, input, member, command, events) {
    requireInput(permissions(state,member,command).includes(input.type), 'You cannot submit this AAR type.',403);
    requireInput(typeof input.id === 'string' && uuid.test(input.id), 'Refresh the form before submitting.');
    const existing = campaign.reports.find(report => report.id === input.id);
    if (existing?.authorId === member.user.id) return {id:existing.id};
    requireInput(!state.updates.some(entry => entry.id === input.id), 'This submission was already used.',409);
    const sessionDate = day(input.date);
    const summary = field(input.publicSummary,'Public recap',1200);
    const attachments = items(input.images,6,'screenshots').map(addImage);
    const selected = items(input.selected,2,'public screenshots');
    requireInput(new Set(selected).size === selected.length && selected.every(index => Number.isInteger(index) && attachments[index]), 'Select screenshots attached to this AAR.');
    if (input.event) requireInput(events.some(event => event.key === input.event), 'Choose an available TAG event.');
    const observation = (row, incident) => {
      requireInput(row && typeof row === 'object', 'Invalid report entry.');
      const location = campaign.entities.find(entry => entry.id === row.location && entry.type === 'location');
      requireInput(!row.location || location, 'Select an existing campaign location.');
      const subject = campaign.entities.find(entry => entry.id === row.subject && entry.type !== 'location');
      requireInput(!row.subject || subject, 'Select an existing person or faction.');
      const point = pin(row.pin);
      requireInput(!point || campaign.map, 'Upload a campaign map before adding pins.');
      return {
        id:randomUUID(), title:field(row.title,'Entry title',100),
        description:field(row.description,incident ? 'Incident' : 'Observation',2000),
        assessment:field(row.assessment,'Unconfirmed assessment',1000,false),
        result:incident ? field(row.result,'Response and outcome',1200) : '',
        time:incident ? field(row.time,'Approximate time',30,false) : '',
        grid:field(row.grid,'In-game grid reference',40,false), pin:point, location:location?.id ?? null, subject:subject?.id ?? null,
        status:'reported',
      };
    };
    campaign.reports.push({
      id:input.id, type:input.type, date:sessionDate, team:field(input.team,'Team',100),
      summary:field(input.summary,'Internal summary',3000),
      outcome:field(input.outcome,'Objective and outcome',2400,input.type !== 'recon'),
      event:events.find(event => event.key === input.event) ?? null,
      author:member.nick || member.user.global_name || member.user.username, authorId:member.user.id,
      findings:items(input.findings,16,'findings').map(row => observation(row,false)),
      incidents:items(input.incidents,16,'incidents').map(row => observation(row,true)),
      images:attachments, publicSummary:summary, submittedAt:now(),
    });
    update(state,campaign,input.id,types[input.type],sessionDate,summary,selected.map(index => attachments[index]));
    return {id:input.id};
  }
  function mutate(input, member, command, events) {
    return transaction(state => {
      if (input.action === 'submit') {
        const prior = state.campaigns.find(entry => entry.id === input.campaign)?.reports.find(entry => entry.id === input.id);
        if (prior?.authorId === member.user.id) return {id:prior.id};
        requireInput(state.active === input.campaign, 'The active campaign changed. Reopen the report form.',409);
        const campaign = state.campaigns.find(entry => entry.id === state.active);
        requireInput(campaign, 'Command needs to start a campaign first.',409);
        const draft=database().prepare('SELECT owner,updated FROM aar_drafts WHERE id=?').get(input.id??'');
        requireInput(!draft||draft.owner===member.user.id,'Draft unavailable.',404);
        requireInput(!draft||input.updated===draft.updated,'This draft changed in another window. Reopen it before submitting.',409);
        const output=submission(state,campaign,input,member,command,events);
        database().prepare('DELETE FROM aar_drafts WHERE id=? AND owner=?').run(output.id,member.user.id);
        return output;
      }
      if (['draft','delete-draft'].includes(input.action)) {
        requireInput(typeof input.id==='string'&&uuid.test(input.id),'Choose a draft.');
        const store=database();
        const owner=member.user.id;
        const previous=store.prepare('SELECT owner,updated FROM aar_drafts WHERE id=?').get(input.id);
        requireInput(!previous||previous.owner===owner,'Draft unavailable.',404);
        if (input.action==='delete-draft') {
          store.prepare('DELETE FROM aar_drafts WHERE id=? AND owner=?').run(input.id,owner);
          return {id:input.id};
        }
        requireInput(state.active && state.active===input.campaign,'This campaign is no longer active.',409);
        requireInput(permissions(state,member,command).includes(input.type),'You cannot create this report type.',403);
        requireInput(!state.updates.some(entry=>entry.id===input.id),'This report has already been submitted.',409);
        requireInput(!previous||input.updated===previous.updated,'This draft changed in another window. Reopen it.',409);
        requireInput(previous || store.prepare('SELECT count(*) AS count FROM aar_drafts WHERE owner=?').get(owner).count<20,
          'Submit or delete an older draft before starting another.');
        const {id,campaign,type,date,team,event,summary,outcome,publicSummary,findings,incidents,images,selected}=input;
        const data={id,campaign,type,date,team,event,summary,outcome,publicSummary,
          findings:items(findings,16,'findings'),incidents:items(incidents,16,'incidents'),
          images:items(images,6,'screenshots'),selected:items(selected,2,'public screenshots')};
        requireInput(data.images.every(image=>typeof image==='string'&&image.length<=Math.ceil(maxImage/3)*4&&/^[a-zA-Z0-9+/]+={0,2}$/.test(image)),
          'Choose valid draft screenshots.');
        const updated=Math.max(now(),(previous?.updated??0)+1);
        store.prepare(`INSERT INTO aar_drafts(id,owner,campaign,data,updated) VALUES (?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated=excluded.updated`).run(id,owner,campaign,JSON.stringify(data),updated);
        return {id,updated};
      }
      requireInput(command,'Command access is required.',403);
      if (input.action === 'roles') {
        for (const key of ['team','squad']) {
          requireInput(input[key] === '' || (typeof input[key] === 'string' && snowflake.test(input[key])), 'Enter a Discord role ID or leave it blank.');
          state.roles[key] = input[key];
        }
        return {};
      }
      if (input.action === 'create') {
        requireInput(state.active === (input.previous ?? null), 'The active campaign changed. Reload before starting another one.',409);
        const prior = state.campaigns.find(entry => entry.id === state.active);
        const campaign = {
          id:randomUUID(), title:field(input.title,'Campaign name',100), mapName:field(input.mapName,'Map name',100),
          backstory:field(input.backstory,'Backstory',5000), goal:field(input.goal,'End goal',2000),
          map:addImage(input.map), entities:[], reports:[], followups:[], assessments:[], createdAt:now(), archivedAt:null,
        };
        if (prior) prior.archivedAt = now();
        state.active = campaign.id;
        state.campaigns.push(campaign);
        return {};
      }
      const campaign = state.campaigns.find(entry => entry.id === state.active);
      requireInput(campaign && input.campaign === campaign.id, 'The active campaign changed. Reload the workspace.',409);
      if (input.action === 'archive') {
        campaign.archivedAt = now();
        state.active = null;
      } else if (input.action === 'brief') {
        campaign.title = field(input.title,'Campaign name',100);
        campaign.backstory = field(input.backstory,'Backstory',5000);
        campaign.goal = field(input.goal,'End goal',2000);
        campaign.progress = field(input.progress,'Campaign progress',2400,false);
      } else if (input.action === 'entity') {
        requireInput(['person','faction','location'].includes(input.type), 'Choose a record type.');
        const existing = campaign.entities.find(entry => entry.id === input.id);
        requireInput(!input.id || existing, 'Record not found.',404);
        const entry = {
          id:existing?.id ?? randomUUID(), type:existing?.type ?? input.type, title:field(input.title,'Name',120),
          description:field(input.description,'Description',2500,false), pin:pin(input.pin), grid:field(input.grid,'Grid reference',40,false),
        };
        if (existing) Object.assign(existing,entry); else campaign.entities.push(entry);
      } else if (input.action === 'review') {
        const report = campaign.reports.find(entry => entry.id === input.report);
        const entry = [...(report?.findings ?? []),...(report?.incidents ?? [])].find(item => item.id === input.entry);
        requireInput(entry && ['reported','confirmed','unconfirmed'].includes(input.status), 'Choose a valid report entry and review status.');
        requireInput(!input.location || campaign.entities.some(item => item.id === input.location && item.type === 'location'), 'Choose a valid location.');
        entry.status = input.status;
        entry.reviewLocation = input.location || null;
        entry.reviewNote = field(input.note,'Review note',1200,false);
      } else if (input.action === 'followup') {
        const existing = campaign.followups.find(entry => entry.id === input.id);
        const report = campaign.reports.find(entry => entry.id === input.report);
        requireInput(!input.report || report, 'Select a campaign report.');
        requireInput(!input.id || existing, 'Follow-up not found.',404);
        const event = events.find(entry => entry.key === input.event);
        requireInput(!input.event || event, 'Choose an available TAG event.');
        if (existing && input.linkEvent === true) {
          existing.event = event ?? null;
        } else if (existing) {
          existing.closedAt = input.close === true ? now() : null;
          existing.resolution = existing.closedAt ? report?.id ?? null : null;
        } else {
          campaign.followups.push({id:randomUUID(), text:field(input.text,'Follow-up',600), source:report?.id ?? null, event:event ?? null, closedAt:null});
        }
      } else if (input.action === 'decision') {
        requireInput(typeof input.id === 'string' && uuid.test(input.id), 'Refresh the form before publishing.');
        if (campaign.assessments.some(entry => entry.id === input.id)) return {id:input.id};
        requireInput(!state.updates.some(entry => entry.id === input.id), 'This submission was already used.',409);
        const report = campaign.reports.find(entry => entry.id === input.report);
        requireInput(!input.report || report, 'Select a campaign report.');
        const title = field(input.title,'Decision title',100);
        const note = field(input.note,'Planning decision',2400);
        const summary = field(input.publicSummary,'Public recap',1200,false);
        campaign.assessments.push({id:input.id,title,note,report:report?.id ?? null,createdAt:now()});
        if (summary) update(state,campaign,input.id,title,day(input.date),summary,[]);
      } else throw new InputError('Unknown campaign action.');
      return {};
    });
  }
  async function handle(request, response, url, member, command, events) {
    const send = (status,data) => {
      response.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});
      response.end(JSON.stringify(data));
    };
    try {
      if (request.method === 'POST') {
        requireInput(request.headers.origin === origin,'Invalid request origin.',403);
        send(200,mutate(await body(request),member,command,events));
        return;
      }
      const state = read();
      const campaign = state.campaigns.find(entry => entry.id === (url.searchParams.get('id') || state.active)) ?? null;
      const outbox = command && campaign ? database().prepare('SELECT id, attempts, message FROM outbox').all()
        .filter(row => campaign.reports.some(report => report.id === row.id) || campaign.assessments.some(entry => entry.id === row.id)) : [];
      const showDrafts=url.searchParams.get('drafts')==='1';
      const drafts=showDrafts ? database().prepare(`SELECT id,campaign,updated,json_extract(data,'$.type') AS type,
        json_extract(data,'$.team') AS team FROM aar_drafts WHERE owner=? ORDER BY updated DESC`).all(member.user.id) : [];
      const requested=showDrafts && url.searchParams.get('draft');
      let draft;
      if (requested) {
        const row=database().prepare('SELECT campaign,data,updated FROM aar_drafts WHERE owner=? AND id=?').get(member.user.id,requested);
        requireInput(row,'Draft unavailable.',404);
        requireInput(row.campaign===state.active,'This draft belongs to an archived campaign.',409);
        draft={...JSON.parse(row.data),updated:row.updated};
      }
      send(200,{drafts,draft,active:state.active,campaign,archive:state.campaigns.filter(entry => entry.archivedAt).map(({id,title})=>({id,title})),
        command,types:permissions(state,member,command),roles:command ? state.roles : undefined,events,outbox});
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
      send(error.status,{error:error.message});
    }
  }

  const imageKey = id => 'campaign-images/' + id + '.jpg';
  function serveImage(response, id, isPublic) {
    const row = uuid.test(id) && database().prepare(`SELECT bytes,uploaded FROM images
      LEFT JOIN image_storage USING(id) WHERE id=? AND (?=0 OR public=1)`).get(id,Number(isPublic));
    if (!row) { response.writeHead(404,{'Cache-Control':'no-store'}); response.end('Image not found'); return; }
    if (row.uploaded) {
      response.writeHead(mediaStore ? 302 : 503, {
        'Cache-Control':'no-store',
        ...(mediaStore && {Location:mediaStore.imageUrl(imageKey(id))}),
      });
      response.end(mediaStore ? '' : 'Campaign image storage is unavailable.');
      return;
    }
    response.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':isPublic ? 'public, max-age=300' : 'private, no-store'});
    response.end(row.bytes);
  }

  let uploading = false;
  async function deliverImages() {
    if (!mediaStore || uploading) return;
    uploading = true;
    try {
      const store = database();
      const queued = store.prepare(`SELECT id,bytes,attempts FROM image_storage
        JOIN images USING(id) WHERE uploaded=0 AND next<=? ORDER BY next,id LIMIT 1`).get(now());
      if (!queued) return;
      try {
        await mediaStore.upload(imageKey(queued.id),queued.bytes);
      } catch (error) {
        const delay = 15_000 * 2 ** Math.min(queued.attempts,8);
        store.prepare('UPDATE image_storage SET next=?, attempts=attempts+1 WHERE id=? AND uploaded=0')
          .run(now()+delay,queued.id);
        const reason = /^IDrive e2 returned HTTP \d{3}$/.test(error.message) ? error.message : error.name;
        console.warn('Campaign media upload will retry:',reason);
        return;
      }
      store.exec('BEGIN IMMEDIATE');
      try {
        store.prepare('UPDATE image_storage SET uploaded=1 WHERE id=?').run(queued.id);
        store.prepare("UPDATE images SET bytes=X'' WHERE id=?").run(queued.id);
        store.exec('COMMIT');
      } catch (error) {
        store.exec('ROLLBACK');
        throw error;
      }
    } finally {
      uploading = false;
    }
  }

  let posting = false;
  async function deliver() {
    if (posting) return;
    posting = true;
    let queued;
    try {
      queued = database().prepare('SELECT * FROM outbox WHERE message IS NULL AND next<=? ORDER BY next LIMIT 1').get(now());
      if (!queued) return;
      const token = process.env.TAG_CAMPAIGN_BOT_TOKEN || parseEnv(readFileSync(resolve(dataDir,'.env'),'utf8')).DISCORD_TOKEN;
      if (!token) throw new Error('Discord bot token unavailable.');
      const entry = JSON.parse(queued.payload);
      const link = origin + '/campaign/#update-' + entry.id;
      const embeds = [{title:entry.title,description:escapeMarkdown(entry.summary),url:link,footer:{text:entry.campaign+' · '+entry.date}}];
      for (const [index,id] of entry.images.entries()) {
        const image = {url:origin+'/campaign-images/'+id};
        if (index === 0) embeds[0].image = image;
        else embeds.push({url:image.url,image});
      }
      const result = await requestDiscord('campaign-publish', 'https://discord.com/api/v10/channels/'+channel+'/messages', {
        method:'POST', headers:{Authorization:'Bot '+token,'Content-Type':'application/json'}, signal:AbortSignal.timeout(8000),
        body:JSON.stringify({content:link,embeds,allowed_mentions:{parse:[]},nonce:entry.id.replaceAll('-','').slice(0,25),enforce_nonce:true}),
      });
      if (!result.ok) throw new Error('Discord returned HTTP '+result.status);
      const message = (await result.json()).id;
      if (!snowflake.test(message ?? '')) throw new Error('Discord response was incomplete.');
      database().prepare('UPDATE outbox SET message=? WHERE id=?').run(message,queued.id);
    } catch (error) {
      if (queued) {
        const delay = Math.max(15 * 2 ** Math.min(queued.attempts,8), error.seconds || 0) * 1000;
        database().prepare('UPDATE outbox SET next=?, attempts=attempts+1 WHERE id=?').run(now()+delay,queued.id);
      }
      console.warn('Campaign Discord outbox:', error.name === 'Error' && /^Discord returned HTTP \d+$/.test(error.message) ? error.message : error.name);
    } finally {
      posting = false;
    }
  }
  function unitContext(member) {
    const state=read();
    const findings=[];
    const reports=[];
    for (const campaign of state.campaigns) {
      const page='/members/campaign/'+(campaign.id===state.active?'':'?campaign='+campaign.id);
      for (const report of campaign.reports) {
        const href=page+'#report-'+report.id;
        reports.push({id:report.id,title:report.date+' · '+types[report.type]+' · '+report.team,href});
        for (const item of [...report.findings,...report.incidents]) {
          findings.push({id:item.id,title:item.title,href,grid:item.grid||'',map:campaign.mapName,pin:item.pin});
        }
      }
      for (const item of campaign.entities.filter(entry=>entry.pin)) findings.push({
        id:item.id,title:item.title,href:page+'#campaign-map',grid:item.grid||'',map:campaign.mapName,pin:item.pin,
      });
    }
    return {roles:state.roles,findings,reports,active:state.active,map:state.campaigns.find(item=>item.id===state.active)?.mapName,
      canAar:Boolean(state.active&&member&&permissions(state,member,false).length)};
  }
  return {handle,serveImage,deliver,deliverImages,unitContext,publicEntries:() => read().updates,
    roleSettings:() => read().roles,
    awardWindows:() => read().campaigns.map(({id,title,createdAt,archivedAt})=>({id,title,createdAt,archivedAt}))};
}
