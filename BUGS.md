# Bug ledger

Provenance: six read-only hunts (lobby/lifecycle, night, day/voting/sheriff, sync/auth, frontend core, phase views),
merged and deduplicated. Every item points at a line I or a hunter read in the code; no speculative entries.
Items marked *(verified)* were re-read by hand during the merge.

Severity: **CRASH** · **BLOCKER** (game cannot proceed) · **CORRUPT** (wrong outcome / wrong info) · **LEAK** · **MINOR**

The hunts converged on six systemic gaps. Most individual defects are symptoms of one of them, so the work
packages below are ordered by root cause rather than by file.

---

## Status after the fix pass

**48 of 52 fixed · 3 accepted by decision · 1 partial.** Backend suite went 196 → 287 tests, all green;
`tsc --noEmit` clean in `backend/` and `frontend/`; `vite build` passes.

| WP | Items | Status |
|---|---|---|
| WP1 identity/authorization | B1–B4 | fixed, except B2 (accepted, documented in AGENTS.md) |
| WP2 action validation | B5–B14 | fixed |
| WP3 reconnect | B15–B19 | fixed |
| WP4 escape hatches | B20–B24 | fixed, except B24 (accepted: no parity win) |
| WP5 mutate-then-validate | B25–B29 | fixed |
| WP6 config validation | B30–B33 | fixed (min player count is now 4) |
| WP7 frontend | B34–B52 | fixed, except B42 (accepted: dead roles are public) and B48 (see below) |

**Decisions taken, incl. deviations from what this file originally proposed:**

- **B2 (rejoin impersonation)** — accepted risk, not fixed. Documented in AGENTS.md. B3 (XSS) is what keeps it out of reach remotely.
- **B20 (escape hatch)** — *GM force-advance only*. No timeout, no auto-exclusion of disconnected players. An explicit revert was made after a first attempt excluded `socketId === null` from completion math, because phones lock constantly and would have silently resolved votes without their owner.
- **B23 (sheriff badge on death)** — the badge is **cleared**, not passed. The village plays on without a tie-break instead of the sheriff choosing a successor.
- **B24 (werewolf parity)** — accepted: the game keeps running when the village is outnumbered.
- **B31** — `MIN_PLAYERS = 4`; the 2–3 player presets are now unreachable.
- **B42 (dead role reveal)** — intentional, spec updated in AGENTS.md.
- **B47 (cupid leak)** — scoped to the manager *and* the participants, because `cupidSelectedLovers` drives the "love partners" narration on the GM's device. Sending it only to the lovers would have silently removed that audio.
- **B48** — partial. `LocalPlayerModel.lovePartner` removed and the dangling `shared` `./models` export deleted; `Game.round` is still not synced, deliberately, because no viewer consumes it.

**Known remaining gaps (not bugs from this ledger):**
- No kick / remove-player path: `handleDisconnect` clears the seat's `socketId` but the player stays in the game.
- The deployed bundle still takes its API origin from `VITE_API_URL` at build time; a `predeploy` guard now fails the deploy if it is unset or localhost.

---

## Found by the e2e harness after the fix pass

**R1 [BLOCKER, regression] `startNight` scheduled the cupid again on night 2, freezing every game.**
The B25 fix moved `getNextToWakeUp(game, true)` above `game.round + 1` so that a missing night role would
throw before any mutation. But `getNextToWakeUp` decides "first night only" roles (cupid) from `game.round`,
so the query ran while the round was still 0: night 2 woke the cupid, `handleBindLovers` rejected with
"round is already 1", and nothing could advance the turn. With no GM escape hatch before this session, that
is a guaranteed freeze on the second night of every game.

Introduced by our own fix pass, invisible to 287 unit tests (they call `getNextToWakeUp` with a hand-built
round), caught by `game-flow.test.ts` the first time the harness ran a full game. Fixed by computing the
first role against the future round (`{ ...game, round: nextRound }`), which keeps validate-before-mutate
and restores the semantics. Pinned by the "night 2 must not wake the cupid" assertion.

