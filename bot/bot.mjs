import { nextTrainingOccurrence } from './training-repeat.mjs';
import { defaultSpecialties } from './unit-specialties.mjs';
import { DatabaseSync } from 'node:sqlite';
import { ranks, canonicalRank, baseDisplayName, discordNickname } from './ranks.mjs';
import { week, ukDate, leaveIntervals, leaveWithinLimit, recordedSundays, sundayProgress, participationStage } from './participation.mjs';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, Events,
  GatewayIntentBits, MessageFlags, SlashCommandBuilder, ModalBuilder,
  StringSelectMenuBuilder, UserSelectMenuBuilder, RoleSelectMenuBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const {
  DISCORD_TOKEN, TAG_TEST_SERVER_ID, BASIC_TRAINING_CHANNEL_ID,
  COMMAND_ROLE_ID, TRAINING_CADRE_ROLE_ID, RECRUIT_ROLE_ID,
  START_HERE_CHANNEL_ID, RECRUIT_HELP_CHANNEL_ID, RESERVE_ROLE_ID,
  PROBATIONARY_ROLE_ID, UPCOMING_OPS_CHANNEL_ID, SUNDAY_MEMBER_ROLE_ID, ROSTER_CHANNEL_ID, LOA_STAFF_CHANNEL_ID, SPECIALIST_TRAINING_CHANNEL_ID, MILESTONE_STAFF_CHANNEL_ID,
} = process.env;

if (!DISCORD_TOKEN) throw new Error('Set DISCORD_TOKEN in .env.');
for (const [name, value] of Object.entries({
  TAG_TEST_SERVER_ID, BASIC_TRAINING_CHANNEL_ID, COMMAND_ROLE_ID,
  TRAINING_CADRE_ROLE_ID, RECRUIT_ROLE_ID,
  START_HERE_CHANNEL_ID, RECRUIT_HELP_CHANNEL_ID, RESERVE_ROLE_ID,
})) {
  if (!/^\d{17,20}$/.test(value ?? '')) throw new Error(`Set ${name} to the Discord ID in .env.`);
}

if (PROBATIONARY_ROLE_ID && (!/^\d{17,20}$/.test(PROBATIONARY_ROLE_ID)
    || [RECRUIT_ROLE_ID, RESERVE_ROLE_ID, COMMAND_ROLE_ID, TRAINING_CADRE_ROLE_ID].includes(PROBATIONARY_ROLE_ID))) {
  throw new Error('Set PROBATIONARY_ROLE_ID to the distinct Probationary Discord role ID in .env.');
}

if (LOA_STAFF_CHANNEL_ID && !/^\d{17,20}$/.test(LOA_STAFF_CHANNEL_ID)) {
  throw new Error('Set LOA_STAFF_CHANNEL_ID to a private Discord channel ID.');
}

if (SPECIALIST_TRAINING_CHANNEL_ID && !/^\d{17,20}$/.test(SPECIALIST_TRAINING_CHANNEL_ID)) {
  throw new Error('Set SPECIALIST_TRAINING_CHANNEL_ID to the Specialist Training channel ID.');
}

if (MILESTONE_STAFF_CHANNEL_ID && !/^\d{17,20}$/.test(MILESTONE_STAFF_CHANNEL_ID)) {
  throw new Error('Set MILESTONE_STAFF_CHANNEL_ID to a private Discord channel ID.');
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
const ephemeral = MessageFlags.Ephemeral;
const statePath = new URL('./basic-training-sessions.json', import.meta.url);
const tempPath = new URL('./basic-training-sessions.tmp', import.meta.url);
let sessions = {};
let cancelledSessions = {};
const retiredWebsiteEvents = new Set();
try {
  for (const [id, entry] of Object.entries(JSON.parse(readFileSync(statePath, 'utf8')))) {
    (entry.cancelledAt ? cancelledSessions : sessions)[id] = entry;
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

function storeSessions(active, cancelled = cancelledSessions) {
  writeFileSync(tempPath, JSON.stringify({ ...active, ...cancelled }, null, 2));
  renameSync(tempPath, statePath);
  sessions = active;
  cancelledSessions = cancelled;
}

function saveSession(id, session) {
  if (!retiredWebsiteEvents.has(id) && !Object.hasOwn(cancelledSessions, id)) storeSessions({ ...sessions, [id]: session });
}

const twoDigits = number => String(number).padStart(2, '0');
const clockChoices = (length, step = 1) => Array.from({ length }, (_, index) => {
  const value = twoDigits(index * step);
  return { name: value, value };
});
const trainingCommand = new SlashCommandBuilder()
  .setName('basic-training')
  .setDescription('Manage TAG Basic Training.')
  .addSubcommand(command => command
    .setName('create').setDescription('Open the Basic Training creation wizard.'))
  .addSubcommand(command => command
    .setName('roster').setDescription('View a private signup roster.')
    .addStringOption(option => option.setName('session').setDescription('Choose a training session').setAutocomplete(true).setRequired(true)))
  .addSubcommand(command => command.setName('attendance').setDescription('Mark Basic Training attendance.'))
  .addSubcommand(command => command
    .setName('result').setDescription('Open the Basic Training sign-off wizard.'));

const ukClock = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/London',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function parseUkStart(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const reference = Date.parse(`${date}T${time}:00Z`);
  if (!Number.isFinite(reference)) return null;

  // Modern UK local time is either UTC or UTC+1. Require one exact match.
  const matches = [reference, reference - 3_600_000].filter(candidate =>
    ukClock.format(candidate) === `${date} ${time}`);
  return matches.length === 1 ? matches[0] : null;
}

const dateLabel = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
});

function dateChoices(query) {
  const today = Date.parse(ukClock.format(Date.now()).slice(0, 10) + 'T00:00:00Z');
  const choices = Array.from({ length: 90 }, (_, index) => {
    const day = new Date(today + index * 86_400_000);
    return { name: dateLabel.format(day), value: day.toISOString().slice(0, 10) };
  });
  return choices.filter(choice =>
    choice.name.toLowerCase().includes(query) || choice.value.includes(query)).slice(0, 25);
}

function hasRole(interaction, id) {
  const roles = interaction.member.roles;
  return Array.isArray(roles) ? roles.includes(id) : roles.cache.has(id);
}

const isSpecialist=session=>Boolean(session?.qualificationRoleId||session?.unitQualification);
function sessionPost(id, session) {
  const count = kind => standardBookings(session,kind);
  const availability = (kind, capacity) => {
    if (capacity === 0) return 'No slots offered';
    const open = Math.max(0, capacity - count(kind));
    return open ? `**${open} of ${capacity} available**` : `**Full** · ${capacity} booked`;
  };
  const button = (action, label, style, disabled = false) => new ButtonBuilder()
    .setCustomId(`bt:${action}:${id}`).setLabel(label).setStyle(style).setDisabled(disabled || closed);
  const stamp = Math.floor(session.start / 1000);
  const stage=trainingStage(session);
  const closed = session.start <= Date.now();
  const safeType = session.type.replace(/[\\`*_~|<>]/g, '\\$&');
  return {
    embeds: [{
      color: 0x507747,
      title: session.trainingTrack==='squad'?'TAG Squad Training':session.trainingTrack==='unit'?'TAG Unit Training':isSpecialist(session) ? 'TAG Specialist Training' : 'TAG Basic Training'+(stage?' '+stage.toUpperCase():''),
      description: closed ? `${safeType}\n\n**Signups closed**` : safeType,
      fields: [
        { name: 'Starts', value: `<t:${stamp}:F> · <t:${stamp}:R>` },
        { name: session.trainingTrack?'Attendee places':isSpecialist(session) ? 'Trainee slots' : 'Recruit slots', value: availability('recruit', session.recruitSlots), inline: true },
        { name: 'Waitlist', value: String(Object.keys(session.waitlist ?? {}).length), inline: true },
        ...(Object.keys(session.prioritySeats??{}).some(key=>session.bookings[key]==='recruit') ?
          [{name:'Priority places booked',value:String(Object.keys(session.prioritySeats).filter(key=>session.bookings[key]==='recruit').length),inline:true}]:[]),
        { name: 'Training Cadre slots', value: availability('cadre', session.cadreSlots), inline: true },
      ],
      footer: { text: `Session ID ${id}` },
    }],
    allowedMentions: { parse: [] },
    components: [new ActionRowBuilder().addComponents(
      button('recruit', count('recruit') >= session.recruitSlots ? 'Join Trainee Waitlist' : session.trainingTrack?'Sign Up':isSpecialist(session) ? 'Sign Up as Trainee' : 'Sign Up as Recruit', ButtonStyle.Primary, !session.recruitSlots),
      button('cadre', count('cadre') >= session.cadreSlots ? 'Join Cadre Waitlist' : 'Sign Up as Training Cadre', ButtonStyle.Secondary, !session.cadreSlots),
      button('cancel', 'Cancel My Signup', ButtonStyle.Danger),
    )],
  };
}

const pendingEdits = new Map();
async function refreshPost(id, message) {
  const previous = pendingEdits.get(id) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(() => {
    if (sessions[id]) return message.edit({ ...sessionPost(id, sessions[id]), content: null });
  });
  pendingEdits.set(id, current);
  try {
    await current;
  } finally {
    if (pendingEdits.get(id) === current) pendingEdits.delete(id);
  }
}

async function handleBooking(interaction) {
  const [, action, id] = interaction.customId.split(':');
  await interaction.deferReply({ flags: ephemeral });
  const session = sessions[id];
  if (!session || session.start <= Date.now()) return interaction.editReply('Signups are closed for this session.');

  const user = interaction.user.id;
  if (action !== 'cancel' && coveredByLeave(session, user)) return interaction.editReply('You have LOA for this date. Contact staff if your plans change.');
  const existing = session.bookings[user];
  const next = { ...session, messageId: session.messageId ?? interaction.message.id, prioritySeats:{...session.prioritySeats},
    bookings: { ...session.bookings }, waitlist: { ...session.waitlist } };
  let waitlisted = false;
  if (action === 'cancel') {
    if (!existing && !next.waitlist[user]) return interaction.editReply('You have no signup for this session.');
    delete next.bookings[user];
    delete next.waitlist[user];
    delete next.prioritySeats[user];
  } else {
    const member = interaction.member;
    if (!trainingEligibility(session, action, member)) {
      return interaction.editReply(trainingStage(session) === 't2' && !hasT1Pass(user) && action !== 'cadre'
        ? 'Pass Basic Training T1 before booking T2.' : 'You do not meet this session’s signup requirements.');
    }
    if (existing || next.waitlist[user]) return interaction.editReply('You already hold a seat or a waitlist place. Cancel it first to switch.');
    const capacity = action === 'cadre' ? session.cadreSlots : session.recruitSlots;
    if (!capacity) return interaction.editReply('This session has no seats of that type.');
    if (standardBookings(session,action) >= capacity
        || Object.values(next.waitlist).includes(action)) {
      next.waitlist[user] = action;
      waitlisted = true;
    } else next.bookings[user] = action;
  }
  saveSession(id, next);
  try {
    await refreshPost(id, interaction.message);
  } catch (error) {
    console.error('Could not refresh signup counts:', error.message);
  }
  await interaction.editReply(action === 'cancel'
    ? 'Your signup was cancelled.'
    : waitlisted ? 'You joined the waitlist. If a seat becomes available, the bot will book it for you and send a DM.' : 'Your training slot is confirmed.');
}

const resultLabels = { passed: 'Passed', failed:'Failed', repeat: 'Needs another session', absent: 'Didn’t attend' };
const signingOff = new Set();

function trainingStage(session) {
  if (session.stage === 't1' || session.stage === 't2') return session.stage;
  return /^Basic Training (T1|T2)$/i.exec(session.type?.trim() ?? '')?.[1].toLowerCase();
}

function hasT1Pass(userId) {
  return Object.values(sessions).some(session =>
    trainingStage(session) === 't1' && session.results?.[userId]?.result === 'passed');
}

function resolveResultRoute(result, choice, profile, stage) {
  if (result !== 'passed' || stage === 't1') return 'none';
  if (choice) return choice;
  if (!profile) return null;
  const units = interests(profile);
  if (!units.includes('160th SOAR')) return 'rangers';
  return units.length === 1 ? 'pilot' : null;
}

function resultNotice(record) {
  if (record.result !== 'passed') {
    return {
      detail: record.result !== 'absent'
        ? `You haven’t passed Basic Training ${record.stage.toUpperCase()} yet. Rebook when you can, or speak to Training Cadre about what to work on. They can arrange a separate practice session if helpful.`
        : `You were recorded as absent for Basic Training ${record.stage.toUpperCase()}. You can book the same course again.`,
      components: [privateLink(`Rebook ${record.stage.toUpperCase()}`, BASIC_TRAINING_CHANNEL_ID),
        privateLink('Contact Training Cadre', RECRUIT_HELP_CHANNEL_ID)],
    };
  }
  if (record.stage === 't1') {
    return {
      detail: 'You passed Basic Training T1. You can now book Basic Training T2.',
      components: [privateLink('Book T2', BASIC_TRAINING_CHANNEL_ID)],
    };
  }
  if (record.route === 'pilot') {
    return {
      detail: 'You’ve passed TAG Basic Training. Training Cadre will hand you over to 160th SOAR for Basic Pilot Training.',
      components: [privateLink('Contact Training Cadre', RECRUIT_HELP_CHANNEL_ID)],
    };
  }
  return {
    detail: 'You passed Basic Training T2 and are now eligible for Ranger probation. Contact Training Cadre for your next RP.',
    components: [privateLink('Contact Training Cadre', RECRUIT_HELP_CHANNEL_ID)],
  };
}

async function recordTrainingResult(interaction, draft) {
  const { sessionId: id, user, result } = draft;
  const session = sessions[id];
  const stage = trainingStage(session);
  if (!stage || !unitStageRole(interaction.member,stage)) return interaction.editReply('The matching Basic Training '+(stage ?? 'stage').toUpperCase()+' Cadre role is required.');
  const previous = session.results?.[user.id];
  const route = resolveResultRoute(result, draft.route, profiles[user.id], stage);
  if (!route) return interaction.editReply('Choose the Rangers or Pilot route before recording a T2 pass.');
  if (stage === 't2' && result === 'passed' && !hasT1Pass(user.id)) {
    return interaction.editReply('This recruit needs a recorded T1 pass before you can sign off T2.');
  }
  if (previous && (previous.result !== result || previous.route !== route)) {
    return interaction.editReply('A different result is already recorded for that recruit on this session.');
  }
  if ((previous?.noticeStatus === 'sent' || previous?.complete)) return interaction.editReply('That result is already recorded and the recruit was notified.');
  if (signingOff.has(user.id)) return interaction.editReply('A result is already being processed for this recruit.');
  signingOff.add(user.id);
  try {
    if (result === 'passed' && route === 'rangers' && !PROBATIONARY_ROLE_ID) {
      return await interaction.editReply('Set PROBATIONARY_ROLE_ID in .env and restart before signing off Rangers passes.');
    }
    const member = await interaction.guild.members.fetch({ user: user.id, force: true }).catch(error => {
      if (error.code === 10007) return null;
      throw error;
    });
    if (!member || (!member.roles.cache.has(RECRUIT_ROLE_ID)
        && !(previous && route === 'rangers' && member.roles.cache.has(PROBATIONARY_ROLE_ID)))) {
      return await interaction.editReply('That member needs to be in TAG MILSIM with the Recruit role.');
    }
    const record = previous ?? { result, route, stage, staffId: interaction.user.id, recordedAt: Date.now() };
    const storeResult = update => {
      const latest = sessions[id];
      saveSession(id, { ...latest, results: { ...latest.results, [user.id]: update } });
    };
    if (!previous) storeResult(record);
    if (result === 'passed' && route === 'rangers' && member.roles.cache.has(RECRUIT_ROLE_ID)) {
      try {
        await member.roles.add(PROBATIONARY_ROLE_ID);
        await member.roles.remove(RECRUIT_ROLE_ID);
      } catch (error) {
        console.error('Could not apply Basic Training promotion:', error.message);
        return await interaction.editReply('Result saved. The role update failed. Check Manage Roles and the bot’s role position, then rerun the same result to finish.');
      }
    }
    const notice = resultNotice({ ...record, stage });
    const delivered = await user.send({
      embeds: [{ title: `TAG Basic Training ${stage.toUpperCase()} — ${resultLabels[result]}`, description: notice.detail, color: result === 'passed' ? 0x507747 : 0xb88732 }],
      components: notice.components,
    }).then(() => true, error => {
      console.error('Could not DM Basic Training result:', error.message);
      return false;
    });
    storeResult({ ...record, roleStatus:'applied', noticeStatus: delivered ? 'sent' : 'failed' });
    const handover = route === 'pilot' ? ' Cadre should now hand the recruit over to 160th SOAR.' : '';
    return await interaction.editReply({ content: `**${resultLabels[result]}** recorded.${handover}\n${delivered ? 'The recruit received a DM.' : 'The DM could not be delivered. Please pass on the outcome privately, or rerun this result to retry.'}`, embeds: [], components: [] });
  } finally {
    signingOff.delete(user.id);
  }
}

const resultDrafts = new Map();

function resultPanel(draft) {
  const session = sessions[draft.sessionId];
  const stage = trainingStage(session);
  const route = draft.kind === 'specialist' ? 'none' : resolveResultRoute(draft.result, draft.route, profiles[draft.user.id], stage);
  const previous = session.results?.[draft.user.id];
  const isT2Pass = draft.result === 'passed' && stage === 't2';
  const routeLabel = route === 'rangers' ? 'Rangers probation' : route === 'pilot' ? '160th SOAR Pilot' : 'Choose a route';
  const rows = [];
  if (!previous) {
    rows.push(pick(`btr:outcome:${draft.id}`, 'Choose the training result',
      Object.entries(resultLabels).map(([value, label]) => ({ value, label, default: draft.result === value }))));
    if (isT2Pass) {
      rows.push(pick(`btr:route:${draft.id}`, 'Choose or change the progression route', [
        { value: 'rangers', label: 'Rangers probation', default: route === 'rangers' },
        { value: 'pilot', label: '160th SOAR Pilot', default: route === 'pilot' },
      ]));
    }
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`btr:confirm:${draft.id}`)
      .setLabel(previous ? 'Retry Sign-off' : 'Record Result').setStyle(ButtonStyle.Success)
      .setDisabled(!draft.result || !route || (previous?.noticeStatus === 'sent' || previous?.complete)),
    new ButtonBuilder().setCustomId(`btr:reselect:${draft.id}`).setLabel('Change Recruit').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`btr:cancel:${draft.id}`).setLabel('Close').setStyle(ButtonStyle.Secondary),
  ));
  return {
    embeds: [{ color: 0x507747, title: draft.kind === 'specialist' ? 'Specialist Training Sign-off' : 'Basic Training Sign-off', fields: [
      { name: 'Session', value: `${session.type} · <t:${Math.floor(session.start / 1000)}:F>` },
      { name: draft.kind === 'specialist' ? 'Trainee' : 'Recruit', value: `<@${draft.user.id}>`, inline: true },
      { name: 'Outcome', value: resultLabels[draft.result] ?? 'Choose below', inline: true },
      ...(isT2Pass ? [{ name: 'Progression route', value: routeLabel }] : []),
    ], footer: { text: (previous?.noticeStatus === 'sent' || previous?.complete) ? 'Result already recorded' : 'Private to you • Confirm to record the result' } }],
    allowedMentions: { parse: [] }, components: rows,
  };
}

const signoffDate = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short',
});

function signoffSessions(kind = 'basic', now = Date.now()) {
  return Object.entries(sessions)
    .filter(([, session]) => session.start <= now && (kind === 'specialist' ? isSpecialist(session) : !isSpecialist(session) && trainingStage(session))
      && Object.values(session.bookings ?? {}).includes('recruit'))
    .sort(([, left], [, right]) => right.start - left.start);
}

function pickerControls(draft, section, length) {
  const button = (action, label, disabled = false) => new ButtonBuilder()
    .setCustomId(`btr:${action}:${draft.id}`).setLabel(label)
    .setStyle(ButtonStyle.Secondary).setDisabled(disabled);
  const buttons = [];
  if (length > 25) buttons.push(
    button(`${section}-prev`, 'Previous Page', draft.page === 0),
    button(`${section}-next`, 'Next Page', (draft.page + 1) * 25 >= length),
  );
  if (section === 'recruits') buttons.push(button('back', 'Change Session'));
  buttons.push(button('cancel', 'Close'));
  return new ActionRowBuilder().addComponents(buttons);
}

async function signoffPicker(draft, guild) {
  const offset = draft.page * 25;
  if (!draft.sessionId) {
    const available = signoffSessions(draft.kind);
    return {
      embeds: [{ color: 0x507747, title: draft.kind === 'specialist' ? 'Specialist Training Sign-off' : 'Basic Training Sign-off',
        description: draft.kind === 'specialist' ? 'Choose a started specialist session with booked trainees.' : 'Choose a started T1 or T2 session with booked recruits.',
        footer: { text: 'Step 1 of 3 • Choose a session' } }],
      components: [pick(`btr:session:${draft.id}`, 'Choose a training session',
        available.slice(offset, offset + 25).map(([value, session]) => ({
          label: eventChoice(value, session, draft.kind).label,
          value,
        }))), pickerControls(draft, 'sessions', available.length)],
    };
  }
  const session = sessions[draft.sessionId];
  const recruits = Object.entries(session.bookings).filter(([, kind]) => kind === 'recruit');
  const choices = await Promise.all(recruits.slice(offset, offset + 25).map(async ([value], index) => {
    const member = guild.members.cache.get(value) ?? await guild.members.fetch(value).catch(() => null);
    const name = member?.displayName || profiles[value]?.name || `Recruit ${offset + index + 1}`;
    return { label: name.slice(0, 100), value,
      description: resultLabels[session.results?.[value]?.result] ?? 'Awaiting sign-off' };
  }));
  return {
    embeds: [{ color: 0x507747, title: draft.kind === 'specialist' ? 'Specialist Training Sign-off' : 'Basic Training Sign-off',
      description: `**${session.type}** · <t:${Math.floor(session.start / 1000)}:F>`,
      footer: { text: draft.kind === 'specialist' ? 'Step 2 of 3 • Choose a booked trainee' : 'Step 2 of 3 • Choose a booked recruit' } }],
    components: [pick(`btr:recruit:${draft.id}`, 'Choose a booked member', choices),
      pickerControls(draft, 'recruits', recruits.length)],
  };
}

async function openResultPanel(interaction, kind = 'basic') {
  if (!signoffSessions(kind).length) return interaction.editReply('There are no started sessions with trainee bookings to sign off.');
  for (const [id, draft] of resultDrafts) {
    if (draft.expires <= Date.now() && !draft.saving) resultDrafts.delete(id);
  }
  const draft = { id: interaction.id, owner: interaction.user.id, kind, page: 0, expires: Date.now() + 15 * 60_000 };
  resultDrafts.set(draft.id, draft);
  return interaction.editReply(await signoffPicker(draft, interaction.guild));
}

async function handleResultPanel(interaction) {
  const [, action, id] = interaction.customId.split(':');
  const draft = resultDrafts.get(id);
  const respond = content => interaction.reply({ content, flags: ephemeral });
  if (!draft || draft.owner !== interaction.user.id || draft.expires <= Date.now()) return respond('This sign-off card expired. Run /basic-training result again.');
  if (!canOpenSignoff(interaction.member)) return respond('This card is for authorised Training Cadre.');
  if (draft.saving) return respond('This result is already being processed.');
  if (action === 'cancel') {
    resultDrafts.delete(id);
    return interaction.update({ content: 'Sign-off closed.', embeds: [], components: [] });
  }
  if (['session', 'recruit', 'back', 'reselect', 'sessions-prev', 'sessions-next', 'recruits-prev', 'recruits-next'].includes(action)) {
    draft.saving = true;
    try {
      await interaction.deferUpdate();
      if (action === 'session') {
        const selected = interaction.values[0];
        if (!signoffSessions(draft.kind).some(([key]) => key === selected)) return interaction.editReply('That session is unavailable. Reopen the wizard.');
        draft.sessionId = selected;
        draft.page = 0;
      } else if (action === 'recruit') {
        const userId = interaction.values[0];
        const session = sessions[draft.sessionId];
        if (session?.bookings[userId] !== 'recruit') return interaction.editReply('That member is unavailable on this roster.');
        const user = await client.users.fetch(userId).catch(() => null);
        if (!user) return interaction.editReply('That Discord account is unavailable.');
        const previous = session.results?.[userId];
        Object.assign(draft, { user, result: previous?.result, route: previous?.route });
        return interaction.editReply(resultPanel(draft));
      } else if (action === 'reselect') {
        draft.user = undefined;
      } else if (action === 'back') {
        draft.sessionId = undefined;
        draft.user = undefined;
        draft.page = 0;
      } else {
        draft.page = Math.max(0, draft.page + (action.endsWith('next') ? 1 : -1));
      }
      return interaction.editReply(await signoffPicker(draft, interaction.guild));
    } finally {
      draft.saving = false;
    }
  }
  if (!draft.user) return respond('Choose a session and recruit first.');
  if (interaction.isStringSelectMenu()) {
    if (sessions[draft.sessionId].results?.[draft.user.id]) return respond('A result is already recorded. Reopen the sign-off card.');
    if (action === 'outcome') {
      draft.result = interaction.values[0];
      draft.route = undefined;
    } else if (action === 'route') {
      draft.route = interaction.values[0];
    }
    return interaction.update(resultPanel(draft));
  }
  if (action !== 'confirm' || !Object.hasOwn(resultLabels, draft.result)) return respond('Choose an outcome first.');
  draft.saving = true;
  try {
    await interaction.deferUpdate();
    if (draft.kind === 'specialist') await specialistResult(interaction, draft);
    else await recordTrainingResult(interaction, draft);
  } finally {
    draft.saving = false;
  }
}

async function showTrainingRoster(interaction, id, kind) {
    const session = sessions[id.trim()];
    if (!session?.bookings || isSpecialist(session) !== (kind === 'specialist')) return interaction.editReply('Session ID not found.');
    const roster = Object.entries(session.bookings).map(([user, kind]) => {
      const record = session.results?.[user];
      const role = kind === 'cadre' ? 'Training Cadre' : kind === 'specialist' ? 'Trainee' : 'Recruit';
      const attendance = attendanceLabels[session.attendance?.[user]?.status];
      const entry = `<@${user}> — ${role}${attendance ? ` · ${attendance}` : ''}`;
      if (!record) return entry;
      const route = record.route === 'none' ? '' : ` (${record.route === 'pilot' ? 'Pilot' : 'Rangers'})`;
      return `${entry} · ${resultLabels[record.result]}${route}`;
    });
    const lines = roster.length ? roster : ['Nobody has signed up yet.'];
    for (let index = 0; index < lines.length; index += 15) {
      const result = { content: lines.slice(index, index + 15).join('\n'), allowedMentions: { parse: [] } };
      if (index === 0) await interaction.editReply(result);
      else await interaction.followUp({ ...result, flags: ephemeral });
    }
    return;
}

async function handleStaff(interaction) {
  const signoff=interaction.commandName==='basic-training' && interaction.options.getSubcommand()==='result';
  if (!hasRole(interaction, COMMAND_ROLE_ID) && !hasRole(interaction, TRAINING_CADRE_ROLE_ID) && !(signoff && canOpenSignoff(interaction.member))) {
    return interaction.reply({ content: 'This command is for Command or Training Cadre.', flags: ephemeral });
  }
  await interaction.deferReply({ flags: ephemeral });
  const options = interaction.options;
  if (interaction.commandName === 'basic-training' && options.getSubcommand() === 'attendance') {
    return openAttendance(interaction, 'basic');
  }
  if (interaction.commandName === 'basic-training' && options.getSubcommand() === 'result') {
    return openResultPanel(interaction);
  }
  if (interaction.commandName === 'basic-training' && options.getSubcommand() === 'roster') {
    return showTrainingRoster(interaction, options.getString('session', true), 'basic');
  }

  if (interaction.commandName === 'basic-training-test') {
    const channel = await interaction.guild.channels.fetch(BASIC_TRAINING_CHANNEL_ID);
    if (!channel?.isSendable()) throw new Error('Basic Training channel cannot receive posts.');
    await channel.send('**TAG Test Bot**\nBasic Training channel check passed.');
    return interaction.editReply(`Test message posted in <#${channel.id}>.`);
  }
  for (const [id, draft] of creationDrafts) {
    if (draft.expires <= Date.now() && !draft.publishing) creationDrafts.delete(id);
  }
  const draft = { id: interaction.id, owner: interaction.user.id, expires: Date.now() + 15 * 60_000 };
  creationDrafts.set(draft.id, draft);
  return interaction.editReply(creationScreen(draft));
}

const onboardingCommand = new SlashCommandBuilder()
  .setName('recruit').setDescription('Manage TAG recruit onboarding.')
  .addSubcommand(command => command.setName('setup').setDescription('Publish the recruit panel in Start Here.'))
  .addSubcommand(command => command.setName('profile').setDescription('View a private recruit profile.')
    .addUserOption(option => option.setName('member').setDescription('Recruit to look up').setRequired(true)));

const profilePath = new URL('./recruit-profiles.json', import.meta.url);
const profileTemp = new URL('./recruit-profiles.tmp', import.meta.url);
let profiles = readState(profilePath);

function readState(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {};
  }
}

