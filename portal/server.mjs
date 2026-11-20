import { createUnitOperations, WorkflowError } from './unit-operations.mjs';
import { createCampaignWorkspace } from './campaign-workspace.mjs';
import { honours, ribbonUrl } from './honours.mjs';
import { createMediaStore } from './media-store.mjs';
import { rankedName, baseDisplayName, canonicalRank } from './ranks.mjs';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { rosterGroups, rosterSlotCode, migrateRoster } from './roster.mjs';

const {
  PUBLIC_ORIGIN, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, TAG_GUILD_ID, TAG_DATA_DIR,
  FULL_MEMBER_ROLE_ID, PROBATIONARY_ROLE_ID, RECRUIT_ROLE_ID, TRAINING_CHANNEL_ID,
  SPECIALIST_CHANNEL_ID, UPCOMING_OPS_CHANNEL_ID, COMMAND_ROLE_ID, TRAINING_CADRE_ROLE_ID,
  TAG_WEB_BRIDGE_KEY, PORT = '3071',
} = process.env;
if (!PUBLIC_ORIGIN || !DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET || !TAG_GUILD_ID || !TAG_DATA_DIR) {
  throw new Error('Configure PUBLIC_ORIGIN, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, TAG_GUILD_ID and TAG_DATA_DIR.');
}
const bridgeUrl='http://127.0.0.1:'+(process.env.TAG_BOT_BRIDGE_PORT??'3072')+'/';
const publicUrl = new URL(PUBLIC_ORIGIN);
if (publicUrl.protocol !== 'https:' || publicUrl.origin !== PUBLIC_ORIGIN) {
  throw new Error('PUBLIC_ORIGIN must be an HTTPS origin without a trailing slash.');
}
const redirectUri = PUBLIC_ORIGIN + '/auth/discord/callback';
const discord = 'https://discord.com';
let mediaStore;
try { mediaStore = createMediaStore(process.env); }
catch { console.warn('Campaign media configuration is incomplete or invalid. Check the five TAG_MEDIA settings in portal/.env.'); }
const campaignWorkspace = createCampaignWorkspace({dataDir:TAG_DATA_DIR,origin:PUBLIC_ORIGIN,requestDiscord:discordRequest,mediaStore});
const unitOperations = createUnitOperations({dataDir:TAG_DATA_DIR,origin:PUBLIC_ORIGIN,context:unitContext,sendJob:deliverUnitJob,getChannels:trainingChannels});
const sessions = new Map();
const stateCookie = '__Host-tag-oauth';
const sessionCookie = '__Host-tag-session';
const returnCookie = '__Host-tag-return';
const maxAge = 4 * 3600;
const staffPages = ['/staff/','/staff/administration/','/staff/training/','/staff/operations/','/staff/administration/tools/','/staff/training/tools/','/staff/operations/tools/'];
const staffTools = {
  '/staff/administration/tools/':['members','roster','assignments','leave','review','history'],
  '/staff/training/tools/':['platoon'],
  '/staff/operations/tools/':['create','events','attendance','campaign'],
};
function returnPath(value) {
  if (typeof value!=='string' || value.length>350 || !value.startsWith('/')) return '/members/';
  const url = new URL(value,PUBLIC_ORIGIN);
  if (url.origin!==PUBLIC_ORIGIN || !['/members/unit/','/members/aar/','/members/campaign/',...staffPages].includes(url.pathname)) return '/members/';
  return url.pathname+url.search;
}
function savedReturn(request) {
  try { return returnPath(decodeURIComponent(cookies(request)[returnCookie] ?? '')); }
  catch { return '/members/'; }
}
function featureSignin(response,url) {
  const destination=encodeURIComponent(returnPath(url.pathname+url.search));
  return reply(response,200,'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>TAG sign-in</title><link rel="stylesheet" href="/site.css"><main class="wrap section"><h1>TAG MILSIM</h1><p>Sign in to open this member page.</p><a class="button primary" href="/auth/discord?next='+destination+'">Sign in with Discord</a></main></html>','text/html; charset=utf-8');
}
const cookie = (name, value, age) => name + '=' + value + '; Path=/; Max-Age=' + age + '; Secure; HttpOnly; SameSite=Lax';
function cookies(request) {
  return Object.fromEntries((request.headers.cookie ?? '').split(';').flatMap(value => {
    const separator = value.indexOf('=');
    return separator < 0 ? [] : [[value.slice(0, separator).trim(), value.slice(separator + 1).trim()]];
  }));
}
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const first = Buffer.from(a);
  const second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}
function redirect(response, location) {
  response.writeHead(303, { Location: location, 'Cache-Control': 'no-store' });
  response.end();
}
function reply(response, status, body, type = 'text/plain; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': type });
  response.end(body);
}
const assetPaths = new Map([
  ['/', ['../dist/index.html', 'text/html; charset=utf-8']],
  ['/units/', ['../dist/units/index.html', 'text/html; charset=utf-8']],
  ['/campaign/', ['../dist/campaign/index.html', 'text/html; charset=utf-8']],
  ['/qualifications/', ['../dist/qualifications/index.html', 'text/html; charset=utf-8']],
  ['/unit-operations.js', ['./unit-operations.js', 'text/javascript; charset=utf-8']],
  ['/unit-operations.css', ['./unit-operations.css', 'text/css; charset=utf-8']],
  ['/campaign-workspace.js', ['./campaign-workspace.js', 'text/javascript; charset=utf-8']],
  ['/campaign-workspace.css', ['./campaign-workspace.css', 'text/css; charset=utf-8']],
  ['/campaign.js', ['../dist/campaign.js', 'text/javascript; charset=utf-8']],
  ['/site.css', ['../dist/site.css', 'text/css; charset=utf-8']],
  ['/site.js', ['../dist/site.js', 'text/javascript; charset=utf-8']],
  ['/dashboard.css', ['./dashboard.css', 'text/css; charset=utf-8']],
  ['/member.js', ['./member.js', 'text/javascript; charset=utf-8']],
  ['/assets/crest.png', ['../dist/assets/crest.png', 'image/png']],
  ['/assets/tag-field.jpg', ['../dist/assets/tag-field.jpg', 'image/jpeg']],
  ['/assets/tag-squad.jpg', ['../dist/assets/tag-squad.jpg', 'image/jpeg']],
]);
for (const key of Object.keys(honours)) {
  const url = ribbonUrl(key);
  if (url) assetPaths.set(url,['../dist'+url,'image/png']);
}
async function serve(response, path, contentType = 'text/html; charset=utf-8') {
  if (!assetFiles.has(path)) {
    assetFiles.set(path, readFile(new URL(path, import.meta.url)).catch(error => {
      assetFiles.delete(path);
      throw error;
    }));
  }
  return reply(response, 200, await assetFiles.get(path), contentType);
}
const retryWindows = new Map();
class DiscordCooldown extends Error {
  constructor(until) {
    super('Discord is temporarily rate limiting sign-in or membership checks.');
    this.seconds = Math.max(1, Math.ceil((until - Date.now()) / 1000));
  }
}
async function discordRequest(route, url, options) {
  const blockedUntil = Math.max(retryWindows.get(route) ?? 0, retryWindows.get('global') ?? 0);
  if (blockedUntil > Date.now()) throw new DiscordCooldown(blockedUntil);
  const response = await fetch(url, options);
  if (response.status === 429) {
    const body = await response.json().catch(() => null);
    const header = Number(response.headers.get('Retry-After'));
    const delay = Math.max(header || 0, Number(body?.retry_after) || 0) || 30;
    const until = Date.now() + Math.ceil(delay * 1000);
    const bucket = body?.global || response.headers.get('X-RateLimit-Global') === 'true' ? 'global' : route;
    retryWindows.set(bucket, Math.max(until, retryWindows.get(bucket) ?? 0));
    console.warn('Discord ' + route + ' rate limited. Backing off for ' + Math.ceil(delay) + ' seconds.');
    throw new DiscordCooldown(until);
  }
  const reset = Number(response.headers.get('X-RateLimit-Reset-After'));
  if (response.headers.get('X-RateLimit-Remaining') === '0' && Number.isFinite(reset) && reset > 0) {
    retryWindows.set(route, Date.now() + Math.ceil(reset * 1000));
  }
  return response;
}
async function discordMember(accessToken) {
  const response = await discordRequest('membership', discord + '/api/v10/users/@me/guilds/' + TAG_GUILD_ID + '/member', {
    headers: { Authorization: 'Bearer ' + accessToken }, signal: AbortSignal.timeout(8000),
  });
  if ([401, 403, 404].includes(response.status)) return null;
  if (!response.ok) throw new Error('Discord member lookup returned HTTP ' + response.status);
  const member = await response.json();
  return member.user?.id && Array.isArray(member.roles) && member.pending !== true ? member : null;
}
async function oauthCallback(request, response, url) {
  response.setHeader('Set-Cookie', cookie(stateCookie, '', 0));
  if (!equal(cookies(request)[stateCookie], url.searchParams.get('state')) || !url.searchParams.get('code')) {
    return reply(response, 400, 'Discord sign-in expired. Return to /members/ and try again.');
  }
  const tokenResponse = await discordRequest('token', discord + '/api/v10/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET,
      code: url.searchParams.get('code'), grant_type: 'authorization_code', redirect_uri: redirectUri }),
    signal: AbortSignal.timeout(8000),
  });
  if (!tokenResponse.ok) return reply(response, 400, 'Discord could not complete sign-in. Return to /members/ to retry.');
  const token = await tokenResponse.json();
  const member = await discordMember(token.access_token);
  if (!member) return reply(response, 403, 'Join TAG MILSIM and complete Discord screening before signing in.');
  const duration = Math.min(maxAge, Number(token.expires_in) || maxAge);
  const session = randomBytes(32).toString('hex');
  const old = cookies(request)[sessionCookie];
  if (old) sessions.delete(old);
  sessions.set(session, { token: token.access_token, memberId: member.user.id, logoutToken:randomBytes(32).toString('hex'), member, checkedAt:Date.now(), expires: Date.now() + duration * 1000 });
  response.setHeader('Set-Cookie', [cookie(stateCookie, '', 0), cookie(returnCookie, '', 0), cookie(sessionCookie, session, duration)]);
  return redirect(response,savedReturn(request));
}
const snapshots = new Map();
const readFailures = new Map();
const assetFiles = new Map();
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const records = value => Object.fromEntries(Object.entries(record(value)).filter(([,entry]) =>
  entry && typeof entry === 'object' && !Array.isArray(entry)));
