# Debugging a live game

The game state lives in memory on a single Render instance. There is no database. That is
fine for playing, but it used to mean that when a live game went wrong there was nothing
to look at afterwards.

There are now two recorders and one retrieval path.

| Layer | What it holds | Survives a crash/restart? |
|---|---|---|
| stdout JSON log | every action, every rejection, every state change | **yes** — Render keeps stdout |
| in-memory journal | the same events plus the full game state after each change | no — it dies with the process |
| client report | what one phone received and when | as long as that page is open |

---

## 1. Turn it on (once, in Render)

Set **`DEBUG_TOKEN`** on the backend service to a long random string
(`openssl rand -hex 24` is fine).

- Without it, `/debug` answers `404` like any unknown path. The feature is off.
- The token is the only key. Anyone with it can see every role and every ballot, so keep it
  out of screenshots and chats.
- Nothing else is required. The stdout log is always on.

Optional limits (defaults in brackets):

| Variable | Meaning |
|---|---|
| `DEBUG_JOURNAL_MAX_EVENTS` | events kept per game `[500]` |
| `DEBUG_JOURNAL_MAX_BYTES` | bytes kept per game `[2000000]` |
| `DEBUG_JOURNAL_TTL_HOURS` | unused journals are pruned after this `[24]` |
| `DEBUG_HOOKS=0` | do not install the crash/SIGTERM handlers |

---

## 2. What you get while the instance is alive

Open:

```
https://<backend-host>/debug?token=<DEBUG_TOKEN>
```

You get a list of every game in memory with phase, round, alive count and last event. Click
a code for the transcript.

```
/debug/game/K7Q2?token=...                 transcript (default)
/debug/game/K7Q2?token=...&format=json     everything, machine-readable
/debug/game/K7Q2?token=...&since=120       only events after seq 120
/debug/game/K7Q2?token=...&download=1      save as a file
/debug/games?token=...                     game list as JSON
```

The transcript looks like this:

```
=== WEREWOLF DEBUG DUMP ===
run       5f1f95d8
game      K7Q2
created   2026-11-27T00:09:25.803Z
captured  2026-11-27T00:09:25.805Z (all times UTC)
server    node v22.14.0 · pid 20436 · uptime 3721s · env production

-- roles (current) --
  Ben                  WEREWOLF
  Clara                WEREWOLF
  Deniz                SEER
  Emre                 WITCH         dead
  ...

-- table (current) --
  phase      DAY
  round      1
  alive      5/6 (dead: Emre)
  sheriff    nobody
  active     WITCH
  winning    -

-- transcript (9 events) --
  00:09:25.803  #000  game.created
  00:09:25.804  #001  state            first record: 6 players, LOBBY, round 0
  00:09:25.804  #002  joinGame         Ben                  1ms
  00:09:25.805  #004  state            Deniz night reveal Clara (WEREWOLF)
  00:09:25.805  #005  revealRole       Emre                  reveal Clara  REJECTED: It is not your turn.
  00:09:25.806  #007  state            phase NIGHT -> DAY · round 0 -> 1 · Emre died (WITCH)
  00:09:25.806  #008  state            Ben voted Clara · Clara voted abstain
```

That block is the handover. Copy it whole; it contains the complete deal, every action, the
exact rejection messages, and the state after each mutation. Nothing has to be reproduced
from memory.

**This dump is the only place the full role assignment is visible during play.** Send it
privately, not to the group chat.

---

## 3. What you get after a crash or a redeploy

The in-memory journal is gone, but every line was already written to stdout before the
handler ran. In the Render dashboard, open **Logs** and search for the game code:

```
"game":"K7Q2"
```

Useful greps:

```
"event":"rejected"          every rejected action, with the server's real error
"event":"action"            every inbound socket event and its payload
"event":"state"             one line per state change: phase, round, deaths, the diff
"level":"error"             snapshot build/sync failures and fatals
"event":"socket.connected"  which socket appeared, and when
"event":"socket"            joins and disconnects (with the seat that was kept)
[werwolf-dump]              the full transcript written on SIGTERM or a fatal error
```

Every line is one JSON object prefixed with `[werwolf]`, so it stays greppable. Every line
carries a `run` id that changes on each boot; two deploys in one log stream never merge.

On **SIGTERM** (every Render deploy / manual restart) and on an **uncaught exception or
unhandled rejection**, the server writes the full transcript of every live game to stdout,
prefixed with `[werwolf-dump]`, synchronously, before it exits. So a clean deploy leaves a
complete record of every game as it stood. A hard kill (`SIGKILL`, OOM) cannot run any
handler; in that case the per-action lines are still there.

Render's log retention depends on the plan. If you need to keep logs longer than the plan
allows, add a log drain in Render; do not add a database just for logs.

---

## 4. The phone side (GM only)

In a running game the Game Master's phone has a collapsed **Debug report** card at the
bottom. It copies one JSON block containing:

- the current state as this phone sees it,
- the last ~150 socket events: connect/disconnect, every `syncState` patch, raw and
  humanised errors, joins,
- uncaught browser errors and unhandled promise rejections,
- URL, user agent, visibility, online flag.

Use it when the server looks healthy but a screen is wrong: the order of the patches, and
the raw error that was replaced by a friendly sentence, are usually the answer.

The button is GM-only on purpose. A normal player's report still contains their own role,
so there is no button to press by accident.

---

## 5. What to send for a diagnosis

1. The game code and the approximate time (UTC is in every line).
2. The text dump from `/debug/game/<id>` if the instance still has it, otherwise the
   matching stdout lines.
3. The GM's client report if the bug is visual.
4. What the table expected to happen, in one sentence.

That is enough to replay the decision chain without a database.

---

## 6. What this deliberately does not do

- **It does not restore a game.** If the instance restarts, the game is still gone. These
  are logs, not persistence. Recovery would need Redis/Postgres or a persistent disk, which
  is a different feature.
- **It does not capture anything before the process started.** A crash during boot is logged,
  but there is no earlier state to dump.
- **It does not send anything off-box.** No third-party logging service, no network calls.
  stdout plus the optional HTTP dump, nothing else.
- **It does not redact.** A dump contains roles, ballots and night actions. That is the
  point; treat the token and the dump as secrets.