function saveProfile(id, profile) {
  const next = { ...profiles, [id]: profile };
  writeFileSync(profileTemp, JSON.stringify(next, null, 2));
  renameSync(profileTemp, profilePath);
  profiles = next;
}

const creationDrafts = new Map();
const basicCourses = [
  { name: 'Basic Training T1', value: 't1' },
  { name: 'Basic Training T2', value: 't2' },
];

function creationScreen(draft) {
  const dateOptions = [
    ...dateChoices('').slice(0, 24),
    { name: 'Enter another date', value: 'custom' },
  ];
  const menu = (key, placeholder, choices) => pick(
    `btw:${key}:${draft.id}`, placeholder, choices.map(({ name, value }) =>
      ({ label: name, value, default: draft[key] === value })),
  );
  const button = new ButtonBuilder().setCustomId(`btw:details:${draft.id}`)
    .setLabel('Continue to Session Details').setStyle(ButtonStyle.Primary)
    .setDisabled(!draft.course || !draft.date || !draft.hour || !draft.minute);
  return {
    embeds: [{ color: 0x507747, title: draft.specialist ? 'Create Specialist Training' : 'Create Basic Training',
      description: 'Choose a course, date and **UK start time**. Then set the number of places.',
      footer: { text: 'Step 1 of 3 • Schedule' },
    }],
    components: [
      menu('course', draft.specialist ? 'Choose a qualification' : 'Choose Basic Training T1 or T2', draft.specialist ? qualificationChoices : basicCourses),
      menu('date', 'Choose date', dateOptions),
      menu('hour', 'Choose hour (24-hour clock)', clockChoices(24)),
      menu('minute', 'Choose minute', clockChoices(12, 5)),
      new ActionRowBuilder().addComponents(button),
    ],
  };
}

function creationDetails(draft) {
  const modal = new ModalBuilder().setCustomId(`btw:form:${draft.id}`).setTitle(draft.specialist ? 'Specialist Training Details' : 'Basic Training Details');
  const fields = [
    ['recruit', draft.specialist ? 'Trainee slots' : 'Recruit slots', '0 to 99', 2],
    ['cadre', 'Training Cadre slots', '0 to 99', 2],
  ];
  if (draft.date === 'custom') fields.push(['date', 'UK date (YYYY-MM-DD)', 'e.g. 2026-12-02', 10]);
  for (const [key, label, placeholder, limit] of fields) {
    const input = new TextInputBuilder().setCustomId(key).setLabel(label).setPlaceholder(placeholder)
      .setStyle(TextInputStyle.Short).setMaxLength(limit).setRequired(true);
    if (draft.details?.[key] !== undefined) input.setValue(draft.details[key]);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }
  return modal;
}

function sessionFromDetails(draft, details, now = Date.now()) {
  const date = draft.date === 'custom' ? details.date : draft.date;
  const start = parseUkStart(date, `${draft.hour}:${draft.minute}`);
  const specialist = draft.specialist ? sundayData.courses?.[draft.course] : null;
  const type = draft.specialist ? specialist?.name : basicCourses.find(course => course.value === draft.course)?.name;
  if (!type || !/^\d{1,2}$/.test(details.recruit) || !/^\d{1,2}$/.test(details.cadre)) return null;
  const recruitSlots = Number(details.recruit);
  const cadreSlots = Number(details.cadre);
  if (!start || start <= now || recruitSlots + cadreSlots === 0) return null;
  return { start, recruitSlots, cadreSlots, type, stage: draft.specialist ? undefined : draft.course, qualificationRoleId: specialist?.roleId, bookings: {} };
}

function creationPreview(draft, session) {
  const post = sessionPost(draft.id, session);
  const embed = post.embeds[0];
  return {
    content: null,
    embeds: [{ ...embed, title: 'Preview • ' + (isSpecialist(session) ? 'TAG Specialist Training' : 'TAG Basic Training'), footer: { text: 'Step 3 of 3 • Only you can see this preview' } }],
    allowedMentions: post.allowedMentions,
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`btw:publish:${draft.id}`).setLabel('Publish').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`btw:details:${draft.id}`).setLabel('Edit Details').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`btw:cancel:${draft.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    )],
  };
}

async function handleCreationWizard(interaction) {
  const [, action, id] = interaction.customId.split(':');
  const draft = creationDrafts.get(id);
  const privateReply = content => interaction.reply({ content, flags: ephemeral });
  if (!draft || draft.owner !== interaction.user.id || draft.expires <= Date.now()) {
    return privateReply('This draft expired. Run /basic-training create to start again.');
  }
  if (!hasRole(interaction, COMMAND_ROLE_ID) && !hasRole(interaction, TRAINING_CADRE_ROLE_ID)) {
    return privateReply('This wizard is for Command or Training Cadre.');
  }
  if (draft.publishing) return privateReply('This session is already being published.');
  if (interaction.isStringSelectMenu() && ['course', 'date', 'hour', 'minute'].includes(action)) {
    if (action === 'course' && draft.specialist && !sundayData.courses?.[interaction.values[0]]?.roleId) {
      return privateReply('Link a Discord qualification role with /tag course before scheduling that course.');
    }
    draft[action] = interaction.values[0];
    draft.details = null;
    return interaction.update(creationScreen(draft));
  }
  if (action === 'details' && interaction.isButton()) {
    if (!draft.course || !draft.date || !draft.hour || !draft.minute) return privateReply('Choose a course, date and start time first.');
    return interaction.showModal(creationDetails(draft));
  }
  if (action === 'form' && interaction.isModalSubmit()) {
    const keys = draft.date === 'custom' ? ['recruit', 'cadre', 'date'] : ['recruit', 'cadre'];
    const details = Object.fromEntries(keys.map(key => [key, interaction.fields.getTextInputValue(key).trim()]));
    const session = sessionFromDetails(draft, details);
    if (!session) return privateReply('Use a future UK date and time, a Basic Training course, and whole slot counts from 0 to 99. At least one slot is required. Reopen the details to try again.');
    draft.details = details;
    return interaction.update(creationPreview(draft, session));
  }
  if (action === 'cancel' && interaction.isButton()) {
    creationDrafts.delete(id);
    return interaction.update({ content: 'Basic Training draft cancelled.', embeds: [], components: [] });
  }
  if (action !== 'publish' || !interaction.isButton() || !draft.details) return;
  const session = sessionFromDetails(draft, draft.details);
  if (!session) return privateReply('The selected start time has passed. Create a new draft.');
  draft.publishing = true;
  try {
    await interaction.deferUpdate();
    const channelId = draft.specialist ? SPECIALIST_TRAINING_CHANNEL_ID : BASIC_TRAINING_CHANNEL_ID;
    const channel = await interaction.guild.channels.fetch(channelId);
    if (!channel?.isSendable()) throw new Error('The training channel cannot receive posts.');
    if (draft.specialist) {
      const role = await interaction.guild.roles.fetch(session.qualificationRoleId);
      if (!qualificationAssignable(role, interaction.guild)) return await interaction.editReply('The qualification role is unavailable or cannot be assigned. Check /tag course and the role hierarchy.');
    }
    saveSession(id, { ...session, channelId });
    const message = await channel.send(sessionPost(id, session));
    creationDrafts.delete(id);
    saveSession(id, { ...sessions[id], messageId: message.id });
    await interaction.editReply({
      content: `Published [training signups](${message.url}). Session ID: ${id}`,
      embeds: [], components: [],
    });
  } finally {
    draft.publishing = false;
  }
}

const questions = [
  ['age', 'Are you 18 or over?', false],
  ['mic', 'Do you have a working mic and speak English?', false],
  ['sunday', 'Can you usually attend on Sundays?', true],
  ['wednesday', 'Can you attend Basic Training on Wednesdays?', true],
];
const unitChoices = [
  { label: '75th Rangers', value: '75th Rangers', description: 'TAG Basic Training, then probation with the Rangers' },
  { label: 'DEVGRU', value: 'DEVGRU', description: 'Rangers probation first, then the DEVGRU selection route' },
  { label: 'RRC', value: 'RRC', description: 'Rangers probation first, then the RRC selection route' },
  { label: '160th SOAR', value: '160th SOAR', description: 'TAG Basic Training first, then Basic Pilot Training with SOAR' },
  { label: 'Undecided', value: 'Undecided', description: 'Start with TAG Basic Training and Rangers probation' },
];

const interests = profile => profile.units ?? [profile.unit ?? 'Undecided'];
const interestLabels = profile => interests(profile).map(unit =>
  unitChoices.find(choice => choice.value === unit)?.label ?? unit).join(', ');

function trainingPath(profile) {
  const units = interests(profile);
  const lines = ['All recruits start with TAG Basic Training.'];
  if (units.some(unit => unit !== '160th SOAR')) {
    lines.push('Ground route: probation with the 75th Rangers.');
    if (units.includes('DEVGRU')) lines.push('After probation, you can pursue DEVGRU selection and Green Team.');
    if (units.includes('RRC')) lines.push('After probation, you can pursue RRC selection and training.');
  }
  if (units.includes('160th SOAR')) {
    lines.push('Pilot route: Cadre hands you over to 160th SOAR for Basic Pilot Training.');
    if (units.length > 1) lines.push('Cadre can help you choose which route to follow.');
  }
  return lines.join('\n');
}
const privateLink = (label, channel) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label)
    .setURL(`https://discord.com/channels/${TAG_TEST_SERVER_ID}/${channel}`),
);

function profileOutcome(profile) {
  if (profile.age === 'no' || profile.mic === 'no') {
    return { reason: 'TAG requires members to be 18 or over and have a working mic and spoken English.' };
  }
  if (profile.sunday === 'no') {
    return { reason: 'TAG’s main sessions are on Sundays, so TAG may not be the right fit if you’re unavailable then. Cadre can talk through your options.' };
  }
  const reserve = profile.sunday === 'sometimes';
  if (profile.wednesday === 'no') {
    return { reserve, reason: 'Cadre can discuss alternatives if Wednesdays are unavailable.' };
  }
  return { reserve, canBook: true };
}

async function handleRecruitStaff(interaction) {
  const command = interaction.options.getSubcommand();
  if (!hasRole(interaction, COMMAND_ROLE_ID) && !hasRole(interaction, TRAINING_CADRE_ROLE_ID)) {
    return interaction.reply({ content: 'This command is for Command or Training Cadre.', flags: ephemeral });
  }
  await interaction.deferReply({ flags: ephemeral });
  if (command === 'profile') {
    const recruit = interaction.options.getUser('member', true);
    const profile = profiles[recruit.id];
    if (!profile) return interaction.editReply('That member has no submitted recruit profile.');
    return interaction.editReply({
      embeds: [{ title: 'Recruit Profile', fields: [
        { name: 'In-game name', value: profile.name },
        { name: '18 or over', value: profile.age, inline: true },
        { name: 'Working mic and English', value: profile.mic, inline: true },
        { name: 'Sundays', value: profile.sunday, inline: true },
        { name: 'Wednesdays', value: profile.wednesday, inline: true },
        { name: 'Unit interest', value: interestLabels(profile) },
        { name: 'Training route', value: trainingPath(profile) },
      ] }],
      allowedMentions: { parse: [] },
    });
  }

  const channel = await interaction.guild.channels.fetch(START_HERE_CHANNEL_ID);
  if (!channel?.isSendable()) throw new Error('Start Here channel cannot receive posts.');
  const message = await channel.send({
    embeds: [{ color: 0x507747, title: 'Welcome to TAG MILSIM',
      description: 'Accept the server rules, then click below to open your recruit profile in DMs. All recruits start with TAG Basic Training. Ground recruits then join the 75th Rangers for probation. Pilot recruits continue with 160th SOAR for Basic Pilot Training.' }],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('tag:profile').setLabel('Complete Recruit Profile').setStyle(ButtonStyle.Primary),
    )],
  });
  return interaction.editReply(`Published the [Start Here panel](${message.url}).`);
}

const profileDrafts = new Map();
const profileSaves = new Set();
const pick = (id, placeholder, options, max = 1) => new ActionRowBuilder().addComponents(
  new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder)
    .setMinValues(1).setMaxValues(max).addOptions(options),
);

function profileStep(draft) {
  const question = questions[draft.step];
  if (!question) {
    return {
      embeds: [{ color: 0x507747, title: 'Unit interests',
        description: 'Select all units you’re interested in. Choose Undecided on its own. Cadre uses your choices to guide your training.' }],
      components: [pick(`tag:unit:${draft.id}`, 'Choose one or more units', unitChoices, 4)],
    };
  }
  const [, title, availability] = question;
  const choices = availability ? ['Yes', 'Sometimes', 'No'] : ['Yes', 'No'];
  return {
    embeds: [{ color: 0x507747, title, footer: { text: `Recruit profile • Question ${draft.step + 1} of ${questions.length}` } }],
    components: [pick(`tag:q:${draft.id}:${draft.step}`, 'Choose your answer',
      choices.map(label => ({ label, value: label.toLowerCase() })))],
  };
}

async function handleRecruitForm(interaction) {
  const id = interaction.user.id;
  const flags = interaction.inGuild() ? ephemeral : undefined;
  const privateReply = content => interaction.reply({ content, flags });
  if (interaction.customId === 'tag:edit-name' && interaction.isButton()) {
    const field = new TextInputBuilder().setCustomId('name').setLabel('TAG display name')
      .setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true);
    const existing = tagName(id, '');
    if (existing) field.setValue(existing.slice(0, 80));
    return interaction.showModal(new ModalBuilder().setCustomId('tag:save-name').setTitle('Edit TAG display name')
      .addComponents(new ActionRowBuilder().addComponents(field)));
  }
  if (interaction.customId === 'tag:save-name' && interaction.isModalSubmit()) {
    const name = interaction.fields.getTextInputValue('name').trim();
    if (!name || !validTagName(name)) return privateReply('Enter a valid TAG display name.');
    await interaction.deferReply({ flags });
    const guild = interaction.guild ?? await client.guilds.fetch(TAG_TEST_SERVER_ID);
    const member = await guild.members.fetch({ user:id, force:true }).catch(() => null);
    if (!member || member.pending || member.user.bot) return interaction.editReply('Complete TAG server screening first.');
    setTagName(id, name, id);
    return interaction.editReply('TAG display name saved. It will appear on your Members Dashboard.');
  }

  if (interaction.customId === 'tag:profile' && interaction.inGuild()) {
    if (!hasRole(interaction, RECRUIT_ROLE_ID) || interaction.member.pending) {
      return privateReply('Accept the rules first. If you already have, ask Training Cadre to check your Recruit role.');
    }
    await interaction.deferReply({ flags: ephemeral });
    const startButton = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('tag:profile-name').setLabel('Start Recruit Profile').setStyle(ButtonStyle.Primary),
    );
    const card = {
      embeds: [{ color: 0x507747, title: 'TAG MILSIM — Recruit Profile',
        description: 'Have your in-game name ready. After that, choose your answers and unit interests from dropdowns.' }],
      components: [startButton],
    };
    try {
      await interaction.user.send(card);
    } catch (error) {
      if (error.code !== 50007) throw error;
      return interaction.editReply({ content: 'I couldn’t send you a DM. You can complete the form privately here, or enable DMs and try again.', ...card });
    }
    return interaction.editReply('I’ve sent you a DM. Open it and click **Start Recruit Profile**.');
  }

  if (interaction.customId === 'tag:profile-name' && interaction.isButton()) {
    const modal = new ModalBuilder().setCustomId('tag:answers').setTitle('TAG Recruit Profile');
    const field = new TextInputBuilder().setCustomId('name').setLabel('TAG display name')
      .setPlaceholder('Your Arma Reforger name').setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true);
    const existing = tagName(id, '');
    if (existing) field.setValue(existing.slice(0, 80));
    modal.addComponents(new ActionRowBuilder().addComponents(field));
    return interaction.showModal(modal);
  }

  if (interaction.isModalSubmit() && interaction.customId === 'tag:answers') {
    if (profileSaves.has(id)) return privateReply('Your previous form is being saved. Try again in a moment.');
    const name = interaction.fields.getTextInputValue('name').trim();
    if (!name || !validTagName(name)) return privateReply('Enter a valid TAG display name to continue.');
    const draft = { answers: { name }, id: interaction.id, step: 0, expires: Date.now() + 15 * 60_000 };
    profileDrafts.set(id, draft);
    return interaction.reply({ ...profileStep(draft), flags });
  }

  if (!interaction.isStringSelectMenu()) return;
  const draft = profileDrafts.get(id);
  if (!draft || draft.expires <= Date.now()) return privateReply('This form expired. Open Complete Recruit Profile again.');
  if (interaction.customId.startsWith('tag:q:')) {
    const question = questions[draft.step];
    if (!question || interaction.customId !== `tag:q:${draft.id}:${draft.step}`) {
      return privateReply('Use the current question in the latest form.');
    }
    const [key, , availability] = question;
    const answer = interaction.values[0];
    if (!['yes', 'no', ...(availability ? ['sometimes'] : [])].includes(answer)) {
      return privateReply('Choose one of the listed answers.');
    }
    draft.answers[key] = answer;
    draft.step++;
    return interaction.update(profileStep(draft));
  }
  const units = interaction.values;
  if (draft.step !== questions.length || interaction.customId !== `tag:unit:${draft.id}`
      || units.length < 1 || units.length > 4 || units.some(unit => !unitChoices.some(choice => choice.value === unit))) {
    return privateReply('Open the latest recruit form to choose your unit interests.');
  }
  if (units.length > 1 && units.includes('Undecided')) {
    return privateReply('Choose Undecided by itself or select the units you’re interested in.');
  }
  if (profileSaves.has(id)) return privateReply('Your profile is already being saved.');
  profileSaves.add(id);
  try {
    await interaction.deferUpdate();
    const guild = interaction.guild ?? await client.guilds.fetch(TAG_TEST_SERVER_ID);
    const member = await guild.members.fetch({ user: id, force: true }).catch(error => {
      if (error.code === 10007) return null;
      throw error;
    });
    if (!member || member.pending || !member.roles.cache.has(RECRUIT_ROLE_ID)) {
      return interaction.editReply({
        content: 'You need the Recruit role in TAG MILSIM to submit this form. Ask Training Cadre if you need help.',
        embeds: [], components: [],
      });
    }
    const profile = { ...draft.answers, units };
    const outcome = profileOutcome(profile);
    if (outcome.reserve) await member.roles.add(RESERVE_ROLE_ID);
    else if (profiles[id] && profileOutcome(profiles[id]).reserve) await member.roles.remove(RESERVE_ROLE_ID);
    saveProfile(id, profile);
    setTagName(id, profile.name, id);
    profileDrafts.delete(id);
    const components = [];
    if (outcome.reserve || !outcome.canBook) components.push(privateLink('Go to Recruit Help', RECRUIT_HELP_CHANNEL_ID));
    if (outcome.canBook) components.push(privateLink('Book Basic Training', BASIC_TRAINING_CHANNEL_ID));
    components.push(new ActionRowBuilder().addComponents(new ButtonBuilder()
      .setCustomId('tag:edit-name').setLabel('Edit TAG display name').setStyle(ButtonStyle.Secondary)));
    const next = outcome.reason ?? (outcome.reserve
      ? 'Visit Recruit Help for the reserve route. You can also book Basic Training.'
      : 'Use the button below to book your next TAG Basic Training session.');
    return await interaction.editReply({ content: null, components, embeds: [{
      color: outcome.canBook ? 0x507747 : 0xb88732,
      title: 'Recruit Profile Saved',
      footer: { text: 'Change your TAG name anytime with /tag name or on the Members Dashboard.' },
      description: outcome.reserve ? 'You’re joining as a Reserve Recruit.' : undefined,
      fields: [
        { name: 'TAG display name', value: profile.name },
        { name: 'Unit interests', value: interestLabels(profile) },
        { name: 'Training route', value: trainingPath(profile) },
        { name: 'Next step', value: next },
      ],
    }] });
  } finally {
    profileSaves.delete(id);
  }
}

async function welcomeRecruit(member) {
  if (member.guild.id !== TAG_TEST_SERVER_ID || member.user.bot || member.pending) return;
  if (member.roles.cache.has(RECRUIT_ROLE_ID)) return;
  try {
    await member.roles.add(RECRUIT_ROLE_ID);
  } catch (error) {
    console.error('Could not assign Recruit:', error.message);
    return;
  }
  await member.send({
    content: 'Welcome to TAG MILSIM. Complete your recruit profile in Start Here.',
    components: [privateLink('Open Start Here', START_HERE_CHANNEL_ID)],
  }).catch(() => {});
}

let cleanupRunning = false;
async function maintainTrainingPosts() {
  if (cleanupRunning) return;
  cleanupRunning = true;
  try {
    for (const [id, draft] of profileDrafts) {
      if (draft.expires <= Date.now()) profileDrafts.delete(id);
    }
    const now = Date.now();
    const due = Object.entries(sessions).filter(([, session]) =>
      session.messageId && !session.cardRemoved && session.start <= now
        && (!session.cardClosed || session.start + 4 * 3_600_000 <= now));
    for (const [id, session] of due) {
      try {
        const channel = await client.channels.fetch(trainingChannelId(session));
        await pendingEdits.get(id)?.catch(() => {});
        if (sessions[id]?.messageId!==session.messageId || sessions[id]?.start!==session.start) continue;
        if (session.start + 4 * 3_600_000 <= now) {
          await channel.messages.delete(session.messageId);
          saveSession(id, { ...sessions[id], cardRemoved: true });
        } else {
          await channel.messages.edit(session.messageId, sessionPost(id, sessions[id]));
          saveSession(id, { ...sessions[id], cardClosed: true });
        }
      } catch (error) {
        if (error.code === 10008 && sessions[id]) saveSession(id, { ...sessions[id], cardRemoved: true });
        else console.error('Could not maintain Basic Training card:', error.message);
      }
    }
    await advanceTrainingSeries(now);
    await sendTrainingInvitations(now);
  } finally {
    cleanupRunning = false;
  }
}

function runMaintenance() {
  maintainTrainingPosts().catch(error => console.error('Training maintenance failed:', error.message));
}

client.on(Events.GuildMemberAdd, welcomeRecruit);
client.on(Events.GuildMemberUpdate, (previous, member) => {
  if (previous.pending && !member.pending) return welcomeRecruit(member);
});

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

function rosterSlotCode(groupKey, slot) {
  if (rosterGroups[groupKey]?.codes) return rosterGroups[groupKey].codes[slot - 1];
  if (groupKey === 'soar') return slot <= 8 ? `${slot}SP` : `${slot - 8}SC`;
  return `${slot}${(slotLetters[groupKey] ?? lineSlotLetters)[slot - 1]}${groupKey.at(-1)}`;
}

const groupChoices = Object.entries(rosterGroups).map(([value, group]) => ({ name: group.label, value }));
const groupOption = option => option.setName('group').setDescription('Squad or SOAR').setRequired(true).addChoices(...groupChoices);
const slotOption = option => option.setName('slot').setDescription('Choose a slot from the roster').setAutocomplete(true).setRequired(true);
const memberOption = option => option.setName('member').setDescription('Member to assign. Leave empty to clear the seat.');
const eventOption = option => option.setName('event').setDescription('Choose a Sunday event').setAutocomplete(true).setRequired(true);

const sundayCommand = new SlashCommandBuilder().setName('sunday').setDescription('Manage TAG Sunday rosters.')
  .addSubcommand(command => command.setName('standing').setDescription('Open the standing assignment panel.'))
  .addSubcommand(command => command.setName('create').setDescription('Open the Sunday event creation wizard.'))
  .addSubcommand(command => command.setName('roster').setDescription('View the standing roster or a Sunday event roster.')
    .addStringOption(option => option.setName('event').setDescription('Choose an event or leave empty for the standing roster').setAutocomplete(true))
    .addStringOption(option => option.setName('group').setDescription('Show one group only').addChoices(...groupChoices)))
  .addSubcommand(command => command.setName('qualify').setDescription('Set the Discord role required to claim a seat.')
    .addStringOption(groupOption).addStringOption(slotOption)
    .addRoleOption(option => option.setName('role').setDescription('Required qualification role. Leave empty to clear.')))
  .addSubcommand(command => command.setName('attendance').setDescription('Mark Sunday operation or platoon training attendance.'))
  .addSubcommand(command => command.setName('seat').setDescription('Assign or clear a slot for one Sunday event.')
    .addStringOption(eventOption).addStringOption(groupOption).addStringOption(slotOption).addUserOption(memberOption));

const rosterPath = new URL('./sunday-rosters.json', import.meta.url);
const rosterTemp = new URL('./sunday-rosters.tmp', import.meta.url);
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

let sundayData = withRrcQualification(withCorrectedHqSlots(withSoarSlots(withRtoSlot({
  standing: {}, events: {}, ...readState(rosterPath),
}))));

function loadCustomElements() {
  for (const [key, element] of Object.entries(sundayData.rosterElements ?? {})) rosterGroups[key] = element;
}
loadCustomElements();

function saveSunday(next) {
  writeFileSync(rosterTemp, JSON.stringify(next, null, 2));
  renameSync(rosterTemp, rosterPath);
  sundayData = next;
}

function validTagName(name) {
  return typeof name === 'string' && name.length <= 80 && !/[\p{Cc}\p{Cf}]/u.test(name);
}

let directorySync = null;
let directoryRetryAt = 0;
const namesChangedDuringSync = new Map();

function directoryMember(member) {
  return {name:member.displayName,roles:[...member.roles.cache.keys()].sort()};
}
function rememberDiscordMember(member) {
  if (member.guild.id!==TAG_TEST_SERVER_ID || member.user.bot || member.pending) return;
  const row=directoryMember(member);
  if (!row.name) return;
  if (directorySync) namesChangedDuringSync.set(member.id,row);
  if (sundayData.discordMemberNames?.[member.id]===row.name &&
      (sundayData.discordMemberRoles?.[member.id]??[]).join(',')===row.roles.join(',')) return;
  saveSunday({...sundayData,discordMemberNames:{...sundayData.discordMemberNames,[member.id]:row.name},
    discordMemberRoles:{...sundayData.discordMemberRoles,[member.id]:row.roles}});
}