**R2 [MINOR, found by the browser suite] Tap-through: a double tap on "Create Game" closed the lobby.**
The second tap of a double tap landed on the lobby's "Close Joining" button, which renders where "Create
Game" was, producing an alert ("Game X only has 1 players…") and closing the lobby with one player in it.
Fixed in `router.ts` with a capture-phase click guard armed on route changes (400ms), mirrored on
`<html data-tap-guard>` so the e2e suite can wait for live input instead of sleeping.

The first attempt also guarded every phase swap and was reverted: it swallowed legitimate fast input
(it broke 10 of 18 browser tests, and a human tapping a wolf target the instant the screen changes has
done nothing wrong). Route changes are the case that was actually observed.

## Found by the expanded e2e batch

**R3 [CORRUPT, fixed] A three-wolf pack could eliminate one of its own.** `WerewolfHandler.handleVote`
rejected self-votes but not packmate votes. With three wolves, two votes on a third plus the target's own
vote for a villager gave a 2:1 majority and the pack killed a werewolf at dawn. Unreachable with two
wolves, which is why it survived. A vote for another werewolf is now rejected.

**R4 [CORRUPT, fixed] The witch's poison could not kill the red lady.** Dawn resolution stripped her from
the dying list for *any* cause, so the one-shot killing potion was consumed and nobody died. She now only
escapes the werewolves' attack (and still dies when her host is killed), not the poison.

**R5 [CORRUPT, fixed] `joinGame` twice on one socket created a ghost seat.** Two players shared a
`socketId`, so `getPlayerBySocketId` always matched the first: the ghost consumed a role it could never
use, and the client received alternating snapshots from two different players. A socket that already holds
a seat is now treated as rejoining. A missing `playerUUID` took the same path.

**R6 [CORRUPT, fixed] Untyped payloads.** `usePotion {"heal":"yes"}` was truthy and burned the one-shot
healing potion; a number or object as a vote/nomination target was silently stored as an abstain, consuming
the action; `changeName` stored numbers and 200-character strings. Payloads are now typed and rejected at
the boundary (names trimmed and capped at 40), while a missing/null/false target still means an explicit
abstain.

**R7 [MINOR, fixed] The cupid never learned the bond was sealed.** The second lover's confirmation advanced
`activeNightRole` in the same snapshot, so the cupid's status list was unmounted before "both ready" could
render. The sleep view now carries a cupid-only confirmation line.

**R8 [NOT A BUG] The Little Girl does not wake, and should not.**
I initially recorded this as a defect: the role is selectable, ships in 10 presets, and its card promises a
peek, yet it has `wakesUp: false`, no handler and is never scheduled. That is deliberate. The peek is a
physical action performed by the narrator around the table ("Little Girl, open your eyes briefly"), not
something the app mediates, so there is nothing for the app to schedule or render. The card describes a real
power; the narrator runs it. Recorded here so a future session does not "implement" a UI for it.

**R9 [BLOCKER, fixed] A seat was bound to one socket, so any other live screen went dark.** Reported from a
real game: phones kept showing old state and players refreshed constantly. The render.com log shows a storm
of `User connected` / `Player <uuid> joined game` / `User disconnected`, plus repeated `wants to nominate ...
but this player was already nominated` - a phone tapping against a snapshot it never received.

`connectPlayerToSocket` overwrote `player.socketId` on every `joinGame`, and `broadcastStateAndStore` sent
the tailored snapshot to that one id. A seat therefore belonged to whichever socket joined *last*. A second
tab, a reopened link, or a reconnect that reached the server before the old socket's timeout left the other
socket connected, receiving nothing, and unable to act (`getPlayerBySocketId` failed too). The only way out
was a refresh. Reproduced as a failing e2e test: an older socket that stays connected never sees the next
phase change, ever.

Fixed by tracking a set of sockets per seat (`socketSeats` / `seatSockets` in `GameManager`): every `joinGame`
adds a binding, every snapshot fans out to all of them, any bound socket may act, and `handleDisconnect` only
clears the seat when the last socket is gone (promoting another live socket to primary otherwise). A socket
that moves to another game is unbound from the old seat first, so it cannot keep receiving that game's
private snapshots - the fallback to `player.socketId` would otherwise have re-added it.

Three client-side causes were fixed with it:
- `GamePage.mount()` called `resetState()` (which nulls `gameId`) and then only restored `playerUUID`. A
  reconnect in the window before the first snapshot read `gameId === null` and skipped its re-announce,
  leaving the phone with no snapshot path until a manual reload. The route's `gameId` is kept now.
