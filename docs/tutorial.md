# Getting started: from nothing to a page that monitors

This is the shortest path from an empty machine to a status page reporting a
real check, then to the two harder cases — a machine you cannot reach, and an
isolated network. Every command and every block of output below was run on
real machines during the end-to-end validation of 2026-08-11; nothing here is
illustrative.

The other pages in `docs/` explain _why_ the pieces are shaped the way they are.
This one only shows the order to do things in.

---

## What you need

- An instance of TERN, reachable over HTTP or HTTPS. In this tutorial it is at
  `http://192.168.1.144:3011` — substitute your own address everywhere.
- Admin access to it (an email and password).
- One or more Linux/macOS machines to monitor. They only need `curl` and `sh`.

Everything below uses the API directly with `curl`, because the admin web UI
calls the very same API — so once you can do it with `curl`, you can do it in
the UI, and you can script it.

---

## 1. Sign in and keep a cookie

```sh
curl -s -c cookie.jar -X POST http://192.168.1.144:3011/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@acme.example","password":"YOUR-PASSWORD"}'
```

```json
{ "mfaRequired": false, "user": { "email": "admin@acme.example", "name": "Ada Admin" } }
```

`cookie.jar` now holds your session. Pass it with `-b cookie.jar` on every
call below. Your page has a **slug** — here `acme` — which appears in every
tenant-scoped URL (`/api/v1/acme/...`).

---

## 2. Your first agent

An **agent** is a small static binary that runs checks on a machine and pushes
the results back. You never copy a config file onto the machine — pairing hands
the agent everything it needs.

### Mint a pairing code

```sh
curl -s -b cookie.jar -X POST http://192.168.1.144:3011/api/v1/acme/pairing-codes \
  -H 'content-type: application/json' -d '{}'
```

```json
{ "pin": "47T9-5SJN", "expiresAt": "2026-08-11T11:00:00Z", ... }
```

### Run the installer on the machine to monitor

One line, on the target machine:

```sh
curl -fsSL http://192.168.1.144:3011/install.sh | sh -s -- \
  --server http://192.168.1.144:3011 --pin 47T9-5SJN
```

What you see:

```
◇  Installing tern-agent
   ✓  Picking the binary for this machine
   ✓  Downloading
   ✓  Pairing
   ✓  Registering to start at boot

✓ Paired as "ubuntu" on tenant acme
✓ Registered as a systemd user service — starts at boot.

  ─────────────────────────────────────────────────────────
  ✓ Running now, and again after a reboot.
  ─────────────────────────────────────────────────────────
```

The last line is the one to read: it is running, and it will come back after a
reboot. If it instead says **NOT set to start after a reboot**, the one command
to fix it is printed right under the warning.

> **Plain HTTP.** When your server is `http://` on a non-local address, the
> installer sets `TERN_ALLOW_PLAIN_HTTP=1` in the service unit for you — the key
> would otherwise cross the network in clear, so the agent refuses plain HTTP
> unless told. Use HTTPS in production.

### Check it, from the machine itself

```sh
tern-agent doctor --config ~/.config/tern/agent.toml
```

```
[ok  ] config: ~/.config/tern/agent.toml — 0 probe(s), interval 60s
[ok  ] permissions: 600 — the key is readable only by its owner
[ok  ] server: http://192.168.1.144:3011 answered in 5 ms
[ok  ] credential: accepted for tenant acme — 0 job(s) assigned
[ok  ] clock: system clock reads 2026, plausible
```

> **One trap worth knowing.** `doctor`, `run` and `pair` all default to the same
> config the service uses (`~/.config/tern/agent.toml`, or `/etc/tern` as root).
> Earlier versions defaulted to `agent.toml` in the _current directory_, so a
> `pair` typed from your home folder wrote the key somewhere the service never
> read — and every call after that was a 401. If you are on an older build, pass
> `--config` explicitly to be sure.

The agent now shows up in your fleet:

```sh
curl -s -b cookie.jar http://192.168.1.144:3011/api/v1/acme/agents
```

```
ubuntu   role=agent  lastSeen=2026-08-11T10:45:16Z
```

---

## 3. Your first control

A **control** is one thing you watch. Create one and assign it to your agent.

```sh
# Create an HTTP check
curl -s -b cookie.jar -X POST http://192.168.1.144:3011/api/v1/acme/controls \
  -H 'content-type: application/json' -d '{
    "key":"web-health","name":"Website health","kind":"http",
    "config":{"url":"http://192.168.1.144:3011/health"},
    "expectedIntervalS":30
  }'
```

The response carries the control's `id`. Assign it to the agent (`AGENT_ID`
comes from the fleet list above):

```sh
curl -s -b cookie.jar -X PUT \
  http://192.168.1.144:3011/api/v1/acme/controls/CONTROL_ID/assignment \
  -H 'content-type: application/json' \
  -d '{"policy":"single","agentIds":["AGENT_ID"]}'
```

The agent picks up new assignments on its refresh cycle (every 5 minutes). To
see it immediately, restart the service — it fetches its jobs at startup:

```sh
systemctl --user restart tern-agent
journalctl --user -u tern-agent -n 3
```

```
INFO tern_agent::runner: agent started probes=1 server=http://192.168.1.144:3011
INFO tern_agent::runner: probed control=web-health kind="http" status=Operational latency_ms=1
```

`probes=1` means it took the job; the `probed ... status=Operational` line is
the check actually running. The result is now in the database and on your page.

### The kinds of control

The same recipe works for every kind. Here are the ones exercised end to end,
with a target that makes each one meaningful:

| Kind        | Example config                                           |
| ----------- | -------------------------------------------------------- |
| `http`      | `{"url":"https://example.com/health"}`                   |
| `tcp`       | `{"host":"db.internal","port":5432}`                     |
| `ping`      | `{"host":"10.0.0.1"}` — needs `CAP_NET_RAW` (see below)  |
| `dns`       | `{"name":"example.com","recordType":"A"}`                |
| `cert`      | `{"host":"example.com","port":443}`                      |
| `websocket` | `{"url":"wss://example.com/socket"}`                     |
| `docker`    | `{"container":"api"}` — needs the Docker socket          |
| `file`      | `{"path":"/var/run/app.pid","mustExist":true}`           |
| `directory` | `{"path":"/var/backups","maxQuietSeconds":86400}`        |
| `uptime`    | `{"of":"process","process":"postgres","minSeconds":300}` |
| `push`      | no probe — your script sends measurements (see step 6)   |

Two need a capability the agent does not have by default:

- **`ping`** uses raw ICMP. Grant it once: `sudo setcap cap_net_raw+ep
$(command -v tern-agent)` and restart the service. Without it, ping falls back
  to a TCP connect and will read `down` against a host that has no echo port.
- **`docker`** needs the agent to see the Docker socket: set
  `TERN_DOCKER_SOCKET=/var/run/docker.sock` in the service environment.

> **About `cert`.** The certificate check completes a real TLS handshake against
> a built-in trust store. A self-signed certificate correctly reads `down`
> ("TLS handshake failed") — that is the check doing its job, not a bug. Point
> it at an endpoint with a certificate from a public CA to see `operational`.

---

## 4. Read the page

Everything you have assigned now shows on the public page. Fetch its summary:

```sh
curl -s http://192.168.1.144:3011/api/v1/public/acme/summary.json
```

or open `http://<your-host>/s/acme` in a browser. Each control is a component;
the ribbon under it is its recent history. That is a working status page.

---

## 5. A machine you cannot reach: put an agent behind a relay

Some machines have no route to your server — inside a customer's network, behind
a VPN, on the far side of a firewall. A **relay** (`tern-proxy`) sits on a
machine that _can_ reach the server and stands in front of the ones that cannot.

### Install the relay

On the machine with a route out, mint a code the same way, then:

```sh
curl -fsSL http://192.168.1.144:3011/install.sh | sh -s -- \
  --server http://192.168.1.144:3011 --pin W3MK-TZ67 --proxy --port 38787
```

The installer prints the exact command to run on the isolated machines, with the
relay's own address already in it:

```
┌─ To add an agent on a machine in this zone ─────────────
│  1. In the admin, Agents → Add an agent → An agent behind a relay.
│     It shows a PIN, good for five minutes.
│  2. Run this on the isolated machine, with that PIN in place of PIN:
│     curl -fsSL http://192.168.1.157:38787/install.sh | sh -s -- --server http://192.168.1.157:38787 --pin PIN
└────────────────────────────────────────────────────────
```

The relay heartbeats to the server and shows up as `role=proxy` in your fleet.

### Install the isolated agent through the relay

On the isolated machine — which cannot reach the server at all — mint a PIN in
the admin and run the printed line. The script, the binary and the pairing all
travel through the relay:

```
✓ Paired as "arch" on tenant acme
```

The isolated agent appears in the fleet under its relay
(`parentAgentId` set). It never held a key to your server: the relay redeemed
the code over its own connection. A compromised host in the zone has nothing to
replay upstream — which is the whole reason a zone exists.

> **Zone latency.** A zone agent is reported through the relay's periodic
> declaration (every 5 minutes by default), so it can take a few minutes to
> appear as "seen" after pairing. This is expected.

---

## 6. Push, for what you cannot probe

A **push** control has no probe: your script or CI sends the measurement. Create
one (`"kind":"push"`), mint a pairing code scoped to it, exchange it for a key,
and send points:

```sh
curl -s -X POST http://192.168.1.144:3011/api/v1/ingest \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"controlKey":"nightly-backup","value":42,"status":"operational"}'
```

```
HTTP 200
```

Use this for a batch job, a device on a customer site, or an existing monitoring
system that already knows the answer.

---

## Where to go next

- [The probe specification](./probes.md) — every kind and assertion in detail.
- [Importing controls](./import.md) — describe forty controls in one YAML file.
- [Operations](./operations.md) — sizing, backups, upgrades.
- [Security model](./security.md) — what pairing, keys and zones protect.
