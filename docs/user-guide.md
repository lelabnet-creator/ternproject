# The TERN user guide

For the person who uses TERN every day: an SRE, a support lead, an ops engineer
who has been handed an account. It assumes somebody else installed the instance
and keeps it running. If that is also you, [Operations](./operations.md) is the
page you want next.

The other pages in `docs/` are written for people changing or running TERN. This
one is written for the screens.

## The two halves

TERN publishes the health of your services on a page anyone can read. There are
two addresses, and they are not the same thing.

- **The public page**, at `/s/<slug>` — no account, no sign-in. Anyone with the
  address sees it. It answers one question: is the thing I depend on working
  right now, and was it working yesterday.
- **The admin**, at `/app/<slug>` — where you decide what the page says.

This edition has no private status page. A page is readable by anyone who has
its address, full stop. What it does have is per-component visibility: a
component marked internal never leaves the server, and is excluded from the
public data by the database query rather than hidden in the browser.

One vocabulary note that saves confusion later. The admin, the API and this
documentation say **control**. The public page says **component**. They are the
same rows — a status page's readers expect "component", and the code has always
said "control".

## Signing in

Open `/app/<your-page>` and sign in with your email and password.

A wrong password, an address with no account and a disabled account all get the
same sentence: `Invalid email or password`. That is deliberate — the form is a
place where a stranger could otherwise learn which addresses exist here. For the
same reason, repeated attempts from one address are rate limited (ten a minute
by default), and the tenth failure in a minute gets a plain HTTP 429 rather than
a friendly explanation.

### The second factor

If your account has an authenticator app configured, the form replaces the
password field with **Authentication code** after your password is accepted. The
half-finished session lasts five minutes and can do nothing except finish. A
wrong code says `Invalid code` and nothing else.

Be aware of what is not there yet. Enrolment, viewing your recovery codes and
turning the second factor off exist in the API and have no screen in the admin —
whoever set the account up called those endpoints directly. Recovery codes are
issued ten at a time and each works once, but the sign-in form has no field for
one. If you lose the authenticator, ask whoever runs the instance rather than
hunting for a link.

### Passkeys

A passkey signs you in with the device instead of a password — a fingerprint, a
face, a security key. Add one under **Options → Account**. Name it something you
will recognise in a list of four; the placeholder guesses from your browser and
is used verbatim if you leave the field alone.

Three things worth knowing before you rely on them:

- A passkey sign-in **satisfies the second factor on its own**, so you are not
  asked for a code afterwards. A passkey is already two factors in one gesture,
  and it is phishing-resistant in a way a typed code is not.
- Sign-in with a passkey never asks for your email first. That is on purpose:
  typing an address into a form that answers "no passkey for that account" turns
  the form into an account oracle.
- Passkeys are bound to the hostname the instance was set up with. If the
  instance moves to a different address, every registered passkey stops working
  and everyone falls back to their password. They also need https, or http on
  localhost — over anything else the panel says so instead of failing at the
  prompt.

Each passkey is independent. Losing one device leaves the others working, and
your password stays the way back in, which is why removing the last one is
allowed without an argument.

### Forgotten passwords, and sessions

**Forgotten your password?** always answers the same way, whether or not the
address has an account. The link works once and expires in thirty minutes.
Setting a new password signs out every device that was signed in and does **not**
sign you in — you land back at the form. If the account uses an authenticator
app, you are still asked for a code.

There is no change-password screen. There is also no active-device list and no
"sign out everywhere" button: signing out ends the session you are using and
nothing else. A session lasts seven days from the moment you signed in, and
using it does not extend it.

### What your role lets you do

Under the page name in the rail is your role, spelled out: `admin`, `user` or
`visitor`.

| Role      | What it can do                                         |
| --------- | ------------------------------------------------------ |
| `admin`   | Everything                                             |
| `user`    | Read the page, declare incidents, schedule maintenance |
| `visitor` | Read the page and its history                          |

In practice Agents, Logs and Options are admin-only — they need permissions the
other two roles do not hold. A `user` who navigates there sees the screens
without their write controls, and the underlying requests are refused anyway.