const eventRecords = value => Object.fromEntries(Object.entries(records(value)).filter(([,entry]) =>
  typeof entry.start === 'number' && Number.isFinite(entry.start) && Math.abs(entry.start) <= 8.64e15));

async function botData(filename, prepare) {
  const path = resolve(TAG_DATA_DIR, filename);
  const cached = snapshots.get(filename);
  let version;
  try {
    const info = await stat(path);
    version = [info.ino,info.size,info.mtimeMs,info.ctimeMs].join(':');
    if (cached?.version === version) return { data:cached.data, unavailable:false };
    if (readFailures.get(filename) === version) return { data:cached?.data ?? prepare({}), unavailable:true };
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unexpected JSON record structure');
    const data = prepare(value);
    snapshots.set(filename, { version,data });
    readFailures.delete(filename);
    return { data, unavailable:false };
  } catch (error) {
    const failure = error instanceof SyntaxError || error.message === 'Unexpected JSON record structure'
      ? version : error.code ?? error.name;
    if (readFailures.get(filename) !== failure) {
      readFailures.set(filename, failure);
      console.warn('Dashboard record read failed for ' + filename + ': ' + (error.code || error.name));
    }
    return { data:cached?.data ?? prepare({}), unavailable:true };
  }
}

function prepareRoster(value) {
  const cleanEvents = events => Object.fromEntries(Object.entries(eventRecords(events)).map(([key,event]) => [
    key, { ...event, groups:Array.isArray(event.groups) ? event.groups : [], seats:records(event.seats),
      attendance:records(event.attendance), loa:records(event.loa) },
  ]));
  return migrateRoster({ ...value, standing:record(value.standing), qualifications:record(value.qualifications),
    events:cleanEvents(value.events), cancelledEvents:cleanEvents(value.cancelledEvents),
    memberDetails:records(value.memberDetails), courses:records(value.courses) });
}

async function verifiedMember(session, fresh) {
  if (session.expires <= Date.now()) return null;
  if (!fresh && Date.now() - session.checkedAt < 60_000) return session.member;
  if (session.check) return session.check;
  session.check = discordMember(session.token).then(member => {
    session.member = member;
    session.checkedAt = Date.now();
    return member;
  });
  try { return await session.check; } finally { session.check = null; }
}

