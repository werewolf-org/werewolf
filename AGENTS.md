This is a web app for the Werwolf Game.

Werewolf is a social deduction game where a informed minority of "werewolves" secretively eliminates players while an uninformed majority of "villagers" attempts to identify and vote them out.
In this mobile version of the game, people can join a game. They then get their roles and then play the game. During the Night special roles do special actions and during the night the village can vote who to vote out and lynch.

# Structure

There is the frontend (`frontend/`), the backend (`backend/`), and shared logic (`shared/`).
Both are written with typescript.

# Shared Logic (`shared/`)

The `shared/` folder contains code that is used by both the frontend and the backend. This ensures type safety and consistency across the entire application.

- **`roles.ts`**: Contains the `Role` enum, `RoleDef` interface, and the `ROLES` constant which defines the metadata (names, descriptions, teams, night order) for every role in the game.
- **`phases.ts`**: Contains the enum `Phase`.

# Reactive State Architecture

The project follows a **Reactive State Machine** pattern. In this model, the Frontend UI is a "pure function" of the State. 

### Core Mandates:
1.  **State-Driven UI**: UI elements MUST NOT trigger other UI elements directly. All UI changes must be a side-effect of a state update. (e.g., A button click calls a socket action -> Socket updates the Store -> Store triggers a UI re-render).
2.  **Unidirectional Data Flow**: Backend State -> Socket `syncState` -> Frontend Store -> UI.
3.  **Tailored Snapshots**: Instead of granular events, the backend sends a "Tailored State Snapshot" (`syncState`) to each player. This snapshot contains only the information that specific player is allowed to see (e.g., their own role, their own potion status, and public game info). **Exception**: a dead player's `role` is public once they die (the death popup shows it), and when the phase is `GAME_OVER` all player roles and statuses are revealed to everyone for the summary screen.

# Development Setup

- **Backend Port:** 3000
- **Frontend Port:** 5173
- **Environment:** Backend uses `.env` for configuration (e.g., `ORIGIN` for CORS).
- **Module System:** Backend is configured as ESM (`"type": "module"`).

# Backend Architecture

The backend is a pure **Node.js `http` + `socket.io`** application. No database is used; all games are stored in-memory in the `GameStore`.

## Core Logic (`backend/src/logic/`)