client.on(Events.GuildMemberAdd, rememberDiscordMember);
client.on(Events.GuildMemberUpdate, (_,member)=>rememberDiscordMember(member));
client.on(Events.GuildMemberRemove, member=>{
  if (member.guild.id!==TAG_TEST_SERVER_ID) return;
  if (directorySync) namesChangedDuringSync.set(member.id,null);
  const names={...sundayData.discordMemberNames};
  const roles={...sundayData.discordMemberRoles};
  const unitDirectory={...sundayData.unitDirectory};
  delete names[member.id];
  delete roles[member.id];
  delete unitDirectory[member.id];
  saveSunday({...sundayData,discordMemberNames:names,discordMemberRoles:roles,unitDirectory});
});

async function refreshDiscordMemberNames(guild) {
  if (directorySync) return directorySync;
  if (Date.now() < directoryRetryAt || Date.now()-(sundayData.discordMemberNamesAt ?? 0) < 5*60_000) return;
  directorySync = (async()=>{
    const names = {};
    const roles = {};
    let after;
    while (true) {
      const page = await guild.members.list({limit:1000,after,cache:false});
      for (const member of page.values()) {
        if (!member.pending && !member.user.bot) {
          const row=directoryMember(member);
          names[member.id]=row.name;
          roles[member.id]=row.roles;
        }
      }
      if (page.size < 1000) break;
      const last = [...page.keys()].reduce((max,id)=>BigInt(id)>BigInt(max)?id:max,'0');
      if (last === after) throw new Error('Discord member pagination did not advance.');
      after=last;
    }
    for (const [id,row] of namesChangedDuringSync) {
      if (row) { names[id]=row.name; roles[id]=row.roles; }
      else { delete names[id]; delete roles[id]; }
    }
    saveSunday({...sundayData,discordMemberNames:names,discordMemberRoles:roles,discordMemberNamesAt:Date.now()});
  })().catch(error=>{
    directoryRetryAt=Date.now()+60_000;
    console.error('Discord member directory sync failed:',error.code ?? '',error.message);
  }).finally(()=>{
    namesChangedDuringSync.clear();
    directorySync=null;
  });
  return directorySync;
}

const nicknameUpdates = new Map();
function syncDiscordNickname(guild, memberId) {
  const prior = nicknameUpdates.get(memberId) ?? Promise.resolve();
  const task = prior.then(async()=>{
    const member = await guild.members.fetch({user:memberId,force:true});
    if (!member || member.pending || member.user.bot) return false;
    const details = sundayData.memberDetails?.[memberId];
    const name = details?.displayName || profiles[memberId]?.name || member.user.globalName || member.user.username;
    const slot = Object.entries(sundayData.standing).find(([key,id]) => id===memberId &&
      !rosterGroups[key.split(':')[0]]?.archived)?.[0];
    const [group,number] = slot?.split(':') ?? [];
    const nickname = discordNickname(name, details?.rank, group ? rosterSlotCode(group,Number(number)) : '');
    if (member.nickname===nickname) return true;
    if (!member.manageable || !guild.members.me?.permissions.has('ManageNicknames')) return false;
    await member.setNickname(nickname,'Sync TAG rank, display name and standing ZAP');
    return true;
  }).catch(error=>{
    console.error('Discord nickname sync failed for '+memberId+':',error.code ?? '',error.message);
    return false;
  }).finally(()=>{
    if (nicknameUpdates.get(memberId)===task) nicknameUpdates.delete(memberId);
  });
  nicknameUpdates.set(memberId,task);
  return task;
}

async function nicknameResult(guild, memberId, message) {
  return message+(await syncDiscordNickname(guild,memberId)
    ? ' Discord nickname synced.' : ' Discord nickname could not be synced. Check Manage Nicknames and the bot’s role position.');
}

function setTagName(memberId, displayName, actor) {
  const memberDetails = { ...sundayData.memberDetails,
    [memberId]: { ...sundayData.memberDetails?.[memberId], displayName, editedBy:actor, editedAt:Date.now() },
  };
  saveSunday({ ...sundayData, memberDetails });
}

function tagName(memberId, fallback) {
  return sundayData.memberDetails?.[memberId]?.displayName ?? profiles[memberId]?.name ?? fallback;
}

function snapshotSeats(groups, standing) {
  return Object.fromEntries(groups.flatMap(group => rosterGroups[group].slots.flatMap((_, index) => {
    if (rosterGroups[group].removed?.includes(index + 1)) return [];
    const key = `${group}:${index + 1}`;
    const memberId = standing[key];
    return [[key, memberId ? { memberId, status: 'awaiting_confirmation' } : { status: 'open' }]];
  })));
}

function rosterEmbeds(groupKeys, eventId, event, { showRoles = false, upcoming = false } = {}) {
  return groupKeys.map(groupKey => {
    const group = rosterGroups[groupKey];
    let filled = 0;
    const lines = group.slots.map((label, index) => {
      const slot = index + 1;
      const key = `${groupKey}:${slot}`;
      if (event ? !Object.hasOwn(event.seats,key) : group.removed?.includes(slot)) return null;
      const user = event ? event.seats[key]?.memberId : sundayData.standing[key];
      const code = rosterSlotCode(groupKey, slot);
      const position = showRoles || groupKey === 'soar' ? `${code} · ${label}` : code;
      if (!user) return `**${position}** · Open`;
      filled++;
      const response = event ? (event.seats[key]?.status === 'confirmed'
        ? (upcoming ? 'Attending' : 'Confirmed') : 'Awaiting confirmation') : '';
      const status = upcoming ? response : (attendanceLabels[event?.attendance?.[user]?.status] ?? response);
      return `**${position}** · <@${user}>${status ? ` · ${status}` : ''}`;
    });
    return {
      color: 0x507747, title: group.label,
      description: [`**${filled} filled** · ${lines.filter(Boolean).length - filled} open`, '', ...lines.filter(Boolean)].join('\n').slice(0,3900),
      ...(!upcoming ? { footer: { text: event ? `Event ID ${eventId}` : 'Standing roster' } } : {}),
    };
  });
}

function fitRosterEmbeds(embeds, reservedCount = 0, reservedText = 0) {
  const result = [];
  let text = reservedText;
  for (const embed of embeds) {
    const length = embed.title.length + embed.description.length + (embed.footer?.text.length ?? 0);
    if (result.length + reservedCount >= 10 || text + length > 5700) break;
    text += length;
    result.push(embed);
  }
  return result;
}

function standingRosterPost() {
  const embeds = rosterEmbeds(Object.keys(rosterGroups).filter(key => !rosterGroups[key].archived), null, null, { showRoles: true });
  return {
    content: '**TAG Standing Roster**\nFull register: https://tagmilsim.co.uk/members/',
    embeds:fitRosterEmbeds(embeds),
    allowedMentions: { parse: [] },
  };
}

let rosterPostQueue = Promise.resolve();
let rosterPostDirty = false;

function refreshStandingRoster() {
  if (!ROSTER_CHANNEL_ID) return Promise.resolve();
  rosterPostDirty = true;
  rosterPostQueue = rosterPostQueue.then(async () => {
    if (!rosterPostDirty) return;
    rosterPostDirty = false;
    try {
      const channel = await client.channels.fetch(ROSTER_CHANNEL_ID);
      if (!channel?.isSendable() || channel.guildId !== TAG_TEST_SERVER_ID) {
        throw new Error('ROSTER_CHANNEL_ID must be a writable text channel in TAG MILSIM.');
      }
      const saved = sundayData.standingPost;
      const post = standingRosterPost();
      if (saved?.channelId === channel.id) {
        try {
          await channel.messages.edit(saved.messageId, post);
          return;
        } catch (error) {
          if (error.code !== 10008) throw error;
        }
      }
      const message = await channel.send(post);
      try {
        saveSunday({ ...sundayData, standingPost: { channelId: channel.id, messageId: message.id } });
      } catch (error) {
        await message.delete().catch(() => {});
        throw error;
      }
    } catch (error) {
      rosterPostDirty = true;
      console.error('Standing roster post update failed:', error.message);
    }
  });
  return rosterPostQueue;
}

async function handleSunday(interaction) {
  if (!hasRole(interaction, COMMAND_ROLE_ID) && !hasRole(interaction, TRAINING_CADRE_ROLE_ID)) {
    return interaction.reply({ content: 'This command is for Command or Training Cadre.', flags: ephemeral });
  }
  await interaction.deferReply({ flags: ephemeral });
  const options = interaction.options;
  const action = options.getSubcommand();
  const eventId = options.getString('event')?.trim();
  const event = eventId && Object.hasOwn(sundayData.events, eventId) ? currentSundayEvent(eventId) : null;
  if (eventId && !event) return interaction.editReply('Sunday event ID not found.');
  const groupKey = options.getString('group');

  if (action === 'attendance') return openAttendance(interaction, 'sunday');

  if (action === 'roster') {
    const active = event?.groups ?? Object.keys(rosterGroups).filter(key => !rosterGroups[key].archived);
    if (groupKey && !active.includes(groupKey)) return interaction.editReply('That group is inactive for this event.');
    const content = event
      ? `**${event.title}** · <t:${Math.floor(event.start / 1000)}:F>`
      : '**TAG Standing Roster**';
    const keys = groupKey ? [groupKey] : active;
    const embeds = rosterEmbeds(keys, eventId, event);
    const total = keys.reduce((count, key) => count + rosterGroups[key].slots.length, 0);
    const filled = keys.reduce((count, key) => count + rosterGroups[key].slots.filter((_, index) => {
      const seat = `${key}:${index + 1}`;
      return event ? event.seats[seat]?.memberId : sundayData.standing[seat];
    }).length, 0);
    return interaction.editReply({ embeds:fitRosterEmbeds(embeds), allowedMentions: { parse: [] },
      content: `${content}\n**${filled} filled** · ${total - filled} open` });
  }

  if (action === 'create') return openSundayWizard(interaction);
  if (action === 'standing') return openStandingPicker(interaction);

  const selected = options.getString('slot', true).trim().toUpperCase();
  const group = rosterGroups[groupKey];
  const slot = /^\d+$/.test(selected) ? Number(selected)
    : (group?.slots.findIndex((_, index) => rosterSlotCode(groupKey, index + 1) === selected) ?? -1) + 1;
  const role = group?.slots[slot - 1];
  if (!role || (!event && (group.archived || group.removed?.includes(slot)))) return interaction.editReply('That slot is not active in this group.');
  if (event && !event.groups.includes(groupKey)) return interaction.editReply('That group is inactive for this event.');
  if (action === 'qualify') {
    if (!hasRole(interaction, COMMAND_ROLE_ID)) return interaction.editReply('Only Command can set slot qualifications.');
    const role = options.getRole('role');
    if (role?.id === interaction.guildId) return interaction.editReply('Choose a qualification role instead of @everyone.');
    const key = `${groupKey}:${slot}`;
    const qualifications = { ...sundayData.qualifications };
    if (role) qualifications[key] = role.id;
    else delete qualifications[key];
    saveSunday({ ...sundayData, qualifications });
    return interaction.editReply({ content: `**${sundaySeatLabel(key)}** · ${role ? `Requires <@&${role.id}>` : 'Qualification cleared'}`,
      allowedMentions: { parse: [] } });
  }
  const member = options.getUser('member');
  if (member?.bot) return interaction.editReply('Choose a human member.');
  const key = `${groupKey}:${slot}`;
  const assignments = event ? event.seats : sundayData.standing;
  if (member && Object.entries(assignments).some(([otherKey, value]) =>
    otherKey !== key && (event ? value.memberId : value) === member.id)) {
    return interaction.editReply('That member already has a seat on this roster. Clear it first if you’re moving them.');
  }
  const next = { ...assignments };
  if (event) {
    next[key] = member ? { memberId: member.id, status: 'awaiting_confirmation' } : { status: 'open' };
    saveSundayEvent(eventId, { ...event, seats: next });
  } else {
    if (member) next[key] = member.id;
    else delete next[key];
    saveSunday({ ...sundayData, standing: next });
    void refreshStandingRoster();
  }
  let invitation = '';
  if (event?.postId && member && event.start > Date.now()) {
    const { delivered } = await sendStandingInvites(eventId, { ...event, seats: { [key]: next[key] } }, interaction.guild);
    invitation = delivered ? ' · Confirmation DM sent' : ' · Confirmation DM not delivered';
  }
  return interaction.editReply({
    content: `${event ? 'Event' : 'Standing'} slot updated · **${group.label} / ${rosterSlotCode(groupKey, slot)} · ${role}** · ${member ? `<@${member.id}>` : 'Open'}${invitation}`,
    allowedMentions: { parse: [] },
  });
}

const standingDrafts = new Map();

function standingCard(draft) {
  const { id, group, slot, memberId } = draft;
  const groups = Object.entries(rosterGroups).filter(([,entry])=>!entry.archived).slice(0,25).map(([value,entry])=>({label:entry.label,value,default:group===value}));
  const rows = groups.length ? [pick(`stp:group:${id}`, 'Choose group', groups)] : [];
  const groupData = rosterGroups[group];
  const positions = groupData?.slots.flatMap((label,index)=>groupData.removed?.includes(index+1)?[]:[{
    label:`${rosterSlotCode(group,index+1)} · ${label}`,value:String(index+1),default:slot===index+1,
  }]).slice(0,25) ?? [];
  if (positions.length) rows.push(pick(`stp:slot:${id}`,'Choose slot or role',positions));
  if (slot) {
    const memberMenu = new UserSelectMenuBuilder().setCustomId(`stp:member:${id}`)
      .setPlaceholder('Choose a server member').setMinValues(1).setMaxValues(1);
    if (memberId) memberMenu.setDefaultUsers(memberId);
    rows.push(new ActionRowBuilder().addComponents(memberMenu));
  }
  const key = slot ? `${group}:${slot}` : null;
  const current = key && sundayData.standing[key];
  const action = (value, label, style) => new ButtonBuilder().setCustomId(`stp:${value}:${id}`).setLabel(label).setStyle(style);
  rows.push(new ActionRowBuilder().addComponents(
    action('save', current && current !== memberId ? 'Replace Assignment' : 'Assign Member', ButtonStyle.Success)
      .setDisabled(!slot || !memberId),
    action('clear', 'Clear Slot', ButtonStyle.Danger).setDisabled(!current),
    action('close', 'Close', ButtonStyle.Secondary),
  ));
  return {
    content: null, allowedMentions: { parse: [] },
    embeds: [{ title: 'Standing Roster Assignment', color: 0x507747,
      description: 'Choose a group, slot and server member, then save the assignment.',
      fields: slot ? [
        { name: 'Selected seat', value: sundaySeatLabel(key) },
        { name: 'Current assignment', value: current ? `<@${current}>` : 'Open', inline: true },
        { name: 'Selected member', value: memberId ? `<@${memberId}>` : 'Choose below', inline: true },
      ] : [] }],
    components: rows,
  };
}

async function openStandingPicker(interaction) {
  for (const [id, draft] of standingDrafts) {
    if (draft.expires <= Date.now()) standingDrafts.delete(id);
  }
  const draft = { id: interaction.id, owner: interaction.user.id, expires: Date.now() + 15 * 60_000 };
  standingDrafts.set(draft.id, draft);
  return interaction.editReply(standingCard(draft));
}

function updateStandingSeat(standing, key, memberId) {
  if (memberId && Object.entries(standing).some(([otherKey, user]) => otherKey !== key && user === memberId)) return null;
  const updated = { ...standing };
  if (memberId) updated[key] = memberId;
  else delete updated[key];
  return updated;
}

async function handleStandingPicker(interaction) {
  const [, action, id] = interaction.customId.split(':');
  const draft = standingDrafts.get(id);
  const reply = content => interaction.reply({ content, flags: ephemeral });
  if (!draft || draft.owner !== interaction.user.id || draft.expires <= Date.now()) {
    return reply('Reopen /sunday standing to continue.');
  }
  if (!hasRole(interaction, COMMAND_ROLE_ID) && !hasRole(interaction, TRAINING_CADRE_ROLE_ID)) {
    return reply('This panel is for Command or Training Cadre.');
  }
  if (action === 'close') {
    standingDrafts.delete(id);
    return interaction.update({ content: 'Standing roster panel closed.', embeds: [], components: [] });
  }
  if (action === 'group' && interaction.isStringSelectMenu()) {
    if (!Object.hasOwn(rosterGroups, interaction.values[0])) return reply('Choose a valid group.');
    Object.assign(draft, { group: interaction.values[0], slot: undefined, memberId: undefined });
  } else if (action === 'slot' && interaction.isStringSelectMenu()) {
    const slot = Number(interaction.values[0]);
    if (!rosterGroups[draft.group]?.slots[slot - 1] || rosterGroups[draft.group].removed?.includes(slot)) return reply('Choose a valid slot.');
    Object.assign(draft, { slot, memberId: undefined });
  } else if (action === 'member' && interaction.isUserSelectMenu() && draft.slot) {
    const member = interaction.users.get(interaction.values[0]);
    if (!member || member.bot || !interaction.members?.has(member.id)) return reply('Choose a human member of this server.');
    draft.memberId = member.id;
  } else if ((action === 'save' || action === 'clear') && draft.slot) {
    if (rosterGroups[draft.group]?.archived || rosterGroups[draft.group]?.removed?.includes(draft.slot)) return reply('This position is no longer active.');
    if (action === 'save' && !draft.memberId) return reply('Choose a member first.');
    const key = `${draft.group}:${draft.slot}`;
    const memberId = action === 'save' ? draft.memberId : undefined;
    const updated = updateStandingSeat(sundayData.standing, key, memberId);
    if (!updated) return reply('That member already has a standing seat. Clear their existing seat first if you’re moving them.');
    saveSunday({ ...sundayData, standing: updated });
    void refreshStandingRoster();
    draft.memberId = undefined;
    return interaction.update({ ...standingCard(draft), content: memberId ? 'Standing assignment saved.' : 'Standing slot cleared.' });
  } else {
    return reply('Use the dropdowns in order.');
  }
  return interaction.update(standingCard(draft));
}

const sundayDrafts = new Map();
const sundayTypes = [
  { value: 'operation', label: 'Main Operation' },
  { value: 'training', label: 'Platoon Training' },
];

function sundayDates(now = Date.now()) {
  const today = new Date(ukClock.format(now).slice(0, 10) + 'T00:00:00Z');
  const first = today.getTime() + ((7 - today.getUTCDay()) % 7) * 86_400_000;
  return Array.from({ length: 25 }, (_, index) => {
    const date = new Date(first + index * 7 * 86_400_000);
    return { value: date.toISOString().slice(0, 10), label: dateLabel.format(date) };
  });
}

function sundayEventFromDraft(draft, standing, now = Date.now()) {
  const { date, hour, minute, type, groups } = draft;
  const start = date && parseUkStart(date, `${hour}:${minute}`);
  const eventType = sundayTypes.find(option => option.value === type);
  if (!eventType || !start || start <= now || new Date(`${date}T00:00:00Z`).getUTCDay() !== 0
      || !groups?.length || !groups.every(group => Object.hasOwn(rosterGroups, group) && !rosterGroups[group].archived)) return null;
  return { title: draft.title || eventType.label, type, start, groups, seats: snapshotSeats(groups, Object.fromEntries(Object.entries(standing).filter(([,memberId]) => sundayData.memberDetails?.[memberId]?.attendanceRequired !== false))) };
}

function sundayWizard(draft) {
  const button = (action, label, style = ButtonStyle.Secondary) => new ButtonBuilder()
    .setCustomId(`suw:${action}:${draft.id}`).setLabel(label).setStyle(style);
  const menu = (key, placeholder, choices) => pick(`suw:${key}:${draft.id}`, placeholder,
    choices.map(choice => ({ ...choice, default: draft[key] === choice.value })));
  const embed = { title: 'Create a Sunday Event', color: 0x507747 };
  if (draft.step === 'schedule') {
    const numeric = choices => choices.map(({ name: label, value }) => ({ label, value }));
    return {
      content: null, embeds: [{ ...embed, description: 'Choose the event type, Sunday date and UK start time.',
        footer: { text: 'Step 1 of 3 • Schedule' } }],
      components: [
        menu('type', 'Choose event type', sundayTypes),
        menu('date', 'Choose Sunday date', sundayDates()),
        menu('hour', 'Choose UK hour', numeric(clockChoices(24))),
        menu('minute', 'Choose minute', numeric(clockChoices(12, 5))),
        new ActionRowBuilder().addComponents(
          button('groups', 'Choose Groups', ButtonStyle.Primary)
            .setDisabled(!draft.type || !draft.date || !draft.hour || !draft.minute),
          button('cancel', 'Cancel'),
        ),
      ],
    };
  }
  if (draft.step === 'groups') {
    const options = Object.entries(rosterGroups).filter(([,group])=>!group.archived && group.slots.some((_,i)=>!group.removed?.includes(i+1))).slice(0,25).map(([value,{label}]) => ({
      label, value, default: draft.groups?.includes(value) ?? false,
    }));
    return {
      content: null, embeds: [{ ...embed, description: 'Select one or more groups for this event, or use **Select All Groups**.',
        footer: { text: 'Step 2 of 3 • Active groups' } }],
      components: [
        pick(`suw:group-pick:${draft.id}`, 'Choose active groups', options, options.length),
        new ActionRowBuilder().addComponents(button('all', 'Select All Groups', ButtonStyle.Primary),
          button('schedule', 'Back'), button('cancel', 'Cancel')),
      ],
    };
  }

  const event = sundayEventFromDraft(draft, sundayData.standing);
  if (!event) return {
    content: 'The selected date or time has passed. Go back and choose another time.',
    embeds: [], components: [new ActionRowBuilder().addComponents(button('schedule', 'Edit Schedule'), button('cancel', 'Cancel'))],
  };
  const assigned = Object.values(event.seats).filter(seat => seat.memberId).length;
  return {
    content: null, embeds: [{ ...embed, title: event.title, fields: [
      { name: 'Starts', value: `<t:${Math.floor(event.start / 1000)}:F>` },
      { name: 'Active groups', value: event.groups.map(key => rosterGroups[key].label).join(', ') },
      { name: 'Roster', value: `**${assigned} assigned** · ${Object.keys(event.seats).length - assigned} open` },
    ], footer: { text: 'Step 3 of 3 • Review before creating' } }],
    allowedMentions: { parse: [] },
    components: [new ActionRowBuilder().addComponents(
      button('publish', 'Create Event', ButtonStyle.Success), button('groups', 'Edit Groups'),
      button('schedule', 'Edit Schedule'), button('rename', 'Optional Title'), button('cancel', 'Cancel'),
    )],
  };
}

async function openSundayWizard(interaction) {
  for (const [id, draft] of sundayDrafts) {
    if (draft.expires <= Date.now()) sundayDrafts.delete(id);
  }
  const draft = { id: interaction.id, owner: interaction.user.id, step: 'schedule', expires: Date.now() + 15 * 60_000 };
  sundayDrafts.set(draft.id, draft);
  return interaction.editReply(sundayWizard(draft));
}

async function publishSunday(id, event, guild) {
  const channel = await guild.channels.fetch(UPCOMING_OPS_CHANNEL_ID);
  if (!channel?.isSendable()) throw new Error('Upcoming Ops channel cannot receive posts.');
  event.confirmBy = confirmationDeadline(event);
  event.standingSeats = { ...event.seats };
  for (const [key, seat] of Object.entries(event.seats)) {
    if (seat.memberId && hasApprovedLeave(event, seat.memberId)) event.seats[key] = {status:'open'};
  }
  const post = await channel.send(sundayPost(id, event));
  saveSundayEvent(id, { ...event, postId: post.id, postChannelId: channel.id }, { refresh: false });
  return post;
}

async function handleSundayWizard(interaction) {
  const [, action, id] = interaction.customId.split(':');
  const draft = sundayDrafts.get(id);
  const privateReply = content => interaction.reply({ content, flags: ephemeral });
  if (!draft || draft.owner !== interaction.user.id || draft.expires <= Date.now()) return privateReply('Run /sunday create to start a new draft.');
  if (!hasRole(interaction, COMMAND_ROLE_ID) && !hasRole(interaction, TRAINING_CADRE_ROLE_ID)) return privateReply('This wizard is for Command or Training Cadre.');
  if (action === 'cancel') {
    sundayDrafts.delete(id);
    return interaction.update({ content: 'Sunday event draft cancelled.', embeds: [], components: [] });
  }
  if (action === 'publish' && draft.step === 'preview') {
    const event = sundayEventFromDraft(draft, sundayData.standing);
    if (!event) return privateReply('Choose a future Sunday time before creating the event.');
    if (!UPCOMING_OPS_CHANNEL_ID) return privateReply('Set UPCOMING_OPS_CHANNEL_ID in .env before publishing.');
    if (draft.publishing) return privateReply('The event is already being published.');
    draft.publishing = true;
    try {
      await interaction.deferUpdate();
      const post = await publishSunday(id, event, interaction.guild);
      sundayDrafts.delete(id);
      await interaction.editReply({ content: `Published [${event.title}](${post.url}). Sending standing-seat confirmations…`,
        allowedMentions: { parse: [] }, embeds: [], components: [] });
      const { delivered, failed } = await sendStandingInvites(id, event, interaction.guild);
      return await interaction.editReply({ content: `Published [${event.title}](${post.url}). Confirmation DMs delivered: ${delivered}. Failed: ${failed}.`,
        allowedMentions: { parse: [] } });
    } finally {
      draft.publishing = false;
    }
  }
  if (action === 'rename' && draft.step === 'preview' && interaction.isButton()) {
    const input = new TextInputBuilder().setCustomId('title').setLabel('Event title')
      .setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(false);
    if (draft.title) input.setValue(draft.title);
    return interaction.showModal(new ModalBuilder().setCustomId(`suw:title:${id}`).setTitle('Sunday Event Title')
      .addComponents(new ActionRowBuilder().addComponents(input)));
  }
  if (action === 'title' && interaction.isModalSubmit() && draft.step === 'preview') {
    draft.title = interaction.fields.getTextInputValue('title').trim();
  } else if (action === 'schedule') {
    draft.step = 'schedule';
  } else if (action === 'groups' && draft.type && draft.date && draft.hour && draft.minute) {
    draft.step = 'groups';
  } else if (action === 'all' && draft.step === 'groups') {
    draft.groups = Object.keys(rosterGroups).filter(key => !rosterGroups[key].archived && rosterGroups[key].slots.some((_,i)=>!rosterGroups[key].removed?.includes(i+1)));
    draft.step = 'preview';
  } else if (action === 'group-pick' && draft.step === 'groups' && interaction.isStringSelectMenu()) {
    draft.groups = Object.keys(rosterGroups).filter(key => interaction.values.includes(key));
    if (!draft.groups.length) return privateReply('Choose at least one active group.');
    draft.step = 'preview';
  } else if (draft.step === 'schedule' && interaction.isStringSelectMenu() && ['type', 'date', 'hour', 'minute'].includes(action)) {
    draft[action] = interaction.values[0];
  } else {
    return privateReply('Use the controls on the current step.');
  }
  return interaction.update(sundayWizard(draft));
}

const attendancePanels = new Map();
const attendanceLabels = { attended: 'Attended', absent: 'Failed to attend', loa: 'LOA' };

function listedEvents(kind, startedOnly = false, now = Date.now()) {
  const events = kind === 'sunday' ? sundayData.events : sessions;
  return Object.entries(events).filter(([, event]) => !event.archivedAt && (kind === 'sunday' || (kind === 'basic' ? !!trainingStage(event) : isSpecialist(event))) && (!startedOnly || event.start <= now))
    .sort(([, a], [, b]) => b.start - a.start);
}

function eventChoice(id, event, kind) {
  const stage = kind === 'basic' ? trainingStage(event) : null;
  const title = event.title || event.type || (stage ? `Basic Training ${stage.toUpperCase()}` : 'Training');
  const when = signoffDate.format(event.start);
  return { label: `${title.slice(0, 65)} · ${when} UK`, value: id };
}