## The guided tour

The first time you load the admin, a small card walks the rail one entry at a
time — seven steps, or eight if you belong to the system tenant, which also has
a Platform screen. Escape closes it, the arrow keys move between steps, and
**Skip the tour** is on every step.

Finishing and skipping do the same thing: they mark the tour seen on your
account, not in the browser. It stays dismissed on every machine you sign in
from.

To see it again, go to **Options → Account** and tick **Show me the tour next
time I open the admin**. It does not start immediately — it starts on your next
page load.

## Controls

A control is one thing you watch. One service, one endpoint, one nightly job.
Everything else in TERN hangs off a control: a component on the page, a line in
an incident's blast radius, a probe an agent runs, a badge in a README.

### The kinds

The kind decides who does the checking, and what is being checked.

| Kind                       | What it does                                          |
| -------------------------- | ----------------------------------------------------- |
| **Push**                   | Your script or CI sends the measurement to TERN       |
| **HTTP**                   | Request a URL and read the response                   |
| **TCP**                    | Open a socket to a host and port                      |
| **Ping**                   | ICMP echo to a host                                   |
| **DNS**                    | Resolve a name and check the answer                   |
| **TLS certificate**        | Read the certificate and its expiry                   |
| **WebSocket**              | Open the handshake to a `ws://` or `wss://` endpoint  |
| **Docker container**       | A container on an agent's host                        |
| **File present or absent** | Whether a path exists on an agent's machine           |
| **Directory activity**     | Whether a directory is still being written to         |
| **Uptime / restart**       | How long a machine, or one process on it, has been up |

Push is the one that inverts the direction. TERN waits to be told, which is what
you want for anything it cannot reach — a batch job, a device on a customer
site, an existing monitoring system that already knows the answer. The rest are
probes, and something has to run them: this server by default, or an agent you
have paired.

Ping is worth one caveat. The server approximates it with a TCP connect, because
a web process should not hold a raw socket. A paired agent does real ICMP where
it is permitted to, and says so when it is not.

**The last four need an agent, and the form says so.** Docker needs the Docker
socket; file, directory and uptime read the machine they run on. This server
refuses to run any of them — not because it cannot, but because it should not:
a control is editable by anyone with write access here, and a server that
answered "does `/root/.ssh/id_ed25519` exist" from this form would be a way to
read its own disk one question at a time. On a machine you installed an agent
on, the same question is ordinary. Uptime additionally needs a Linux agent,
since both figures come from `/proc`.

These four are what catch the failures a network check cannot see:

- The service answers on its port, and the nightly export was never written.
  → **File**, on the export, with a freshness check.
- The spool directory stopped draining two days ago and nothing said anything.
  → **Directory**, with _fail after this many seconds with no change_.
- The machine rebooted at 03:12 and was back in twenty seconds. Availability
  never dipped; the in-memory queue, the warm cache and every session went with
  it. → **Uptime**, with _fail below_ set a little above the check interval, so
  the restart costs exactly one failed check instead of disappearing between two
  green points.

For file and directory, the healthy answer can be either direction: a
certificate must be **there**, a stale lock file must be **gone**, a backup drop
must keep **receiving**, a dead-letter folder must stay **empty**.

### Creating one

**New control** opens a four-step editor: Definition, Preview, Simulate, Script.
The last three need the control to exist, so they stay locked until the first
step is saved.

On **Definition**:

- **Key** is what scripts and alerts push against — lowercase letters, digits,
  dot, dash, underscore. It is fixed once the control is saved, which is the
  point: renaming the display name later never breaks ingestion.
- **Name** and **Description** are what a reader sees.
- **What to check** picks the kind, and the fields below it change to match. Each
  target shape has its own field, so switching from HTTP to Ping does not
  silently reinterpret a URL as a hostname.
- **Every (seconds)** and **Runs from** appear for probes only. "Runs from" is
  informational — it reads `This server, until an agent covers this control`, and
  the way to change it is to pair an agent, not to edit this.
- **Advanced** holds the two latency thresholds. The defaults are the right
  answer for almost everyone, which is why they are folded away.