- The socket service now re-emits `joinGame` on `visibilitychange`/`pageshow`/`online`, so a phone that
  wakes from a lock catches up instead of trusting a socket the server may already have dropped.
- `alert()` on every rejected action is gone. It blocks the JS thread; a blocking dialog cannot answer
  socket.io's ping, so one "already nominated" could drop the connection and start a reconnect storm. The
  game page shows a non-blocking toast (`#game-toast`) instead, and the day nomination confirm re-checks the
  latest snapshot before emitting, like the sheriff screen already did.

**R10 [UX + CORRUPT, fixed] The nomination stage explained a rule nobody could see, and its rejections leaked ids.**
Reported from a real game: people nominated someone, that person turned out to be nominated already, and
nothing on screen explained why they could not do it. The screen had two competing lists ("Trial List" and
"Available for Nomination"), the only way to pass was a pseudo-player at the bottom of the second list
called "Nominate No One", progress read "0/5 players have nominated" with no hint of who was missing or what
happens next, and the confirm button always said "Confirm Nomination", even for "no one".

Underneath the copy sat a rules bug. A target could be nominated by exactly one player, first come first
served, which turns agreement into a race and buys nothing: the trial ballot is just the set of distinct
named players, with no cap and no ranking, so a second nomination changes the set not at all. The error it
produced was shown to the player verbatim, UUIDs included: `Player with playerUUID 3f2a… wants to nominate
9c1b… but this player was already nominated`.

Fixed:
- Several players may name the same person. `getNominatedPlayers` dedupes, so the ballot lists a candidate
  once while `players[].nomination` keeps every nominator. `VoteHandler.nominate` lost the exclusivity check.
- One seat-ordered list of every living player, including those already on trial (chip `On trial · 2`).
  "No nomination" is a separate outlined button outside the list, not a pseudo-player.
- Every nomination path is a selection plus one confirm button whose label names the action
  (`Nominate Anna`, `Nominate Anna too`, `Confirm no nomination`), so a mis-tap cannot submit. The hint under
  the list explains what the tap will do instead of refusing it.
- The header states the consequence ("If nobody is nominated, the day ends without a lynch") and the
  progress names the undecided players ("Waiting for Ben, Clara"). The waiting state keeps updating, so an
  AFK phone is visible to the whole table.
- Trial progress says "decided" (abstains count) and the ballot names every nominator.
- Day-stage rejections are plain sentences now, and `toHumanError` in `socket.service.ts` is the net that
  keeps any remaining UUID or field-name message off a phone.

Naming the undecided players is fine during nominations because that stage is public. It is deliberately
**not** done during the trial vote: vote targets are private until the tally resolves, so that stage keeps a
bare count. That visibility difference is also the answer to "why two stages at all": nominate in the open,
then decide without seeing which way the room is leaning.

**R11 [UX, fixed] The trial showed how far along it was, never who it was waiting for.**
The vote stage showed "2 of 5 decided" and nothing else, so a stalled table had to ask around the
room which phone was the blocker, and the GM had no better view than anyone else. The count was
already public, so naming the non-voters leaks nothing about the ballot: participation is not the
secret, the choice is.

- `sync.provider.ts` publishes `players[].hasVoted` (a boolean from `isVoteCast`), never the target.
  `voteProgress` now uses the same predicate, so an abstain counts as decided in both places.