function eventLink(channel, message) {
  return /^\d{17,20}$/.test(channel ?? '') && /^\d{17,20}$/.test(message ?? '')
    ? discord + '/channels/' + TAG_GUILD_ID + '/' + channel + '/' + message : null;
}
function accessFor(member) {
  if (COMMAND_ROLE_ID && member.roles.includes(COMMAND_ROLE_ID)) return 'Command';
  if (TRAINING_CADRE_ROLE_ID && member.roles.includes(TRAINING_CADRE_ROLE_ID)) return 'Training Cadre';
  return 'Member';
}
function unitNavigation(member) {
  let roles={};
  try { roles=campaignWorkspace.roleSettings(); } catch { /* Campaign storage can be temporarily unavailable. */ }
  const access=unitOperations.navigationAccess(member,{...roles,command:COMMAND_ROLE_ID,cadre:TRAINING_CADRE_ROLE_ID});
  const administrative=accessFor(member)!=='Member';
  return {...access,administrative,
    administration:administrative||access.honours,
    training:access.command||access.cadre||access.leader||access.reviews,
    operations:administrative||access.command||access.leader||access.gameMaster};
}
function staffLanding(response,path,access) {
  const unit = view => '/members/unit/?view='+view;
  const tools = (name,area='administration') => '/staff/'+area+'/tools/?tool='+name;
  const administration=[
    ...(access.command?[
      ['Manage members',tools('members'),'Update member names, ranks and roles.'],
      ['Roster structure',tools('roster'),'Manage units, elements and slots.'],
      ['Standing assignments',tools('assignments'),'Assign members to standing slots.'],
      ['Command inbox',unit('command'),'Manage policy, role settings, cases and delivery.'],
    ]:[]),
    ...(access.administrative?[
      ['Leave requests',tools('leave'),'Review and record member leave.'],
      ['Attendance review',tools('review'),'Review attendance rates and exemptions.'],
      ['Event history',tools('history'),'Browse completed and cancelled events.'],
    ]:[]),
    ...(access.honours?[['Review honours',unit('honours-review'),'Decide nominations and publish citations.']]:[]),
  ];
  const training=[
    ...(access.command||access.cadre?[
      ['Courses & assessment forms',unit('courses'),'Create course templates, upload materials and build assessment forms.'],
      ['Schedule training',unit('training'),'Create Basic Training, specialist or squad sessions and choose who to invite.'],
      ['Attendance & sign-off',unit('attendance'),'Record attendance and candidate results.'],
    ]:[]),
    ...(access.administrative?[['Schedule Sunday platoon training',tools('platoon','training'),'Choose a date, time and participating groups.']]:[]),
    ...(access.leader||access.cadre?[['Candidate records',unit('records'),'Review available assessments.']]:[]),
    ...(access.reviews?[['Review applications',unit('application-review'),'Decide applications for qualifications you oversee.']]:[]),
  ];
  const operations=[
    ...(access.leader||access.command?[
      ['Campaign','/members/campaign/?manage=1','Open the current campaign and its reports.'],
      ['Create an AAR','/members/aar/','Start a report or continue one of your private drafts.'],
      ['Orders & readiness',unit('orders'),'View orders and track readiness for upcoming events.'],
      ['Taskings',unit('taskings'),'View assigned tasks and follow-ups.'],
    ]:[]),
    ...(access.command||access.gameMaster?[['Game Master briefs',unit('gm'),'Open restricted operation briefs.']]:[]),
    ...(access.administrative?[
      ['Create an operation',tools('create','operations'),'Set up a Sunday operation.'],
      ['Manage events',tools('events','operations'),'Edit, cancel or archive scheduled events.'],
      ['Event attendance',tools('attendance','operations'),'Open a register and mark attendance.'],
    ]:[]),
    ...(access.command?[['Public campaign updates',tools('campaign','operations'),'Publish and edit public campaign entries.']]:[]),
  ];
  const pages={
    '/staff/':['Unit Dashboard',[
      ...(access.administration?[['Administration','/staff/administration/','Manpower, roster, leave and reports.']]:[]),
      ...(access.training?[['Training','/staff/training/','Courses, assessment forms and training sessions.']]:[]),
      ...(access.operations?[['Operations','/staff/operations/','Campaign, AARs, orders and events.']]:[]),
    ]],
    '/staff/administration/':['Administration',administration],
    '/staff/training/':['Training',training],
    '/staff/operations/':['Operations',operations],
  };
  const [title,cards]=pages[path];
  if (!cards.length) return reply(response,403,'This area is unavailable for your roles.');
  const links=cards.map(([label,url,description])=>'<a class="dashboard-tile" href="'+url+'"><strong>'+label+'</strong><span>'+description+'</span></a>').join('');
  const back=path==='/staff/'?'':'<a class="button outline small" href="/staff/">Unit Dashboard</a>';
  return reply(response,200,'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>'+
    title+' | TAG MILSIM</title><link rel="stylesheet" href="/site.css"><link rel="stylesheet" href="/dashboard.css?v=dashboard-nav">'+
    '<header class="top"><div class="wrap top-inner"><a class="brand" href="/"><span class="brand-mark" aria-hidden="true"></span><strong>TAG MILSIM</strong></a>'+
    '<div class="portal-header-actions">'+back+'<a class="button outline small" href="/members/">Members Dashboard</a></div></div></header>'+
    '<main class="wrap section"><h1>'+title+'</h1><nav class="dashboard-tiles" aria-label="'+title+'">'+links+'</nav></main></html>',
    'text/html; charset=utf-8');
}
async function dashboardAction(request, response, member) {
  if (request.headers.origin !== PUBLIC_ORIGIN) return reply(response, 403, 'Invalid request origin.');
  if (!TAG_WEB_BRIDGE_KEY) return reply(response, 503, 'The website is awaiting its connection to the TAG bot.');
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 8192) return reply(response, 413, 'Request too large.');
  }
  let input;
  try { input = JSON.parse(raw); } catch { return reply(response, 400, 'Invalid request.'); }
  if (!input || !['attendance','confirm-standing','leave','withdraw-leave','edit-leave','approve-leave','standing','event-standing','event-unassign','members','sunday','training','cancel-event','delete-event','archive-event','edit-event','member-admin','member-rank','member-role','roster-unit','roster-element','campaign-release','member-details'].includes(input.action)) return reply(response, 400, 'Invalid action.');
  const access = accessFor(member);
  if ((!['confirm-standing','leave','withdraw-leave','edit-leave','member-details'].includes(input.action) && access === 'Member') ||
      (['standing','event-standing','event-unassign','members','delete-event','archive-event','member-admin','member-rank','member-role','roster-unit','roster-element','campaign-release'].includes(input.action) && access !== 'Command') ||
      (['leave','withdraw-leave','edit-leave'].includes(input.action) && input.values?.member != null && input.values.member !== member.user.id && access === 'Member') ||
      (input.action === 'member-details' && input.values?.member != null && input.values.member !== member.user.id && access !== 'Command')) {
    return reply(response, 403, 'Staff access required.');
  }
  try {
    const result = await fetch(bridgeUrl, {
      method: 'POST', headers: { Authorization: 'Bearer ' + TAG_WEB_BRIDGE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: member.user.id, action: input.action, values: input.values }),
      signal: AbortSignal.timeout(20_000),
    });
    const { message } = await result.json();
    return Array.isArray(message) ? reply(response, result.status, JSON.stringify(message), 'application/json; charset=utf-8')
      : reply(response, result.status, message);
  } catch {
    return reply(response, 503, 'The TAG bot could not confirm the change. Refresh before retrying.');
  }
}
const ukDay = new Intl.DateTimeFormat('sv-SE', {timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'});
function leaveStatus(event, memberId, ranges) {
  const mark = event.attendance?.[memberId]?.status;
  if (mark) return mark;
  const date = ukDay.format(event.start);
  if ((event.loa?.[memberId]?.approved && !event.loa[memberId].withdrawnAt) || ranges.some(range => range.from <= date && date <= range.to && (!range.effectiveAt || event.start >= range.effectiveAt) && (!range.withdrawnAt || event.start < range.withdrawnAt))) return 'loa';
  return 'pending';
}
function registerPeople(event, kind, groups) {
  if (kind !== 'sunday') return Object.entries({ ...event.leaveBookings, ...event.bookings }).map(([id,role]) =>
    [id, role === 'cadre' ? 'Training Cadre' : 'Participants', '']);
  const seats = new Map();
  for (const [key,seat] of Object.entries(event.standingSeats ?? {})) if (seat?.memberId) seats.set(seat.memberId,key);
  for (const [key,seat] of Object.entries(event.seats ?? {})) if (seat.memberId) seats.set(seat.memberId,key);
  for (const [id,key] of Object.entries(event.leaveSeats ?? {})) if (typeof key === 'string') seats.set(id,key);
  for (const [id,response] of Object.entries(event.responses ?? {})) {
    if (!seats.has(id) && event.loa?.[id] && typeof response?.seat === 'string') seats.set(id,response.seat);
  }
  return [...seats].map(([id,key]) => {
    const [group,slot] = key.split(':');
    return [id, groups[group]?.label, rosterSlotCode(group,Number(slot),groups)];
  });
}

function standingOptions(event, standing, name, rangesFor, groups) {
  const assigned = new Set(Object.values(event.seats).map(seat => seat.memberId));
  return Object.entries(event.seats).flatMap(([slot,seat]) => {
    const id = standing[slot];
    if (!id || seat.status !== 'open' || seat.memberId || assigned.has(id) ||
        event.responses?.[id]?.status === 'declined' || leaveStatus(event,id,rangesFor(id)) === 'loa') return [];
    const [group,number] = slot.split(':');
    return [{slot, id, label:name(id) + ' · ' + rosterSlotCode(group,Number(number),groups)}];
  });
}

function memberNextAction({upcomingOperations,upcomingTraining,recruit,basicStage,canBookBasic,now}) {
  const first = (events, test) => events.filter(test).sort((a,b)=>a.start-b.start)[0];
  const card = (heading,detail,event,label,href) => ({
    heading,detail,event:event ? {title:event.title,start:event.start} : null,link:href ? {label,href} : null,
  });
  const pending = first(upcomingOperations,event=>event.status === 'Awaiting confirmation' &&
    (!event.confirmBy || event.confirmBy > now));
  if (pending) return {
    ...card('Confirm your place','You have a standing slot for this event.',pending,'Submit leave','#leave'),
    confirmationEvent:pending.key,
    deadline:pending.confirmBy,
  };
  const booked = first([...upcomingOperations,...upcomingTraining],event=>['Attending','Booked'].includes(event.status));
  if (booked) {
    if (booked.orders) return card('Read your orders','Your place is confirmed.',booked,'Read orders',booked.orders);
    return card(booked.status === 'Booked' ? 'Your training is booked' : 'Your place is confirmed',
      '',booked,'Open event in Discord',booked.url);
  }
  const waiting = first(upcomingTraining,event=>event.status === 'Waitlisted');
  if (waiting) return card('You’re on the waitlist','Check the session for updates.',waiting,'Open session in Discord',waiting.url);
  if (recruit) {
    if (!basicStage || !canBookBasic) return card('Check your training progression',
      'Contact Training Cadre if you need help with your next step.',null,'View service record','#record');
    const session = first(upcomingTraining,event=>event.stage === basicStage && event.status !== 'LOA' && event.url);
    if (session) return card('Book Basic Training '+basicStage.toUpperCase(),'Check availability and book through Discord.',
      session,'Open session in Discord',session.url);
    return card('Look out for Basic Training '+basicStage.toUpperCase(),'There’s no upcoming session to book at the moment.',
      null,'View events','#events');
  }
  const open = first(upcomingOperations,event=>event.status === 'View available seats' && event.canBrowse && event.url);
  if (open) return card('Check available operation slots','Discord shows the places you’re eligible to take.',
    open,'Open signup in Discord',open.url);
  return card('You’re all caught up','There’s nothing to confirm or book right now.',null,'View events','#events');
}

async function memberData(member, view) {
  const [roster, trainingResult, profileResult] = await Promise.all([
    botData('sunday-rosters.json', prepareRoster), botData('basic-training-sessions.json', eventRecords), botData('recruit-profiles.json', records),
  ]);
  const rosterData = roster.data;
  const groups = { ...rosterGroups, ...records(rosterData.rosterElements) };
  const units = {tag:{label:'TAG'},...records(rosterData.rosterUnits)};
  const training = trainingResult.data;
  const profiles = profileResult.data;
  const id = member.user.id;
  const roles = new Set(member.roles);
  const access = accessFor(member);
  const events = Object.values(rosterData.events);
  const results = Object.values(training).filter(item => item.results?.[id]).sort((a,b) => b.start-a.start);
  const stage = item => item.stage ?? /^Basic Training (T1|T2)$/i.exec(item.type ?? '')?.[1].toLowerCase();
  const t2 = results.find(item => stage(item) === 't2' && item.results[id].result === 'passed');
  const t1Passed = results.some(item => stage(item) === 't1' && item.results[id].result === 'passed');
  const probationStart = t2?.results[id].route === 'rangers' ? t2.results[id].recordedAt ?? 0 : 0;
  const mainOps = events.filter(event => event.type === 'operation' && event.start >= probationStart
    && event.attendance?.[id]?.status === 'attended').length;
  const progression = roles.has(FULL_MEMBER_ROLE_ID) ? 'Full Member'
    : roles.has(PROBATIONARY_ROLE_ID) ? 'Ranger probation · ' + Math.min(mainOps,3) + '/3 main operations'
    : t2?.results[id].route === 'pilot' ? 'Awaiting 160th SOAR handover'
    : t1Passed ? 'Ready to book T2'
    : roles.has(RECRUIT_ROLE_ID) ? 'Recruit · Ready to book T1' : 'TAG member';
  const now = Date.now();
  const names = rosterData.memberDetails ?? {};
  const discordNames = record(rosterData.discordMemberNames);
  const currentName = names[id]?.displayName || profiles[id]?.name || member.nick || member.user.global_name || member.user.username;
  const display = assigned => assigned ? rankedName(names[assigned]?.displayName ||
    (assigned === id ? currentName : profiles[assigned]?.name || discordNames[assigned] || 'Assigned'),
    names[assigned]?.rank) : 'Open';
  const lineup = event => (event.groups ?? []).filter(key => Object.hasOwn(groups,key)).map(key => ({
    label: groups[key].label,
    seats: groups[key].slots.flatMap((role,index) => {
      if (!Object.hasOwn(event.seats,key+':'+(index+1))) return [];
      const seat = event.seats?.[key+':'+(index+1)];
      const member = display(seat?.memberId);
      return [{ code: rosterSlotCode(key,index+1,groups), role, member: seat?.memberId
        ? member + (seat.status === 'confirmed' ? ' · Attending' : ' · Awaiting confirmation') : 'Open' }];
    }),
  }));
  const leaveRanges = rosterData.leaveRanges ?? {};
  const rangesFor = key => Array.isArray(leaveRanges[key]) ? leaveRanges[key].flatMap((entry,index) => entry ? [{...entry,index}] : []) : [];
  const today = ukDay.format(now);
  const leave = rangesFor(id).slice().reverse().map(({from,to,index,submittedAt,withdrawnAt,reason}) => ({
    from,to,index,submittedAt,reason,status:withdrawnAt ? 'Withdrawn' : 'Recorded',canWithdraw:!withdrawnAt && to >= today,
  }));
  const singleLeave = [
    ...Object.entries(rosterData.events).map(([key,event])=>[key,event,'sunday']),
    ...Object.entries(training).map(([key,event])=>[key,event,'training']),
  ].filter(([,event])=>!event.cancelledAt).flatMap(([key,event,kind]) => {
    const entries = { ...event.loa };
    for (const [memberId,mark] of Object.entries(event.attendance ?? {})) {
      if (mark?.status === 'loa' && (!entries[memberId] || entries[memberId].withdrawnAt)) {
        entries[memberId] = { approved:true,submittedAt:mark.markedAt };
      }
    }
    return Object.entries(records(entries)).map(([memberId,entry])=>({key,kind,memberId,title:event.title || event.type,start:event.start,...entry}));
  });
  for (const entry of singleLeave.filter(item=>item.memberId===id)) {
    leave.push({ event:entry.key,kind:entry.kind,title:entry.title,start:entry.start,submittedAt:entry.submittedAt,reason:entry.reason,
      status:entry.withdrawnAt ? 'Withdrawn' : entry.approved ? 'Approved' : 'Pending',
      canWithdraw:!entry.withdrawnAt && entry.start > now });
  }
  const name = memberId => {
    const label = memberId === id ? currentName : names[memberId]?.displayName || profiles[memberId]?.name || discordNames[memberId];
    return typeof label === 'string' && label ? rankedName(label,names[memberId]?.rank) : 'Member · ' + String(memberId).slice(-6);
  };
  const releases = Object.entries(records(rosterData.publicCampaign)).sort(([,a],[,b])=>b.publishedAt-a.publishedAt);
  const staff = access === 'Member' || view !== 'staff' ? null : {
    campaignReleases:access==='Command' ? releases.map(([key,entry])=>({key,...entry})) : [],
    managedEvents: [
      ...Object.entries(rosterData.events).map(([key,event]) => [key,event,'sunday']),
      ...Object.entries(rosterData.cancelledEvents ?? {}).map(([key,event]) => [key,event,'sunday']),
      ...Object.entries(training).map(([key,event]) => [key,event,'training']),
    ].filter(([,event]) => event.start > now || event.cancelledAt || access === 'Command')
      .sort(([,a],[,b]) => b.start-a.start).map(([key,event,kind]) => {
        const cancelled = Boolean(event.cancelledAt);
        const archived = Boolean(event.archivedAt);
        const autoWednesday = kind === 'training' && key === String(event.start * 10 + (event.stage === 't1' ? 1 : 2));
        const hasRecords = Object.keys(event.attendance ?? {}).length || Object.keys(event.results ?? {}).length || Object.keys(event.loa ?? {}).length;
        const hasBookings = kind === 'sunday' ? Object.values(event.seats ?? {}).some(seat => seat.status === 'confirmed')
          : Object.keys(event.bookings ?? {}).length;
        return { key, kind, title:event.title || event.type, start:event.start, cancelled, archived,
          groups:event.groups ?? [], recruitSlots:event.recruitSlots, cadreSlots:event.cadreSlots,
          canEdit:!cancelled && !archived && event.start>now,
          canArchive:access === 'Command' && !archived && !cancelled && event.start <= now,
          canCancel:!cancelled && event.start > now,
          canDelete:access === 'Command' && !autoWednesday && !hasRecords && (cancelled || !hasBookings) };
      }).filter(event => event.canCancel || event.canDelete || event.canArchive || event.cancelled),

    leaveRequests: [...Object.keys(leaveRanges).flatMap(memberId => rangesFor(memberId).map(entry => ({
      memberId, name:name(memberId), from:entry.from, to:entry.to, reason:entry.reason, approved:true,
      index:entry.index, withdrawn:Boolean(entry.withdrawnAt), canWithdraw:!entry.withdrawnAt && entry.to >= today,
      start:entry.submittedAt,
    }))), ...singleLeave.map(entry => ({
      key:entry.key,kind:entry.kind,memberId:entry.memberId,name:name(entry.memberId),title:entry.title,start:entry.start,
      reason:entry.reason, returnDate:entry.returnDate, approved:Boolean(entry.approved), submittedAt:entry.submittedAt,
      withdrawn:Boolean(entry.withdrawnAt), canWithdraw:!entry.withdrawnAt && entry.start > now,
    }))].sort((a,b)=>b.start-a.start).slice(0,100),
    courses: Object.entries(rosterData.courses).map(([key, course]) => ({ key, name: course.name })),
    groups: Object.entries(groups).map(([key, group]) => ({ key, label:group.label, archived:Boolean(group.archived) })),
    elements: access === 'Command' ? Object.entries(groups).map(([key,element])=>({
      ...element,key,unit:element.unit ?? 'tag',codes:element.slots.map((_,i)=>rosterSlotCode(key,i+1,groups)),
    })) : [],
    units: access === 'Command' ? Object.entries(units).map(([key,unit])=>({key,...unit})) : [],

    people: access === 'Command' ? [...new Set([...Object.keys(profiles),...Object.keys(names),...Object.keys(discordNames)])].filter(key => /^\d{17,20}$/.test(key) && !rosterData.participation?.[key]?.removedAt)
      .map(key => ({ key, name:baseDisplayName(name(key),names[key]?.rank) })).sort((a,b) => a.name.localeCompare(b.name)) : [],
    registers: [...Object.entries(rosterData.events).map(([key, event]) => [key,event,'sunday']),
      ...Object.entries(training).map(([key, event]) => [key,event,(event.qualificationRoleId || event.unitQualification) ? 'specialist' : 'basic'])]
      .filter(([, event]) => !event.cancelledAt && (event.postId || event.messageId || Object.keys(event.attendance ?? {}).length))
      .sort(([,a],[,b]) => (a.start > now && b.start > now) ? a.start-b.start : b.start-a.start)
      .slice(0,100).map(([key,event,kind]) => ({
        key, kind, title:event.title || event.type, start:event.start, started:event.start <= now, archived:Boolean(event.archivedAt),
        assignments:access === 'Command' && kind === 'sunday' && event.start > now
          ? Object.entries(event.seats).filter(([,seat])=>seat.memberId).map(([slot,seat])=>({slot,id:seat.memberId,label:name(seat.memberId)})) : [],
        standingOptions: access === 'Command' && kind === 'sunday' && event.start > now
          ? standingOptions(event,rosterData.standing,name,rangesFor,groups) : [],
        people:registerPeople(event,kind,groups).map(([memberId,group,code]) => ({
          id:memberId, name:name(memberId), group, code, exempt:names[memberId]?.attendanceExempt === true, status:leaveStatus(event,memberId,rangesFor(memberId)),
        })),
      })),
  };
  const directory = records(rosterData.unitDirectory);
  const awardView=websiteAwardView(rosterData.courses,{...rosterData.cancelledEvents,...rosterData.events});
  const decorations = key => {
    const probation = rosterData.probationAwards?.[key];
    const joined = key === id ? Date.parse(member.joined_at) : rosterData.participation?.[key]?.joined;
    const after = probation?.complete && probation.at >= (joined || 0) ? probation.at : 0;
    return awardView.decorations?.(key,after);
  };
  const toCard = (key,entry) => ({
    decorations:decorations(key)?.items,
    status:entry.status,medals:entry.medals,streak:entry.streak,qualifications:[...new Set([...(entry.qualifications??[]).filter(name=>!Object.values(rosterData.courses)
      .some(course=>course.name===name&&awardView.revokedRoles(key).includes(course.roleId))),...awardView.names(key)])], name:rankedName(names[key]?.displayName || entry.name,names[key]?.rank ?? entry.rank), rank:canonicalRank(names[key]?.rank ?? entry.rank),
    billet:Object.entries(rosterData.standing).filter(([,memberId])=>memberId===key).map(([slot])=>{
      const [group,number]=slot.split(':');
      const element=groups[group];
      return element && !element.archived ? element.label+' · '+element.slots[Number(number)-1] : null;
    }).filter(Boolean).join(' / '),
  });
  const rosterView=()=>({
    rosterUnits:Object.entries(units).filter(([,unit])=>!unit.archived).map(([key,unit])=>({key,label:unit.label})),
    roster: Object.entries(groups).filter(([,group])=>!group.archived).map(([key, group]) => ({
      key, label:group.label, parent:group.parent, unit:group.unit ?? 'tag', unitLabel:units[group.unit ?? 'tag']?.label ?? 'TAG',
      seats: group.slots.flatMap((role, index) => {
        if (group.removed?.includes(index+1)) return [];
        const assigned = rosterData.standing[key + ':' + (index + 1)];
        const name = display(assigned);
        return [{ code: rosterSlotCode(key,index+1,groups), role, member: name, rank: assigned ? names[assigned]?.rank : null, occupied: Boolean(assigned),
          ...(access === 'Command' && view === 'staff' ? { key: key + ':' + (index + 1), assigned: assigned ?? '' } : {}) }];
      }),
    })),
  });
  if (view==='directory') return { ...rosterView(), unitDashboard:Object.values(unitNavigation(member)).some(Boolean), displayName:rankedName(currentName,names[id]?.rank),access,recordsDelayed:roster.unavailable,
    directory:Object.entries(directory).filter(([key])=>!rosterData.participation?.[key]?.removedAt)
      .map(([key,entry])=>toCard(key,entry)).sort((a,b)=>a.name.localeCompare(b.name)),
  };
  const upcomingOperations = Object.entries(rosterData.events).filter(([,event]) =>
    event.postId && !event.cancelledAt && !event.archivedAt && event.start > now).map(([key,event]) => {
    const assignment = Object.values(event.seats ?? {}).find(seat => seat.memberId === id);
    const onLeave = leaveStatus(event,id,rangesFor(id)) === 'loa';
    return {
      key, title:event.title, start:event.start,
      status:onLeave ? 'LOA' : assignment ? (assignment.status === 'confirmed' ? 'Attending' : 'Awaiting confirmation') : 'View available seats',
      url:eventLink(event.postChannelId ?? UPCOMING_OPS_CHANNEL_ID,event.postId), lineup:lineup(event),
      confirmBy:assignment?.confirmBy ?? event.confirmBy,
      canBrowse:event.responses?.[id]?.status !== 'declined' && !assignment &&
        Object.values(event.seats ?? {}).some(seat => !seat.memberId && seat.status === 'open'),
      orders:awardView.hasPublishedOrders?.('sunday:'+key) ? '/members/unit/?view=orders&event='+encodeURIComponent('sunday:'+key) : null,
    };
  });
  const upcomingTraining = Object.values(training).filter(item =>
    item.messageId && !item.cancelledAt && !item.archivedAt && !item.cardRemoved && item.start > now).map(item => ({
      title:item.type, start:item.start, stage:item.trainingTrack || item.qualificationRoleId || item.unitQualification ? null : stage(item),
      status:leaveStatus(item,id,rangesFor(id)) === 'loa' ? 'LOA' : item.bookings?.[id] ? 'Booked' : item.waitlist?.[id] ? 'Waitlisted' : 'View session',
      url:eventLink(item.channelId ?? ((item.qualificationRoleId || item.unitQualification) ? SPECIALIST_CHANNEL_ID : TRAINING_CHANNEL_ID),item.messageId),
    }));
  const profile = profiles[id];
  const nextAction = !roster.unavailable && !trainingResult.unavailable && !profileResult.unavailable
    ? memberNextAction({upcomingOperations,upcomingTraining,now,
      recruit:roles.has(RECRUIT_ROLE_ID) && !roles.has(FULL_MEMBER_ROLE_ID) && !roles.has(PROBATIONARY_ROLE_ID),
      basicStage:t2 ? null : t1Passed ? 't2' : 't1',
      canBookBasic:!profile || (profile.age !== 'no' && profile.mic !== 'no' && profile.sunday !== 'no' && profile.wednesday !== 'no'),
    }) : null;
  return {
    displayName:rankedName(currentName,names[id]?.rank), editName:baseDisplayName(currentName,names[id]?.rank), medals:directory[id]?.medals ?? 0, streak:directory[id]?.streak ?? 0,
    recordsDelayed: roster.unavailable || trainingResult.unavailable || profileResult.unavailable,
    progression, mainOps, access, leave, staff, nextAction, decorations:decorations(id),
    unitDashboard:Object.values(unitNavigation(member)).some(Boolean),
    myCard:toCard(id,{name:currentName,status:progression}),
    mySchedule:[...upcomingOperations,...upcomingTraining].filter(event=>['Attending','Awaiting confirmation','Booked','Waitlisted'].includes(event.status))
      .sort((a,b)=>a.start-b.start).slice(0,30).map(({title,start,status,url,orders})=>({title,start,status,url,orders})),
    qualifications: [...new Set([...Object.values(rosterData.courses).filter(course => roles.has(course.roleId)&&!awardView.revokedRoles(id).includes(course.roleId)).map(course => course.name),
      ...awardView.names(id)])],
    training: results.filter(item=>!item.results[id].unitAssessment).slice(0,12).map(item => ({
      title: item.type,
      result: { passed:'Passed', repeat:'Needs another session', absent:'Didn’t attend' }[item.results[id].result] ?? 'Recorded',
    })),
    attendance: events.filter(event => event.attendance?.[id]).sort((a,b)=>b.start-a.start).slice(0,12).map(event => ({
      title: event.title, status: { attended:'Attended', absent:'Failed to attend', loa:'LOA' }[event.attendance[id].status] ?? 'Recorded',
    })),
    events: [...upcomingOperations,...upcomingTraining].sort((a,b)=>a.start-b.start).slice(0,30)
      .map(({title,start,status,url,lineup,orders})=>({title,start,status,url,lineup,orders})),
    ...rosterView(),
  };
}

const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  try {
    const url = new URL(request.url, PUBLIC_ORIGIN);
    const path = url.pathname;
    if (path === '/auth/logout' && request.method === 'POST') {
      response.setHeader('Cache-Control', 'no-store');
      const key = cookies(request)[sessionCookie];
      const session = sessions.get(key);
      if (session) {
        let body = '';
        for await (const chunk of request) {
          body += chunk;
          if (body.length > 1024) return reply(response, 413, 'Sign-out request too large.');
        }
        if (!equal(session.logoutToken, new URLSearchParams(body).get('logoutToken'))) {
          return reply(response, 403, 'Sign-out request expired. Return to /members/ and try again.');
        }
        sessions.delete(key);
      }
      response.setHeader('Set-Cookie', cookie(sessionCookie, '', 0));
      return redirect(response, '/members/');
    }
    if (request.method !== 'GET' && !(request.method === 'POST' && ['/api/member/action','/api/campaign-workspace','/api/unit-operations'].includes(path))) return reply(response, 405, 'Method not allowed');
    if (path === '/auth/discord') {
      const state = randomBytes(32).toString('hex');
      response.setHeader('Set-Cookie', [cookie(stateCookie,state,600),cookie(returnCookie,encodeURIComponent(returnPath(url.searchParams.get('next'))),600)]);
      const query = new URLSearchParams({
        client_id: DISCORD_CLIENT_ID, redirect_uri: redirectUri, response_type: 'code',
        scope: 'identify guilds.members.read', state,
      });
      return redirect(response, discord + '/oauth2/authorize?' + query);
    }
    if (path === '/auth/discord/callback') {
      response.setHeader('Cache-Control','no-store');
      return await oauthCallback(request, response, url);
    }
    if (path === '/discord' || path === '/discord/' || path === '/join-discord') {
      const invite = process.env.TAG_DISCORD_INVITE_URL ?? '';
      const target = /^https:\/\/(?:discord\.gg\/|discord\.com\/invite\/)[a-z0-9-]+$/i.test(invite)
        ? invite : 'https://discord.gg/GxMSnCMVy2';
      return redirect(response,target);
    }
    if (path === '/api/public-campaign') {
      const {data:roster}=await botData('sunday-rosters.json',prepareRoster);
      const entries=Object.values(records(roster.publicCampaign))
        .map(({title,date,summary,intel,publishedAt})=>({title,date,summary,intel,publishedAt}));
      let campaignEntries = [];
      try { campaignEntries = campaignWorkspace.publicEntries(); }
      catch (error) { console.warn('Campaign public updates unavailable:',error.name); }
      const feed = [...campaignEntries,...entries].sort((a,b)=>(b.publishedAt ?? 0)-(a.publishedAt ?? 0))
        .map(({publishedAt,...entry})=>entry);
      response.setHeader('Cache-Control','public,max-age=60');
      return reply(response,200,JSON.stringify(feed),'application/json; charset=utf-8');
    }
    const publicImage = /^\/campaign-images\/([a-f0-9-]{36})$/.exec(path);
    if (publicImage) return campaignWorkspace.serveImage(response,publicImage[1],true);
    if (path === '/campaign/' && mediaStore) {
      response.setHeader('Content-Security-Policy', response.getHeader('Content-Security-Policy')+"; img-src 'self' "+mediaStore.origin);
    }
    if (['/members/campaign','/members/aar','/members/unit'].includes(path)) return redirect(response,path+'/'+url.search);
    const unitFile=/^\/members\/unit-file\/[0-9a-f-]+$/.test(path);
    if (path==='/members/unit/' || path==='/api/unit-operations' || unitFile) {
      response.setHeader('Cache-Control','private, no-store');
      const session=sessions.get(cookies(request)[sessionCookie]);
      const member=session?.expires>Date.now()?await verifiedMember(session,false):null;
      if (!member || member.user.id!==session.memberId) return path==='/members/unit/'?featureSignin(response,url)
        : reply(response,401,'Sign in with Discord to open TAG Unit Operations.');
      const {data:roster}=await botData('sunday-rosters.json',prepareRoster);
      const removed=roster.participation?.[member.user.id]?.removedAt;
      if (removed && !(Date.parse(member.joined_at)>removed)) return reply(response,403,'TAG membership required.');
      if (path==='/members/unit/') return await serve(response,'./unit-operations.html');
      return await unitOperations.handle(request,response,url,member);
    }
    const privateImage = /^\/members\/campaign-image\/([a-f0-9-]{36})$/.exec(path);
    if (['/members/campaign/','/members/aar/','/api/campaign-workspace'].includes(path) || privateImage) {
      response.setHeader('Cache-Control','private, no-store');
      const session = sessions.get(cookies(request)[sessionCookie]);
      if (!session || session.expires <= Date.now()) {
        if (path === '/members/campaign/' || path === '/members/aar/') return featureSignin(response,url);
        return reply(response,401,'Sign in with Discord to open the campaign workspace.');
      }
      const member = await verifiedMember(session,false);
      if (!member || member.user.id !== session.memberId) return reply(response,401,'Sign in with Discord to open the campaign workspace.');
      const {data:roster,unavailable} = await botData('sunday-rosters.json',prepareRoster);
      const removed = roster.participation?.[member.user.id]?.removedAt;
      if (removed && !(Date.parse(member.joined_at) > removed)) return reply(response,403,'TAG membership required.');
      if (privateImage) return campaignWorkspace.serveImage(response,privateImage[1],false);
      if (path === '/members/campaign/' || path === '/members/aar/') {
        if (path === '/members/aar/' || url.searchParams.get('manage')==='1') {
          const access=unitNavigation(member);
          if (!access.command && !access.leader) return reply(response,403,'A configured Team Leader, Squad Leader or Command role is required.');
        }
        response.setHeader('Content-Security-Policy', response.getHeader('Content-Security-Policy')+
          "; img-src 'self' blob:"+(mediaStore ? ' '+mediaStore.origin : ''));
        return await serve(response,'./campaign-workspace.html');
      }
      if (request.method === 'POST' && unavailable) return reply(response,503,'TAG membership records are temporarily unavailable.');
      const events = Object.entries(roster.events).filter(([,event])=>!event.cancelledAt)
        .sort(([,a],[,b])=>b.start-a.start).slice(0,100)
        .map(([key,event])=>({key,title:event.title || (event.type === 'operation' ? 'Main Operation' : 'Sunday Event'),start:event.start}));
      return await campaignWorkspace.handle(request,response,url,member,accessFor(member) === 'Command',events);
    }
    const sections = {'/units':'/units/','/campaign':'/campaign/','/qualifications':'/qualifications/','/members':'/members/','/staff':'/staff/','/members/directory':'/members/directory/'};
    if (Object.hasOwn(sections,path)) return redirect(response,sections[path]);
    if (staffPages.some(page=>page===path+'/')) return redirect(response,path+'/'+url.search);
    if (staffPages.includes(path)) {
      response.setHeader('Cache-Control','private, no-store');
      const session=sessions.get(cookies(request)[sessionCookie]);
      const member=session?.expires>Date.now()?await verifiedMember(session,false):null;
      if (!member || member.user.id!==session.memberId) return featureSignin(response,url);
      const {data:roster}=await botData('sunday-rosters.json',prepareRoster);
      const removed=roster.participation?.[member.user.id]?.removedAt;
      if (removed && !(Date.parse(member.joined_at)>removed)) return reply(response,403,'TAG membership required.');
      const access=unitNavigation(member);
      if (!Object.hasOwn(staffTools,path)) return staffLanding(response,path,access);
      if (!access.administrative) return reply(response,403,'Staff access required.');
      const tool=url.searchParams.get('tool')||'attendance';
      if (!staffTools[path].includes(tool)) return reply(response,404,'Management tool not found.');
      if (['members','roster','assignments','campaign'].includes(tool) && !access.command) {
        return reply(response,403,'Command access required.');
      }
      const html=await readFile(new URL('./staff.html',import.meta.url),'utf8');
      return reply(response,200,html.replace('__TAG_LOGOUT_TOKEN__',session.logoutToken),'text/html; charset=utf-8');
    }
    const pages = {'/members/':'dashboard.html','/members/directory/':'directory.html'};
    if (Object.hasOwn(pages,path) || path === '/api/member' || path === '/api/member/action') {
      response.setHeader('Cache-Control','private, no-store');
      const key = cookies(request)[sessionCookie];
      const session = sessions.get(key);
      if (Object.hasOwn(pages,path)) {
        if (!session || session.expires <= Date.now()) return await serve(response, './signin.html');
        const html = await readFile(new URL('./'+pages[path],import.meta.url), 'utf8');
        return reply(response, 200, html.replace('__TAG_LOGOUT_TOKEN__', session.logoutToken), 'text/html; charset=utf-8');
      }
      let member = null;
      if (session?.expires > Date.now()) {
        // The bot fetches the actor's current guild membership before handling every action.
        member = path === '/api/member/action' ? session.member : await verifiedMember(session, url.searchParams.get('refresh') === '1');
      }
      if (!member || member.user.id !== session?.memberId) {
        if (key) sessions.delete(key);
        return reply(response, 401, 'Sign-in required');
      }
      if (path === '/api/member/action') return request.method === 'POST'
        ? await dashboardAction(request, response, member) : reply(response, 405, 'Method not allowed');
      const {data:roster}=await botData('sunday-rosters.json',prepareRoster);
      const removed=roster.participation?.[member.user.id]?.removedAt;
      if (removed && !(Date.parse(member.joined_at) > removed)) {
        sessions.delete(key);
        return reply(response,401,'TAG membership required.');
      }
      const view=url.searchParams.get('view');
      if (view==='staff' && accessFor(member)==='Member') return reply(response,403,'Staff access required.');
      return reply(response, 200, JSON.stringify(await memberData(member,view)), 'application/json; charset=utf-8');
    }
    const asset = assetPaths.get(path);
    return asset ? await serve(response, ...asset) : reply(response, 404, 'Page not found');
  } catch (error) {
    const path = request.url?.split('?')[0];
    if (error instanceof DiscordCooldown && !response.headersSent) {
      response.setHeader('Retry-After', String(error.seconds));
      response.setHeader('Cache-Control', 'no-store');
      if (path === '/auth/discord/callback') {
        return reply(response, 503, 'Discord is rate limiting sign-in. Wait ' + error.seconds + ' seconds, then start again from https://tagmilsim.co.uk/members/.');
      }
      return reply(response, 503, 'Discord is rate limiting membership checks. Try again in ' + error.seconds + ' seconds.');
    }
    console.error('Dashboard request failed on ' + (path === '/auth/discord/callback' ? 'Discord callback' :
      path?.startsWith('/api/member') ? 'member API' : 'website') + ': ' + error.name + ' ' + error.message);
    if (!response.headersSent) return reply(response, 503, 'TAG is temporarily unavailable. Please try again shortly.');
    response.end();
  }
});
setInterval(() => {
  for (const [key, value] of sessions) if (value.expires <= Date.now()) sessions.delete(key);
}, 600_000).unref();
server.listen(Number(PORT), '127.0.0.1', () => console.log('TAG portal listening on loopback port ' + PORT));

