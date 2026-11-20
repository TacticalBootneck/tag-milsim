# TAG MILSIM

This repository contains the TAG public website, members portal, Discord bot and
tests for the Arma Reforger community.

## Run from a checkout

Use Node.js 24. Configure separate local files at `bot/.env` and `portal/.env`
from the matching examples. Set `TAG_DATA_DIR` to the absolute path of the
checkout's `bot` directory. Set the same 64-character hex `TAG_WEB_BRIDGE_KEY`
in both files. The bot uses the Discord Server Members Intent. Configure the
Discord OAuth redirect URI as `PUBLIC_ORIGIN/auth/discord/callback`, and put
the portal behind an HTTPS reverse proxy to its loopback `PORT`.

```bash
npm --prefix bot ci
node --test tests/*.test.*
node tests/staging.e2e.mjs "$PWD" "$PWD/bot"
```

Run the following in separate terminals or configure services to run them
from their respective directories.

```bash
(cd bot && npm start)
(cd portal && node --env-file=.env server.mjs)
```

Keep all real settings, member records and SQLite databases on the host.
Staging uses dummy Discord identities and IDrive credentials.

## Update the existing Ubuntu installation

This source tree also serves as the update bundle for existing installations
using `~/tag-bot` and `~/tag-website`. Run the installer as
the normal service owner on the Ubuntu host. It checks both installations,
runs the included tests, and backs up the source files before it replaces them.

```bash
bash install.sh &&
systemctl --user restart tag-bot.service &&
systemctl --user restart tag-website.service &&
systemctl --user is-active tag-bot.service tag-website.service
```

The bot and website keep their existing Discord tokens and shared bridge secret.
The website data path must point to the installed bot directory.

## Set up roles and Discord delivery

1. Open **Members Dashboard → Unit operations → Command inbox → Role and attendance
   settings**.
2. Enter the role IDs for **Basic Training Cadre T1**, **Basic Training Cadre T2**,
   and the specialist cadre roles you have created. Enter **Seasoned Member** and
   **Game Master** role IDs. Leave unused specialties blank. Confirm the Campaign
   workspace has the existing Team Leader and Squad Leader role IDs.
3. Set a **private Command Discord channel** for reports. Orders are announced
   in your existing Upcoming Ops channel. AAR public recaps retain their
   existing Campaign channel. The bot sends tasking, GM and event start DMs.
4. Review **Qualification access and reviewers**. JTAC and DEVGRU Operator are
   open to Seasoned Members by default. Set a reviewer role wherever Command
   should delegate application review.
5. Confirm the first weekly attendance register. Check names, LOAs and Discord
   delivery before enabling attendance enforcement in Command settings.

Basic Training results require the matching T1 or T2 cadre role, including
Discord sign-off. Sign-off may be blocked until the stage role IDs are entered
in the website or provided in the bot environment as
`BASIC_TRAINING_CADRE_T1_ROLE_ID` and `BASIC_TRAINING_CADRE_T2_ROLE_ID`.

The bot needs access to the relevant channels, Manage Roles to sync awards and
Reserve transfers, and permission and hierarchy to remove members if Command
enables the attendance policy. If a recipient blocks Discord DMs, review the
failed delivery in the Command inbox. Retrying an existing delivery retains its
original idempotency key.

## Where to find things

| Area | What you can do |
|---|---|
| **My Next Action** | See one suggested next step on the member homepage. Confirm an assigned operation seat from the card or submit leave. Open published orders for your confirmed event or jump to the relevant Discord training or signup post. |
| **AARs** | Open a separate reporting area, save private drafts, and resume or delete them. Submit a completed report to publish the public recap. |
| **Orders & readiness** | Draft, request review, publish and revise in-game orders. Link campaign findings and map pins. Track leader acknowledgements, readiness, places needing cover, LOA and extra-life redemptions. |
| **Taskings** | Command can choose a unit, free-text estimated strength, UK task and AAR deadlines, task and intended outcome. Assigned unit leaders receive direct DMs. Record the actual outcome and link a submitted AAR. |
| **Game Master briefs** | Command can draft or publish an operation-specific brief for chosen Game Masters. Set approved branches and combination rules. Each assigned GM receives a private link and keeps their selections private until sharing after attendance closeout. |
| **Schedule training** | Name a Basic, squad, unit or specialist session. Choose a posting channel, squads and individual DM recipients, or a repeat cadence. |
| **Courses** | Create and schedule courses. Upload the presentation and instructor guide, define reusable criteria, assign assessments and keep draft or retest history. |
| **Candidate records** | Eligible leaders can read completed assessments across the unit. Training Cadre records outcomes and can correct feedback with a reason. Candidates cannot open their own assessments. |
| **Attendance & sign-off** | Bulk-select members, mark unmarked rows attended, preserve and edit exceptions, preview, then confirm. Bulk-sign Basic or specialist results using the required cadre role. |
| **Apply for a qualification** | Submit and review applications. Seasoned Member is earned after ten post-probation operations or by Command/Discord role assignment. An application approval is separate from a qualification award. |
| **My attendance & rewards** | View the rolling record, formal warnings and exemptions, request a move to Reserves, and exchange an earned reward for an extra in-game life or a priority course place. |
| **Command inbox** | Find open cases, overdue tasks, roster vacancies, role settings and failed deliveries. Correct member qualifications, Seasoned Member and reward balances with a reason. |