The create button stays enabled and tells you what is missing when you press it.
A greyed-out button gives no reason, and the reason is the whole point.

### Thresholds and the expected interval

**Degraded above (ms)** and **Down above (ms)** turn a latency into a state. A
push carrying a slower measurement than the degraded threshold is shown degraded;
past the down threshold it is shown down. The down threshold has to be above the
degraded one, and the API says so in plain words if it is not.

**Expected interval** carries two meanings in one field, and they are the same
idea seen from either end:

- For a probe, it is how often the check runs.
- For a pushed control, it is the silence after which TERN stops believing the
  last measurement. Twice the interval with nothing arriving and TERN records a
  point of `unknown` — never `down`. Silence means we stopped hearing, which is
  not the same claim as the service being broken, and reporting it as an outage
  would turn every agent restart into a public incident.

A control inside a maintenance window that silences alerting is exempt from that
sweep, since it was expected to go quiet.

One gap to know about: the editor only shows **Every (seconds)** for probe kinds,
and saves an empty interval for push controls. A push control created through
this form is therefore never swept, and keeps showing its last measurement
however old it is. Watch the **Last check** line on the card instead.

### Public and internal

The card shows an `internal` tag on controls that stay out of the public page,
and a `disabled` one on controls that have stopped.

There is no visibility switch in the editor. A control you create is public — it
is on the page or it is not worth creating. Internal controls arrive a different
way: when a measurement is pushed for a key that does not exist yet, TERN
registers the control automatically and marks it internal, so an unexpected key
never publishes itself onto a page people are reading. Publishing one afterwards
is not something this edition's admin can do.

### Reading a control card

Three moments, and they answer different questions, which is why all three are
there.

- **Last check** — whether anything is still reporting, with the status it
  reported as a word beside the time. Hover for the check's own message.
- **Last success** — how long it has been broken.
- **Last failure** — whether something that reads fine now has been quietly
  flapping.

A card showing only the first can be green and three days stale at the same time.

**Check** runs a probe immediately and stores the result. It is offered only
where it can work, and refuses out loud where it cannot: a pushed control has no
probe, a disabled one is meant to have stopped, a broken target configuration
needs fixing first, and a control an agent runs from its own network is one this
server cannot see — it will report on its next interval.

### The other three steps

**Preview** is where you choose the widget. It saves the moment you choose, not
on a button. Widgets that need history are unavailable on a page keeping none,
and widgets that draw a measurement only appear for a control that has a value
label and unit.

That last one has a rough edge. The banner tells you to set the value label and
unit "in step 1", and step 1 has no such fields — this edition has no screen for
them. A plain status control sees the status widgets and nothing more.

**Simulate** fills the control with plausible history so you can see the widget
with data in it. Choose a number of days and a target uptime, generate, and
remove it when you are done. Simulated points are marked separately and never
count towards published uptime, and the widget labels them `simulated data`
while they are there.

**Script** is covered next.

### The generated scripts

The Script step hands you the same push, written ten ways: Python, PowerShell,
Bash, Go, Node.js, Ruby, PHP, Perl, C# / .NET and Lua. They arrive together as
tabs rather than being generated on demand — someone who works in Perl should not
have to discover that Perl is on offer.

Each script has this control's key and thresholds already in it, and reads
`TERN_API_KEY` from the environment, so the file itself is safe to commit. Copy
it, or download it — the machine being monitored is often not the one running
your browser.

The banner about the placeholder is honest rather than decorative. Existing API
keys are stored only as hashes and cannot be shown again, so a script generated
later carries a placeholder where the key goes. Mint a new key, or pair an agent,
and paste the value in.