function attendancePeople(event, kind) {
  if (kind !== 'sunday') return Object.entries({ ...event.leaveBookings, ...event.bookings }).map(([id, role]) =>
    ({ id, role: role === 'cadre' ? 'Training Cadre' : isSpecialist(event) ? 'Trainee' : 'Recruit' }));
  const people = new Map();
  for (const [key, seat] of Object.entries(event.standingSeats ?? {})) {
    if (seat?.memberId) people.set(seat.memberId, key);
  }
  for (const [key, seat] of Object.entries(event.seats ?? {})) {
    if (seat?.memberId) people.set(seat.memberId, key);
  }
  for (const [id,key] of Object.entries(event.leaveSeats ?? {})) if (typeof key === 'string') people.set(id,key);
  for (const [id,response] of Object.entries(event.responses ?? {})) {
    if (!people.has(id) && event.loa?.[id] && typeof response?.seat === 'string') people.set(id,response.seat);
  }
  return [...people].map(([id, key]) => {
    const [group, number] = key.split(':');
    const team = rosterGroups[group];
    return { id, role: team ? `${team.label} · ${team.slots[Number(number) - 1]}` : 'Participant' };
  });
}

function attendanceCard(draft) {
  const button = (action, label, style = ButtonStyle.Secondary) =>
    new ButtonBuilder().setCustomId(`att:${action}:${draft.id}`).setLabel(label).setStyle(style);
  const pager = (length, pageSize) => {
    const row = new ActionRowBuilder();
    if (length > pageSize) row.addComponents(
      button('prev', 'Previous').setDisabled(draft.page === 0),
      button('next', 'Next').setDisabled((draft.page + 1) * pageSize >= length),
    );
    if (draft.eventId) row.addComponents(button('back', 'Change Event'));
    return row.addComponents(button('close', 'Close'));
  };
  if (!draft.eventId) {
    const events = listedEvents(draft.kind, true);
    const choices = events.slice(draft.page * 25, draft.page * 25 + 25)
      .map(([id, event]) => eventChoice(id, event, draft.kind));
    return {
      content: null, embeds: [{ title: 'Take Attendance', color: 0x507747,
        description: choices.length ? 'Choose an event by name and date.' : 'No events have started yet.' }],
      components: [...(choices.length ? [pick(`att:event:${draft.id}`, 'Choose an event', choices)] : []), pager(events.length, 25)],
    };
  }

  const event = (draft.kind === 'sunday' ? sundayData.events : sessions)[draft.eventId];
  const people = attendancePeople(event, draft.kind);
  const page = people.slice(draft.page * 4, draft.page * 4 + 4);
  const count = people.filter(person => event.attendance?.[person.id]).length;
  const rows = page.map((person, index) => {
    const status = event.attendance?.[person.id]?.status;
    const mark = (value, label, style) => button(`${value}.${person.id}`, `${index + 1} · ${label}`, style)
      .setDisabled(status === value);
    return new ActionRowBuilder().addComponents(
      mark('attended', 'Attended', ButtonStyle.Success),
      mark('absent', 'Failed to attend', ButtonStyle.Danger),
      mark('loa', 'LOA', ButtonStyle.Secondary),
    );
  });
  return {
    content: null, allowedMentions: { parse: [] },
    embeds: [{ title: 'Take Attendance', color: 0x507747,
      description: `**${eventChoice(draft.eventId, event, draft.kind).label}**\n${count} of ${people.length} marked`,
      fields: page.map((person, index) => ({
        name: `${index + 1}. ${person.role}`,
        value: `<@${person.id}> · **${attendanceLabels[event.attendance?.[person.id]?.status] ?? 'Unmarked'}**`,
      })),
      footer: { text: people.length
        ? `Page ${draft.page + 1} of ${Math.ceil(people.length / 4)} • Use the matching numbered buttons below`
        : 'Nobody is on this roster yet' },
    }],
    components: [...rows, pager(people.length, 4)],
  };
}

async function openAttendance(interaction, kind) {
  for (const [key, panel] of attendancePanels) {
    if (panel.expires <= Date.now()) attendancePanels.delete(key);
  }
  const draft = { id: interaction.id, owner: interaction.user.id, kind, page: 0, expires: Date.now() + 30 * 60_000 };
  attendancePanels.set(draft.id, draft);
  return interaction.editReply(attendanceCard(draft));
}

function markAttendance(kind, eventId, memberId, status, staffId) {
  const event = (kind === 'sunday' ? sundayData.events : sessions)[eventId];
  if (!event || event.archivedAt || opsState()?.registers[(kind==='sunday'?'sunday':'training')+':'+eventId]?.closedAt || (event.start > Date.now() && status !== 'loa') || !Object.hasOwn(attendanceLabels, status)
      || !attendancePeople(event, kind).some(person => person.id === memberId)) return false;
  if (event.attendance?.[memberId]?.status === status) return true;
  const updated = { ...event, attendance: { ...event.attendance, [memberId]: { status, staffId, markedAt: Date.now() } } };
  if (kind !== 'sunday') {
    saveSession(eventId, updated);
    if (status === 'loa') releaseTrainingLeave(eventId);
  } else {
    if (status === 'loa' && event.loa?.[memberId] && !event.loa[memberId].withdrawnAt) updated.loa = {
      ...event.loa, [memberId]: { ...event.loa[memberId], approved:true, approvedBy:staffId },
    };
    saveSundayEvent(eventId, updated);
    if (status === 'loa' && event.start > Date.now()) applyApprovedLeave(eventId, updated);
    if (event.type === 'operation' && status === 'attended') void notifyProbation(memberId).catch(error=>console.error('Probation notice failed:',error.message));
  }
  return true;
}

async function handleAttendance(interaction) {
  const [, action, id] = interaction.customId.split(':');
  const draft = attendancePanels.get(id);
  const reply = content => interaction.reply({ content, flags: ephemeral });
  if (!draft || draft.owner !== interaction.user.id || draft.expires <= Date.now()) return reply('Reopen the attendance command to continue.');
  if (!hasRole(interaction, COMMAND_ROLE_ID) && !hasRole(interaction, TRAINING_CADRE_ROLE_ID)) {
    return reply('This panel is for Command or Training Cadre.');
  }
  if (action === 'close') {
    attendancePanels.delete(id);
    return interaction.update({ content: 'Attendance panel closed. Marks were saved as you went.', embeds: [], components: [] });
  }
  if (action === 'event' && interaction.isStringSelectMenu()) {
    const eventId = interaction.values[0];
    if (!listedEvents(draft.kind, true).some(([key]) => key === eventId)) return reply('That event is unavailable.');
    draft.eventId = eventId;
    draft.page = 0;
  } else if (action === 'back') {
    draft.eventId = undefined;
    draft.page = 0;
  } else if (action === 'next' || action === 'prev') {
    const event = draft.eventId && (draft.kind === 'sunday' ? sundayData.events : sessions)[draft.eventId];
    const length = event ? attendancePeople(event, draft.kind).length : listedEvents(draft.kind, true).length;
    const last = Math.max(0, Math.ceil(length / (event ? 4 : 25)) - 1);
    draft.page = Math.max(0, Math.min(last, draft.page + (action === 'next' ? 1 : -1)));
  } else {
    const [status, memberId] = action.split('.');
    if (!draft.eventId || !markAttendance(draft.kind, draft.eventId, memberId, status, interaction.user.id)) {
      return reply('This person is no longer available on the event roster.');
    }
  }
  return interaction.update(attendanceCard(draft));
}

async function rosterAutocomplete(interaction) {
  if (!hasRole(interaction, COMMAND_ROLE_ID) && !hasRole(interaction, TRAINING_CADRE_ROLE_ID)) return interaction.respond([]);
  if (interaction.commandName === 'sunday' && interaction.options.getFocused(true).name === 'slot') {
    const group = interaction.options.getString('group');
    const query = interaction.options.getFocused().toLowerCase().trim();
    const choices = rosterGroups[group]?.slots.map((label, index) => {
      const code = rosterSlotCode(group, index + 1);
      return { name: `${code} · ${label}`, value: code };
    }) ?? [];
    return interaction.respond(choices.filter(choice => choice.name.toLowerCase().includes(query)).slice(0,25));
  }
  const kind = interaction.commandName === 'sunday' ? 'sunday' : 'basic';
  const query = interaction.options.getFocused().trim().toLowerCase();
  const choices = listedEvents(kind).map(([id, event]) => eventChoice(id, event, kind))
    .filter(choice => choice.label.toLowerCase().includes(query) || choice.value.includes(query)).slice(0, 25);
  return interaction.respond(choices.map(({ label: name, value }) => ({ name, value })));
}

const sundaySignupPanels = new Map();

function confirmationDeadline(event, publishedAt = Date.now()) {
  const cutoff = event.start - 72 * 3_600_000;
  return cutoff > publishedAt ? cutoff : event.start;
}

function sundayPost(id, event) {
  const seats = Object.values(event.seats);
  const attending = seats.filter(seat => seat.status === 'confirmed').length;
  const awaiting = seats.filter(seat => seat.status === 'awaiting_confirmation').length;
  const open = seats.filter(seat => !seat.memberId && seat.status === 'open').length;
  const closed = event.start <= Date.now();
  return {
    embeds: [{ title: event.title, color: 0x507747,
      description: closed ? 'Signups are closed.' : 'Use **Sign Up** to see the open slots you’re eligible for.',
      fields: [
        { name: 'Starts', value: `<t:${Math.floor(event.start / 1000)}:F>` },
        { name: 'Lineup', value: `**${attending} attending** · ${awaiting} awaiting confirmation · ${open} open` },
      ],
    }, ...fitRosterEmbeds(rosterEmbeds(event.groups, id, event, { showRoles: true, upcoming: true }),1,350)],
    allowedMentions: { parse: [] },
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`suo:open:${id}`).setLabel('Sign Up')
        .setStyle(ButtonStyle.Primary).setDisabled(closed),
    )],
  };
}

const sundayPostRefreshes = new Map();

function refreshSundayPost(id) {
  const previous = sundayPostRefreshes.get(id) ?? Promise.resolve();
  const task = previous.then(async () => {
    const event = sundayData.events[id];
    if (!event?.postId) return;
    const channelId = event.postChannelId ?? UPCOMING_OPS_CHANNEL_ID;
    if (!channelId) return;
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isSendable() || channel.guildId !== TAG_TEST_SERVER_ID) return;
    await channel.messages.edit(event.postId, sundayPost(id, sundayData.events[id]));
  }).catch(error => console.error('Upcoming Ops lineup update failed:', error.message));
  sundayPostRefreshes.set(id, task);
  void task.finally(() => {
    if (sundayPostRefreshes.get(id) === task) sundayPostRefreshes.delete(id);
  });
  return task;
}

function saveSundayEvent(id, event, { refresh = true } = {}) {
  if (retiredWebsiteEvents.has(id) || Object.hasOwn(sundayData.cancelledEvents ?? {}, id)) return;
  saveSunday({ ...sundayData, events: { ...sundayData.events, [id]: event } });
  if (refresh && event.postId) void refreshSundayPost(id);
}

function releaseUnanswered(event, now = Date.now()) {
  const pending = Object.entries(event.seats).filter(([, seat]) => {
    const deadline = seat.confirmBy ?? event.confirmBy;
    return deadline && now >= deadline && seat.status === 'awaiting_confirmation';
  });
  if (!pending.length) return event;
  const seats = { ...event.seats };
  const responses = { ...event.responses };
  const coverPending = { ...event.coverPending };
  for (const [key, seat] of pending) {
    if (seat.memberId) responses[seat.memberId] = { status: 'no_response', seat: key, at: now };
    seats[key] = { status: 'open' };
    coverPending[key] = 'cutoff:' + now;
  }
  return { ...event, seats, responses, coverPending };
}

function currentSundayEvent(id) {
  const saved = sundayData.events[id];
  if (!saved) return null;
  const event = releaseUnanswered(saved);
  if (event !== saved) saveSundayEvent(id, event);
  return event;
}

function sundaySeatLabel(key) {
  const [group, slot] = key.split(':');
  return `${rosterGroups[group].label} · ${rosterSlotCode(group, Number(slot))} · ${rosterGroups[group].slots[Number(slot) - 1]}`;
}

async function sendStandingInvites(id, event, guild) {
  let delivered = 0;
  let failed = 0;
  for (const [key, seat] of Object.entries(event.seats)) {
    if (!seat.memberId) continue;
    const latest = currentSundayEvent(id);
    if (latest?.seats[key]?.memberId !== seat.memberId || latest.seats[key].status !== 'awaiting_confirmation') continue;
    try {
      const member = await guild.members.fetch(seat.memberId);
      await member.send({
        embeds: [{ title: event.title, color: 0x507747, fields: [
          { name: 'Your seat', value: sundaySeatLabel(key) },
          { name: 'Starts', value: `<t:${Math.floor(event.start / 1000)}:F>` },
          { name: 'Confirm by', value: `<t:${Math.floor(event.confirmBy / 1000)}:F>` },
        ] }],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`suo:yes:${id}:${key}`).setLabel('I’m Attending').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`suo:no:${id}:${key}`).setLabel('I Can’t Attend').setStyle(ButtonStyle.Secondary),
        )],
      });
      delivered++;
    } catch (error) {
      failed++;
      console.error('Sunday confirmation DM failed:', error.message);
    }
  }
  return { delivered, failed };
}

const slotRoleOverrides = readSlotRoleOverrides();
function readSlotRoleOverrides() {
  try {
    return Object.fromEntries(Object.entries(readState(new URL('./slot-role-overrides.json', import.meta.url)))
      .filter(([,role]) => typeof role === 'string' && /^\d{17,20}$/.test(role) && role !== TAG_TEST_SERVER_ID));
  } catch (error) {
    console.error('Could not read slot-role-overrides.json. Using configured Discord qualification roles:', error.message);
    return {};
  }
}

function defaultSeatQualification(label) {
  const position = label.toLowerCase();
  if (/platoon (commander|sergeant)/.test(position)) return 'command';
  if (/squad leader/.test(position)) return 'squad leader';
  if (/team leader/.test(position)) return 'team leader';
  if (/medic/.test(position)) return 'medic';
  if (/\barfr\b/.test(position)) return 'medic';
  if (/\bhat\b.*gunner/.test(position)) return 'hat gunner';
  if (/machine gunner/.test(position)) return 'machine gunner';
  if (/uav operator/.test(position)) return 'uav operator';
  if (/jtac/.test(position)) return 'jtac';
  if (/\bcct\b/.test(position)) return 'cct';
  if (/pilot/.test(position)) return 'rotary pilot';
  if (/mortar gunner/.test(position)) return 'mortar gunner';
  if (/designated marksman|sniper/.test(position)) return position.includes('sniper') ? 'sniper' : 'designated marksman';
  return null;
}

function eligibleSundaySeats(event, roles, memberId) {
  const general = [PROBATIONARY_ROLE_ID, SUNDAY_MEMBER_ROLE_ID, RESERVE_ROLE_ID, COMMAND_ROLE_ID]
    .some(role => role && roles.has(role));
  if (RECRUIT_ROLE_ID && roles.has(RECRUIT_ROLE_ID)) return [];
  return Object.entries(event.seats).filter(([key, seat]) => {
    if (seat.memberId || seat.status !== 'open') return false;
    const requiredRole = sundayData.qualifications?.[key] ?? slotRoleOverrides[key];
    if (requiredRole) return roles.has(requiredRole);
    const [group, slot] = key.split(':');
    const label = rosterGroups[group]?.slots[Number(slot) - 1];
    if (!label) return false;
    const rule = defaultSeatQualification(label);
    if (rule === 'command') {
      return Boolean((COMMAND_ROLE_ID && roles.has(COMMAND_ROLE_ID)) ||
        (memberId && sundayData.standing?.[key] === memberId));
    }
    if (!rule) return general;
    const qualifiedRole = sundayData.courses?.[rule]?.roleId ?? slotRoleOverrides[rule];
    return Boolean(qualifiedRole && roles.has(qualifiedRole));
  }).map(([key]) => key);
}

function signupCard(id, panel, keys) {
  const offset = panel.page * 25;
  const choices = keys.slice(offset, offset + 25).map(value => ({ value, label: sundaySeatLabel(value).slice(0,100) }));
  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`suo:prev:${id}`).setLabel('Previous').setStyle(ButtonStyle.Secondary)
      .setDisabled(panel.page === 0),
    new ButtonBuilder().setCustomId(`suo:next:${id}`).setLabel('Next').setStyle(ButtonStyle.Secondary)
      .setDisabled(offset + 25 >= keys.length),
  );
  return {
    content: null, embeds: [{ title: 'Available Sunday Seats', color: 0x507747,
      description: choices.length ? 'Choose a seat to confirm your signup.' : 'There are no open seats matching your roles right now.' }],
    components: [...(choices.length ? [pick(`suo:claim:${id}`, 'Choose an open seat', choices)] : []),
      ...(keys.length > 25 ? [controls] : [])],
  };
}

function confirmStandingSeat(id, memberId, slot) {
  if (!Object.hasOwn(sundayData.events,id)) return null;
  const event = currentSundayEvent(id);
  if (!event.postId || event.start <= Date.now() || event.cancelledAt || event.archivedAt ||
      hasApprovedLeave(event,memberId) || event.responses?.[memberId]?.status === 'declined') return null;
  const key = slot ?? Object.keys(event.seats).find(key=>event.seats[key].memberId === memberId);
  const seat = event.seats[key];
  if (seat?.memberId !== memberId) return null;
  if (seat.status === 'confirmed') return key;
  if (seat.status !== 'awaiting_confirmation') return null;
  saveSundayEvent(id,{
    ...event,
    seats:{...event.seats,[key]:{...seat,status:'confirmed'}},
    responses:{...event.responses,[memberId]:{status:'confirmed',seat:key,at:Date.now()}},
  });
  return key;
}

async function handleSundaySignup(interaction) {
  const [, action, id, group, slot] = interaction.customId.split(':');
  if (action === 'yes' || action === 'no') {
    const key = `${group}:${slot}`;
    if (action === 'no') {
      const event = currentSundayEvent(id);
      const seat = event?.seats[key];
      if (event?.start > Date.now() && seat?.memberId === interaction.user.id &&
          ['awaiting_confirmation','confirmed'].includes(seat.status)) return interaction.showModal(leaveModal(id,key));
    }
    if (action === 'no' || !confirmStandingSeat(id,interaction.user.id,key)) {
      return interaction.update({ content:'This confirmation is no longer available.',components:[] });
    }
    return interaction.update({ content: 'Your attendance is confirmed.', components: [
      new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('suo:no:'+id+':'+key)
        .setLabel('I Can’t Attend').setStyle(ButtonStyle.Secondary)),
    ] });
  }
  if (!interaction.inGuild()) return;
  await interaction.deferReply({ flags: ephemeral });
  const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
  const event = currentSundayEvent(id);
  if (!event?.postId || event.start <= Date.now() || member.pending) return interaction.editReply('Signups are closed for this event or server screening is incomplete.');
  if (hasApprovedLeave(event, member.id) || event.responses?.[member.id]?.status === 'declined') return interaction.editReply('Staff can help if your leave plans have changed.');
  if (Object.values(event.seats).some(seat => seat.memberId === member.id)) {
    return interaction.editReply('You already have a seat for this event. If it’s a standing seat, check your confirmation DM.');
  }
  const keys = eligibleSundaySeats(event, member.roles.cache, member.id);
  const panelId = `${id}:${member.id}`;
  const panel = sundaySignupPanels.get(panelId) ?? { page: 0 };
  if (action === 'claim' && interaction.isStringSelectMenu()) {
    const key = interaction.values[0];
    if (!keys.includes(key)) return interaction.editReply('That seat is no longer open or you do not have the required role. Open Sign Up again.');
    saveSundayEvent(id, { ...event, seats: { ...event.seats, [key]: { memberId: member.id, status: 'confirmed' } } });
    sundaySignupPanels.delete(panelId);
    return interaction.editReply(`You’re confirmed for **${sundaySeatLabel(key)}**.`);
  }
  const delta = action === 'next' ? 1 : action === 'prev' ? -1 : 0;
  panel.page = action === 'open' ? 0 : Math.max(0, Math.min(Math.ceil(keys.length / 25) - 1, panel.page + delta));
  sundaySignupPanels.set(panelId, panel);
  return interaction.editReply(signupCard(id, panel, keys));
}
const opsStaff = i => hasRole(i, COMMAND_ROLE_ID) || hasRole(i, TRAINING_CADRE_ROLE_ID);
const safeMentions = { parse: [] };
const sendPrivate = (user, content) => user.send({ content, allowedMentions: safeMentions }).then(() => true, () => false);
const lookupEvent = o => o.setName('event').setDescription('Select an event').setAutocomplete(true).setRequired(true);
const targetMember = o => o.setName('member').setDescription('Select a member').setRequired(true);
const qualificationNames = [
  'JTAC', 'FO', 'CCT', 'Medic', 'Machine Gunner', 'HAT Gunner', 'Team Leader', 'Squad Leader',
  'RRC Operator', 'DEVGRU Operator', 'Rotary Pilot', 'Fixed Wing Pilot', 'CAS Pilot', 'UAV Operator',
  'Training Cadre T1', 'Training Cadre T2', 'Training Cadre GT', 'Training Cadre RRC',
  'Designated Marksman', 'Sniper', 'Mortar Gunner', 'Spotter', 'Dog Handler',
];
const qualificationChoices = qualificationNames.map(name => ({ name, value: name.toLowerCase() }));
const workflowsCommand = new SlashCommandBuilder().setName('tag').setDescription('TAG training and personnel tools.')
  .addSubcommand(c => c.setName('loa').setDescription('View or approve a private Sunday LOA.')
    .addStringOption(lookupEvent).addUserOption(targetMember)
    .addBooleanOption(o => o.setName('approve').setDescription('Approve this LOA')))
  .addSubcommand(c => c.setName('course').setDescription('Open the specialist qualification role setup panel.'))
  .addSubcommand(c => c.setName('courses').setDescription('View configured specialist courses.'))
  .addSubcommand(c => c.setName('specialist').setDescription('Open the specialist training creation wizard.'))
  .addSubcommand(c => c.setName('specialist-result').setDescription('Open the specialist result and qualification sign-off wizard.'))
  .addSubcommand(c => c.setName('specialist-attendance').setDescription('Mark attendance for a specialist training session.'))
  .addSubcommand(c => c.setName('specialist-roster').setDescription('View specialist training bookings and results.')
    .addStringOption(lookupEvent))
  .addSubcommand(c => c.setName('name').setDescription('Change your TAG display name on Discord and the website.')
    .addStringOption(o => o.setName('display-name').setDescription('The name to show on TAG records').setRequired(true).setMaxLength(80))
    .addUserOption(o => o.setName('member').setDescription('Command only: edit another member')))
  .addSubcommand(c => c.setName('record').setDescription('View your service record.')
    .addUserOption(o => o.setName('member').setDescription('Optional staff lookup')))
  .addSubcommand(c => c.setName('probation').setDescription('Sign off probation after three main operations.').addUserOption(targetMember))
  .addSubcommand(c => c.setName('review').setDescription('Review a member’s Sunday attendance.').addUserOption(targetMember))
  .addSubcommand(c => c.setName('wednesday').setDescription('Configure automatic Wednesday Basic Training.')
    .addStringOption(o => o.setName('course').setDescription('Course').setRequired(true)
      .addChoices({name:'T1',value:'t1'},{name:'T2',value:'t2'}))
    .addBooleanOption(o => o.setName('enabled').setDescription('Enable weekly publishing').setRequired(true))
    .addStringOption(o => o.setName('hour').setDescription('UK start hour').addChoices(...clockChoices(24)))
    .addStringOption(o => o.setName('minute').setDescription('Start minute').addChoices(...clockChoices(12, 5)))
    .addIntegerOption(o => o.setName('recruits').setDescription('Recruit seats').setMinValue(1).setMaxValue(99))
    .addIntegerOption(o => o.setName('cadre').setDescription('Cadre seats').setMinValue(0).setMaxValue(99)));

function qualificationAssignable(role, guild) {
  return role && role.id !== guild.id && role.editable && !role.managed
    && role.permissions.bitfield === 0n
    && ![COMMAND_ROLE_ID, TRAINING_CADRE_ROLE_ID, RECRUIT_ROLE_ID, PROBATIONARY_ROLE_ID, SUNDAY_MEMBER_ROLE_ID, RESERVE_ROLE_ID].includes(role.id);
}

function leaveModal(id, key) {
  const input = (key, label, max, required, style) => new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId(key).setLabel(label).setMaxLength(max).setRequired(required).setStyle(style));
  return new ModalBuilder().setCustomId('loa:' + id + ':' + key).setTitle('Sunday Leave of Absence')
    .addComponents(input('reason','Reason for absence',400,true,TextInputStyle.Paragraph),
      input('return','Expected return (YYYY-MM-DD, optional)',10,false,TextInputStyle.Short));
}

function coveredByLeave(event, memberId) {
  if (event.attendance?.[memberId]?.status === 'loa') return true;
  const date = ukClock.format(event.start).slice(0,10);
  return (sundayData.leaveRanges?.[memberId] ?? []).some(range => range.from <= date && date <= range.to && (!range.effectiveAt || event.start >= range.effectiveAt) && (!range.withdrawnAt || event.start < range.withdrawnAt));
}

function hasApprovedLeave(event, memberId) {
  if (coveredByLeave(event, memberId)) return true;
  const date = ukClock.format(event.start).slice(0,10);
  return Object.values(sundayData.events).some(source => {
    const leave = source.loa?.[memberId];
    return leave?.approved && (!leave.withdrawnAt || event.start < leave.withdrawnAt) && (source.start === event.start
      || (source.start < event.start && leave.returnDate && date < leave.returnDate));
  });
}

async function submitLeave(i) {
  await i.deferReply({ flags: i.inGuild() ? ephemeral : undefined });
  const [, id, group, slot] = i.customId.split(':');
  const key = group + ':' + slot;
  const event = currentSundayEvent(id);
  const member = i.user.id;
  if (!event || event.start <= Date.now() || event.seats[key]?.memberId !== member) {
    return i.editReply('That seat is no longer assigned to you.');
  }
  const reason = i.fields.getTextInputValue('reason').trim();
  const returnDate = i.fields.getTextInputValue('return').trim();
  if (!reason || (returnDate && (!parseUkStart(returnDate,'12:00') || returnDate <= ukClock.format(event.start).slice(0,10)))) {
    return i.editReply('Enter a reason and, if known, a valid return date after the event. Open the form again to retry.');
  }
  const from=ukDate(event.start);
  const to=returnDate ? ukDate(Date.parse(returnDate+'T00:00:00Z')-86400000) : from;
  if (!leaveWithinLimit([...(sundayData.leaveRanges?.[member] ?? []),{from,to}],Date.now(),legacyLeaveRanges(member))) {
    return i.editReply('Leave may cover at most 42 consecutive days.');
  }
  await recordLeave(id, event, key, member, reason, returnDate, i.id);
  await i.editReply('LOA submitted privately. Your seat is now open.');
}

async function recordLeave(id, event, key, member, reason, returnDate, requestId) {
  saveSundayEvent(id, { ...event, seats: { ...event.seats, [key]: { status: 'open' } },
    responses: { ...event.responses, [member]: { status: 'declined', seat: key, at: Date.now() } },
    loa: { ...event.loa, [member]: { reason, returnDate, submittedAt: Date.now(), approved: false } },
    coverPending: { ...event.coverPending, [key]: requestId } });
  if (LOA_STAFF_CHANNEL_ID) {
    try {
      const channel = await client.channels.fetch(LOA_STAFF_CHANNEL_ID);
      if (channel?.guildId === TAG_TEST_SERVER_ID && channel.isSendable()) {
        await channel.send({content:'LOA submitted by <@'+member+'> for **'+event.title+'**. View it with /tag loa.', allowedMentions:safeMentions});
      }
    } catch (error) {
      console.error('LOA staff notification failed:',error.message);
    }
  }
}