## Honours and deployment ribbons

Set `TAG_HONOURS_COMMANDER_ROLE_ID` in the website environment to the Discord
role that can review nominations. The bot sends a private link after the
member directory has synced the role. Nominations stay private to the role
holders. An approved citation appears in the member’s rewards and directory
card. Artwork sources are recorded in [the ribbon credits](dist/assets/honours/SOURCES.md).

The service ribbon advances after each set of ten attended main operations
and ten attended Sunday platoon training sessions after recorded probation,
using confirmed attendance registers marked as counting. Existing reward
credit rules are separate.

Campaign awards use the archived campaign’s start and end dates and all
non-cancelled main operations in that period. Confirm each operation’s
attendance register to publish eligibility. A member needs strictly more
than 80% attendance. Corrections to confirmed attendance update eligibility.

## Policy and rewards

One confirmed operation or training session can count toward the attendance
policy and reward in a London calendar week. The rolling window covers ten
calendar weeks. A missing or cancelled week does not create an absence.
Approved LOA is recorded for its actual week. The third approved LOA week
places enforcement on hold for Command review.

| Unexcused misses | Action |
|---:|---|
| 3 | Formal warning 1 |
| 4 | Formal warning 2 |
| 5 | Formal warning 3 and standing roster release |
| 7 | Removal from TAG if eligible and there is no hold, exemption or Reserve transfer |

With two approved LOA weeks in the same window, the removal threshold is nine
total missed weeks. Existing Recruit and Reserve inactivity rules continue
separately. Enforcement for active members starts disabled for Command review.

Confirmed weekly events count toward the five-operation and five-training
reward. One reward can be reserved at a time. An extra in-game life requires a
confirmed operation seat and an enabled event. Command records whether it was
used before closing attendance. Priority course places open when the normal
capacity is full, and the booking must meet the course’s application rules.
One priority place per course is the default. Training Cadre can set a different
limit. A priority booking spends the credit when attendance is confirmed.
Unused or cancelled reservations return the reward.

Start DMs are scheduled for **24 hours, 12 hours, six hours, one hour,
15 minutes and five minutes** before kickoff. Booked training attendees and
confirmed operation attendees receive reminders. LOA and cancellations are
excluded. On a restart or late signup, the bot sends the currently due phase.

## Recurring training

Open **Members Dashboard → Unit operations → Schedule training**. Select a
training type, enter the event name and UK start time, and choose a Discord
posting channel. The channel picker lists the text and announcement channels
that you and the bot can post to. Leaving it at the default uses the configured
Basic, Specialist, or optional `SQUAD_TRAINING_CHANNEL_ID` channel as appropriate.

Select squads and individual invitees as needed. The bot sends one invitation
per selected member after posting the session. Squad recipients come from the
current standing roster for each new session. Bookings are made separately for
each occurrence. Booked attendees receive the normal start reminders.

Repeat options are daily, weekly, every two weeks, every four weeks and monthly.
Four hours after a session starts, the bot retires its Discord signup post and
posts the next session to the same channel. Attendance, bookings and sign-off
history are kept. **Stop repeating** preserves the currently posted session.
After downtime, a repeat series advances to a future occurrence.

## Staging checks and data

### IDrive e2 campaign media

Keep the campaign media bucket private. Create a dedicated Read and write
access key restricted to that bucket. Leave object and bucket
deletion disabled. On Ubuntu, add these settings to
`~/tag-website/portal/.env`, entering the two credentials locally in the editor.

```dotenv
TAG_MEDIA_BUCKET=
TAG_MEDIA_ENDPOINT=
TAG_MEDIA_REGION=
TAG_MEDIA_ACCESS_KEY_ID=
TAG_MEDIA_SECRET_ACCESS_KEY=
```

Set both credentials before restarting `tag-website.service`. With both
blank, new uploads continue to use local storage. After deployment, upload a
test image through the campaign workspace and check the `campaign-images/`
prefix in the IDrive console. Confirm the image opens from the relevant TAG
page. The website log records failed transfers as
`Campaign media upload will retry` without logging signed URLs or credentials.

New campaign maps and screenshots on submitted AARs are queued on Ubuntu.
The website can serve them locally until IDrive accepts them. It then serves
them through five-minute signed download links. Only selected public recap
screenshots are served through the public image route. Existing images and
private draft attachments continue to use local storage. Course documents
continue to use the course workspace's current storage.

Keep the bucket and its objects when upgrading or rotating the access key.
Back up the bucket alongside the campaign database. The database records where
the uploaded images are stored and releases its local copies after upload.

### Verification and backups

The installer runs source checks and the API and DOM tests. The full-stack
staging test runs the real website and bot code against temporary fixtures and
simulated Discord and IDrive connections. It uses separate loopback ports and
dummy IDs and credentials.

```bash
node tests/staging.e2e.mjs "$HOME/tag-website" "$HOME/tag-bot"
```

The existing campaign database now stores private AAR drafts. The new
`unit-operations.sqlite` in the bot's data directory keeps assessment versions,
documents, attendance, GM and tasking records, and the delivery queue. Include
both SQLite databases in a SQLite-aware backup, or take the backup with the
website and bot stopped.