setInterval(() => void campaignWorkspace.deliver(), 5000).unref();
if (mediaStore) {
  setInterval(() => void campaignWorkspace.deliverImages().catch(error =>
    console.warn('Campaign media queue unavailable:',error.name)), 5000).unref();
}

setInterval(() => void unitOperations.deliver().catch(error=>console.error('Unit operations delivery failed:',error.name)),5000).unref();

function websiteAwardView(registry,events) {
  let campaigns=[];
  try { campaigns=campaignWorkspace.awardWindows(); } catch { /* Campaigns can be temporarily unavailable. */ }
  try { return unitOperations.memberAwardsView(registry,campaigns,events); }
  catch { return {revokedRoles:()=>[],names:()=>[]}; }
}
async function trainingChannels(actor) {
  const result=await fetch(bridgeUrl,{
    method:'POST',headers:{Authorization:'Bearer '+TAG_WEB_BRIDGE_KEY,'Content-Type':'application/json'},
    body:JSON.stringify({actor,action:'training-channels',values:{}}),signal:AbortSignal.timeout(5000),
  });
  const {message}=await result.json();
  if (!result.ok || !Array.isArray(message)) throw new WorkflowError('Training channels unavailable.',503);
  return message;
}
async function deliverUnitJob(id) {
  if (!TAG_WEB_BRIDGE_KEY) throw new WorkflowError('The TAG bot bridge is not configured.',503);
  const result=await fetch(bridgeUrl,{
    method:'POST',headers:{Authorization:'Bearer '+TAG_WEB_BRIDGE_KEY,'Content-Type':'application/json'},
    body:JSON.stringify({action:'unit-job',values:{id}}),signal:AbortSignal.timeout(22_000),
  });
  const sample=await result.json();
  if (!result.ok) throw new WorkflowError(typeof sample.message==='string'?sample.message:'The TAG bot could not complete this delivery.',result.status);
}
async function unitContext(member) {
  const [roster,training]=await Promise.all([botData('sunday-rosters.json',prepareRoster),botData('basic-training-sessions.json',eventRecords)]);
  const source=roster.data;
  const directory=record(source.unitDirectory);
  const syncedRoles=record(source.discordMemberRoles);
  const sourceRoles={...record(source.unitRoleIds),full:FULL_MEMBER_ROLE_ID||source.unitRoleIds?.full,
    probation:PROBATIONARY_ROLE_ID||source.unitRoleIds?.probation,recruit:RECRUIT_ROLE_ID||source.unitRoleIds?.recruit};
  const names=record(source.discordMemberNames);
  const membership=record(source.participation);
  const details=record(source.memberDetails);
  const awards=record(source.probationAwards);
  const campaign=campaignWorkspace.unitContext(member);
  const groups={...rosterGroups,...source.rosterElements};
  const enabledGroups=Object.entries(groups).filter(([,group])=>!group.archived);
  const mId=member?.user.id;
  const personStatus=member?.roles.includes(process.env.RESERVE_ROLE_ID||source.unitRoleIds?.reserve)?'Reserve':
    member?.roles.includes(FULL_MEMBER_ROLE_ID)?'Full Member':member?.roles.includes(PROBATIONARY_ROLE_ID)?'Probationary':
      member?.roles.includes(RECRUIT_ROLE_ID)?'Recruit':null;
  const members={};
  for (const id of new Set([...Object.keys(directory),...Object.keys(names),...(mId?[mId]:[])])) {
    const part=membership[id]??{};
    const joined=id===mId?(Date.parse(member.joined_at)||part.joined):part.joined;
    if (part.removedAt && !(joined>part.removedAt)) continue;
    if (!/^\d{17,20}$/.test(id)) continue;
    const award=awards[id];
    const roleIds=id===mId?member.roles:syncedRoles[id]??directory[id]?.roleIds??[];
    const recordedStatus=roleIds.includes(sourceRoles.recruit)?'Recruit':roleIds.includes(sourceRoles.reserve)?'Reserve':
      roleIds.includes(sourceRoles.probation)?'Probationary':roleIds.includes(sourceRoles.full)?'Full Member':null;
    members[id]={id,name:rankedName(details[id]?.displayName??directory[id]?.name??names[id]??
      (id===mId?member.nick||member.user.global_name||member.user.username:'TAG Member'),details[id]?.rank),
      status:recordedStatus??(id===mId?personStatus:null)??directory[id]?.status??part.role??'Member',
      roleIds,
      joined:joined??0,activeSince:part.activeSince||0,probationAt:award?.complete?award.at:0,
      exempt:details[id]?.attendanceExempt===true,required:details[id]?.attendanceRequired!==false};
  }
  const units={tag:'TAG',devgru:'DEVGRU',rrc:'RRC',soar:'160th SOAR'};
  for (const [key,unit] of Object.entries(source.rosterUnits??{})) {
    if (!unit.archived) units[key]=unit.label;
  }
  const groupUnit=(key,entry)=>{
    if (key==='soar') return 'soar';
    if (entry?.unit && entry.unit!=='tag') return entry.unit;
    const label=key+' '+entry?.label;
    return /dev\s*gru/i.test(label)?'devgru':/\brrc\b/i.test(label)?'rrc':/\bsoar\b/i.test(label)?'soar':'tag';
  };
  const assignments=Object.entries(source.standing).flatMap(([slot,id])=>{
    const [group,num]=slot.split(':');
    const entry=groups[group];
    const title=entry?.slots?.[Number(num)-1];
    if (!title || entry.archived || entry.removed?.includes(Number(num)) || !members[id]) return [];
    return [{group,id,title,unit:groupUnit(group,entry)}];
  });
  const unitLeaders={};
  const leaderSlot=title=>/\b(?:team lead(?:er)?|squad lead(?:er)?|pilot lead|lead pilot|detachment lead(?:er)?|unit commander|platoon commander|platoon sergeant)\b/i.test(title);
  for (const [key] of Object.entries(units)) {
    const rosterLeads=assignments.filter(row=>row.unit===key&&leaderSlot(row.title));
    unitLeaders[key]=[...new Set(rosterLeads.map(row=>row.id))];
  }
  const events={};
  const qualificationEntries=Object.entries(record(source.courses));
  for (const [kind,items] of [['sunday',{...source.cancelledEvents,...source.events}],['training',training.data]]) {
    for (const [id,event] of Object.entries(items)) {
      if (!/^[a-zA-Z0-9-]{1,63}$/.test(id) || event.repeatSkipped) continue;
      const sunday=kind==='sunday';
      const key=kind+':'+id;
      const basicStage=!sunday && (event.stage==='t1'||event.stage==='t2'?event.stage:/^Basic Training (T1|T2)$/i.exec(event.type??'')?.[1].toLowerCase())||null;
      const qualification=sunday?null:basicStage??event.unitQualification??qualificationEntries.find(([,course])=>course.roleId && course.roleId===event.qualificationRoleId)?.[0]??null;
      const chosen=(event.groups??[]).flatMap(key=>groups[key]?[{key,label:groups[key].label}]:[]);
      const memberships={};
      const leaderMembers={};
      const add=(index,person,group)=>{
        if (person && group && !(index[person]??=[]).includes(group)) index[person].push(group);
      };
      const lineup=Object.entries(event.seats??{}).map(([slot,seat])=>{
        const [group,index]=slot.split(':');
        if (seat?.status==='confirmed') {
          add(memberships,seat.memberId,group);
          if (leaderSlot(groups[group]?.slots?.[Number(index)-1]??'')) add(leaderMembers,seat.memberId,group);
        }
        return {member:seat.memberId,name:members[seat.memberId]?.name??(seat.memberId?'TAG Member':'Open'),
          group:groups[group]?.label??group,slot:rosterSlotCode(group,Number(index),groups)||slot,status:seat.status};
      });
      for (const entry of assignments) {
        if (!chosen.some(group=>group.key===entry.group)) continue;
        add(memberships,entry.id,entry.group);
        if (leaderSlot(entry.title)) add(leaderMembers,entry.id,entry.group);
      }
      for (const [id,slot] of Object.entries(event.leaveSeats??{})) {
        if (lineup.some(item=>item.member===id)) continue;
        const [key,index]=String(slot).split(':');
        lineup.push({member:id,name:members[id]?.name??'TAG Member',group:groups[key]?.label??key,
          slot:rosterSlotCode(key,Number(index),groups)||slot,status:'LOA'});
      }
      const recruits=Object.entries(event.bookings??{}).filter(([,type])=>type==='recruit').map(([person])=>person);
      const priorityCount=recruits.filter(person=>event.prioritySeats?.[person]).length;
      events[key]={
        id,key,kind:sunday?(event.type==='operation'?'operation':'training'):'course',title:event.title||event.type||'Untitled event',
        start:event.start,cancelled:!!event.cancelledAt,groups:chosen,lineup,memberships,leaderMembers,
        confirmed:[...new Set(Object.values(event.seats??{}).filter(item=>item?.status==='confirmed'&&item.memberId).map(item=>item.memberId))],
        leads:Object.entries(leaderMembers).map(([id,groups])=>({id,groups,name:members[id]?.name??'TAG leader'})),
        people:registerPeople(event,sunday?'sunday':'training',groups).map(([person])=>person),candidates:recruits,
        basicStage,qualification,repeat:event.repeat,repeatStopped:!!event.repeatStopped,priorityLimit:event.priorityLimit,results:record(event.results),
        marks:Object.fromEntries(Object.entries(record(event.attendance)).map(([person,mark])=>[person,mark?.status])),
        onLeave(person) {
          if (!person) return false;
          const unmarked={...event,attendance:{}};
          return event.attendance?.[person]?.status==='loa' ||
            leaveStatus(unmarked,person,Array.isArray(source.leaveRanges?.[person])?source.leaveRanges[person]:[])==='loa';
        },
        priorityCount,standardFull:recruits.length-priorityCount>=(event.recruitSlots??Infinity),
      };
    }
  }
  const vacancies=enabledGroups.flatMap(([key,group])=>group.slots.flatMap((slot,index)=>
    group.removed?.includes(index+1)||source.standing[key+':'+(index+1)]?[]:[{group:group.label,slot}]));
  return {
    available:!roster.unavailable,directoryFresh:Number(source.directoryUpdatedAt)>Date.now()-2*3600_000,guild:TAG_GUILD_ID,
    roles:{command:COMMAND_ROLE_ID,cadre:TRAINING_CADRE_ROLE_ID,team:campaign.roles.team,squad:campaign.roles.squad},
    qualifications:Object.fromEntries(qualificationEntries.map(([key,{name,roleId}])=>[key,{name,discordRole:roleId}])),
    events,members,squads:enabledGroups.map(([key,group])=>({key,label:group.label})),findings:campaign.findings,canAar:campaign.canAar,campaign:campaign.active,map:campaign.map,reports:campaign.reports,vacancies,units,unitLeaders,
  };
}