const resultLocks = new Set();
async function specialistResult(i, draft) {
  const { sessionId: id, user, result } = draft;
  const event = sessions[id];
  if (event?.unitQualification) return i.editReply('Record this course’s candidate assessments in Unit Operations on the TAG website.');
  if (!specialistStageRole(i.member,event)) return i.editReply('The matching specialist Training Cadre role is required.');
  if (!event?.qualificationRoleId || event.start > Date.now() || event.bookings[user.id] !== 'recruit') {
    return i.editReply('Choose a started specialist session and one of its booked trainees.');
  }
  const previous = event.results?.[user.id];
  if (previous?.complete) return i.editReply('That result is already recorded.');
  if (previous && previous.result !== result) return i.editReply('A different result is already recorded.');
  const lock = id + ':' + user.id;
  if (resultLocks.has(lock)) return i.editReply('This sign-off is already in progress.');
  resultLocks.add(lock);
  const record = previous ?? { result, route:'none', staffId:i.user.id, recordedAt:Date.now() };
  const store = value => saveSession(id,{ ...sessions[id], results:{ ...sessions[id].results, [user.id]:value } });
  try {
    store(record);
    if (result === 'passed') {
      const role = await i.guild.roles.fetch(event.qualificationRoleId);
      if (!qualificationAssignable(role,i.guild)) return i.editReply('Result saved. Check the qualification role permissions and hierarchy, then retry.');
      const member = await i.guild.members.fetch(user.id);
      await member.roles.add(role);
    }
    store({ ...record, complete:true });
    const sent = await sendPrivate(user, event.type + ' · ' + resultLabels[result] + (result === 'passed' ? '. Qualification role awarded.' : '. Contact Cadre for your next step.'));
    return i.editReply({ content: 'Result saved.' + (sent ? ' The member was notified.' : ' Their DMs are unavailable.'), embeds: [], components: [] });
  } finally {
    resultLocks.delete(lock);
  }
}

const qualificationPanels = new Map();

function qualificationPanel(draft, notice = '') {
  const chosen = qualificationChoices.find(option => option.value === draft.qualification);
  const linked = draft.qualification && sundayData.courses?.[draft.qualification]?.roleId;
  const select = pick('qcp:qualification:'+draft.id, 'Choose a TAG qualification', qualificationChoices.map(option => ({
    label: option.name,
    value: option.value,
    description: sundayData.courses?.[option.value]?.roleId ? 'Role linked' : 'Role not linked',
    default: option.value === draft.qualification,
  })));
  const rows = [select];
  if (chosen) {
    const roleMenu = new RoleSelectMenuBuilder().setCustomId('qcp:role:'+draft.id)
      .setPlaceholder('Choose the Discord role to award').setMinValues(1).setMaxValues(1);
    if (draft.roleId) roleMenu.setDefaultRoles(draft.roleId);
    rows.push(new ActionRowBuilder().addComponents(roleMenu));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('qcp:save:'+draft.id).setLabel(linked ? 'Save Role Link' : 'Link Role')
      .setStyle(ButtonStyle.Success).setDisabled(!chosen || !draft.roleId || linked === draft.roleId),
    new ButtonBuilder().setCustomId('qcp:close:'+draft.id).setLabel('Close').setStyle(ButtonStyle.Secondary),
  ));
  return {
    content: notice || null, embeds: [{ title: 'Specialist Qualification Setup', color: 0x507747,
      description: 'Choose a qualification, select its Discord role, then save. You can link another qualification from the same panel.',
      fields: chosen ? [
        { name: 'Qualification', value: chosen.name },
        { name: 'Current role', value: linked ? '<@&'+linked+'>' : 'Role not linked', inline: true },
        { name: 'Selected role', value: draft.roleId ? '<@&'+draft.roleId+'>' : 'Choose below', inline: true },
      ] : [] }],
    components: rows, allowedMentions: safeMentions,
  };
}

function openQualificationPanel(interaction) {
  for (const [id, draft] of qualificationPanels) {
    if (!draft.saving && draft.expires <= Date.now()) qualificationPanels.delete(id);
  }
  const draft = { id: interaction.id, owner: interaction.user.id, expires: Date.now()+15*60_000 };
  qualificationPanels.set(draft.id,draft);
  return interaction.editReply(qualificationPanel(draft));
}

async function handleQualificationPanel(interaction) {
  const [, action, id] = interaction.customId.split(':');
  const draft = qualificationPanels.get(id);
  const error = content => interaction.reply({content,flags:ephemeral});
  if (!draft || draft.expires <= Date.now() || draft.owner !== interaction.user.id) return error('Run /tag course to open your own setup panel.');
  if (!hasRole(interaction,COMMAND_ROLE_ID)) return error('Only Command can configure course roles.');
  if (draft.saving) return error('The role link is being saved.');
  if (action === 'close') {
    qualificationPanels.delete(id);
    return interaction.update({content:'Qualification setup closed.',embeds:[],components:[]});
  }
  if (action === 'qualification' && interaction.isStringSelectMenu()) {
    const value = interaction.values[0];
    if (!qualificationChoices.some(choice=>choice.value===value)) return error('Choose a qualification from the list.');
    Object.assign(draft,{qualification:value,roleId:undefined});
    return interaction.update(qualificationPanel(draft));
  }
  if (action === 'role' && interaction.isRoleSelectMenu() && draft.qualification) {
    const role = interaction.roles.get(interaction.values[0]);
    if (!qualificationAssignable(role,interaction.guild)) {
      return error('Choose an assignable qualification role below the bot, with server-wide permissions off.');
    }
    draft.roleId = role.id;
    return interaction.update(qualificationPanel(draft));
  }
  if (action !== 'save' || !draft.qualification || !draft.roleId) return error('Choose a qualification and role first.');
  draft.saving = true;
  try {
    await interaction.deferUpdate();
    const role = await interaction.guild.roles.fetch(draft.roleId,{force:true});
    if (!qualificationAssignable(role,interaction.guild)) {
      draft.roleId = undefined;
      return await interaction.editReply(qualificationPanel(draft,'That role is no longer assignable. Choose another role.'));
    }
    const {name,value} = qualificationChoices.find(choice=>choice.value===draft.qualification);
    saveSunday({...sundayData,courses:{...sundayData.courses,[value]:{name,roleId:role.id}}});
    draft.roleId = undefined;
    return await interaction.editReply(qualificationPanel(draft,'**'+name+'** is now linked to <@&'+role.id+'>.'));
  } finally {
    draft.saving = false;
  }
}

async function handleWorkflowCommand(i) {
  const action = i.options.getSubcommand();
  const user = i.options.getUser('member') ?? i.user;
  if (action === 'name') {
    if (user.id !== i.user.id && !hasRole(i, COMMAND_ROLE_ID)) {
      return i.reply({ content:'Only Command can change another member’s name.', flags:ephemeral });
    }
    const name = i.options.getString('display-name', true).trim();
    if (!name || !validTagName(name)) return i.reply({ content:'Enter a valid TAG display name.', flags:ephemeral });
    await i.deferReply({ flags:ephemeral });
    const member = await i.guild.members.fetch({ user:user.id, force:true }).catch(() => null);
    if (!member || member.pending || member.user.bot) return i.editReply('Choose a screened TAG member.');
    setTagName(member.id, name, i.user.id);
    return i.editReply({ content:'TAG display name saved.', allowedMentions:safeMentions });
  }
  const lead = squadLeaderFor(user.id) === i.user.id && user.id !== i.user.id;
  const allowed = opsStaff(i) || action === 'courses' || (action === 'record' && user.id === i.user.id)
    || (lead && ['record','probation'].includes(action));
  if (!allowed && !(action==='specialist-result' && canOpenSignoff(i.member))) return i.reply({ content:'You do not have access to that action.', flags:ephemeral });
  await i.deferReply({flags:ephemeral});
  const o = i.options;
  if (action === 'loa') {
    const id = o.getString('event',true);
    const event = sundayData.events[id];
    const loa = event?.loa?.[user.id];
    if (!loa) return i.editReply('No LOA was submitted for that member on this event.');
    const approve = o.getBoolean('approve');
    if (approve && !loa.approved) {
      saveSundayEvent(id,{...event,loa:{...event.loa,[user.id]:{...loa,approved:true,approvedBy:i.user.id}}},{refresh:false});
    }
    return i.editReply({embeds:[{title:'Private Leave of Absence',fields:[
      {name:'Member',value:'<@'+user.id+'>'},{name:'Event',value:event.title},
      {name:'Reason',value:loa.reason},{name:'Expected return',value:loa.returnDate || 'Single event / unknown'},
      {name:'Status',value:loa.approved || approve ? 'Approved':'Submitted'},
    ]}],allowedMentions:safeMentions});
  }
  if (action === 'courses') {
    const lines = qualificationChoices.map(({ name, value }) => {
      const roleId = sundayData.courses?.[value]?.roleId;
      return '**'+name+'** · '+(roleId ? '<@&'+roleId+'>' : 'Role not linked');
    });
    return i.editReply({embeds:[{title:'TAG Qualification Catalogue',color:0x507747,description:lines.join('\n')}],allowedMentions:safeMentions});
  }
  if (action === 'course') {
    if (!hasRole(i,COMMAND_ROLE_ID)) return i.editReply('Only Command can configure course roles.');
    return openQualificationPanel(i);
  }
  if (action === 'specialist') {
    if (!SPECIALIST_TRAINING_CHANNEL_ID) return i.editReply('Set SPECIALIST_TRAINING_CHANNEL_ID in .env before creating a specialist session.');
    return openSpecialistCreation(i);
  }
  if (action === 'specialist-result') return openResultPanel(i, 'specialist');
  if (action === 'specialist-attendance') return openAttendance(i, 'specialist');
  if (action === 'specialist-roster') return showTrainingRoster(i, o.getString('event', true), 'specialist');
  if (action === 'wednesday') return configureWednesday(i);
  return serviceRecord(i,action,user);
}
function squadLeaderFor(userId) {
  const seat = Object.keys(sundayData.standing).find(key => sundayData.standing[key] === userId);
  const group = seat?.split(':')[0];
  return /^1-[1-5]$/.test(group ?? '') ? sundayData.standing[group+':1'] : undefined;
}

function opsCount(userId) {
  const starts = Object.values(sessions).flatMap(session => {
    const pass = session.results?.[userId];
    return trainingStage(session) === 't2' && pass?.result === 'passed' && pass.route === 'rangers'
      && Number.isFinite(pass.recordedAt) ? [pass.recordedAt] : [];
  });
  const since = starts.length ? Math.min(...starts) : 0;
  return Object.values(sundayData.events).filter(event => event.type === 'operation' && event.start >= since
    && event.attendance?.[userId]?.status === 'attended').length;
}

const probationLocks = new Set();
async function serviceRecord(i, action, user) {
  const member = await i.guild.members.fetch(user.id).catch(()=>null);
  if (!member) return i.editReply('That member is no longer on this server.');
  const count = opsCount(user.id);
  if (action === 'probation') {
    if (count < 3) return i.editReply('Three attended main operations are required. Recorded: '+count+'/3.');
    if (!SUNDAY_MEMBER_ROLE_ID || !PROBATIONARY_ROLE_ID || [RECRUIT_ROLE_ID, PROBATIONARY_ROLE_ID,
      COMMAND_ROLE_ID, TRAINING_CADRE_ROLE_ID, RESERVE_ROLE_ID, TAG_TEST_SERVER_ID].includes(SUNDAY_MEMBER_ROLE_ID)) {
      return i.editReply('Configure a distinct Full Member role as SUNDAY_MEMBER_ROLE_ID.');
    }
    const prior = sundayData.probationAwards?.[user.id];
    if (prior?.complete) return i.editReply('Probation has already been signed off.');
    if (!member.roles.cache.has(PROBATIONARY_ROLE_ID) && !prior) return i.editReply('That member needs the Probationary role.');
    if (probationLocks.has(user.id)) return i.editReply('Sign-off is already in progress.');
    probationLocks.add(user.id);
    const record = prior ?? { staffId:i.user.id, at:Date.now() };
    const store = value => saveSunday({...sundayData,probationAwards:{...sundayData.probationAwards,[user.id]:value}});
    try {
      const role = await i.guild.roles.fetch(SUNDAY_MEMBER_ROLE_ID);
      if (!role?.editable || role.managed || role.permissions.has('Administrator')) return i.editReply('The configured Full Member role cannot be assigned.');
      if (!prior) store(record);
      await member.roles.add(role);
      await member.roles.remove(PROBATIONARY_ROLE_ID);
      store({...record,complete:true});
      await sendPrivate(user,'Your Ranger probation has been signed off. You are now a Full Member.');
      return i.editReply('Probation signed off. Full Member granted.');
    } finally {
      probationLocks.delete(user.id);
    }
  }
  const events = Object.values(sundayData.events).filter(event => event.start <= Date.now()).sort((a,b)=>b.start-a.start);
  if (action === 'review') {
    const eligible = events.filter(event => {
      const expected = event.standingSeats ?? event.seats;
      return (Object.values(expected ?? {}).some(seat=>seat.memberId === user.id)
        || (!event.standingSeats && event.responses?.[user.id]))
        && !hasApprovedLeave(event,user.id);
    }).slice(0,8);
    const marks = eligible.map(event=>event.attendance?.[user.id]?.status
      ?? (event.responses?.[user.id]?.status === 'no_response' ? 'absent' : 'unmarked'));
    const attended = marks.filter(mark=>mark === 'attended').length;
    const marked = marks.filter(mark=>mark !== 'unmarked').length;
    const rate = marked ? Math.round(100*attended/marked) : null;
    return i.editReply('**Sunday attendance review**\n'+attended+'/'+marked+' marked eligible events attended'
      +(rate === null ? '.' : ' ('+rate+'%). '+(sundayData.memberDetails?.[user.id]?.attendanceExempt ? 'Exempt from the 75% requirement.' : 100*attended >= 75*marked ? 'Meets 75%.' : 'Below 75% · staff review.'))
      +'\n'+(eligible.length-marked)+' awaiting attendance marks.');
  }
  const training = Object.values(sessions).filter(event=>event.results?.[user.id]&&!event.results[user.id].unitAssessment).sort((a,b)=>b.start-a.start).slice(0,8)
    .map(event=>event.type+' · '+resultLabels[event.results[user.id].result]);
  const attendance = events.filter(event=>event.attendance?.[user.id]).slice(0,8)
    .map(event=>event.title+' · '+attendanceLabels[event.attendance[user.id].status]+' · <t:'+Math.floor(event.start/1000)+':d>');
  const roles = [...new Set([...Object.values(sundayData.courses ?? {}).map(course=>course.roleId),...Object.values(sundayData.qualifications ?? {})])]
    .filter(id=>member.roles.cache.has(id)).map(id=>'<@&'+id+'>');
  const pilot = Object.values(sessions).some(event=>trainingStage(event)==='t2' && event.results?.[user.id]?.result==='passed' && event.results[user.id].route==='pilot');
  const progression = member.roles.cache.has(SUNDAY_MEMBER_ROLE_ID) ? 'Full Member'
    : member.roles.cache.has(PROBATIONARY_ROLE_ID) ? 'Ranger probation · '+Math.min(count,3)+'/3 main ops'+(count>=3?' · Ready for sign-off':'')
      : pilot ? 'Awaiting 160th SOAR handover' : hasT1Pass(user.id) ? 'Ready to book T2' : 'Ready to book T1';
  const list = (name,values) => ({name,value:values.join('\n').slice(0,1024)||'None recorded'});
  return i.editReply({embeds:[{title:'TAG Service Record',color:0x507747,fields:[
    {name:'Member',value:tagName(user.id, member.displayName)},{name:'Progression',value:progression},
    list('Qualifications',roles),list('Recent training results',training),list('Recent Sunday attendance',attendance),
  ]}],allowedMentions:safeMentions});
}

async function workflowAutocomplete(i) {
  if (!opsStaff(i)) return i.respond([]);
  const query = i.options.getFocused().toLowerCase().trim();
  const kind = i.options.getSubcommand() === 'loa' ? 'sunday' : 'specialist';
  const options = listedEvents(kind).map(([value,event]) => ({name:eventChoice(value,event,kind).label,value}));
  return i.respond(options.filter(o=>o.name.toLowerCase().includes(query)).slice(0,25));
}

function configureWednesday(i) {
  if (!hasRole(i,COMMAND_ROLE_ID)) return i.editReply('Only Command can change recurring sessions.');
  const stage = i.options.getString('course',true);
  const enabled = i.options.getBoolean('enabled',true);
  const hour = i.options.getString('hour');
  const minute = i.options.getString('minute');
  const config = hour && minute ? hour+':'+minute : null;
  const recruits = i.options.getInteger('recruits');
  const cadre = i.options.getInteger('cadre') ?? 0;
  if (enabled && (!config || !parseUkStart('2027-01-06',config) || !recruits)) {
    return i.editReply('Choose the UK hour and minute, and enter the recruit capacity to enable this course.');
  }
  saveSunday({...sundayData,wednesdays:{...sundayData.wednesdays,[stage]:enabled?{time:config,recruits,cadre}:null}});
  return i.editReply('Wednesday '+stage.toUpperCase()+(enabled?' enabled at '+config+' UK. The bot publishes up to seven days ahead.':' disabled.'));
}

function trainingChannelId(session) {
  return session.channelId ?? BASIC_TRAINING_CHANNEL_ID;
}

async function updateTrainingCard(id) {
  const session = sessions[id];
  if (!session?.messageId || session.cardRemoved) return;
  const channel = await client.channels.fetch(trainingChannelId(session));
  const message = await channel.messages.fetch(session.messageId);
  await refreshPost(id,message);
}

function trainingEligibility(session, action, member) {
  if (coveredByLeave(session, member.id ?? member.user?.id)) return false;
  if (action === 'cadre') return clubRole(member,TRAINING_CADRE_ROLE_ID) ||
    session.scheduleActor && canOpenSignoff(member);
  if (session.trainingTrack) return [SUNDAY_MEMBER_ROLE_ID,PROBATIONARY_ROLE_ID,RESERVE_ROLE_ID,TRAINING_CADRE_ROLE_ID,COMMAND_ROLE_ID]
    .some(role=>clubRole(member,role)) || session.invitedPeople?.includes(member.id ?? member.user?.id);
  if (isSpecialist(session)) {
    const state=opsState();
    const key=session.unitQualification||Object.keys(sundayData.courses??{}).find(key=>sundayData.courses[key].roleId===session.qualificationRoleId);
    const id=member.id??member.user?.id;
    const settings=state?.settings.qualifications[key];
    if ((settings?.applications??['jtac','devgru operator'].includes(key)) && !Object.values(state?.applications??{}).some(item=>item.member===id&&item.qualification===key&&item.status==='approved')) return false;
    return [PROBATIONARY_ROLE_ID,SUNDAY_MEMBER_ROLE_ID,TRAINING_CADRE_ROLE_ID].some(role=>clubRole(member,role));
  }
  const profile = profiles[member.id];
  return clubRole(member,RECRUIT_ROLE_ID)
    && (trainingStage(session) !== 't2' || hasT1Pass(member.id)) && (!profile || profileOutcome(profile).canBook);
}

function vacancyButton(id,key) {
  return new ActionRowBuilder().addComponents(new ButtonBuilder()
    .setCustomId('cover:'+id+':'+key).setLabel('Take This Seat').setStyle(ButtonStyle.Success));
}

async function claimCover(i) {
  await i.deferReply({flags:i.inGuild()?ephemeral:undefined});
  const [,id,group,slot] = i.customId.split(':');
  const key = group+':'+slot;
  const guild = await client.guilds.fetch(TAG_TEST_SERVER_ID);
  const member = await guild.members.fetch({user:i.user.id,force:true}).catch(()=>null);
  const event = currentSundayEvent(id);
  if (!member || !event || event.start <= Date.now() || hasApprovedLeave(event,member.id)
      || event.responses?.[member.id]?.status === 'declined'
      || Object.values(event.seats).some(seat=>seat.memberId===member.id)
      || !eligibleSundaySeats(event,member.roles.cache,member.id).includes(key)) return i.editReply('That seat is no longer open to you.');
  saveSundayEvent(id,{...event,seats:{...event.seats,[key]:{memberId:member.id,status:'confirmed'}}});
  return i.editReply('You’re confirmed for **'+sundaySeatLabel(key)+'**.');
}

let workflowsBusy = false;
function pendingAttendanceMilestones(memberId, count, sent) {
  const milestones = [{ key: memberId + ':probation', label: 'Probation completed' }];
  for (let total = 13; total <= count; total += 10) {
    milestones.push({ key: memberId + ':' + total, label: total + ' main operations attended' });
  }
  return milestones.filter(milestone => !sent[milestone.key]);
}

async function notifyStaffAttendanceMilestones() {
  const channelId = MILESTONE_STAFF_CHANNEL_ID || LOA_STAFF_CHANNEL_ID;
  if (!channelId) return;
  const pending = Object.entries(sundayData.probationAwards ?? {}).flatMap(([memberId, award]) =>
    award.complete ? pendingAttendanceMilestones(memberId, opsCount(memberId), sundayData.attendanceMilestones ?? {})
      .map(milestone => ({ memberId, ...milestone })) : []);
  if (!pending.length) return;
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isSendable() || channel.guildId !== TAG_TEST_SERVER_ID) {
    throw new Error('The staff milestone channel must be writable in TAG MILSIM.');
  }
  for (const milestone of pending) {
    const nonce = createHash('sha256').update('tag-attendance:' + milestone.key).digest('hex').slice(0, 24);
    await channel.send({
      embeds: [{ title: milestone.label, description: '<@' + milestone.memberId + '>', color: 0x507747 }],
      allowedMentions: safeMentions, nonce, enforceNonce: true,
    });
    saveSunday({ ...sundayData, attendanceMilestones: {
      ...sundayData.attendanceMilestones, [milestone.key]: Date.now(),
    } });
  }
}

async function workflowTick(guild) {
  if (workflowsBusy) return;
  workflowsBusy = true;
  try {
    const steps = [
      ['Staff attendance milestones',notifyStaffAttendanceMilestones],
      ['Participation policy',()=>checkParticipation(guild)],
      ['Wednesday publishing',publishWednesdays],
      ['Training notifications',()=>trainingNotifications(guild)],
      ['Sunday notifications',()=>sundayNotifications(guild)],
    ];
    for (const [name, step] of steps) {
      try { await step(); } catch (error) { console.error(name+' failed:',error.message); }
    }
  } finally {
    workflowsBusy = false;
  }
}

let nextParticipationCheck = 0;
function legacyLeaveRanges(memberId) {
  return Object.values(sundayData.events).flatMap(event=>{
    const leave=event.loa?.[memberId];
    const marked=event.attendance?.[memberId]?.status === 'loa';
    if (!marked && !leave?.approved) return [];
    const from=ukDate(event.start);
    const to=leave?.returnDate ? ukDate(Date.parse(leave.returnDate+'T00:00:00Z')-86400000) : from;
    return [{from,to,withdrawnAt:leave?.withdrawnAt}];
  });
}

function updateParticipation(id, entry) {
  saveSunday({...sundayData,participation:{...sundayData.participation,[id]:entry}});
}

async function sendPolicyNotice(member, message) {
  if (await sendPrivate(member.user,message)) return true;
  const channelId=MILESTONE_STAFF_CHANNEL_ID || LOA_STAFF_CHANNEL_ID;
  if (!channelId) return false;
  const channel=await client.channels.fetch(channelId).catch(()=>null);
  if (channel?.guildId!==TAG_TEST_SERVER_ID || !channel.isSendable()) return false;
  return Boolean(await channel.send({content:'Could not DM <@'+member.id+'>. Please pass on this notice: '+message,
    allowedMentions:safeMentions}).catch(()=>null));
}

function clearStandingMember(id) {
  const standing=Object.fromEntries(Object.entries(sundayData.standing).filter(([,member])=>member!==id));
  saveSunday({...sundayData,standing});
  void refreshStandingRoster();
}

function releaseDepartedMember(memberId) {
  clearStandingMember(memberId);
  for (const [id,event] of Object.entries(sundayData.events)) {
    if (event.start<=Date.now()) continue;
    const seats=Object.fromEntries(Object.entries(event.seats).map(([key,seat])=>
      [key,seat.memberId===memberId?{status:'open'}:seat]));
    if (Object.values(event.seats).some(seat=>seat.memberId===memberId)) saveSundayEvent(id,{...event,seats});
  }
  for (const [id,session] of Object.entries(sessions)) {
    if (session.start<=Date.now() || (!session.bookings?.[memberId] && !session.waitlist?.[memberId])) continue;
    const bookings={...session.bookings},waitlist={...session.waitlist};
    delete bookings[memberId];
    delete waitlist[memberId];
    saveSession(id,{...session,bookings,waitlist});
    void updateTrainingCard(id).catch(error=>console.error('Training lineup update failed:',error.message));
  }
}

function participationRole(member) {
  const roles=member.roles.cache;
  return roles.has(RECRUIT_ROLE_ID) ? 'Recruit' : roles.has(RESERVE_ROLE_ID) ? 'Reserve'
    : roles.has(PROBATIONARY_ROLE_ID) ? 'Probationary' : roles.has(SUNDAY_MEMBER_ROLE_ID) ? 'Full Member' : 'Member';
}

function attendedT1(member) {
  return Object.values(sessions).some(session=>trainingStage(session)==='t1' && session.start>=member.joinedTimestamp &&
    (session.attendance?.[member.id]?.status==='attended' || ['passed','repeat'].includes(session.results?.[member.id]?.result)));
}

function hasCurrentLeave(memberId, now) {
  const today=Date.parse(ukDate(now)+'T00:00:00Z')/86400000;
  return leaveIntervals(sundayData.leaveRanges?.[memberId] ?? [],legacyLeaveRanges(memberId))
    .some(([from,to])=>from<=today && today<=to);
}