### 1. Orchestration (`game.manager.ts`)
The `GameManager` is the central entry point for all game traffic (called from `index.ts`). It manages the high-level workflow:
- **State Management**: Fetches the `Game` from the store and ensures it is updated and broadcasted after every change via `broadcastStateAndStore()`.
- **Traffic Control**: It identifies the player by their socket ID and delegates the specific business logic to specialized **Handlers**.
- **Validation**: Uses **Selectors** to verify if a player is authorized to perform an action (e.g., checking if it's currently their night turn).

### 2. State Mutation (`handlers/`)
These modules contain the "Doers"—the only logic permitted to modify the `Game` and `Player` objects.
- **`lobby.handler.ts`**: Manages the pre-game lifecycle (creation, joining, name changes) and the complex role distribution logic.
- **`night.handler.ts`**: Controls the progression of night turns. It resolves all night actions (Werewolf kills, Witch potions, Red Lady visits) into a "morning report" of deaths and transitions the game to the next phase.
- **`vote.handler.ts`**: Reusable logic for both Lynch and Sheriff election voting. It handles vote casting and resolves the outcome, including tie-breaking rules.
- **`role.handler.ts`**: Contains the specific action logic for individual roles (e.g., Werewolf consensus, Seer reveals, Cupid's bond).

### 3. Derived State (`selectors/`)
These modules contain the "Readers"—pure utility functions that calculate information from the `Game` object without ever modifying it.
- **`night.selectors.ts`**: Logic to determine the Werewolves' target, find the next role to wake up based on `nightOrder`, and validate role turns.
- **`vote.selectors.ts`**: Math-heavy logic to calculate vote counts, check for voting completion, and determine winners (handling the Sheriff's tie-breaking power).

### 4. Communication & Sync (`communication/sync.provider.ts`)
The `SyncProvider` is responsible for building the **Tailored Snapshots**. 
- It aggregates the current game state and authorizations into a customized JSON patch for each specific player.
- It ensures players only see what they are allowed to (e.g., a Villager doesn't see Werewolf votes).
- **Exception**: when the phase is `GAME_OVER` it reveals all roles and statuses for the summary screen; a dead player's role is revealed as soon as they die (this is intentional, the death popup shows it).

## Communication Flow
1. **Socket Event**: `index.ts` initializes the Socket.IO server and delegates event registration to `socket.routes.ts`. `socket.routes.ts` receives socket events and calls the relevant `GameManager` method.
2. **Logic Execution**: `GameManager` fetches the game, validates the request via **Selectors**, and executes the change via a **Handler**.
3. **State Sync**: `GameManager` invokes the `SyncProvider` to generate tailored snapshots for all players and broadcasts them via `socket.service.ts`.

## Socket Routing (`backend/src/socket.routes.ts`)
All Socket.IO event handlers are registered in a dedicated `socket.routes.ts` file. This separation keeps `index.ts` clean and purely infrastructural (HTTP server + Socket.IO setup).

Events handled include:
- **Lobby**: `createGame`, `joinGame`, `changeName`, `closeJoining`, `roleDistribution`, `startGame`
- **Night Roles**: `werewolfVote`, `sleepover` (Red Lady), `revealRole` / `seerConfirmed` (Seer), `bindLovers` / `confirmLoverBond` (Cupid), `usePotion` / `witchConfirms` (Witch)
- **Day Actions**: `nominate`, `vote`, `readyForNight`
- **Sheriff Election**: `nominate`, `vote`, `acceptSheriffRole`
- **Lifecycle**: `disconnect`

## Data Storage (`backend/src/store/`)
- **`game.store.ts`**: Singleton in-memory database (`Map<string, Game>`).

## Tests (`backend/src/__tests__/`)
The backend has comprehensive unit tests for all core logic, written with **Vitest**. Test files are in `backend/src/__tests__/`. When writing new code, please make sure to add test functions.

### Running Tests
```bash
cd backend
npm test         # Run all tests once (unit + e2e)
npm run test:e2e # Only the end-to-end suite
npx vitest       # Run in watch mode
npx vitest run src/__tests__/vote.selectors.test.ts  # Single file
```

### End-to-end harness (`src/__tests__/e2e/`)
Starts a real server on an ephemeral port (`startGameServer(0)` from `src/server.ts`) and drives it with
real `socket.io-client`s, one per player. Assertions are made on the **tailored snapshots** a client
receives, because that is everything a player ever sees.

- `harness.ts` — `TestGame` (create a lobby with N clients, close joining, distribute, start, find a
  client by role) and `Client` (`waitFor`, `waitForPhase`, `waitForTurn`, `dropAndReconnect`,
  `errors`). Clients re-emit `joinGame` on reconnect exactly like the frontend does.
- `smoke.test.ts` — proves the harness itself works. If it is red, no other e2e result means anything.
- `game-flow.test.ts` — full games: night resolution, sheriff election, day vote, all win conditions.
- `reconnect.test.ts` — reload, network blip, rejoin, disconnect mid-night.
- `security.test.ts` — manager-only actions, out-of-turn actions, dead players, target validation,
  snapshot leaks.
- `fuzz.test.ts` + `fuzz/` — **seeded random full games**. Random player count (4–10), random valid role
  composition, and every client picks a random *legal* action from its own snapshot (plus ~8% chaos
  probes that are expected to be rejected). Invariants are checked after every sync, so the assertions
  do not depend on the outcome: no info leak, identical public state across clients, deaths only at
  dawn or lynch, monotonic death, at most one (living) sheriff, coherent aggregates, legal phase edges,
  terminal winner matching the living set. A random game that needs `managerAdvance`, or that hits the
  round/event cap, fails: the escape hatch is for AFK humans, not for the state machine.

  Exploration is biased on purpose: acting is near-certain, but the *target* is uniform, and the
  branches that historically broke (all-abstain day, tied lynch, sheriff declining, no sheriff at all,
  witch with no potions, early village win) each get 8–12% per run and are logged as `[branch:…]`.
  Run it harder with:

  ```bash
  E2E_SEED=424242 E2E_FUZZ_GAMES=25 npx vitest run src/__tests__/e2e/fuzz.test.ts
  ```

  `E2E_SEED` pins the run and, because the role deal is seeded too, replays down to who is the seer.
  A failure dumps the seed, the composition, the last actions and every client's snapshot.

Rules: roles are assigned randomly, so always discover them from snapshots (`state.role`), never assume
an assignment. Synchronise with `waitFor*`, never with sleeps. Always `close()` the game in `afterEach`.

### Browser end-to-end (`e2e/`, Playwright)
Covers what a socket-level test cannot see: the Vite proxy, the websocket upgrade, the hash router, the
store, the phase views and touch input. Starts the real backend (port 3210) and a real Vite dev server
(port 5273, `--mode e2e` so `frontend/.env.e2e` clears `VITE_API_URL` and the app talks to its own origin
through the proxy). One browser context per player = one phone each (iPhone 13, chromium).

```bash
npm install                    # at the repo root, once
npx playwright install chromium
npm run test:e2e               # all browser specs
npx playwright test -c e2e/playwright.config.ts --grep lobby

# a second concurrent run (another agent, another CI job) needs its own ports,
# otherwise both runs fight over :3210/:5273
E2E_BACKEND_PORT=3311 E2E_FRONTEND_PORT=5374 npm run test:e2e
```

- `e2e/lib/flows.ts` — shared flows (`createGame`, `joinGame`, `setName`, `closeJoining`, `readRoleCards`,
  `startActualGame`, `startGameWithPlayers`, `isVisible`, `waitUntilVisible`, `waitForNight`,
  `collectPageErrors`, `failOnDialogs`). `startGameWithPlayers` returns the role each phone was dealt.
- `e2e/specs/wiring.spec.ts` — four phones from the start page into the first night. If this is red,
  ignore every other browser result.
- `e2e/specs/gameplay.spec.ts` — lobby, an acting role's night turn, a bystander, the day vote, the GM
  escape hatch.
- `e2e/specs/reconnect.spec.ts` — reload in the lobby and mid-game, a second tab not stealing a seat.
- `e2e/specs/disconnect-phases.spec.ts` — **the disconnection matrix**: every phase (lobby, role
  selection, distribution, night as bystander and on your own turn, sheriff election, all three day
  stages, game over) against four shapes of loss: a network blip (offline + transport close, then a new
  socket id), a reload, a closed tab reopened in the same context, and the GM going offline. Asserts
  catch-up rather than stale state, seat/role identity, and that a pending own turn does not silently
  advance. Note: `setOffline` alone does not drop an open websocket — a real radio loss is only noticed
  at socket.io's ping timeout (~45s), so the spec closes the transport explicitly to be honest about
  what it proves.
- `e2e/specs/robustness.spec.ts` — failed join, back button during the server gate, double-tap create.
- `e2e/specs/escaping.spec.ts` — an HTML payload in a player name renders as text.

Rules: every spec asserts in `afterEach` that no `dialog` opened and no `pageerror`/`console.error`
happened — the app must never use `alert()` as its only feedback. Roles are random, so derive them from
`startGameWithPlayers().roles`. No `waitForTimeout`; use `expect.poll` / `isVisible`. Animate-free
assertions beat immediate clicks. The browser suite runs locally against a local backend: it cannot judge
audio pacing or real device behaviour.



### Test Coverage
| File | Tests | Coverage |
|---|---|---|
| `vote.selectors.test.ts` | 30 | `isVotingComplete`, `getVoteResult`, `getNominations`, `getNominatedPlayers`, `getVotingWinner` (ties, abstains, sheriff tie-breaker), `getActingPlayers` |
| `night.selectors.test.ts` | 31 | `getWerewolfVotes`, `getWerewolfVictimUUID`, `getNextToWakeUp` (night order, first-night-only roles), `checkPlayerNightRole` (turn, liveness) |
| `vote.handler.test.ts` | 61 | `nominate`, `castLynchVote`, `castSheriffVote`, `readyForNight`, `acceptSheriffRole`, `forceAdvance`, `handleSheriffDeath` |
| `lobby.handler.test.ts` | 29 | `createGame`, `createNewPlayer`, `roleDistribution` validation, `startGame` atomicity, `closeJoining`, `changeName`, game id uniqueness |
| `night.handler.test.ts` | 18 | `nextRole`, `forceNextRole`, night resolution (witch heal/kill, lover chain, red lady, sheriff death) |
| `role.handler.test.ts` | 48 | Werewolf, Seer, Cupid, Witch, RedLady handlers incl. target and turn validation |
| `game.store.test.ts` | 10 | `GameStore` singleton, CRUD, `hasGame`, `cleanupOldGames` |
| `game.manager.test.ts` | 17 | Manager authority, join/rejoin/disconnect, dead players, `managerAdvance` |
| `sync.provider.test.ts` | 23 | `getLocalPlayerState` — role hiding, vote visibility, witch info, seer reveals, cupid lover info |
| `scenarios.test.ts` | 20 | **Full game simulations**: multi-round games, couple wins, all-abstain, witch dual potion, sheriff tie-breaker, red lady death, dead-lock scenarios |
| `e2e/smoke.test.ts` | 2 | The harness itself: lobby to first night, per-player snapshots |
| `e2e/game-flow.test.ts` | 11 | Complete nights (heal, poison, red lady), sheriff election, full day, all three win conditions, sheriff death badge clear, dead-GM election exit |
| `e2e/reconnect.test.ts` | 5 | Reload mid-day, network blip with new socket id, lobby refresh, post-lobby rejoin, disconnect mid-night |
| `e2e/security.test.ts` | 9 | Manager-only actions, stranger socket, out-of-turn, dead players, target validation, snapshot leaks, escape hatch, intentional death reveal |
| `e2e/voting.test.ts` | 28 | Every tie shape (incl. three-way and the sheriff as a tied candidate), abstains, nomination collisions, vote integrity, lynch chains, election ordering, `forceAdvance` from each day stage |
| `e2e/roles-and-night.test.ts` | 27 | Composition extremes (1–3 wolves, no cupid/witch, all five wakers), night-order integrity, cupid/witch/seer/red-lady edges, three rounds of persistence |
| `e2e/protocol.test.ts` | 23 | Malformed payloads per event, unknown events, replay, concurrent emits, multi-game isolation, socket churn, name/ID validation |
| `e2e/fuzz.test.ts` | 2 | Seeded random full games: 3 per run by default, invariant checking after every sync, hard-branch coverage report |

Browser suite (`e2e/specs/`, Playwright, ~4.5 min, 67 tests):

| File | Tests | Coverage |
|---|---|---|
| `wiring.spec.ts` | 2 | Four phones into the first night; bad game id shows the error card |
| `gameplay.spec.ts` | 5 | Lobby, acting role's night turn, bystander, full day→night 2, GM escape hatch |
| `reconnect.spec.ts` | 4 | Reload in lobby and mid-game, second context, error-card recovery |
| `disconnect-phases.spec.ts` | 18 | Disconnection matrix: 10 phases × network blip, reload, reopened tab, GM offline; connection banner and role chip |
| `robustness.spec.ts` | 5 | Failed join, gate overlay, double-tap create, stray-tap guard, GM-only control |
| `escaping.spec.ts` | 2 | HTML payload in a player name inert in lobby, day and death popup |
| `roles-ui.spec.ts` | 10 | Witch heal/poison/both, seer, cupid bond on both lovers, werewolf pack, villager, dead role never wakes |
| `screens.spec.ts` | 5 | Sheriff election, day result, game over, 10-player lobby, 40-char name |
| `audio.spec.ts` | 5 | Narration and atmosphere are Game-Manager-only (measured per phone), no repeats per snapshot, silence before a game |
| `navigation.spec.ts` | 11 | Deep links, Back/Forward, hash case, two games in one context, reload on distribution and game over, overflow, tap-target size |


### Test Helpers
`test-helpers.ts` provides mock factories:
- `createMockGame(overrides)`
- `createMockPlayer(overrides)`
- `createGameWithPlayers(count)`
- `setRoles(game, roles[])`

## Data Models
- **Enums:** String Enums are used for `Role` (e.g., `"WEREWOLF"`) and `Phase` (e.g., `"NIGHT"`) for better logging and serialization.
- **Player State:** Role-specific attributes (like `usedHealingPotion` or `lovePartner`) are stored in `Player` objects to persist across rounds and enable rejoining.

## Game Logic (State Machine)
The game follows a strict phase sequence:
1.  **LOBBY**: Players join via QR code/Socket.
2.  **ROLE_SELECTION**: Game Master selects roles.
3.  **DISTRIBUTION**: Roles are assigned.
4.  **NIGHT**: A sequence of sub-turns (Seer -> Wolves -> Witch -> ...).
    - The `Game` object tracks `activeNightRole` to know whose turn it is.
    - `role.handler.ts` manages the transition between roles using `nextRole`.
    - An action is only valid when the player's role is `activeNightRole` *and* the player is alive.
5.  **SHERIFF_ELECTION**: Occurs after the first Night (Round 0).
    - The village votes for a Sheriff.
    - Resolution requires the elected Sheriff to accept the badge or the GM to continue.
6.  **DAY**: Discussion and Voting.
    - Day consists of 3 stages: Nominations (discussion), Trial (voting on nominated players), and Results.
    - Voting logic is handled in `VoteHandler.castLynchVote`.
    - Lynch resolution triggers a return to **NIGHT**.
7.  **GAME_OVER**: Win condition met.

## Known limitations (accepted, do not "fix" silently)

- **Rejoin is keyed on `playerUUID`, not a secret.** `playerUUID` is part of every player's snapshot, so in principle one player can take over another's seat by emitting `joinGame` with their UUID. Accepted for a party game played by friends in one room; do not build a token scheme without asking. The frontend escaping of display names is what keeps this from being remotely reachable.
- **No werewolf/villager parity win condition.** The game only ends when all wolves are dead, only wolves are alive, or only the loving couple is alive. A village that is outnumbered keeps playing.
- **The game manager is the only escape hatch.** When a phase is stuck (a player went AFK), the GM advances it explicitly; there is no timeout and a disconnected player is not removed from the game, only from the socket mapping.
- **Some roles are narrator-mediated, not app-driven.** The Little Girl has `wakesUp: false` and no handler because her peek happens physically around the table, narrated by the game master. Do not add a night UI for her without asking; the same will apply to any future role whose ability is someone's word rather than a screen.


# Frontend Architecture

## Core Concepts

The frontend is built without a heavy framework (like React or Vue), relying on a custom, lightweight component system.

### 1. The Reactive Store (`src/store.ts`)
- A centralized, observable store (`LocalAppState`).
- Views subscribe to specific parts of the state via `subscribeSelector`.
- **UI is reactive**: When the store receives a `syncState` from the server, all mounted views automatically update to reflect the truth.

### 2. View Architecture
- **Base Class**: All views extend the `View` abstract class (`src/base-view.ts`).
- **Lifecycle**:
    - `mount(container)`: Called when the view enters the DOM.
    - `unmount()`: Called when the view is replaced. It automatically cleans up all store subscriptions.
- **Subscription Management**: Views use `subscribeSelector(this, selector, callback)` to register listeners. The store automatically adds these to the `View`'s internal unsubscription list. This prevents "ghost" updates from old rounds or destroyed components by ensuring all listeners are killed during `unmount()`.
- **Self-Updating**: Views are reactive. They mount once and listen to the store, mapping the current state to HTML whenever a relevant change occurs.

### 3. Routing (`src/router.ts`)
- A simple Hash-based router (`#/`, `#/game/:id`).
- Handles the lifecycle of top-level views.

### 4. Audio Service (`src/audio.service.ts`)
- A singleton managing atmosphere (looping background) and narration (one-time lines).
- **Narration is restricted**: To prevent chaos, narration sounds only play on the **Game Manager's** device.
- **Atmosphere**: Also restricted to the Game Manager to maintain a shared environmental feel for those playing in person.

## Folder Structure (`frontend/src/`)
- **`router.ts`**: Navigation logic.
- **`base-view.ts`**: The abstract `View` class and lifecycle definitions.
- **`store.ts`**: Global state.
- **`socket.service.ts`**: WebSocket communication.
- **`audio.service.ts`**: Sound and narration management.
- **`pages/`**:
    - **`start.ts`**: Landing page.
    - **`game.ts`**: Main Game Controller.
    - **`phases/`**: Sub-views for specific game phases.