- The day trial and the sheriff election name the waiters under the count ("Waiting for you, Clara
  and Deniz."), and the post-vote message names them too. "You" is used when the phone holding the
  screen is the blocker, so the line reads as an instruction rather than a status.
- No threshold and no GM-only view. A threshold hides the names exactly when the phase is most stuck,
  and the GM is a player who can be the missing one.
- Guards: `sync.provider.test.ts` asserts `hasVoted` is public and that no roster entry carries a
  vote target; the voting e2e test asserts the participation flags track the count; `vote-progress.spec.ts`
  asserts the copy, including the abstain case.
- Deliberately accepted: naming the waiters is social pressure. That is the point of a shared clock,
  and the nomination stage already behaved that way, so the two stages now match.

**R12 [OPS, fixed] A live failure left no record.**
The game lives in memory on one Render instance, and the only output was a handful of
unstructured `console.log` lines. After a crash, a redeploy, or a phone showing the wrong
screen, there was nothing to reconstruct: no action log, no rejected error, no state.

- Every inbound socket event is now journaled before its handler runs and logged as one
  JSON line to stdout, with the game id, the seat, the phase and the payload. A rejection
  adds a second line with the real server error. stdout survives the process, which is the
  only thing that survives a crash.
- The per-game journal also stores the full `Game` after every mutation, so a dump answers
  "what did the table look like when this went wrong" and not just "which call failed".
  `/debug/game/:id` serves it as a name-resolved transcript or JSON, gated by `DEBUG_TOKEN`
  and disabled (404) when the token is unset.
- `uncaughtException`, `unhandledRejection` and `SIGTERM` flush a transcript of every live
  game to stdout before exiting, so a deploy or a crash still leaves the last state behind.
- The GM's phone has a "Copy debug report" button for the client half: recent patches, raw
  errors before `toHumanError`, and browser exceptions.
- Guards: `debug.journal.test.ts` (budgets, dedupe, rendering), `debug.http.test.ts` (token
  gate, formats, `since`), `e2e/debug.test.ts` (a real rejection in a real game),
  `debug-report.spec.ts` (the GM button; no button for anyone else).
- Accepted limit, documented in `DEBUGGING.md`: this is forensics, not persistence. A
  restart still drops the game, and the journal dies with the process; only the stdout
  lines remain. Recovery would need a store, which is a separate decision.

**R13 [UX, fixed] The day's action bar sat below the fold, and the night never said who was missing.**
Two phone problems in the same phase.

- With five or more players the roster pushed "Nominate" and "Vote to Lynch" out of the
  viewport, so the one action a stage asks for was only reachable by scrolling first. It was
  found in `prototype/nominations.html` and left there until it could be decided. The action
  bar of every day stage is now sticky at the bottom of the screen (`day.html`), in the flow
  rather than fixed, so a short stage does not leave a floating button and the page still
  ends where it looks like it ends. The sticky bar is the prototype's candidate, folded in.
- After the lynch, "Ready for Night" only reflected the player's own flag. A stuck table had
  to ask around the room whose phone had not tapped, and the GM had no better view than
  anyone else. `players[].readyForNight` is now in the tailored snapshot, the result stage
  shows "3 of 5 ready" plus the missing names, and the local confirmation message names them
  too. It is participation, not a choice: there is nothing to hide, and dead players see the
  same tally (they are not asked, but they are watching).
- Guards: `day-actions.spec.ts` asserts that the nomination, ballot and ready buttons are
  fully inside an unscrolled phone viewport while the day screen is taller than the screen
  (verified red with the sticky rule removed), and that the ready phone, an observer and the
  dead phone all see the same missing names with the "you" wording where it applies;
  `sync.provider.test.ts` pins the public flag; `e2e/voting.test.ts` pins that every client
  sees who has confirmed and that a corpse is never counted. `waitForNight` in the browser
  helpers now also accepts the dead player's night panel.

**Observations, deliberately not changed:**
- The red lady's `#red-lady-waiting-message` never renders: `handleSleepover` advances the turn immediately,
  so she goes straight to the sleep view and learns the outcome at dawn.
- `#gm-continue-controls` stays hidden when a sheriff was elected but never accepted, so that case is
  escaped with the GM's Force advance rather than a contextual button. Backend-side the GM is allowed
  (B21); the UI simply offers the hatch instead.
- `AudioService.playSFX` has **zero call sites**, so `/sounds/sfx/` can never play. Left in place for the
  planned soundboard (issue #20).
- Two raw JS error messages still reach the client for degenerate payloads: a zero-argument emit
  (`socket.emit('changeName')`) and `roleDistribution {roles: null}`. Both are caught, mutate nothing and
  are cosmetic; fixing them means threading the event name through the central route guard, because
  `createGame` legitimately sends no payload.
- `MIN_PLAYERS = 4` makes the 2- and 3-player entries in `role-presets.json` unreachable data.


- **No disconnect indicator on the game route.** *Fixed.* `#connection-banner` ("Connection lost.
  Reconnecting…") appears whenever a game is on screen and `isConnected` is false. The socket.io server
  now uses `pingInterval: 10s` / `pingTimeout: 10s` instead of 25s/20s, so a real radio loss is noticed in
  ~20s instead of ~45s. B15 fixed the reconnection; this is the visible half.
- **A player who was offline during DISTRIBUTION could never learn their role.** *Fixed.* `#my-role-chip`
  shows your role during NIGHT, SHERIFF_ELECTION and DAY (hidden in LOBBY/ROLE_SELECTION/DISTRIBUTION,
  where the role card is the right affordance, and in GAME_OVER, where the summary is). It renders from
  the snapshot, so it also survives a hard reload.
- **A seat that never returns keeps its distributed role forever.** *Open, by decision.* There is no
  kick/remove path, only the GM escape hatch to skip the turn. Whether the GM should remove the player or
  the village should keep a silent seat is a game-design question, not a bug: decide it after a playtest.



## WP1 — No identity & authorization layer

- **B1 [CORRUPT]** GM-only actions take no `socketId` at all. `closeJoining` / `roleDistribution` / `startGame`
  are `(gameId)` only, so any socket that knows the 4-char game id can assign roles and start the game.
  The only GM gate in the entire backend is `vote.handler.ts:99`; the lobby's GM gate is CSS (`lobby.ts:52`).
  `socket.routes.ts:30-34`, `game.manager.ts:103-120`
- **B2 [CORRUPT]** Rejoin is authenticated by `playerUUID`, which is broadcast to every player in the snapshot.
  Read the werewolf's UUID out of your own `syncState`, emit `joinGame`, and you inherit their player object
  (role, potions, seer reveals, votes) and their tailored snapshot. `game.manager.ts:76-89`,
  `lobby.handler.ts:65-67`, `sync.provider.ts:45`
- **B3 [LEAK]** Stored XSS: 15 unescaped `displayName` interpolations across 9 views; no escape helper exists.
  A name of `<img src=x onerror=...>` runs on every other phone, and the GM's phone is where `startGame` lives.
  `changeName` has no validation (length, trim, characters). `lobby.ts:114`, `day.ts:167,182,297,405`,
  `sheriff-election.ts:132,205,315`, `werewolves.ts:88`, `seer.ts:113`, `witch.ts:131`, `cupid.ts:95,134`,
  `red-lady.ts:74`, `game-over.ts:100`, `lobby.handler.ts:71`
- **B4 [MINOR]** `acceptSheriffRole` never checks `sheriffElectionDone`, so the GM can skip an election mid-nomination
  and leave `sheriffElectionDone === false` for the rest of the game. `vote.handler.ts:94-100`

## WP2 — Actions are never validated (turn, liveness, target)

- **B5 [BLOCKER]** `checkPlayerNightRole` never compares against `activeNightRole`; it only checks phase + role.
  Any night role can act during another role's sub-turn, and `nextRole` advances relative to the *current* role.
  The Seer can emit `seerConfirmed` five times on night 0 and walk the night to dawn with zero deaths —
  repeatable every round, permanently disabling the werewolf kill. `night.selectors.ts:71-78`,
  `night.handler.ts:64-73` *(verified)*
- **B6 [CORRUPT]** `nightAction` is the only action path without `if(!player.isAlive) return`; `vote`, `nominate`,
  `acceptSheriffRole`, `readyForNight` all have it. A lynched witch can still poison; a dead seer can still peek.
  `game.manager.ts:122-134`, `night.selectors.ts:71`
- **B7 [CORRUPT]** Kill targets are never validated. `handleVote` stores any UUID and dawn resolution kills the
  *love partner* of everyone in the dying list — vote for a corpse and you assassinate their living partner
  (a free kill nobody ordered). Witch can poison herself or a non-existent UUID. `role.handler.ts:5-17,59-90`,
  `night.handler.ts:22-47`
- **B8 [BLOCKER]** Cupid can bind a player to themselves: only one player ends up with `lovePartner`, so the
  `>= 2 confirmed` condition can never be met and the night never leaves the CUPID sub-turn. No timeout, no skip.
  `role.handler.ts:35-47,49-56`
- **B9 [CORRUPT]** Lovers can be re-bound: no guard on a second `bindLovers` (round stays 0 all first night) and
  old back-references are not cleared, producing two couples and phantom couple wins. `role.handler.ts:42-45`
- **B10 [LEAK]** Seer can peek unlimited players per night — no once-per-night guard (the code's own TODO) and,
  via B5, not even turn-bound. `role.handler.ts:21-27`
- **B11 [CORRUPT]** `confirmLoverBond` passes `role = null`, which returns early from `checkPlayerNightRole` and
  skips every check; the only guard left is an object-identity comparison that also lets a dead lover confirm.
  `socket.routes.ts:48`, `role.handler.ts:51-52`
- **B12 [CORRUPT]** `readyForNight` is not gated on `lynchDone`: all alive players emitting it during nominations
  ends the day with no lynch. `vote.handler.ts:85-92`
- **B13 [CORRUPT]** `nominate` accepts a dead or non-existent UUID. The candidate then renders in no list and
  `getVotingWinner` can never find it, so the day degenerates to "nobody lynched". `vote.handler.ts:45-49`
- **B14 [MINOR]** Socket payloads are `any`, and the selectors use `!== null`, so a missing field stores
  `undefined` which counts as "voted" but renders as nothing ("You have nominated undefined"). `vote.handler.ts:46,61,73`,
  `vote.selectors.ts:3-19`, `day.ts:108`

## WP3 — No reconnect contract

- **B15 [BLOCKER]** Frontend never re-emits `joinGame` on `connect`. socket.io issues a new id after any blip,
  so the server keeps the stale id: sync goes to a dead socket and every action throws
  "Player with socketId … not found". `socket.service.ts:137`, `game.manager.ts:26`
- **B16 [BLOCKER]** Backend `disconnect` is a no-op with a TODO, `socketId` is never cleared, no leave/kick path.
  Ghost players count toward `players.length`, must be given roles, and an AFK werewolf blocks the kill forever
  (`getWerewolfVictimUUID` returns null until every alive wolf has a `nightAction`).
  `socket.routes.ts:62-65`, `night.selectors.ts:40`
- **B17 [BLOCKER]** Rejoin is gated on `NODE_ENV === 'production'`, which nothing in the repo sets. Locally every
  lobby refresh creates a duplicate player, and since `isManager` is `players.length === 0`, the GM badge
  disappears for everyone and the lobby can never be closed. `game.manager.ts:77`, `lobby.handler.ts:43`
- **B18 [CORRUPT]** One global `localStorage.playerUUID` shared across games: opening a second game sends the first
  game's UUID, which is rejected outside LOBBY → blank page. `store.ts:70`, `socket.service.ts:159`
- **B19 [BLOCKER]** Joining after `closeJoining` falls into the rejoin branch with `playerUUID === null` and throws;
  no snapshot is ever sent, so the client renders an empty `#phase-view-container` behind one `alert()`.
  `game.manager.ts:79-89`, `lobby.handler.ts:66`, `game.ts:42`

## WP4 — No escape hatches (stuck states)

- **B20 [BLOCKER]** Every phase requires *all* actors: all alive werewolves must vote, all alive players must
  vote/nominate/ready. There is no timeout, no GM skip, no force-advance anywhere except `acceptSheriffRole`.
  One locked phone freezes the game permanently. `night.selectors.ts:40`, `vote.selectors.ts:3-19`,
  `vote.handler.ts:90-91`, `socket.routes.ts` (no skip event)
- **B21 [BLOCKER]** The GM cannot continue a sheriff election if the elected sheriff never accepts — AGENTS.md
  says they can; the code only allows the GM in the *no-sheriff* branch and the UI hides the button. `vote.handler.ts:96-97`,
  `sheriff-election.ts:243-252`
- **B22 [BLOCKER]** Dead GM + no elected sheriff = no exit from SHERIFF_ELECTION. `acceptSheriffRole` returns
  silently for dead players and every other player is rejected. `game.manager.ts:161`, `sheriff-election.ts:255`
- **B23 [CORRUPT]** The sheriff badge is never passed on death (#38, never implemented). `sheriffUUID` is only
  written in `resolveSheriffVoting`, and a dead sheriff gets no tie-break, so every later tie silently produces
  "nobody lynched". `vote.handler.ts:37-42`, `vote.selectors.ts:52-53`, `sync.provider.ts:47`
- **B24 [MINOR]** Werewolf/villager parity is not a win condition (explicit TODO), so a decided game keeps running.
  `game.manager.ts:34-36`

## WP5 — Mutate-then-validate, no rollback

`GameStore` holds `Game` **by reference**, so any mutation made before a throw is already live, while the missing
`broadcastStateAndStore` means no client ever hears about it.

- **B25 [BLOCKER]** `startGame` sets `phase = NIGHT` before resolving the first night role and never rolls back:
  a throw leaves NIGHT with `activeNightRole === null`, no snapshot, and no way back to DISTRIBUTION. `lobby.handler.ts:109-114`
- **B26 [CORRUPT]** `roleDistribution` assigns roles in a loop and can throw halfway, leaving a half-assigned game. `lobby.handler.ts:82-89`
- **B27 [CRASH]** `resolveNightActions` throws *after* `phase = DAY` is set and before deaths are applied, leaving
  DAY with unresolved deaths and stale `nightAction`s. `night.handler.ts:16`
- **B28 [CORRUPT]** `WitchHandler.handlePotion` commits `usedHealingPotion = true` and arms the heal *before*
  validating the kill potion, so a rejected request still burns the potion — invisibly, because the throw skips the
  broadcast. `role.handler.ts:63-68`
- **B29 [MINOR]** `broadcastStateAndStore` has no per-player try/catch; one throw aborts the loop and desyncs
  everyone after that player. It also emits before persisting, which is meaningless while the store holds the same
  object. `game.manager.ts:27-31`

## WP6 — Invalid game configuration is accepted

- **B30 [CORRUPT]** `roleDistribution` validates only that counts *sum* to `players.length`: 0 werewolves,
  all-villagers and unknown role keys (`{"FOO": 5}`) all pass, and keys are cast blindly to `Role`. `lobby.handler.ts:82-89`
- **B31 [MINOR]** No minimum player count. A solo GM is force-assigned Werewolf and `startGame` immediately ends
  the game as a werewolf win. `lobby.handler.ts:74-81`, `role-selection.ts:61-66`
- **B32 [MINOR]** Game ids are 4 random base-36 chars with no uniqueness check against the store, and
  `GameStore.createGame` is a bare `Map.set` — a collision silently overwrites a running game.
  `lobby.handler.ts:7`, `game.store.ts:12-16`
- **B33 [MINOR]** `role-presets.json` includes `Hunter` from 14 players up, but `HUNTER` is commented out of the
  role order, so the preset is silently one short and "Distribute Roles" stays disabled with no explanation.
  `role-presets.json`, `role-selection.ts:45-54`

## WP7 — Frontend correctness

- **B34 [BLOCKER]** Sheriff ballot lists the players who *nominated*, not the players who *were nominated*
  (`p.nomination` is the target, not the nominator). Confirmed against `day.ts:271-279`, which builds the correct
  reverse map. Votes then fail the backend's `nominatedPlayers.includes()` check. `sheriff-election.ts:195` *(verified)*
- **B35 [BLOCKER]** `ServerGate.unmount()` never removes its body-level overlay (`position: fixed; z-index: 1000`),
  so pressing Back while the gate is up leaves a permanent translucent black screen. `server-gate.ts:60`
- **B36 [CRASH]** The deployed bundle is built from the gitignored dev `.env`; `dist/assets/index-*.js` currently
  contains a hardcoded `http://localhost:3000`, and `npm run deploy` inlines whatever `.env` holds. No dev proxy
  either, so a fresh clone's `io('')` dials Vite's own port with a forced websocket transport and can never connect.
  No `connect_error` handler, so the only symptom is a 45s gate timeout. `socket.service.ts:20`, `vite.config.ts:8`
- **B37 [BLOCKER]** A failed join leaves a blank game page: on `error` the state keeps `phase === null`, nothing
  renders, and the stale `playerUUID` is never cleared so every retry fails identically. `game.ts:42`
- **B38 [MINOR]** `subscribeSelector` never invokes its callback with the current value, so every view hand-rolls
  its first paint (`server-gate.ts` has a "CRITICAL: the socket may have connected before we subscribed" workaround). `store.ts:132`
- **B39 [MINOR]** `resetState()` is a hand-maintained duplicate missing `gameId`, `winningTeam`, `nominationsFinished`,
  `cupidSelectedLovers`, and it bypasses `setState`, so no subscriber is notified. Because `gameId` survives, actions
  between mount and first sync can target the *previous* game. `store.ts:143`
- **B40 [MINOR]** Night confirm buttons have no submitted flag. A double tap re-emits after the turn moved on and
  `nextRole` advances again, skipping the next role. `werewolves.ts:23`, `seer.ts:84`, `red-lady.ts:21`
  (all other actions have the same gap; none corrupt state because the backend re-checks.)
- **B41 [LEAK]** `night.ts` prints `Current Turn: <plural role name>` for every sleeping player, revealing the exact
  role composition of the game. `night.ts:79`
- **B42 [LEAK?]** Dead players' roles are sent to everyone (`phase === GAME_OVER || !isAlive`), contradicting
  AGENTS.md. Looks deliberate, since `game.ts:97` prints the role in the death popup. `sync.provider.ts:50` *(verified)*
- **B43 [MINOR]** Witch kill list fires on a single tap with no confirm step, irreversibly burning a one-shot potion. `witch.ts:142`
- **B44 [MINOR]** Sheriff nomination list offers already-nominated candidates, which the backend rejects with a raw
  `alert()`. `sheriff-election.ts:122`
- **B45 [MINOR]** Every `syncState` restarts the win narration from the top on the GM's device. `game-over.ts:46`
- **B46 [MINOR]** `night.ts` hides the previous role's sub-view but never unmounts it, leaving live subscriptions. `night.ts:104`
- **B47 [MINOR]** `cupidSelectedLovers` is broadcast to everyone, leaking that a Cupid exists and has picked. `sync.provider.ts:26`
- **B48 [MINOR]** Model drift: frontend `LocalPlayerModel.lovePartner` is never sent; `Game.round` never synced;
  `shared/package.json` exports `./models` → `shared/models.ts`, which does not exist; models are duplicated by hand. `store.ts:12`, `shared/package.json`
- **B49 [MINOR]** Every gate Retry constructs a new Manager (guard is `socket?.connected`, not `socket`) and no
  handler is ever removed. `socket.service.ts:17`
- **B50 [MINOR]** The gate's deadline starts at page load, not at mount, so tapping "Create game" after 45s times out
  instantly; a late connect is then ignored. `server-gate.ts:30`
- **B51 [MINOR]** "Create game" has no in-flight guard on a warm connection; a double tap creates two games. `start.ts:41`
- **B52 [MINOR]** `placeholder.ts` is unreachable (all `Phase` values are handled) — dead code.

---

## Reference: snapshot audiences

| Field | Sent to | Note |
|---|---|---|
| `gameId`, `playerUUID` | all | B1, B2 |
| `phase`, `lynchDone`, `sheriffElectionDone`, `winningTeam` | all | public |
| `activeNightRole` | all | reveals existence of the role |
| `players[]` (`playerUUID`, `displayName`, `isSheriff`, `isAlive`, `nomination`, `role`) | all | `role` non-null on death (B42) |
| `displayName`, `isManager`, `role`, `lovePartner*`, `readyForNight`, `myVoteTargetUUID`, `myNominationUUID` | own | ok |
| `nominationsFinished`, `voteProgress`, `votedOutUUID` | all | public |
| `voteResults` | all | full ballot, incl. dead voters |
| `werewolfVotes`, `werewolfVictim` | alive werewolves (+ witch) | correctly gated |
| `witchUsed*Potion` | own flags | misnamed: reads `false` for non-witches |
| `redLadySleepoverUUID`, `seerReveal*` | own, by role | no `isAlive` gate |
| `cupidSelectedLovers` | everyone | B47 |
| `cupidFirst/SecondLover*` | cupid + lovers | ok |

## Test-suite notes

`scenarios.test.ts:533-546` casts a **dead player's vote** and passes — the suite encodes B6.
Untested: disconnected alive players in completion math (B20), `readyForNight` with `lynchDone === false` (B12),
GM `acceptSheriffRole` when a sheriff *is* elected (B21), 3-way ties, ties where the sheriff is a tied candidate
or abstained, `undefined` payloads (B14), duplicate nominations, dead nominees.