async function checkParticipation(guild) {
  const now=Date.now();
  if (now<nextParticipationCheck) return;
  nextParticipationCheck=now+10*60_000;
  const members=await guild.members.fetch();
  nextParticipationCheck=now+60*60_000;
  const sundays=recordedSundays(Object.values(sundayData.events),now);
  const directory={};
  for (const member of members.values()) {
    if (member.pending || member.user.bot || !member.joinedTimestamp) continue;
    const roles=member.roles.cache;
    const id=member.id;
    const person=sundayData.memberDetails?.[id];
    const role=participationRole(member);
    const previous=sundayData.participation?.[id];
    const sameMembership=previous?.joined===member.joinedTimestamp;
    const state=sameMembership ? {...previous} : {joined:member.joinedTimestamp};
    if (state.removedAt) continue;
    const legacy=legacyLeaveRanges(id);
    const intervals=leaveIntervals(sundayData.leaveRanges?.[id] ?? [],legacy);
    const currentDay=Date.parse(ukDate(now)+'T00:00:00Z')/86400000;
    const onLeave=intervals.some(([from,to])=>from<=currentDay && currentDay<=to);
    const activeRole = value=>value==='Full Member' || value==='Probationary';
    const activeSince = activeRole(role) && sameMembership && !activeRole(state.role)
      ? now : (state.activeSince ?? member.joinedTimestamp);
    const progress=sundayProgress(sundays,id,activeSince,event=>hasApprovedLeave(event,id));
    directory[id]={name:tagName(id,member.displayName),rank:person?.rank ?? '',status:role,
      qualifications:Object.values(sundayData.courses ?? {}).filter(course=>roles.has(course.roleId)).map(course=>course.name),roleIds:[...roles.keys()],
      medals:progress.medals,streak:progress.streak};
    if (!sameMembership || state.role!==role) {
      state.role=role;
      state.roleSince=now;
      state.activeSince=activeSince;
      state.notice=null;
      state.removalNoticeAt=null;
      updateParticipation(id,state);
    }

    // The website applies the rolling ten-week policy to active members after closeout.
    if (role==='Full Member' || role==='Probationary') continue;
    const t1Done=role==='Recruit' && attendedT1(member);
    const type=role==='Recruit' && !t1Done ? 'recruit' : role==='Reserve' && !person?.reserveExempt ? 'reserve' : null;
    const lastActivity=type==='reserve' ? Math.max(state.roleSince,...sundays.filter(event=>event.attendance?.[id]?.status==='attended').map(event=>event.start)) : member.joinedTimestamp;
    const episode=type==='member' ? progress.episode : lastActivity;
    const notice=state.notice?.type===type && state.notice.episode===episode ? state.notice : null;
    if (state.notice && !notice) {
      state.notice=null;
      state.removalNoticeAt=null;
      updateParticipation(id,state);
    }
    if (!type || onLeave && type!=='recruit') continue;
    const step=participationStage({type,now,base:lastActivity,missed:progress.missed,notice});
    if (!step) continue;
    if (step.stage) {
      const text=type==='recruit' ? 'You have not completed Basic Training T1 and are being considered inactive. Attend T1 within one week to avoid removal from TAG.'
        : type==='reserve' ? 'You have been inactive in Reserve for three months. Attend a Sunday event or contact Command about an exemption within two weeks to avoid removal.'
        : step.stage===4 ? 'Final TAG inactivity warning: four recorded Sunday weeks missed. Attend a Sunday event to avoid removal after a fifth missed week.'
        : 'TAG inactivity warning: '+step.stage+' recorded Sunday weeks missed. Please attend the next Sunday event or file leave if needed.';
      if (await sendPolicyNotice(member,text)) updateParticipation(id,{...state,notice:{type,episode,stage:step.stage,at:now}});
      continue;
    }
    if (!member.kickable) continue;
    const eligibleNow = () => {
      if (type === 'recruit') return !attendedT1(member);
      if (hasCurrentLeave(id,Date.now())) return false;
      const latest=recordedSundays(Object.values(sundayData.events),Date.now());
      if (type==='reserve') return !sundayData.memberDetails?.[id]?.reserveExempt &&
        !latest.some(event=>event.start>episode && event.attendance?.[id]?.status==='attended');
      const current=sundayProgress(latest,id,activeSince,event=>hasApprovedLeave(event,id));
      return current.episode===episode && current.missed>=5;
    };
    try {
      const currentMember=await guild.members.fetch({user:id,force:true}).catch(()=>null);
      if (!currentMember?.kickable || currentMember.joinedTimestamp!==member.joinedTimestamp ||
          participationRole(currentMember)!==role || !eligibleNow()) continue;
      if (!state.removalNoticeAt) {
        if (!await sendPolicyNotice(member,'You are being removed from TAG due to inactivity. Contact Command if you would like to return.')) continue;
        state.removalNoticeAt=Date.now();
        updateParticipation(id,state);
      }
      if (!eligibleNow() || participationRole(currentMember)!==role) continue;
      await currentMember.kick('TAG inactivity policy: '+type);
      updateParticipation(id,{...state,removedAt:Date.now()});
      releaseDepartedMember(id);
      delete directory[id];
    } catch (error) { console.error('TAG inactivity removal failed for',id,error.message); }
  }
  saveSunday({...sundayData,unitDirectory:directory,directoryUpdatedAt:now,unitRoleIds:{
    recruit:RECRUIT_ROLE_ID,reserve:RESERVE_ROLE_ID,probation:PROBATIONARY_ROLE_ID,full:SUNDAY_MEMBER_ROLE_ID,
  }});
}

async function publishWednesdays() {
  const today = new Date(ukClock.format(Date.now()).slice(0,10)+'T00:00:00Z');
  const offset = (10-today.getUTCDay())%7;
  const dateFor = days => new Date(today.getTime()+days*86_400_000).toISOString().slice(0,10);
  for (const [stage,config] of Object.entries(sundayData.wednesdays ?? {})) {
    if (!config) continue;
    let start = parseUkStart(dateFor(offset),config.time);
    if (start && start <= Date.now() && offset === 0) start = parseUkStart(dateFor(7),config.time);
    if (!start || start <= Date.now()) continue;
    const id = String(start*10+(stage==='t1'?1:2));
    if (sessions[id]?.messageId || cancelledSessions[id] || Object.values(sessions).some(s=>s.start===start && trainingStage(s)===stage && s.messageId)) continue;
    const session = {start,stage,type:'Basic Training '+stage.toUpperCase(),recruitSlots:config.recruits,cadreSlots:config.cadre,bookings:{}};
    const channel = await client.channels.fetch(BASIC_TRAINING_CHANNEL_ID);
    const message = await channel.send({...sessionPost(id,session),nonce:id,enforceNonce:true});
    saveSession(id,{...session,messageId:message.id});
  }
}

async function trainingNotifications(guild) {
  for (const [id, initial] of Object.entries(sessions)) {
    if (initial.start <= Date.now() || !initial.messageId) continue;
    releaseTrainingLeave(id);
    let changed = false;
    for (const [userId, role] of Object.entries(initial.waitlist ?? {})) {
      const current = sessions[id];
      if (!current) break;
      const capacity = role==='cadre'?current.cadreSlots:current.recruitSlots;
      if (standardBookings(current,role) >= capacity) continue;
      const member = await guild.members.fetch(userId).catch(()=>null);
      const latest = sessions[id];
      if (!latest?.waitlist?.[userId] || latest.start <= Date.now()) continue;
      if (standardBookings(latest,role) >= capacity) continue;
      const waitlist = {...latest.waitlist};
      delete waitlist[userId];
      const eligible = member && trainingEligibility(latest,role,member);
      saveSession(id,{...latest,waitlist,bookings:eligible?{...latest.bookings,[userId]:role}:latest.bookings});
      if (eligible) {
        changed = true;
        await sendPrivate(member.user,'Your waitlist seat is now confirmed for **'+latest.type+'** at <t:'+Math.floor(latest.start/1000)+':F>.');
      }
    }
    if (changed) await updateTrainingCard(id).catch(error=>console.error('Training card refresh failed:',error.message));
  }
}

function releaseTrainingLeave(id) {
  const event = sessions[id];
  if (!event || event.start <= Date.now()) return;
  const released = Object.entries(event.bookings ?? {}).filter(([memberId]) => coveredByLeave(event, memberId));
  if (!released.length) return;
  const bookings = { ...event.bookings };
  for (const [memberId] of released) delete bookings[memberId];
  saveSession(id, { ...event, bookings, leaveBookings:{ ...event.leaveBookings, ...Object.fromEntries(released) } });
  void updateTrainingCard(id).catch(error => console.error('LOA training card update failed:', error.message));
}

function applyApprovedLeave(id, event) {
  const released = Object.entries(event.seats).filter(([, seat]) => seat.memberId && hasApprovedLeave(event,seat.memberId));
  if (!released.length) return;
  const seats = {...event.seats};
  const coverPending = {...event.coverPending};
  const leaveSeats = {...event.leaveSeats};
  for (const [key, seat] of released) {
    leaveSeats[seat.memberId] = key;
    seats[key] = {status:'open'};
    coverPending[key] = 'leave:'+Date.now();
  }
  saveSundayEvent(id,{...event,seats,coverPending,leaveSeats});
}

const eventReminders = [[5,'5m'],[15,'15m'],[60,'1h'],[360,'6h'],[720,'12h'],[1440,'24h']];
function reminderState(kind,id,memberId) {
  const event=(kind==='training'?sessions:sundayData.events)[id];
  if (!event || event.archivedAt || event.cancelledAt || event.start<=Date.now()) return null;
  const phase=eventReminders.find(([minutes])=>event.start-Date.now()<=minutes*60_000)?.[1];
  if (!phase) return null;
  const key=memberId+':'+event.start+':'+phase;
  if (event.startReminders?.[key]) return null;
  if (kind==='training') {
    if (!event.messageId || !event.bookings?.[memberId] || coveredByLeave(event,memberId) ||
        phase==='24h' && event.reminders?.[memberId+':24h'] || phase==='1h' && event.reminders?.[memberId+':1h']) return null;
    return {event,phase,key,channel:trainingChannelId(event),post:event.messageId};
  }
  if (!event.postId || hasApprovedLeave(event,memberId) || phase==='1h' && event.opReminders?.[memberId]) return null;
  const slot=Object.entries(event.seats).find(([,seat])=>seat.memberId===memberId&&seat.status==='confirmed')?.[0];
  return slot ? {event,phase,key,channel:event.postChannelId??UPCOMING_OPS_CHANNEL_ID,post:event.postId,slot} : null;
}
async function sendEventReminder(kind,id,memberId) {
  if (!reminderState(kind,id,memberId)) return;
  const user=await client.users.fetch(memberId).catch(()=>null);
  const current=reminderState(kind,id,memberId);
  if (!user || user.bot || !current) return;
  const {event,phase,key,channel,post,slot}=current;
  const location=channel&&post?'\nhttps://discord.com/channels/'+TAG_TEST_SERVER_ID+'/'+channel+'/'+post:'';
  let result='sent';
  try {
    await user.send({content:'**'+(event.title||event.type)+'** starts <t:'+Math.floor(event.start/1000)+':R> (reminder '+phase+').'
      +(slot?'\nYour slot: '+sundaySeatLabel(slot):'')+location,allowedMentions:safeMentions,
      nonce:createHash('sha256').update('start:'+kind+':'+id+':'+key).digest('hex').slice(0,25),enforceNonce:true});
  } catch (error) {
    if (error.code!==50007) { console.warn('Event reminder delivery failed:',error.message); return; }
    result='dm_unavailable';
  }
  const latest=(kind==='training'?sessions:sundayData.events)[id];
  if (!latest || latest.start!==event.start) return;
  const updated={...latest,startReminders:{...latest.startReminders,[key]:result}};
  if (kind==='training') saveSession(id,updated); else saveSundayEvent(id,updated,{refresh:false});
}

let reminderTickBusy=false;
async function sendDueEventReminders() {
  if (reminderTickBusy) return;
  reminderTickBusy=true;
  try {
    const due=[];
    for (const [kind,events] of [['sunday',sundayData.events],['training',sessions]]) {
      for (const [id,event] of Object.entries(events)) {
        if (event.start<=Date.now()||event.start-Date.now()>86_400_000) continue;
        const members=kind==='training'?Object.keys(event.bookings??{}):
          [...new Set(Object.values(event.seats??{}).filter(seat=>seat.memberId&&seat.status==='confirmed').map(seat=>seat.memberId))];
        for (const member of members) if (reminderState(kind,id,member)) due.push({kind,id,member,start:event.start});
      }
    }
    due.sort((a,b)=>a.start-b.start);
    for (let index=0;index<due.length;index+=6) {
      const outcomes=await Promise.allSettled(due.slice(index,index+6).map(({kind,id,member})=>sendEventReminder(kind,id,member)));
      for (const result of outcomes) if (result.status==='rejected') console.warn('Event reminder worker failed:',result.reason?.name);
    }
  } finally { reminderTickBusy=false; }
}

async function sundayNotifications(guild) {
  let candidates;
  for (const id of Object.keys(sundayData.events)) {
    const event = currentSundayEvent(id);
    if (!event.postId || event.start <= Date.now()) continue;
    applyApprovedLeave(id, event);
    const updated = sundayData.events[id];
    if (!updated) continue;
    for (const [key, seat] of Object.entries(updated.seats)) {
      const check = () => {
        const current = sundayData.events[id];
        const assigned = current?.seats[key];
        const deadline = assigned?.confirmBy ?? current?.confirmBy;
        if (!current || !seat.memberId || assigned?.memberId !== seat.memberId ||
            assigned.status !== 'awaiting_confirmation' || !(deadline > Date.now() && deadline-Date.now() <= 86_400_000) ||
            current.confirmReminders?.[seat.memberId] || hasApprovedLeave(current,seat.memberId)) return null;
        return {current,deadline};
      };
      if (!check()) continue;
      const user = await client.users.fetch(seat.memberId).catch(()=>null);
      const reminder = check();
      if (!user || !reminder) continue;
      const {current,deadline} = reminder;
      saveSundayEvent(id,{...current,confirmReminders:{...current.confirmReminders,[seat.memberId]:true}},{refresh:false});
      await sendPrivate(user,'Reminder: confirm your seat for **'+current.title+'** by <t:'+Math.floor(deadline/1000)+':F>. Use your original confirmation DM.');
    }
    for (const [key, revision] of Object.entries(sundayData.events[id].coverPending ?? {})) {
      const latest = currentSundayEvent(id);
      if (latest?.coverPending?.[key] !== revision) continue;
      const seatIsOpen = latest.seats[key]?.status === 'open' && !latest.seats[key]?.memberId;
      if (seatIsOpen) candidates ??= await guild.members.fetch();
      const current = currentSundayEvent(id);
      if (current?.coverPending?.[key] !== revision) continue;
      const pending = {...current.coverPending};
      delete pending[key];
      saveSundayEvent(id,{...current,coverPending:pending},{refresh:false});
      if (!seatIsOpen) continue;
      for (const member of candidates.values()) {
        const active = currentSundayEvent(id);
        if (!active || active.start <= Date.now() || active.seats[key]?.status !== 'open') break;
        if (member.user.bot || member.pending || hasApprovedLeave(active,member.id) || active.responses?.[member.id]?.status === 'declined'
            || Object.values(active.seats).some(seat=>seat.memberId===member.id)
            || !eligibleSundaySeats(active,member.roles.cache,member.id).includes(key)) continue;
        await member.send({content:'Cover requested for **'+sundaySeatLabel(key)+'** on **'+active.title+'**.',
          components:[vacancyButton(id,key)],allowedMentions:safeMentions}).catch(()=>{});
      }
    }
  }
}

function openSpecialistCreation(interaction) {
  for (const [id, draft] of creationDrafts) if (draft.expires <= Date.now() && !draft.publishing) creationDrafts.delete(id);
  const draft = { id: interaction.id, owner: interaction.user.id, specialist: true, expires: Date.now()+15*60_000 };
  creationDrafts.set(draft.id,draft);
  return interaction.editReply(creationScreen(draft));
}

async function notifyProbation(memberId) {
  if (opsCount(memberId) < 3 || sundayData.probationNotices?.[memberId]) return;
  const guild = await client.guilds.fetch(TAG_TEST_SERVER_ID);
  const member = await guild.members.fetch(memberId).catch(()=>null);
  if (!member?.roles.cache.has(PROBATIONARY_ROLE_ID) || sundayData.probationNotices?.[memberId]) return;
  saveSunday({...sundayData,probationNotices:{...sundayData.probationNotices,[memberId]:true}});
  await sendPrivate(member.user,'You’ve attended three main operations. Ask your squad lead or Cadre to sign off your probation.');
  const leadId = squadLeaderFor(memberId);
  if (leadId && leadId !== memberId) {
    const lead = await client.users.fetch(leadId).catch(()=>null);
    if (lead) await sendPrivate(lead,'<@'+memberId+'> has completed three main operations. Use /tag probation to review their sign-off.');
  }
}

const commandGuide = new SlashCommandBuilder().setName('commands').setDescription('Show TAG bot commands and what they do.');
const postingTestCommand = new SlashCommandBuilder().setName('basic-training-test').setDescription('Check that the bot can post in Basic Training.');
const registeredCommands = [
  trainingCommand, onboardingCommand, sundayCommand, workflowsCommand, commandGuide, postingTestCommand,
];

function commandGuidePost() {
  const cards = [
    ['Training', [trainingCommand, postingTestCommand]],
    ['Recruitment', [onboardingCommand]],
    ['Sunday operations and platoon training', [sundayCommand]],
    ['Specialist training and personnel', [workflowsCommand]],
    ['Help', [commandGuide]],
  ].flatMap(([name, builders]) => {
    const lines = builders.flatMap(builder => {
      const command = builder.toJSON();
      const children = command.options?.filter(option => option.type === 1) ?? [];
      return children.length
        ? children.map(child => '**/'+command.name+' '+child.name+'** — '+child.description)
        : ['**/'+command.name+'** — '+command.description];
    });
    const fields = [];
    for (const line of lines) {
      const field = fields.at(-1);
      if (field && field.value.length + line.length + 1 <= 1024) field.value += '\n' + line;
      else fields.push({ name: fields.length ? name + ' (continued)' : name, value: line });
    }
    return fields;
  });
  return {
    embeds: [{ title: 'TAG Command Guide', color: 0x507747,
      description: 'Use these commands in TAG MILSIM. Staff actions require the appropriate Discord role.',
      fields: cards }],
    allowedMentions: safeMentions,
  };
}

client.once(Events.ClientReady, async () => {
  try {
    const guild = await client.guilds.fetch(TAG_TEST_SERVER_ID);
    for (const command of registeredCommands) await guild.commands.create(command.toJSON());
    const syncNames = () => { void refreshDiscordMemberNames(guild); };
    syncNames();
    setInterval(syncNames,5*60_000).unref();
    const tick = () => workflowTick(guild).catch(error=>console.error('TAG workflow maintenance failed:',error.message));
    startWebsiteBridge(guild);
    tick();
    setInterval(tick,30_000).unref();
    const remind=()=>void sendDueEventReminders().catch(error=>console.warn('Event reminders unavailable:',error.name));
    remind();
    setInterval(remind,20_000).unref();
    runMaintenance();
    setInterval(runMaintenance, 30_000).unref();
    if (ROSTER_CHANNEL_ID) {
      void refreshStandingRoster();
      setInterval(() => {
        if (rosterPostDirty) void refreshStandingRoster();
      }, 30_000).unref();
    }
    const releaseSeats = () => {
      try {
        for (const id of Object.keys(sundayData.events)) currentSundayEvent(id);
      } catch (error) {
        console.error('Sunday seat deadline check failed:', error.message);
      }
    };
    releaseSeats();
    setInterval(releaseSeats, 30_000).unref();
    for (const [id, event] of Object.entries(sundayData.events)) {
      if (event.postId && event.start > Date.now()) void refreshSundayPost(id);
    }
    console.log(`Ready in ${guild.name}. Run /basic-training create.`);
  } catch (error) {
    console.error('Could not register the command:', error.message);
    client.destroy();
    process.exitCode = 1;
  }
});

client.on(Events.InteractionCreate, async interaction => {
  const recruitForm = (interaction.isButton() && ['tag:profile', 'tag:profile-name', 'tag:edit-name'].includes(interaction.customId))
    || (interaction.isModalSubmit() && ['tag:answers','tag:save-name'].includes(interaction.customId))
    || (interaction.isStringSelectMenu() && /^tag:(q|unit):/.test(interaction.customId));
  const sundaySignup = (interaction.isButton() || interaction.isStringSelectMenu())
    && interaction.customId.startsWith('suo:');
  const privateWorkflow = (interaction.isModalSubmit() && interaction.customId.startsWith('loa:'))
    || (interaction.isButton() && interaction.customId.startsWith('cover:'));
  if (interaction.guildId !== TAG_TEST_SERVER_ID && (interaction.inGuild() || (!recruitForm && !sundaySignup && !privateWorkflow))) return;
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'commands') {
      await interaction.reply({ ...commandGuidePost(), flags: ephemeral });
    } else if ((interaction.isButton() || interaction.isStringSelectMenu() || interaction.isRoleSelectMenu())
        && interaction.customId.startsWith('qcp:')) {
      await handleQualificationPanel(interaction);
    } else if (privateWorkflow) {
      if (interaction.isModalSubmit()) await submitLeave(interaction);
      else await claimCover(interaction);
    } else if (interaction.isAutocomplete() && interaction.commandName === 'tag') {
      await workflowAutocomplete(interaction);
    } else if (interaction.isChatInputCommand() && interaction.commandName === 'tag') {
      await handleWorkflowCommand(interaction);
    } else if ((interaction.isButton() || interaction.isStringSelectMenu() || interaction.isUserSelectMenu())
        && interaction.customId.startsWith('stp:')) {
      await handleStandingPicker(interaction);
    } else if (sundaySignup) {
      await handleSundaySignup(interaction);
    } else if (interaction.isAutocomplete() && ['sunday', 'basic-training'].includes(interaction.commandName)) {
      await rosterAutocomplete(interaction);
    } else if ((interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit())
        && interaction.customId.startsWith('suw:')) {
      await handleSundayWizard(interaction);
    } else if ((interaction.isButton() || interaction.isStringSelectMenu()) && interaction.customId.startsWith('att:')) {
      await handleAttendance(interaction);
    } else if (interaction.isChatInputCommand() && interaction.commandName === 'sunday') {
      await handleSunday(interaction);
    } else if (interaction.isChatInputCommand() && interaction.commandName === 'recruit') {
      await handleRecruitStaff(interaction);
    } else if (recruitForm) {
      await handleRecruitForm(interaction);
    } else if ((interaction.isButton() || interaction.isStringSelectMenu())
        && interaction.customId.startsWith('btr:')) {
      await handleResultPanel(interaction);
    } else if ((interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit())
        && interaction.customId.startsWith('btw:')) {
      await handleCreationWizard(interaction);
    } else if (interaction.isButton() && /^bt:(recruit|cadre|cancel):[a-zA-Z0-9-]{1,63}$/.test(interaction.customId)) {
      await handleBooking(interaction);
    } else if (interaction.isChatInputCommand() && ['basic-training', 'basic-training-test'].includes(interaction.commandName)) {
      await handleStaff(interaction);
    }
  } catch (error) {
    console.error('Basic Training interaction failed:', error.message);
    if (!interaction.isAutocomplete() && interaction.deferred) {
      await interaction.editReply({ content: 'The bot could not complete that action. Check the bot console.' }).catch(() => {});
    }
  }
});