The eleventh tab, **Agent (Rust)**, is the same idea for a paired agent, and is
described under [Agents](#agents).

## Declaring and running an incident

This is the thing a status page exists to do. Incidents open under pressure, so
the screen follows how one is actually run rather than what the table looks like:
you open it before you know the cause, you add updates as you learn, and the
postmortem is written afterwards, calmly.

### Opening one

**Declare an incident** asks for a title, a severity, a first update, and which
components it is taking with it.

- **Title** is what a reader sees first. "Checkout is failing", not "incident 4".
- **Severity** is Minor (inconvenient, not blocking), Major (a real part of the
  service is unusable) or Critical (the service is down).
- **First update** is Markdown, and it is the text subscribers receive. You are
  not expected to know the cause — say what you see.
- **Affected components** is a checkbox and a level per control: Degraded,
  Partial outage or Major outage. The level is the part that matters on the page.
- **Show on the public page** off keeps it to the admin while you confirm
  something is real. Nothing is sent to subscribers while it is off, whatever the
  notify toggle says.

It opens as _investigating_.

### While it is running

The timeline shows newest first — during an incident the last thing said is what
everyone is looking for.

**Post an update** carries a status, a body, and optionally a revised blast
radius. The status choices are Investigating (we see it, we do not know why),
Identified (we know the cause), Monitoring (a fix is out, we are watching) and
Resolved (it is over).

An update with no text is refused. It tells a subscriber nothing.

There is no separate resolve button. Resolving is choosing **Resolved** and
posting the update that says so — the button relabels itself to **Resolve the
incident**. Resolving without saying anything is what the API already refuses,
and a button offering it would only produce an error.

Setting the status back to anything other than Resolved reopens the incident and
clears the resolution time.

### The two behaviours that surprise people

**Resolving clears the declared impact.** Every component you attached goes back
to showing what it is actually measuring. This is intentional — leaving the
impact in place keeps the page red after the incident is closed — but it means
the blast radius is not a record you can read back afterwards. The timeline is
the record. The screen warns you before you press the button.

**A postmortem draft cannot be read back.** Saving a draft stores it; the API
hands out the text only once it is published, so reopening the incident shows an
empty editor. Keep your own copy until you publish. A published postmortem is
readable and stays editable.

### The postmortem

The postmortem section appears once the incident is resolved — the API refuses to
attach one before that. It is Markdown: what broke, why, and what changes.
Publishing sends a notification to subscribers; saving a draft does not.

### What the public actually sees

Be clear about this before you write your first update. A declared impact
**overrides** the measured status of each attached component for as long as the
incident is open and public, taking the worst level if several incidents hit one
component. A team that has said "this is a major outage" is making a judgement
the raw samples cannot.

But this edition's public page renders no incident section. Visitors see the
components turn red and the overall headline change. They do not see the title,
the severity or the timeline. Your written updates reach subscribers by mail and
webhook; they do not appear on the page. If the wording matters to your readers,
that is worth knowing before you rely on it.

## Maintenance windows

Work you know about in advance. Announcing it is the difference between a planned
outage and a page full of alarmed readers.

### Scheduling one

**Schedule a window** asks for a title, optional details, a start and an end in
your local time, and the components involved. The defaults land on tomorrow, on
the hour, for an hour, because that is the shape of nearly every window anyone
schedules.

Four toggles decide how it behaves:

- **Open and close it automatically** — on by default. Off means you move it by
  hand, and a window still saying "scheduled" an hour after it began is worse
  than none.
- **Silence alerting for the attached components** — see below.
- **Show on the public page** — off keeps it to the admin and sends nothing.
- **Announce it now** — otherwise the first your subscribers hear of it is the
  earliest reminder.

A window with no components attached still exists — the work happened — but it
marks nothing on the page and silences nothing. The list says so rather than
leaving you to discover it.

### Reminders

Reminders are offsets before the start: 7 d, 1 d, 4 h, 1 h and 15 min. A day and
an hour are ticked by default. They go to subscribers of the attached components,
and each one is recorded as it fires, so the list shows `· sent` beside the marks
that have already gone out.

Two behaviours are built in and worth relying on. Postponing a window re-arms any
reminder it has outrun. And when several marks come due at once — after the
instance was down, say — only the closest is sent, so a day-before and an
hour-before reminder do not land back to back.

### Alert suppression

**Silence alerting for the attached components** stops the stale sweep from
marking those controls `unknown` while the window is in progress. A control that
is expected to go quiet should not be reported as lost contact.

That is all it does. It does not suppress notifications, because nothing in TERN
notifies on a control changing state in the first place — see
[Subscribers and notifications](#subscribers-and-notifications).

### What stays editable

What a window accepts narrows as it advances, and the form disables the fields
rather than letting the API refuse them at three in the morning.

| Status              | Still editable                                               |
| ------------------- | ------------------------------------------------------------ |
| Scheduled           | Everything                                                   |
| In progress         | End, components, the three behaviour toggles, title, details |
| Completed/cancelled | Title and details — the wording of a record                  |

The start and the reminders freeze the moment a window opens, because reminders
already went out against them. The end stays movable: pushing it is exactly what
you need when the work runs long.

### Cancelling versus deleting

The button says which one you are about to do, and it is not a preference.

- A window **nobody was told about** — still scheduled, no reminders sent, never
  opened — is a draft, and it is removed outright.
- Anything else has been announced, so it is **cancelled and announced** rather
  than made to disappear. A window that vanishes leaves people expecting work
  that never happens.

## The page layout

**Page layout** decides two things about `/s/<slug>`: the order components appear
in, and how densely they are drawn.

Reorder by dragging the handle or with the up and down arrows — both do the same
thing, and the arrows work without a mouse. Nothing is saved until you press
**Save layout**, and an `Unsaved changes` marker says when there is something to
save.

The **Preview** tab embeds the real public page in an iframe, not a drawing of
it, so it cannot drift from what visitors get. It follows your unsaved choices;
visitors keep seeing the saved ones. Desktop and Phone switch the frame width.

### The three densities

| Density     | What it does                                           |
| ----------- | ------------------------------------------------------ |
| **List**    | One component per row. The most readable on a phone.   |
| **Grid**    | Cards side by side, wrapping. Good for a wall display. |
| **Compact** | Tight rows for a long list of components.              |

Compact is not merely tighter. It drops the widget from every card, which is
where the height actually goes. Choose it for a page with thirty components where
the point is the list of names and their states; choose List or Grid when the
history is the point.

### Widgets

Each control's widget is chosen in the control editor's Preview step, not here.
The same seven are used by the editor's gallery and by the public page, so what
you pick is what is drawn.

| Widget                    | What it answers                                                   |
| ------------------------- | ----------------------------------------------------------------- |
| **Uptime ribbon**         | Which days were bad, at a glance. One bar per day, 30/60/90 days. |
| **Status timeline**       | When exactly it was down, to the minute. 24 h, 7 d or 30 d.       |
| **Availability calendar** | Whether there is a pattern — a bad weekday, a bad week.           |
| **Response time band**    | Whether it is slow, and for how many people. p50, p95, p99.       |
| **Value against limits**  | A measurement, and how close it is to the line that matters.      |
| **Live stream**           | What is happening right now, for a page keeping no history.       |
| **Single number**         | One figure, large. Sometimes the right answer is not a chart.     |

The ribbon is the default. Widgets needing history are unavailable on a page in
live mode, and the live stream is unavailable on one keeping history — the
gallery says which, rather than hiding them.

### The uptime percentage changed meaning in 0.1.21

If you have been reading this page for a while, the number under the ribbon is
not computed the way it used to be, and it is worth knowing which way it moved.

It used to be **a ratio of checks**: how many measurements said "up", out of how
many were taken. It is now **a ratio of time**: how long the service was
available, out of how long it was actually being watched.

The difference is not academic. Under the old rule, a ten-minute outage cost a
component checked every ten seconds six hundred failed points and one checked
every five minutes two — same outage, same service, two very different
percentages. Lengthening a component's interval also silently improved its
whole history, because the past was re-divided by a smaller number.

What you will most likely notice:

- **Slow no longer counts as broken.** A component that was up but degraded used
  to lower its uptime. It no longer does — the ribbon answers "did it work", and
  the response-time band answers "how well". Most pages go slightly _up_.
- **Time nobody measured is no longer counted as good.** A day when the agent
  was offline used to quietly count as available. It is now left out of the
  calculation entirely, and the bar for that day is drawn as "no record".
- **Planned maintenance is left out**, and only for as long as it actually ran —
  a window announced for two hours and finished in twenty minutes removes twenty
  minutes, not two hours.
- **A single failed check no longer opens a hole.** Two consecutive failures are
  needed. When they do come, the outage is counted from the _first_ of them, not
  from the one that confirmed it.
- **A silent push component now counts against you.** A nightly job that stopped
  running used to show as "unknown" and drop out of the figure. Silence is the
  only signal a push component has, so it is now unavailability — a backup that
  has not run in a month no longer reports 100%.

Historical bars are redrawn under the new rule when the page is loaded; nothing
is rewritten in the database, so switching back would restore the old figures
exactly.

### Live mode, and which widgets suit it

**Retention mode** is set in **Options**, and it is one choice with three
consequences. It answers a question about your page rather than about your
storage: does a reader come here to find out **what is happening right now**, or
**whether you have been reliable**?

|                       | `historical` (the default)                                              | `live`                                                   |
| --------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------- |
| Raw checks kept       | The longer of _raw retention_ and _retention days_ — 90 days by default | _Raw retention_ alone — 7 days by default                |
| The public page shows | The last 90 days                                                        | The last 24 hours                                        |
| Widgets available     | Everything except the live stream                                       | The live stream, single number, and value against limits |

In `live`, **retention days is ignored entirely**. That is the setting people
change first and the one that does nothing here: a live page keeps what _raw
retention_ says and no more, so lengthening the history window on a live page
changes nothing at all until the mode changes with it.

The four history widgets — uptime ribbon, status timeline, availability
calendar, response time band — need days of aggregated history to say anything.
On a live page they are offered greyed out with the reason, because a 30-day
ribbon over 24 hours of data is not a smaller ribbon, it is a misleading one.

What works well in live mode is the opposite family:

- **Live stream** — the only widget that _requires_ live. A dense recent series,
  read as a shape rather than as a history.
- **Single number** and **Value against limits** — a current reading, and how
  close it is to the line that matters.

So live suits a wall display, an event, a lab, a rig — something probed often,
watched while it runs, and not asked about last month. Historical suits the page
somebody links in a contract. If you are unsure, stay historical: it is the
default, it keeps everything live mode would have kept, and switching to live
later is a decision to stop keeping history rather than to start.

One limit worth naming. Components are grouped under headings on the public page,
and the groups come from the database, but this edition has no screen for
creating, renaming or moving them. The layout screen orders components within
whatever grouping already exists.

## Agents

An agent is a small process on another machine that runs your probes and pushes
the results back. You want one wherever this server cannot reach — inside a
customer's network, behind a VPN, on the far side of a firewall — and wherever
"can I reach it from here" is a different question from "is it up".

### What pairing does

Pairing is the whole enrolment. **Add an agent** mints an eight-character PIN,
good for fifteen minutes and one use. Run the install command on the machine
being monitored, the agent redeems the PIN, and the server hands back an API key
scoped to ingestion **and the list of probes that agent is to run**.

That last half is the point. The agent asks the server what it is for; the list
of what is monitored never lives only on the monitored machine. There is nothing
to copy into a config file — the agent writes its own, and the screen shows you
what it will write so you can see it before it runs.

The PIN is minted when you press the button, not when the page loads. A pairing
code is a credential with a short life, and one delivered with every page view
would sit in a browser cache, unused and valid.

Which agent runs a given probe is decided in that control's **Script → Agent**
tab: a policy of **One agent** (the usual case — several agents probing the same
URL is load, not redundancy) or **Every agent** (probe from each site, to tell
"down" from "unreachable from here"), plus optional pinning of specific agents.
An agent whose key does not cover the control is shown greyed with the reason
rather than omitted.

### Reading the fleet screen

The header counts: how many are active, how many revoked, and how many are not
reporting.

The circle above the list is the fleet, arranged by meaning rather than
decoration:

- **Distance from the centre** is time since last contact. The dashed rings are
  the boundaries.
- **Colour** is the same thing, so the two channels agree.
- **Size** is how many probes that agent runs.
- **Sector** is the site, alphabetically, with the unsited last.

An agent heartbeats every five minutes. Anything seen in the last ten minutes
reads as healthy; over ten minutes it is quiet; over sixty, nothing at all.
Nothing notifies you when an agent goes silent — this screen is where you find
out, and a component that has stopped reporting is the other place.

Each row carries the name, the site, the OS and architecture, the agent version
and when it was last heard from. Expanding a row lists the probes it runs.
**Rename** sets the name and the site — the site is your words: data centre,
customer, region.

**Revoke** kills the agent's key immediately and keeps the record, so the fleet
still shows the agent existed. **Delete**, available in the bulk bar, revokes and
removes the row; after that only the audit log remembers which one it was. There
is no un-revoke — a revoked agent has to be paired again.

If your instance provisions its own local agent, it shows a `this instance` badge
and refuses both. It is not a permissions problem; it is a state the object
refuses, and turning it off is a setting on the instance.

## Subscribers and notifications

### How someone subscribes

From the public page. **Subscribe to updates** opens a small form offering two
channels — an email address, or an HTTPS endpoint for a webhook. Any disclaimer
your page has configured appears here and in the confirmation mail, which is
where a data-protection notice has to be to count as one.

Subscriptions are always double opt-in. The address is stored unconfirmed and
receives a confirmation link; nothing is delivered until that link is followed.
Webhook subscribers get the same thing as an unsigned POST carrying the URL. The
form answers identically whether the address is new, already pending or already
confirmed — telling a stranger which is which turns the form into a way to test
addresses.

Unconfirmed subscriptions are deleted after seven days. The link itself has no
separate expiry; it stops working when the row goes.

**A caveat, and it is a real one.** The confirmation link points at
`/s/<slug>/confirm/<token>`, and this edition's web app has no route for that
path — it renders the status page and confirms nothing. The API endpoint behind
it works. If subscribers report that confirming does nothing, this is why, and it
is one for whoever runs your instance.

### What gets sent, and what does not

Notifications come from incidents and maintenance windows, and from nothing else:

- an incident opened, updated, resolved, or its postmortem published;
- a maintenance window scheduled, started, completed or cancelled, and each
  reminder as it falls due.

**A component changing state on its own notifies nobody.** A control going down
turns the page red and does not send a message. Someone has to look, and someone
has to declare an incident. This is the single most common wrong assumption
about TERN, so plan your on-call around a monitoring system that does alert, and
use TERN to tell your users.

Every incident and maintenance form carries a **Notify subscribers** toggle, on
by default, and turning it off is how you make a correction that is not worth a
second mail. Nothing is sent at all while the incident or window is not public.

There are no quiet hours, no digests and no throttling. One event produces one
message per confirmed subscriber. A failed delivery is retried five times, at one
minute, five minutes, half an hour, two hours and a day, and then given up on.

Subscriptions made through the public form cover the whole page. Per-component
scoping exists in the data and in the API, and the form does not offer it.

### Unsubscribing, and what an admin can see

Every notification mail carries an unsubscribe link and the one-click
`List-Unsubscribe` headers mail clients use. Following it shows a confirmation
page with a single button; the link alone never unsubscribes anyone, because mail
clients prefetch links. Confirming deletes the row.

You cannot see subscriber addresses. They are stored encrypted and are never
decrypted for an admin — the API exposes counts only, and the admin surfaces even
those only as a number on the Danger tab. There is no way to remove one
subscriber by hand. This is a deliberate trade: a status page's subscriber list
is a list of people who depend on you, and it is not something an admin account
should be able to walk.

### Sending mail, and outbound webhooks

**Options → Notifications** has three tabs.

**Email** chooses the sender: the instance's own mail, or this page's — your
server, your domain, your deliverability. Host, port, credentials and a From
address, with the usual reminder that 587 means STARTTLS and 465 means implicit
TLS. Stored passwords are never shown again; leaving the field blank keeps the
one on file. **Send a test to** proves it before an incident does.

**Outbound webhooks** are endpoints this page posts to, one per row. The signing
secret is shown exactly once when you add the endpoint — copy it then. Deliveries
carry a timestamp header and an HMAC-SHA256 signature over the timestamp and the
raw body, which is what lets your receiver reject a replayed or forged delivery.
An address on the server's own network is refused, with the address named.

**Inbound webhooks** are the other direction entirely: receivers that let an
existing monitoring system push measurements into TERN. They are notifications
only in the sense that they share a tab.

## Badges

A badge is an SVG served by this instance for a README, a docs page or an
intranet. It runs no JavaScript, fetches nothing, and reads out to a screen
reader — the status is always a word, never only a colour.

**Options → Badges** builds one. Choose the subject — the whole page, meaning the
worst status across every public control, or one public control. Give it a label
if the default (`status`, or the control's own name) is not what you want. Then
pick a style:

| Style           | What it looks like                                                       |
| --------------- | ------------------------------------------------------------------------ |
| **Flat**        | The two-part pill every README already has a row of.                     |
| **Plastic**     | The same pill with a gloss, for pages whose other badges have one.       |
| **Circle**      | A dot and the word beside it — compact enough to sit inside a sentence.  |
| **Alert block** | A callout with a coloured rule, for the top of a page or a docs section. |
| **Status bar**  | A strip that spans a column, with the state in a chip on the right.      |

Each preview is the live endpoint rather than a drawing of it, so what you see is
what will be served.

**Take it away** gives you three things to copy: the URL, a Markdown snippet and
an HTML one, each linking the badge back to your page. A badge is cached for a
minute and keeps serving the last good render while it refreshes, so an embedded
badge should never become a broken image. A control that does not exist, or is
not public, renders a badge reading `no data` rather than a 404, for the same
reason.

One defect to work around today: the Markdown and HTML snippets link to
`https://<host>/<slug>` instead of `https://<host>/s/<slug>`, which lands on the
instance's landing page. Copy the URL, and fix the link target by hand until that
is corrected.

## Logs

Three tabs, and they answer three different questions.

### The audit trail

Who changed what, to what, and from where. Sign-ins, pairings, revocations,
configuration changes, incidents and maintenance transitions all land here as
they happen, each with a timestamp, the actor, the target and the calling IP.

Search matches the action, the target and the actor; the action dropdown is
built from the actions this page has actually recorded, so it never offers a
filter that returns nothing. The screen shows the hundred most recent entries and
has no pagination — narrowing the search is how you reach further back. There is
no export.

Entries are never edited or deleted from here, which is what makes them worth
reading. They do age out: retention is per page, configured under **Options →
Advanced** as **Keep the audit trail for (days)**, minimum thirty, and older
entries are deleted hourly.

### Forwarding

Audit entries can be mirrored to a syslog collector — mirrored, not moved. The
row is always written to the database first; the copy is best-effort and is never
retried, so the collector going away costs you the mirror and nothing else.

Configure a host, a port, UDP or TCP, a facility in `local0`–`local7`, and either
RFC 5424 or a JSON payload. RFC 5424 parses without a custom rule at the far end;
JSON carries the entry's metadata as well. **Send a test line** confirms it, with
the honest caveat that UDP cannot confirm anything arrived — a datagram was sent,
and your collector has to be the one to say it landed.

Syslog is the only destination. There is no HTTP sink, no vendor integration.

### Monitoring

What the HTTP layer is doing right now, refreshed every ten seconds over a window
of 15, 60 or 120 minutes.

Everyone who can reach this tab sees **Push rate by agent**: ingest requests this
instance served, by the agent that sent them. During a jam that is the column
that says which host to look at.

The instance-wide half — traffic by class, latency percentiles, rate-limited and
failed counts, requests in flight, the database pool and the configured limits —
is visible only to an admin of the system tenant. As a tenant admin you see your
own agents and nothing about the shared machinery. If you need the rest, ask
whoever runs the instance.

One caveat is printed on the tab itself and is worth repeating: these figures are
measured inside one API process. If your instance runs more than one API
container, each keeps its own count and neither knows about the other.