function startWebsiteBridge(guild) {
  const secret = process.env.TAG_WEB_BRIDGE_KEY;
  if (!secret || !/^[a-f0-9]{64}$/.test(secret)) return;
  let sequence = 0n;
  const webEventId = () => (((BigInt(Date.now()) - 1420070400000n) << 22n) | (4190208n + (sequence++ % 4096n))).toString();
  const bridge = createServer(async (request, response) => {
    const send = (status, message) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ message }));
    };
    const supplied = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from('Bearer ' + secret);
    if (request.method !== 'POST' || request.url !== '/' || supplied.length !== expected.length
        || !timingSafeEqual(supplied, expected)) return send(403, 'Access denied.');
    try {
      let raw = '';
      for await (const chunk of request) {
        raw += chunk;
        if (raw.length > 8192) return send(413, 'Request too large.');
      }
      const { actor, action, values } = JSON.parse(raw) ?? {};
      if (action==='unit-job') {
        try { return send(200,await runUnitJob(guild,values?.id)); }
        catch (error) {
          if (error instanceof UnitJobError) return send(error.status,error.message);
          if (error.code===50013 || error.code===50001) return send(403,'The bot lacks the required Discord permissions.');
          console.error('TAG management delivery failed:',error.name,error.code??'');
          return send(503,'The TAG bot could not complete this delivery.');
        }
      }
      if (!/^\d{17,20}$/.test(actor ?? '') || !values || typeof values !== 'object') return send(400, 'Invalid request.');
      const member = await guild.members.fetch({ user: actor, force: true }).catch(() => null);
      if (!member || member.pending || member.user.bot) return send(403, 'TAG membership required.');
      const command = Boolean(COMMAND_ROLE_ID && member.roles.cache.has(COMMAND_ROLE_ID));
      const staff = command || Boolean(TRAINING_CADRE_ROLE_ID && member.roles.cache.has(TRAINING_CADRE_ROLE_ID));
      if (action === 'confirm-standing') {
        if (typeof values.event !== 'string' || !/^[a-zA-Z0-9-]{1,63}$/.test(values.event)) return send(400,'Choose an operation.');
        return confirmStandingSeat(values.event,actor)
          ? send(200,'Your attendance is confirmed.') : send(409,'This confirmation is no longer available.');
      }
      if (action==='training-channels') {
        if (!staff && !canOpenSignoff(member)) return send(403,'Staff access required.');
        const channels=await guild.channels.fetch();
        return send(200,[...channels.values()].filter(channel=>trainingChannelAllowed(channel,guild,member))
          .map(({id,name})=>({id,name})).sort((a,b)=>a.name.localeCompare(b.name)));
      }
      if (!['leave','withdraw-leave','edit-leave','member-details'].includes(action) && !staff) return send(403, 'Staff access required.');
      if (['attendance','approve-leave'].includes(action) &&
          !/^[a-zA-Z0-9-]{1,63}$/.test(values.event ?? '')) return send(400, 'Choose an existing event.');
      if (['attendance','approve-leave'].includes(action) &&
          !/^\d{17,20}$/.test(values.member ?? '')) return send(400, 'Choose an existing member.');
      if (action === 'attendance') {
        if (!['sunday','basic','specialist'].includes(values.kind) ||
          !markAttendance(values.kind, values.event, values.member, values.status, actor)) {
          return send(409, 'This attendance mark is no longer available.');
        }
        return send(200, 'Attendance saved.');
      }
      if (action === 'leave') {
        const target = values.member ?? actor;
        if (target !== actor && !staff) return send(403,'Staff access required.');
        if (typeof target !== 'string' || !/^\d{17,20}$/.test(target)) return send(400,'Choose a member.');
        if (target !== actor) {
          const recipient = await guild.members.fetch({user:target,force:true}).catch(()=>null);
          if (!recipient || recipient.pending || recipient.user.bot) return send(404,'Active member not found.');
        }
        const { from, to } = values;
        const reason = typeof values.reason === 'string' ? values.reason.trim() : '';
        const valid = date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && parseUkStart(date,'12:00');
        if (!valid(from) || !valid(to) || to < from || from < ukClock.format(Date.now()).slice(0,10) || !reason || reason.length > 400) {
          return send(400, 'Choose a date range starting today or later, and enter a reason.');
        }
        const current = sundayData.leaveRanges?.[target] ?? [];
        if (!leaveWithinLimit([...current,{from,to}],Date.now(),legacyLeaveRanges(target))) return send(400,'Leave may cover at most 42 consecutive days.');
        if (!current.some(item => !item.withdrawnAt && item.from === from && item.to === to)) {
          const leaveRanges = { ...sundayData.leaveRanges,
            [target]: [...current, { from, to, reason, submittedAt:Date.now() }],
          };
          saveSunday({ ...sundayData, leaveRanges });
        }
        for (const [id,event] of Object.entries(sundayData.events)) {
          if (event.start > Date.now()) applyApprovedLeave(id,event);
        }
        for (const id of Object.keys(sessions)) releaseTrainingLeave(id);
        return send(200, 'LOA recorded for both dates and all days in between.');
      }
      if (action === 'edit-leave') {
        const target = values.member ?? actor;
        if (target !== actor && !staff) return send(403,'Staff access required.');
        const reason = typeof values.reason === 'string' ? values.reason.trim() : '';
        if (typeof target !== 'string' || !/^\d{17,20}$/.test(target) || !reason || reason.length > 400) return send(400,'Enter a reason.');
        if (values.event !== undefined) {
          if (typeof values.event !== 'string' || !Object.hasOwn(sundayData.events,values.event)) return send(404,'Event not found.');
          const event = sundayData.events[values.event];
          const leave = event.loa?.[target];
          if (!leave || leave.withdrawnAt || leave.submittedAt !== values.submittedAt || event.start <= Date.now()) return send(409,'This LOA is no longer editable.');
          saveSundayEvent(values.event,{ ...event,loa:{ ...event.loa,[target]:{ ...leave,reason,editedBy:actor,editedAt:Date.now() } } },{refresh:false});
          return send(200,'Leave reason updated.');
        }
        const ranges = sundayData.leaveRanges?.[target] ?? [];
        const entry = Number.isSafeInteger(values.index) && ranges[values.index];
        if (!entry || entry.withdrawnAt || entry.submittedAt !== values.submittedAt) return send(409,'This LOA is no longer editable.');
        const {from,to} = values;
        const valid = date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && parseUkStart(date,'12:00');
        const today = ukClock.format(Date.now()).slice(0,10);
        if (!valid(from) || !valid(to) || from > to || to < today || (from < today && from !== entry.from)) return send(400,'Choose valid leave dates ending today or later.');
        const changedRange = from !== entry.from || to !== entry.to;
        const now = Date.now();
        const updated = ranges.map((leave,index)=>index !== values.index ? leave : changedRange
          ? {...leave,withdrawnAt:now,withdrawnBy:actor}
          : {...leave,reason,editedAt:now,editedBy:actor});
        if (changedRange) updated.push({from:from < today ? today : from,to,reason,submittedAt:now,effectiveAt:now,editedBy:actor});
        if (!leaveWithinLimit(updated,now,legacyLeaveRanges(target))) return send(400,'Leave may cover at most 42 consecutive days.');
        saveSunday({...sundayData,leaveRanges:{...sundayData.leaveRanges,[target]:updated}});
        for (const [id,event] of Object.entries(sundayData.events)) if (event.start > now) applyApprovedLeave(id,event);
        for (const id of Object.keys(sessions)) releaseTrainingLeave(id);
        return send(200,'LOA updated. Any remaining places can be booked again.');
      }
      if (action === 'withdraw-leave') {
        const target = values.member ?? actor;
        if (target !== actor && !staff) return send(403, 'Staff access required to withdraw another member’s LOA.');
        if (typeof target !== 'string' || !/^\d{17,20}$/.test(target)) return send(400, 'Choose a leave request.');
        if (values.event !== undefined) {
          if (typeof values.event !== 'string' || !/^[a-zA-Z0-9-]{1,63}$/.test(values.event)) return send(400, 'Choose an event.');
          const training = values.kind === 'training';
          const event = (training ? sessions : sundayData.events)[values.event];
          const request = event?.loa?.[target];
          const mark = event?.attendance?.[target];
          const leave = request && !request.withdrawnAt ? request : mark?.status === 'loa' ? { submittedAt:mark.markedAt } : request;
          if (!leave || leave.submittedAt !== values.submittedAt) return send(404, 'Leave request not found. Refresh the dashboard.');
          if (leave.withdrawnAt) return send(200, 'LOA is already withdrawn.');
          if (event.start <= Date.now()) return send(409, 'This event has already started.');
          const responses = { ...event.responses };
          if (responses[target]?.status === 'declined') delete responses[target];
          const attendance = { ...event.attendance };
          if (attendance[target]?.status === 'loa') delete attendance[target];
          const updated = { ...event, responses, attendance, loa:{
            ...event.loa, [target]:{ ...leave, withdrawnAt:Date.now(), withdrawnBy:actor },
          } };
          if (training) saveSession(values.event,updated);
          else saveSundayEvent(values.event,updated);

          return send(200, 'Event LOA withdrawn. You can sign up again where a place is available.');
        }
        if (typeof target !== 'string' || !/^\d{17,20}$/.test(target) || !Number.isSafeInteger(values.index) || values.index < 0) {
          return send(400, 'Choose a leave request.');
        }
        const ranges = sundayData.leaveRanges?.[target] ?? [];
        const range = ranges[values.index];
        if (!range || range.submittedAt !== values.submittedAt) return send(404, 'Leave request not found. Refresh the dashboard.');
        if (range.withdrawnAt) return send(200, 'LOA is already withdrawn.');
        if (range.to < ukClock.format(Date.now()).slice(0,10)) return send(409, 'This LOA has already ended.');
        const updated = ranges.map((entry,index) => index === values.index
          ? { ...entry, withdrawnAt:Date.now(), withdrawnBy:actor } : entry);
        saveSunday({ ...sundayData, leaveRanges:{ ...sundayData.leaveRanges, [target]:updated } });
        return send(200, 'LOA withdrawn for upcoming events. You can sign up again where a place is available.');
      }
      if (action === 'approve-leave') {
        const event = sundayData.events[values.event];
        const leave = event?.loa?.[values.member];
        if (!leave || leave.withdrawnAt) return send(404, 'Active leave request not found.');
        if (!leave.approved) saveSundayEvent(values.event, { ...event,
          loa: { ...event.loa, [values.member]: { ...leave, approved: true, approvedBy: actor } },
        }, { refresh: false });
        return send(200, 'Leave approved.');
      }
      if (['member-admin','member-role','member-rank'].includes(action)) {
        if (!command) return send(403, 'Command access required.');
        if (typeof values.member !== 'string' || !/^\d{17,20}$/.test(values.member)) return send(400, 'Choose a member.');
        const target = await guild.members.fetch({ user:values.member, force:true }).catch(() => null);
        if (!target || target.pending || target.user.bot) return send(404, 'TAG member not found.');
        if (action === 'member-rank') {
          if (typeof values.rank !== 'string' || (values.rank && !Object.hasOwn(ranks,values.rank))) return send(400,'Choose a rank from the list.');
          if (['attendanceRequired','attendanceExempt','reserveExempt'].some(key => values[key] !== undefined && typeof values[key] !== 'boolean')) {
            return send(400, 'Choose valid attendance settings.');
          }
          const details = { ...sundayData.memberDetails?.[target.id], rank:values.rank.trim(), editedBy:actor, editedAt:Date.now() };
          if (details.displayName) details.displayName=baseDisplayName(details.displayName,details.rank || sundayData.memberDetails?.[target.id]?.rank);
          for (const key of ['attendanceRequired','attendanceExempt','reserveExempt']) if (typeof values[key] === 'boolean') details[key] = values[key];
          if (values.reserveExemptionReason !== undefined) {
            if (typeof values.reserveExemptionReason !== 'string' || values.reserveExemptionReason.length>160) return send(400,'Enter an exemption reason up to 160 characters.');
            details.reserveExemptionReason=details.reserveExempt?values.reserveExemptionReason.trim():'';
          }
          saveSunday({ ...sundayData, memberDetails:{ ...sundayData.memberDetails, [target.id]:details } });
          return send(200, await nicknameResult(guild,target.id,'Member details saved.'));
        }
        const canManage = role => role && role.id !== guild.id && role.editable && !role.managed &&
          role.permissions.bitfield === 0n && ![COMMAND_ROLE_ID,TRAINING_CADRE_ROLE_ID].includes(role.id);
        if (action === 'member-role') {
          if (typeof values.add !== 'boolean' || typeof values.role !== 'string' || !/^\d{17,20}$/.test(values.role)) return send(400, 'Choose a role.');
          const role = await guild.roles.fetch(values.role);
          if (!target.manageable || !canManage(role)) return send(409, 'This role or member must be managed in Discord.');
          if (values.add) await target.roles.add(role, 'TAG portal by ' + actor);
          else await target.roles.remove(role, 'TAG portal by ' + actor);
          return send(200, values.add ? 'Role added.' : 'Role removed.');
        }
        const qualifications = new Set(Object.values(sundayData.courses ?? {}).map(course => course.roleId));
        const roles = await guild.roles.fetch();
        return send(200, [{ rank:canonicalRank(sundayData.memberDetails?.[target.id]?.rank), ranks:Object.entries(ranks),
          attendanceRequired:sundayData.memberDetails?.[target.id]?.attendanceRequired !== false,
          attendanceExempt:sundayData.memberDetails?.[target.id]?.attendanceExempt === true,
          reserveExempt:sundayData.memberDetails?.[target.id]?.reserveExempt === true,
          reserveExemptionReason:sundayData.memberDetails?.[target.id]?.reserveExemptionReason ?? '',
          roles:roles.filter(canManage).map(role => ({ id:role.id, name:role.name, held:target.roles.cache.has(role.id),
            qualification:qualifications.has(role.id), manageable:target.manageable })),
        }]);
      }
      if (['roster-unit','roster-element'].includes(action)) {
        if (!command) return send(403,'Command access required.');
        const result = saveRosterStructure(action,values);
        if (result.status===200 && action==='roster-element' && values.key) {
          const ids=new Set(Object.entries(sundayData.standing).filter(([key])=>key.startsWith(values.key+':')).map(([,id])=>id));
          for (const id of ids) void syncDiscordNickname(guild,id);
        }
        return send(result.status,result.message);
      }
      if (action === 'campaign-release') {
        if (!command) return send(403,'Command access required.');
        const entries={...sundayData.publicCampaign};
        const key=values.key || randomUUID();
        if (values.key && (typeof values.key!=='string' || !Object.hasOwn(entries,values.key))) return send(404,'Campaign entry not found.');
        if (values.remove===true) {
          if (!values.key) return send(400,'Choose an entry to remove.');
          delete entries[key];
        } else {
          const {title,date,summary,intel} = values;
          if (typeof title!=='string' || !title.trim() || title.length>100 ||
              typeof date!=='string' || (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !parseUkStart(date,'12:00'))) ||
              typeof summary!=='string' || !summary.trim() || summary.length>1800 ||
              !Array.isArray(intel) || intel.length>12 || intel.some(point=>typeof point!=='string' || !point.trim() || point.length>240)) {
            return send(400,'Enter a title, summary, and up to 12 intel notes of 240 characters each.');
          }
          entries[key]={title:title.trim(),date,summary:summary.trim(),intel:intel.map(point=>point.trim()),publishedAt:Date.now()};
        }
        saveSunday({...sundayData,publicCampaign:entries});
        return send(200,values.remove===true?'Campaign entry removed.':'Campaign entry published.');
      }
      if (action === 'edit-event') {
        const result = editWebsiteEvent(values);
        return send(result.status,result.message);
      }
      if (action === 'members') {
        if (!command) return send(403, 'Command access required.');
        rememberDiscordMember(member);
        const timeout = AbortSignal.timeout(7000);
        await new Promise(resolve=>{
          const finish=()=>{timeout.removeEventListener('abort',finish);resolve();};
          timeout.addEventListener('abort',finish,{once:true});
          refreshDiscordMemberNames(guild).then(finish,finish);
        });
        const saved = sundayData.discordMemberNames ?? {};
        const names = {...saved};
        for (const person of guild.members.cache.values()) {
          if (!person.pending && !person.user.bot && !Object.hasOwn(names,person.id)) names[person.id]=person.displayName;
        }
        const isPartial = !sundayData.discordMemberNamesAt || directoryRetryAt>Date.now();
        return send(200,Object.entries(names).map(([id,discordName])=>({
          key:id,name:tagName(id,discordName),partial:isPartial,
        })).sort((a,b)=>a.name.localeCompare(b.name)));
      }
      if (action === 'member-details') {
        const targetId = values.member ?? actor;
        if (targetId !== actor && !command) return send(403, 'Command access required.');
        if (!/^\d{17,20}$/.test(targetId) || !validTagName(values.name)) return send(400, 'Enter a display name up to 80 characters.');
        const target = targetId === actor ? member : await guild.members.fetch({ user:targetId, force:true }).catch(() => null);
        if (!target || target.pending || target.user.bot) return send(404, 'TAG member not found.');
        const name = values.name.trim();
        setTagName(target.id, baseDisplayName(name || target.user.globalName || target.user.username,sundayData.memberDetails?.[target.id]?.rank), actor);
        return send(200, await nicknameResult(guild,target.id,'TAG display name saved.'));
      }
      if (['cancel-event','delete-event','archive-event'].includes(action)) {
        if (action !== 'cancel-event' && !command) return send(403, 'Command access required.');
        const result = await retireWebsiteEvent(values, actor, action);
        return send(result.status, result.message);
      }
      if (action === 'event-unassign') {
        if (!command) return send(403, 'Command access required.');
        const { event:id, slot, member:target } = values;
        if (typeof id !== 'string' || !Object.hasOwn(sundayData.events,id) || typeof slot !== 'string') return send(404,'Event or slot not found.');
        const event = sundayData.events[id];
        if (event.start <= Date.now() || !Object.hasOwn(event.seats,slot) || !target || event.seats[slot]?.memberId !== target) {
          return send(409,'The assignment changed or the event has started.');
        }
        const standingSeats = { ...event.standingSeats };
        if (standingSeats[slot]?.memberId === target) delete standingSeats[slot];
        const responses = { ...event.responses };
        if (responses[target]?.seat === slot) delete responses[target];
        saveSundayEvent(id,{ ...event,standingSeats,responses,seats:{ ...event.seats,[slot]:{status:'open'} } });
        return send(200,'Assignment removed. The slot is open.');
      }
      if (action === 'event-standing') {
        if (!command) return send(403, 'Command access required.');
        const { event:id, slot, member:targetId } = values;
        if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,63}$/.test(id) ||
            typeof slot !== 'string' || !/^[a-z0-9-]+:[1-9][0-9]*$/.test(slot) ||
            typeof targetId !== 'string' || !/^\d{17,20}$/.test(targetId)) return send(400, 'Choose a standing member.');
        const target = await guild.members.fetch({ user:targetId, force:true }).catch(() => null);
        if (!target || target.pending || target.user.bot) return send(409, 'This member must complete Discord screening.');
        const event = currentSundayEvent(id);
        if (!event?.postId || event.start <= Date.now() || event.archivedAt) return send(409, 'Choose an upcoming operation.');
        const seat = event.seats[slot];
        if (sundayData.standing[slot] !== targetId || !seat || seat.memberId || seat.status !== 'open' ||
            Object.values(event.seats).some(entry => entry.memberId === targetId) ||
            event.responses?.[targetId]?.status === 'declined' || hasApprovedLeave(event,targetId)) {
          return send(409, 'The member or slot is no longer available. Refresh the register.');
        }
        const nextSeat = { memberId:targetId, status:'awaiting_confirmation' };
        // A late assignment may arrive after the standing roster confirmation cutoff.
        const cutoff = event.confirmBy > Date.now() ? event.confirmBy : event.start;
        saveSundayEvent(id, { ...event, seats:{ ...event.seats, [slot]:{...nextSeat,confirmBy:cutoff} } });
        void sendStandingInvites(id, { ...event, confirmBy:cutoff, seats:{[slot]:nextSeat} }, guild)
          .catch(error => console.error('Standing confirmation failed:', error.message));
        return send(200, 'Member added to this operation. The bot will attempt to send their confirmation DM.');
      }
      if (action === 'standing') {
        if (values.member !== '' && !/^\d{17,20}$/.test(values.member ?? '')) return send(400, 'Select a current TAG member.');
        if (!command) return send(403, 'Command access required.');
        const [group, slot] = String(values.slot).split(':');
        if (!Object.hasOwn(rosterGroups, group) || !/^\d+$/.test(slot ?? '') ||
            (!rosterGroups[group].slots[Number(slot) - 1] || rosterGroups[group].archived || rosterGroups[group].removed?.includes(Number(slot)))) return send(400, 'Choose a valid standing slot.');
        const target = values.member === '' ? null : await guild.members.fetch({ user: values.member, force: true }).catch(() => null);
        if (values.member !== '' && (!target || target.pending || target.user.bot)) return send(400, 'Select a current TAG member.');
        if (target) rememberDiscordMember(target);
        const key = group + ':' + Number(slot);
        if ((sundayData.standing[key] ?? '') !== values.previous) return send(409, 'The slot has changed. Refresh before editing.');
        const standing = updateStandingSeat(sundayData.standing, key, target?.id);
        if (!standing) return send(409, 'This member already holds another standing slot. Clear it first.');
        saveSunday({ ...sundayData, standing });
        void refreshStandingRoster();
        const affected=[...new Set([values.previous,target?.id].filter(Boolean))];
        const synced=await Promise.all(affected.map(id=>syncDiscordNickname(guild,id)));
        return send(200,'Standing roster updated.'+(synced.includes(false)?' A Discord nickname could not be synced. Check bot permissions.':''));
      }
      if (action === 'training') {
        const { date, hour, minute, course, recruit, cadre, specialist } = values;
        const session = sessionFromDetails({ date, hour, minute, course, specialist: specialist === true }, { recruit, cadre });
        const channelId = specialist === true ? SPECIALIST_TRAINING_CHANNEL_ID : BASIC_TRAINING_CHANNEL_ID;
        if (!session || !channelId) return send(400, 'Check the course, date, slots and configured Discord channel.');
        const channel = await guild.channels.fetch(channelId);
        if (!channel?.isSendable()) return send(409, 'The training channel cannot receive posts.');
        if (specialist === true && !qualificationAssignable(await guild.roles.fetch(session.qualificationRoleId), guild)) {
          return send(409, 'Configure the qualification role in Discord first.');
        }
        if (Object.values(sessions).some(item => !item.cardRemoved && item.type === session.type && item.start === session.start)) {
          return send(409, 'This training session is already scheduled.');
        }
        const id = webEventId();
        saveSession(id, { ...session, channelId });
        try {
          const message = await channel.send(sessionPost(id, session));
          saveSession(id, { ...sessions[id], messageId: message.id });
        } catch (error) {
          saveSession(id, { ...sessions[id], cardRemoved: true });
          throw error;
        }
        return send(200, 'Training signups published in Discord.');
      }
      if (action === 'sunday') {
        const { title, date, hour, minute, type, groups } = values;
        if (typeof title !== 'string' || title.length > 80 || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') ||
          !/^\d{2}$/.test(hour ?? '') || !/^\d{2}$/.test(minute ?? '') || !Array.isArray(groups)) {
          return send(400, 'Choose a valid UK date, time and at least one group.');
        }
        const event = sundayEventFromDraft({ title: title.trim(), date, hour, minute, type, groups: [...new Set(groups)] }, sundayData.standing);
        if (!event || !UPCOMING_OPS_CHANNEL_ID) return send(400, 'Choose a future Sunday and configure the Upcoming Ops channel.');
        if (Object.values(sundayData.events).some(item => item.type === type && item.start === event.start)) {
          return send(409, 'This event is already scheduled.');
        }
        const id = webEventId();
        await publishSunday(id, event, guild);
        void sendStandingInvites(id, event, guild).catch(error => console.error('Standing invites failed:', error.message));
        return send(200, 'Event published in Discord. Standing-seat confirmations are being sent.');
      }
      return send(400, 'Unknown dashboard action.');
    } catch (error) {
      console.error('Dashboard action failed:', error.message);
      return send(503, 'The bot could not complete this action. Refresh before retrying.');
    }
  });
  bridge.requestTimeout = 10_000;
  bridge.on('error', error => console.error('Dashboard connection failed:', error.message));
  bridge.listen(Number(process.env.TAG_BOT_BRIDGE_PORT??'3072'),'127.0.0.1');
}

async function retireWebsiteEvent(values, actor, action) {
  const remove = action === 'delete-event';
  const archive = action === 'archive-event';
  const { event: id, kind } = values;
  const fail = (status, message) => ({ status, message });
  if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,63}$/.test(id) || !['sunday','training'].includes(kind)) {
    return fail(400, 'Choose a valid event.');
  }
  const sunday = kind === 'sunday';
  const active = sunday ? sundayData.events : sessions;
  const archived = sunday ? (sundayData.cancelledEvents ?? {}) : cancelledSessions;
  const event = active[id] ?? archived[id];
  if (!event) return fail(404, 'Event not found.');
  const autoWednesday = !sunday && id === String(event.start * 10 + (event.stage === 't1' ? 1 : 2));
  if (remove && autoWednesday) return fail(409, 'Use Cancel event for automatically scheduled Wednesday training.');
  if (remove && (Object.keys(event.attendance ?? {}).length || Object.keys(event.results ?? {}).length)) {
    return fail(409, 'Events with attendance or training results cannot be deleted.');
  }
  if (archive && (!active[id] || event.archivedAt || event.start > Date.now())) return fail(409, 'Only a started event can be archived.');
  if (!remove && !archive && (event.cancelledAt || event.archivedAt || event.start <= Date.now())) return fail(409, 'Only upcoming events can be cancelled.');
  if (remove && (Object.keys(event.loa ?? {}).length || (!event.cancelledAt &&
      (sunday ? Object.values(event.seats ?? {}).some(seat => seat.status === 'confirmed') : Object.keys(event.bookings ?? {}).length)))) {
    return fail(409, 'This event has member bookings or leave records. Cancel an upcoming event to preserve its history.');
  }
  const nextActive = { ...active };
  const nextArchived = { ...archived };
  delete nextActive[id];
  if (remove) delete nextArchived[id];
  else if (archive) nextArchived[id] = { ...event, archivedAt:Date.now(), archivedBy:actor };
  else nextArchived[id] = { ...event, cancelledAt:Date.now(), cancelledBy:actor };
  if (archive) {
    const updated = nextArchived[id];
    if (sunday) saveSundayEvent(id, updated, {refresh:false});
    else saveSession(id, updated);
    return fail(200, 'Event archived. Attendance and results remain in its history.');
  }
  if (sunday) saveSunday({ ...sundayData, events:nextActive, cancelledEvents:nextArchived });
  else storeSessions(nextActive, nextArchived);
  retiredWebsiteEvents.add(id);

  const title = event.title ?? event.type;
  const post = sunday ? event.postId : event.messageId;
  const channelId = sunday ? event.postChannelId ?? UPCOMING_OPS_CHANNEL_ID : trainingChannelId(event);
  if (!remove) {
    const memberIds = sunday ? Object.values(event.seats ?? {}).map(seat => seat.memberId).filter(Boolean)
      : Object.keys(event.bookings ?? {});
    void Promise.allSettled([...new Set(memberIds)].map(async id => {
      const user = await client.users.fetch(id);
      await sendPrivate(user, `Cancelled · ${title} · <t:${Math.floor(event.start / 1000)}:F>`);
    }));
  }
  const done = remove ? 'Test event deleted.' : 'Event cancelled and saved in history.';
  if (!post || !channelId) return fail(200, done);
  try {
    if (sunday) await sundayPostRefreshes.get(id);
    else await pendingEdits.get(id)?.catch(() => {});
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isSendable() || channel.guildId !== TAG_TEST_SERVER_ID) throw new Error('Event channel unavailable');
    if (remove) await channel.messages.delete(post);
    else await channel.messages.edit(post, { content:`Cancelled · ${title}`, embeds:[], components:[], allowedMentions:safeMentions });
    return fail(200, done);
  } catch (error) {
    if (error.code !== 10008) {
      console.error('Dashboard event post cleanup failed:', error.message);
      return fail(200, done + ' The Discord post could not be updated. Staff can remove it in Discord.');
    }
    return fail(200, done);
  }
}

function editWebsiteEvent(values) {
  const fail = (status,message) => ({status,message});
  const { event:id, kind, date, hour, minute } = values;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,63}$/.test(id) ||
      !['sunday','training'].includes(kind) || typeof date !== 'string' ||
      !/^\d{2}$/.test(hour ?? '') || !/^\d{2}$/.test(minute ?? '')) return fail(400,'Choose a valid event and start time.');
  const sunday = kind === 'sunday';
  const event = (sunday ? sundayData.events : sessions)[id];
  if (!event || event.archivedAt || event.start <= Date.now()) return fail(409,'Only upcoming active events can be edited.');
  if (event.start !== values.previousStart) return fail(409,'The schedule changed. Refresh before editing.');
  const start = parseUkStart(date,`${hour}:${minute}`);
  if (!start || start <= Date.now()) return fail(400,'Choose a future UK start time.');
  if (Object.entries(sunday ? sundayData.events : sessions).some(([key,item]) => key !== id && item.start === start && item.type === event.type)) {
    return fail(409,'This event is already scheduled.');
  }
  if (!sunday) {
    const { recruitSlots, cadreSlots } = values;
    const booked = Object.values(event.bookings ?? {});
    if (![recruitSlots,cadreSlots].every(n=>Number.isInteger(n)&&n>=0&&n<=99) || recruitSlots+cadreSlots===0 ||
        recruitSlots < booked.filter(x=>x==='recruit').length || cadreSlots < booked.filter(x=>x==='cadre').length) {
      return fail(400,'Choose capacities that fit current bookings.');
    }
    const repeatDate=event.repeat&&start!==event.start?{repeatDay:date,repeatTime:hour+':'+minute,repeatAnchor:Number(date.slice(-2))}:{};
    saveSession(id,{ ...event,start,recruitSlots,cadreSlots,...repeatDate,reminders:start===event.start?event.reminders:{} });
    void updateTrainingCard(id).catch(error=>console.error('Training edit card update failed:',error.message));
  } else {
    const { title, groups } = values;
    if (typeof title !== 'string' || !title.trim() || title.length > 80 || !Array.isArray(groups) || !groups.length ||
        !groups.every(group=>Object.hasOwn(rosterGroups,group) && (!rosterGroups[group].archived || event.groups.includes(group)))) {
      return fail(400,'Enter a title and choose at least one roster element.');
    }
    const selected = [...new Set(groups)];
    if (Object.entries(event.seats).some(([slot,seat]) => seat.memberId && !selected.includes(slot.split(':')[0]))) {
      return fail(409,'Clear assigned seats before removing their element.');
    }
    const seats = Object.fromEntries(Object.entries(event.seats).filter(([slot])=>selected.includes(slot.split(':')[0])));
    for (const [slot,seat] of Object.entries(snapshotSeats(selected.filter(group=>!event.groups.includes(group)),{}))) seats[slot] ??= seat;
    const schedule = start === event.start ? {} : {
      confirmBy:confirmationDeadline({start}), confirmReminders:{}, opReminders:{},
    };
    if (start !== event.start) {
      for (const [key, seat] of Object.entries(seats)) {
        if (seat.confirmBy) seats[key] = { ...seat,confirmBy:schedule.confirmBy };
      }
    }
    saveSundayEvent(id,{ ...event,...schedule,start,title:title.trim(),groups:selected,seats });
  }
  return fail(200,'Event updated. The bot will update its Discord post.');
}

function saveRosterStructure(action, values) {
  const reply = (status,message) => ({status,message});
  const units = { tag:{label:'TAG'}, ...sundayData.rosterUnits };
  const elements = { ...sundayData.rosterElements };
  const key = typeof values.key === 'string' ? values.key : '';
  const label = typeof values.label === 'string' ? values.label.trim() : '';
  if (action === 'roster-unit') {
    if (key && !Object.hasOwn(units,key)) return reply(404,'Unit not found.');
    if (values.mode === 'delete') {
      if (!key || key === 'tag' || Object.values(rosterGroups).some(e=>e.unit===key)) return reply(409,'Only an empty custom unit can be deleted.');
      delete units[key];
    } else if (values.mode === 'archive' || values.mode === 'restore') {
      if (!key || key === 'tag') return reply(409,'The default TAG unit must remain available.');
      if (values.mode === 'archive' && Object.values(rosterGroups).some(e => e.unit === key && !e.archived)) {
        return reply(409,'Archive or move this unit’s active elements first.');
      }
      units[key] = {...units[key],archived:values.mode === 'archive'};
    } else {
      if (!label || label.length > 60) return reply(400,'Enter a unit name up to 60 characters.');
      const id = key || 'unit-' + randomUUID().slice(0,8);
      units[id] = {...units[id],label};
    }
    saveSunday({...sundayData,rosterUnits:units});
    return reply(200,'Unit saved.');
  }

  const prior = key && Object.hasOwn(rosterGroups,key) ? rosterGroups[key] : null;
  if (key && !prior) return reply(404,'Element not found.');
  const children = key ? Object.values(rosterGroups).filter(element => element.parent === key) : [];
  if (values.mode === 'delete') {
    if (!prior || !key.startsWith('element-')) return reply(409,'Built-in elements can be archived.');
    const eventReferences = [...Object.values(sundayData.events),...Object.values(sundayData.cancelledEvents ?? {})];
    const references = table=>Object.keys(table ?? {}).some(slot=>slot.startsWith(key+':'));
    if (children.length || references(sundayData.standing) || references(sundayData.qualifications) ||
        eventReferences.some(event=>event.groups?.includes(key) || references(event.seats))) return reply(409,'This element has child elements, assignments, or event history. Archive it to preserve those records.');
    delete elements[key];
  } else if (values.mode === 'archive' || values.mode === 'restore') {
    if (!prior) return reply(404,'Choose an existing element.');
    const archive = values.mode === 'archive';
    if (archive && children.some(element=>!element.archived)) return reply(409,'Move or archive the active child elements first.');
    if (!archive && (units[prior.unit ?? 'tag']?.archived || (prior.parent && rosterGroups[prior.parent]?.archived))) {
      return reply(409,'Restore the unit and parent element first.');
    }
    const codes = prior.slots.map((_,i)=>rosterSlotCode(key,i+1));
    elements[key] = {...prior,codes,archived:archive};
  } else {
    const {unit,parent,slots,codes,removed} = values;
    if (!label || label.length > 60 || !Array.isArray(slots) || !Array.isArray(codes) || !Array.isArray(removed) ||
        slots.length > 100 || slots.length !== codes.length || slots.length < (prior?.slots.length ?? 0) ||
        slots.some(slot=>typeof slot !== 'string' || !slot.trim() || slot.length > 60) ||
        codes.some(code=>typeof code !== 'string' || !/^[A-Z0-9-]{1,12}$/.test(code)) ||
        removed.some(i=>!Number.isInteger(i) || i<1 || i>slots.length)) return reply(400,'Enter a name and valid role and ZAP code for each position.');
    const duplicate = codes.find((code,i)=>codes.indexOf(code)!==i);
    if (duplicate) return reply(400,'ZAP code ' + duplicate + ' is repeated. Give each position its own code.');
    if (typeof unit !== 'string' || !Object.hasOwn(units,unit) || units[unit].archived) return reply(400,'Choose an active unit.');
    if (prior && unit !== (prior.unit ?? 'tag') && children.length) return reply(409,'Move child elements before moving this element to another unit.');
    if (parent && (typeof parent !== 'string' || !Object.hasOwn(rosterGroups,parent) || rosterGroups[parent].archived ||
        (rosterGroups[parent].unit ?? 'tag') !== unit)) return reply(400,'Choose an active parent in the same unit.');
    const seen = new Set([key]);
    for (let node = parent; node; node = rosterGroups[node]?.parent) {
      if (seen.has(node)) return reply(409,'An element cannot be its own ancestor.');
      seen.add(node);
    }
    const used = new Set(Object.entries(rosterGroups).filter(([id])=>id!==key)
      .flatMap(([id,element])=>element.slots.map((_,i)=>rosterSlotCode(id,i+1))));
    const collision = codes.find(code=>used.has(code));
    if (collision) return reply(409,'ZAP code ' + collision + ' already belongs to another element.');
    const held = removed.find(index=>key && sundayData.standing[key+':'+index]);
    if (held) return reply(409,'Clear the standing assignment for ' + codes[held-1] + ' before removing the position.');
    const id = key || 'element-' + randomUUID().slice(0,8);
    elements[id] = {label,unit,parent:parent || '',slots:slots.map(slot=>slot.trim()),codes,removed:[...new Set(removed)],archived:prior?.archived ?? false};
  }
  saveSunday({...sundayData,rosterElements:elements});
  if (values.mode === 'delete') delete rosterGroups[key];
  loadCustomElements();
  void refreshStandingRoster();
  return reply(200,'Element saved.');
}

let unitDatabase;
function unitDb() {
  if (unitDatabase) return unitDatabase;
  try {
    unitDatabase = new DatabaseSync(new URL('./unit-operations.sqlite',import.meta.url),{readOnly:true});
    unitDatabase.exec('PRAGMA busy_timeout=2000');
    return unitDatabase;
  } catch (error) {
    if (error.code==='ERR_SQLITE_ERROR') return null;
    throw error;
  }
}
function opsState() {
  const db=unitDb();
  if (!db) return null;
  try {
    const row=db.prepare('SELECT data FROM unit_state WHERE id=1').get();
    return row ? JSON.parse(row.data) : null;
  } catch (error) {
    if (error.code==='ERR_SQLITE_ERROR' && /no such table/.test(error.message)) return null;
    throw error;
  }
}
function clubRole(member,role) {
  return Boolean(role && (Array.isArray(member?.roles) ? member.roles.includes(role) : member?.roles?.cache?.has(role)));
}
function unitStageRole(member,stage) {
  return clubRole(member,opsState()?.settings.roles[stage] || process.env['BASIC_TRAINING_CADRE_'+stage.toUpperCase()+'_ROLE_ID']);
}
function specialistStageRole(member,event) {
  if (!event?.qualificationRoleId) return false;
  const settings=opsState()?.settings;
  const key=Object.keys(sundayData.courses??{}).find(key=>sundayData.courses[key].roleId===event.qualificationRoleId);
  const specialty=key&&(settings?.qualifications[key]?.specialty??defaultSpecialties[key]);
  return Boolean(specialty && clubRole(member,settings.roles[specialty]));
}
function canOpenSignoff(member) {
  const settings=opsState()?.settings;
  return clubRole(member,COMMAND_ROLE_ID)||clubRole(member,TRAINING_CADRE_ROLE_ID)||unitStageRole(member,'t1')||
    unitStageRole(member,'t2')||Object.entries(settings?.roles??{}).some(([key,role])=>!['seasoned','gm'].includes(key)&&clubRole(member,role));
}
function standardBookings(session,kind) {
  return Object.entries(session.bookings??{}).filter(([id,role])=>role===kind && (kind!=='recruit'||!session.prioritySeats?.[id])).length;
}

class UnitJobError extends Error {
  constructor(status,message) { super(message); this.status=status; }
}
function unitCheck(ok,status,message) {
  if (!ok) throw new UnitJobError(status,message);
}
async function jobMember(guild,id,missing=false) {
  unitCheck(/^\d{17,20}$/.test(id??''),400,'Invalid Discord member.');
  const member=await guild.members.fetch({user:id,force:true}).catch(error=>{
    if (error.code===10007) return null;
    throw error;
  });
  unitCheck(missing || (member && !member.pending && !member.user.bot),404,'This member is no longer in TAG.');
  return member;
}
const jobLocks=new Set();
async function runUnitJob(guild,key) {
  unitCheck(typeof key==='string'&&key.length<=220,400,'Invalid delivery ID.');
  const db=unitDb();
  unitCheck(db,503,'The website is preparing its delivery queue.');
  const queued=db.prepare('SELECT data,status FROM unit_jobs WHERE id=?').get(key);
  unitCheck(queued,404,'Delivery unavailable.');
  if (queued.status==='sent'||queued.status==='superseded') return 'Already delivered.';
  unitCheck(queued.status==='pending',409,'This delivery is not pending.');
  unitCheck(!jobLocks.has(key),503,'Delivery in progress.');
  jobLocks.add(key);
  try {
    const job=JSON.parse(queued.data);
    if (job.type==='notify') return await deliverUnitNotice(guild,key,job);
    if (job.type==='attendance') {
      const latest=opsState()?.registers[job.key];
      if (!latest?.closedAt || latest.version!==job.version) return 'Superseded.';
      const training=job.key.startsWith('training:');
      const event=(training?sessions:sundayData.events)[job.event];
      unitCheck(event && !event.cancelledAt,409,'The event is unavailable in Discord.');
      if ((event.unitRegisterVersion??0)>=job.version) return 'Already synchronised.';
      const attendance={...event.attendance};
      for (const [id,status] of Object.entries(job.marks)) {
        if (status==='not-required') delete attendance[id];
        else attendance[id]={status,staffId:job.actor,markedAt:latest.closedAt};
      }
      const updated={...event,attendance,unitRegisterVersion:job.version};
      if (training) {
        saveSession(job.event,updated);
        void updateTrainingCard(job.event).catch(()=>{});
      } else {
        saveSundayEvent(job.event,updated);
        if (event.type==='operation') for (const [id,mark] of Object.entries(job.marks)) {
          if (mark==='attended') void notifyProbation(id).catch(error=>console.error('Probation notice failed:',error.name));
        }
      }
      return 'Discord attendance synchronised.';
    }
    if (job.type==='stop-training') {
      const actor=await jobMember(guild,job.actor);
      const event=sessions[job.event];
      unitCheck(event?.repeatSeries,404,'Training repeat schedule unavailable.');
      const specialty=event.stage || (opsState()?.settings.qualifications[event.unitQualification]?.specialty??defaultSpecialties[event.unitQualification]);
      unitCheck(clubRole(actor,COMMAND_ROLE_ID) || (event.trainingTrack?
        canOpenSignoff(actor):specialty&&clubRole(actor,opsState()?.settings.roles[specialty])),403,'The matching cadre role is required.');
      const next={...sessions};
      for (const [id,session] of Object.entries(sessions)) {
        if (session.repeatSeries===event.repeatSeries) next[id]={...session,repeatStopped:true};
      }
      storeSessions(next);
      return 'The posted training stays open. Future repeats have stopped.';
    }
    if (job.type==='schedule') {
      const actor=await jobMember(guild,job.actor);
      const settings=opsState()?.settings;
      const stage=['t1','t2'].includes(job.qualification)?job.qualification:null;
      const qual=settings?.qualifications[job.qualification];
      const stageRole=stage || (qual?.specialty??defaultSpecialties[job.qualification]);
      unitCheck(clubRole(actor,COMMAND_ROLE_ID) || (job.trainingTrack?canOpenSignoff(actor):stageRole&&clubRole(actor,settings?.roles[stageRole])),
        403,'The matching cadre role is no longer authorised.');
      if (sessions[job.event]?.messageId) return 'Session already posted.';
      const start=parseUkStart(job.day,job.time);
      unitCheck(start>Date.now(),409,'The scheduled UK start time is invalid or has passed.');
      unitCheck(!cancelledSessions[job.event],409,'The session was cancelled.');
      const defaultChannel=stage?BASIC_TRAINING_CHANNEL_ID:job.trainingTrack?
        (process.env.SQUAD_TRAINING_CHANNEL_ID||SPECIALIST_TRAINING_CHANNEL_ID||BASIC_TRAINING_CHANNEL_ID):SPECIALIST_TRAINING_CHANNEL_ID;
      const channelId=job.channel||defaultChannel;
      const channel=await guild.channels.fetch(channelId);
      unitCheck(channel?.isSendable()&&channel.guildId===guild.id,403,'The training channel is not available to the bot.');
      if (job.channel) unitCheck(trainingChannelAllowed(channel,guild,actor),403,'You or the bot cannot post training in this channel.');
      const priorityLimit=opsState()?.limits['training:'+job.event];
      const session=sessions[job.event]??{
        type:job.title,stage,start,recruitSlots:job.places,cadreSlots:job.instructors,trainingTrack:job.trainingTrack??undefined,
        channelId,bookings:{},scheduleActor:job.actor,customPostingChannel:!!job.channel,priorityLimit,
        invitedSquads:job.squads??[],invitedPeople:job.people??[],
        ...(!stage&&job.qualification?{unitQualification:job.qualification}: {}),
        ...(job.repeat&&job.repeat!=='none'?{repeat:job.repeat,repeatSeries:job.event,repeatDay:job.day,repeatTime:job.time,repeatAnchor:Number(job.day.slice(-2))}:{}),
      };
      await postScheduledTraining(job.event,session,channel);
      return 'Training posted to Discord. Invitations will follow.';
    }
    if (job.type==='specialist') {
      const event=sessions[job.event];
      const state=opsState();
      const specialty=state?.settings.qualifications[job.qualification]?.specialty??defaultSpecialties[job.qualification];
      const [actor,member]=await Promise.all([jobMember(guild,job.actor),jobMember(guild,job.member)]);
      unitCheck(specialty && clubRole(actor,state.settings.roles[specialty]),403,'The assessor no longer has the required cadre role.');
      const key=event?.unitQualification||Object.keys(sundayData.courses??{}).find(key=>sundayData.courses[key].roleId===event?.qualificationRoleId);
      unitCheck(event && !event.cancelledAt && event.start<=Date.now()&&key===job.qualification,409,'The assessment event is unavailable.');
      const previous=event.results?.[member.id];
      const result=job.result==='retest'?'repeat':job.result;
      if (previous?.unitAssessment===job.assessment) return 'Result already synchronised.';
      unitCheck(!previous || previous.recordedAt<=job.recordedAt,409,'A newer Discord result already exists.');
      saveSession(job.event,{...event,results:{...event.results,[member.id]:{result,route:'none',staffId:job.actor,
        recordedAt:job.recordedAt,complete:true,unitAssessment:job.assessment}}});
      return 'Specialist assessment outcome synchronised.';
    }
    if (job.type==='basic') {
      const event=sessions[job.event];
      const stage=event&&trainingStage(event);
      const [actor,target]=await Promise.all([jobMember(guild,job.actor),jobMember(guild,job.member)]);
      unitCheck(stage&&event.start<=Date.now()&&event.bookings?.[target.id]==='recruit',409,'Choose a started Basic Training session with this candidate booked.');
      unitCheck(unitStageRole(actor,stage),403,'The assessor no longer has the required Basic Training Cadre role.');
      const result=job.result==='retest'?'repeat':job.result;
      unitCheck(Object.hasOwn(resultLabels,result),400,'Invalid Basic Training result.');
      unitCheck(!event.results?.[target.id] || event.results[target.id].result===result,409,'A different result is already recorded for this session.');
      let reply='';
      await recordTrainingResult({guild,member:actor,user:actor.user,editReply:value=>{reply=typeof value==='string'?value:value.content;}},
        {sessionId:job.event,user:target.user,result,route:job.route||undefined});
      const saved=sessions[job.event]?.results?.[target.id];
      unitCheck(saved?.result===result,409,reply||'Basic Training result was not recorded.');
            if (result==='passed'&&saved.route==='rangers'&&saved.roleStatus!=='applied') {
        const fresh=await jobMember(guild,job.member);
        unitCheck(!fresh.roles.cache.has(RECRUIT_ROLE_ID)&&fresh.roles.cache.has(PROBATIONARY_ROLE_ID),503,'Result recorded, but the probation role still needs to sync.');
      }
      unitCheck(saved.noticeStatus==='sent'||saved.complete,409,'Result saved. The recruit’s Discord DM needs a retry or private follow-up.');
      return reply||'Basic Training result synchronised.';
    }
    if (job.type==='manual-role') {
      const [actor,target,role]=await Promise.all([jobMember(guild,job.actor),jobMember(guild,job.member),guild.roles.fetch(job.role)]);
      const current=opsState();
      const adjustment=current?.adjustments?.[job.member];
      const expected=job.kind==='seasoned'?adjustment?.seasoned:adjustment?.qualifications[job.qualification];
      const configured=job.kind==='seasoned'?current?.settings.roles.seasoned:
        current?.settings.qualifications[job.qualification]?.discordRole || sundayData.courses?.[job.qualification]?.roleId;
      if (expected!==job.mode || configured!==job.role) return 'Superseded by a later Command change.';
      unitCheck(clubRole(actor,COMMAND_ROLE_ID)&&qualificationAssignable(role,guild),403,'The role cannot be edited by the TAG bot.');
      if (job.kind==='qualification') unitCheck(!Object.values(current.settings.roles).includes(role.id),409,'A qualification role cannot also be a cadre role.');
      const grant=job.mode==='grant'||job.mode==='automatic'&&job.preserve;
      if (grant&&!target.roles.cache.has(role.id)) await target.roles.add(role,'TAG Command adjustment');
      if (!grant&&target.roles.cache.has(role.id)) await target.roles.remove(role,'TAG Command adjustment');
      return 'Command role adjustment synchronised.';
    }
    if (job.type==='role') {
      const state=opsState();
      const adjustment=state?.adjustments?.[job.member];
      if ((job.source==='seasoned'?adjustment?.seasoned:adjustment?.qualifications[job.qualification])==='revoke') return 'Revoked by Command.';
      const configured=job.source==='seasoned'?state?.settings.roles.seasoned
        : state?.settings.qualifications[job.qualification]?.discordRole || sundayData.courses?.[job.qualification]?.roleId;
      unitCheck(configured===job.role,409,'The configured role has changed since this award was queued.');
      unitCheck(job.source!=='qualification'||!Object.values(state.settings.roles).includes(job.role),409,'Qualification roles must be separate from cadre roles.');
      const [target,role]=await Promise.all([jobMember(guild,job.member),guild.roles.fetch(job.role)]);
      unitCheck(qualificationAssignable(role,guild),403,'The configured award role is protected or above the bot.');
      if (!target.roles.cache.has(role.id)) await target.roles.add(role,'TAG website award');
      return 'Role synchronised.';
    }
    if (job.type==='priority'||job.type==='priority-cancel') {
      const target=await jobMember(guild,job.member,job.type==='priority-cancel');
      const state=opsState();
      const claim=state?.claims[job.claim];
      unitCheck(claim && claim.member===job.member,409,'The reward request is no longer open.');
      const session=sessions[job.event];
      if (!session || session.start<=Date.now()) {
        unitCheck(job.type==='priority-cancel',409,'The session has already started or is unavailable.');
        return 'Booking no longer open.';
      }
      const seats={...session.prioritySeats};
      const bookings={...session.bookings};
      const waitlist={...session.waitlist};
      if (job.type==='priority-cancel') {
        if (seats[job.member]!==job.claim) return 'Already released.';
        delete seats[job.member];
        delete bookings[job.member];
      } else {
        if (seats[job.member]===job.claim && bookings[job.member]) return 'Already booked.';
        const limit=Math.min(job.limit,state?.limits[claim.event]??session.priorityLimit??1);
        const count=Object.entries(seats).filter(([id])=>bookings[id]==='recruit').length;
        unitCheck(claim.status==='pending' && trainingEligibility(session,'recruit',target)&&!bookings[target.id] &&
          standardBookings(session,'recruit')>=session.recruitSlots && count<limit,409,'The priority place is no longer available.');
        seats[target.id]=job.claim;
        bookings[target.id]='recruit';
        delete waitlist[target.id];
      }
      saveSession(job.event,{...session,prioritySeats:seats,bookings,waitlist});
      void updateTrainingCard(job.event).catch(error=>console.error('Priority booking card refresh failed:',error.name));
      return 'Priority place synchronised.';
    }
    if (job.type==='policy'||job.type==='reserve') {
      const target=await jobMember(guild,job.member,job.type==='policy');
      if (!target && job.type==='policy') {
        updateParticipation(job.member,{...sundayData.participation?.[job.member],joined:job.joined,removedAt:Date.now()});
        releaseDepartedMember(job.member);
        return 'The member has already left TAG.';
      }
      unitCheck(!job.joined || target.joinedTimestamp===job.joined,409,'This member has rejoined since the job was queued.');
      const state=opsState();
      const policy=state?.cases[job.member];
      if (job.type==='policy') {
        const eligibility=()=> {
          const current=opsState();
          const entry=current?.cases[job.member];
          const exemption=current?.exemptions[job.member];
          return current?.settings.policy && entry?.episode===job.episode && entry.stage>=job.stage && !entry.hold && !entry.review &&
            !(exemption && exemption.start<=Date.now() && Date.now()<exemption.end) &&
            !sundayData.memberDetails?.[job.member]?.attendanceExempt && ['Full Member','Probationary'].includes(participationRole(target));
        };
        unitCheck(eligibility(),503,'Attendance case is on hold or no longer eligible.');
        if (job.stage===4) {
          unitCheck(target.kickable,403,'Discord does not allow the bot to remove this member.');
          await sendPrivate(target.user,'Command attendance policy: you have reached the TAG removal threshold.');
          unitCheck(eligibility(),503,'Attendance case was put on hold.');
          await target.kick('TAG rolling ten-week attendance policy');
          updateParticipation(target.id,{...sundayData.participation?.[target.id],joined:target.joinedTimestamp,removedAt:Date.now()});
          releaseDepartedMember(target.id);
        } else {
          clearStandingMember(target.id);
          void syncDiscordNickname(guild,target.id);
        }
      } else {
        const command=await jobMember(guild,job.actor);
        unitCheck(clubRole(command,COMMAND_ROLE_ID)&&policy?.hold,403,'The Reserve transfer has no authorised Command hold.');
        const reserve=await guild.roles.fetch(RESERVE_ROLE_ID);
        unitCheck(reserve?.editable && !reserve.managed && !reserve.permissions.has('Administrator'),403,'The Reserve role is above the bot or cannot be assigned.');
        if (!clubRole(target,RESERVE_ROLE_ID)) await target.roles.add(reserve,'TAG Command attendance intervention');
        releaseDepartedMember(target.id);
        updateParticipation(target.id,{...sundayData.participation?.[target.id],joined:target.joinedTimestamp,
          role:'Reserve',roleSince:Date.now(),notice:null});
        void syncDiscordNickname(guild,target.id);
        await sendPrivate(target.user,'Command approved your move to TAG Reserves.');
      }
      return 'Roster and Discord synchronised.';
    }
    throw new UnitJobError(400,'Unknown delivery type.');
  } finally { jobLocks.delete(key); }
}

function trainingChannelAllowed(channel,guild,actor) {
  return channel?.guildId===guild.id && [0,5].includes(channel.type) && channel.isSendable() &&
    channel.permissionsFor?.(actor)?.has(['ViewChannel','SendMessages']) &&
    channel.permissionsFor?.(guild.members.me)?.has(['ViewChannel','SendMessages','EmbedLinks']);
}

function inviteRecipients(session) {
  const squads=new Set((session.invitedSquads??[]).filter(key=>rosterGroups[key]&&!rosterGroups[key].archived));
  const roster=Object.entries(sundayData.standing??{}).flatMap(([seat,member])=>{
    const [key,slot]=seat.split(':');
    return squads.has(key)&&!rosterGroups[key].removed?.includes(Number(slot))?[member]:[];
  });
  return [...new Set([...(session.invitedPeople??[]),...roster])];
}

async function postScheduledTraining(id,session,channel) {
  saveSession(id,{...session,inviteRecipients:session.inviteRecipients??inviteRecipients(session)});
  const post=await channel.send({...sessionPost(id,session),
    nonce:createHash('sha256').update('scheduled-training:'+id).digest('hex').slice(0,25),enforceNonce:true});
  if (!sessions[id]) {
    await channel.messages.delete(post.id).catch(()=>{});
    return false;
  }
  saveSession(id,{...sessions[id],messageId:post.id});
  return true;
}

async function advanceTrainingSeries(now) {
  for (const [id,prior] of Object.entries(sessions)) {
    if (!prior.repeat || prior.repeat==='none' || prior.repeatStopped || prior.repeatSkipped || prior.repeatNext ||
      !prior.cardRemoved || prior.start+4*3_600_000>now) continue;
    try {
      const children=[...Object.entries(sessions),...Object.entries(cancelledSessions)]
        .filter(([,item])=>item.repeatPrevious===id&&!item.repeatSkipped);
      const posted=children.find(([,item])=>item.messageId||item.cancelledAt);
      if (posted) {
        saveSession(id,{...sessions[id],repeatNext:posted[0]});
        continue;
      }

      const pending=children.find(([,item])=>item.start>now);
      for (const [key,item] of children.filter(([,item])=>item.start<=now)) saveSession(key,{...item,repeatSkipped:true});
      const next=pending?{start:pending[1].start,day:pending[1].repeatDay}:nextTrainingOccurrence(prior,now,parseUkStart);
      if (!next) continue;
      const nextId=pending?.[0]??createHash('sha256').update(prior.repeatSeries+':'+next.day).digest('hex').slice(0,32);
      const channel=await client.channels.fetch(trainingChannelId(prior));
      if (!channel?.isSendable() || channel.guildId!==TAG_TEST_SERVER_ID) continue;
      if (prior.customPostingChannel) {
        const guild=await client.guilds.fetch(TAG_TEST_SERVER_ID);
        const actor=await jobMember(guild,prior.scheduleActor,true);
        if (!actor || !trainingChannelAllowed(channel,guild,actor)) continue;
      }
      if (!sessions[id] || sessions[id].repeatStopped || sessions[id].repeatNext) continue;

      const session=pending?.[1]??{
        type:prior.type,stage:prior.stage,unitQualification:prior.unitQualification,trainingTrack:prior.trainingTrack,
        start:next.start,channelId:trainingChannelId(prior),customPostingChannel:prior.customPostingChannel,scheduleActor:prior.scheduleActor,
        recruitSlots:prior.recruitSlots,cadreSlots:prior.cadreSlots,priorityLimit:prior.priorityLimit,bookings:{},
        repeat:prior.repeat,repeatSeries:prior.repeatSeries,repeatPrevious:id,repeatDay:next.day,repeatTime:prior.repeatTime,
        repeatAnchor:prior.repeatAnchor,invitedSquads:prior.invitedSquads,invitedPeople:prior.invitedPeople,
      };
      if (await postScheduledTraining(nextId,session,channel) && sessions[id]) saveSession(id,{...sessions[id],repeatNext:nextId});
    } catch (error) { console.error('Training series rollover failed:',error.message); }
  }
}

async function sendTrainingInvitations(now) {
  let guild;
  let remaining=24;
  for (const [id,session] of Object.entries(sessions)) {
    if (!session.messageId || session.cardRemoved || session.start<=now || !session.scheduleActor) continue;
    const recipients=session.inviteRecipients??inviteRecipients(session);
    if (!session.inviteRecipients) saveSession(id,{...session,inviteRecipients:recipients});
    for (const memberId of recipients) {
      const current=sessions[id];
      if (!current || current.start<=Date.now() || current.inviteStatus?.[memberId]) continue;
      if (remaining--<=0) return;
      let status;
      try {
        guild??=await client.guilds.fetch(TAG_TEST_SERVER_ID);
        const member=await jobMember(guild,memberId,true);
        if (!member || member.pending || member.user.bot || coveredByLeave(current,memberId)) status='skipped';
        else {
          const channel=await client.channels.fetch(trainingChannelId(current));
          const canView=channel?.permissionsFor?.(member)?.has('ViewChannel')!==false;
          const link='https://discord.com/channels/'+TAG_TEST_SERVER_ID+'/'+trainingChannelId(current)+'/'+current.messageId;
          if (!sessions[id] || sessions[id].start!==current.start || coveredByLeave(sessions[id],memberId)) continue;
          await member.user.send({
            content:'Training invitation · '+current.type+' · <t:'+Math.floor(current.start/1000)+':F>\n'+
              (canView?'Sign up: '+link:'Contact Training Cadre for signup access.'),
            allowedMentions:safeMentions,nonce:createHash('sha256').update('invite:'+id+':'+memberId).digest('hex').slice(0,25),enforceNonce:true,
          });
          status='sent';
        }
      } catch (error) {
        if (error.code===50007) status='dm_unavailable';
        else { console.error('Training invitation failed:',error.message); continue; }
      }
      if (sessions[id]) saveSession(id,{...sessions[id],inviteStatus:{...sessions[id].inviteStatus,[memberId]:status}});
    }
  }
}

async function deliverUnitNotice(guild,key,job) {
  const nonce=createHash('sha256').update(key).digest('hex').slice(0,25);
  const message={content:job.text,allowedMentions:safeMentions,nonce,enforceNonce:true};
  if (job.destination==='member') {
    const target=await jobMember(guild,job.memberId);
    if (job.requiredRole && !clubRole(target,job.requiredRole)) throw new UnitJobError(409,'The recipient no longer holds the required TAG role.');
    if (key.startsWith('notice:gm-brief:') && !clubRole(target,opsState()?.settings.roles.gm)) throw new UnitJobError(409,'The recipient no longer holds the Game Master role.');
    try { await target.user.send(message); return 'DM delivered.'; }
    catch (error) {
      if (error.code===50007) throw new UnitJobError(409,'The member’s Discord DMs are closed.');
      throw error;
    }
  }
  const channelId=job.destination==='orders'?UPCOMING_OPS_CHANNEL_ID:opsState()?.settings.channel || job.channel;
  unitCheck(channelId,422,'CHANNEL_REQUIRED');
  const channel=await guild.channels.fetch(channelId);
  unitCheck(channel?.isSendable() && channel.guildId===guild.id,403,'Choose a sendable channel inside TAG.');
  if (job.destination!=='orders') unitCheck(channel.permissionsFor?.(guild.roles.everyone)?.has('ViewChannel')===false,403,'The Command report channel must be private.');
  await channel.send(message);
  return 'Channel post delivered.';
}

try {
  await client.login(DISCORD_TOKEN);
} catch {
  console.error('Discord login failed. Check your token and network.');
  process.exitCode = 1;
}

