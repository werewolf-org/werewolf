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
3.  **Tailored Snapshots**: Instead of granular events, the backend sends a "Tailored State Snapshot" (`syncState`) to each player. This snapshot contains only the information that specific player is allowed to see (e.g., their own role, their own potion status, and public game info). **Exception**: When the phase is `GAME_OVER`, all player roles and statuses are revealed to everyone for the summary screen.

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
- **Exception**: When the phase is `GAME_OVER`, it reveals all roles and statuses for the summary screen.

## Communication Flow
1. **Socket Event**: `index.ts` receives a socket event and calls the relevant `GameManager` method.
2. **Logic Execution**: `GameManager` fetches the game, validates the request via **Selectors**, and executes the change via a **Handler**.
3. **State Sync**: `GameManager` invokes the `SyncProvider` to generate tailored snapshots for all players and broadcasts them via `socket.service.ts`.

## Data Storage (`backend/src/store/`)
- **`game.store.ts`**: Singleton in-memory database (`Map<string, Game>`).

## Data Models
- **Enums:** String Enums are used for `Role` (e.g., `"WEREWOLF"`) and `Phase` (e.g., `"NIGHT"`) for better logging and serialization.
- **Player State:** Role-specific attributes (like `usedHealingPotion` or `lovePartner`) are stored in `Player` objects to persist across rounds and enable rejoining.

## Game Logic (State Machine)
The game follows a strict phase sequence:
1.  **LOBBY**: Players join via QR code/Socket.
2.  **SETUP**: Game Master selects roles.
3.  **DISTRIBUTION**: Roles are assigned.
4.  **NIGHT**: A sequence of sub-turns (Seer -> Wolves -> Witch -> ...).
    - The `Game` object tracks `activeNightRole` to know whose turn it is.
    - `role.handler.ts` manages the transition between roles using `nextRole`.
5.  **SHERIFF_ELECTION**: Occurs after the first Night (Round 0).
    - The village votes for a Sheriff.
    - Resolution requires the elected Sheriff to accept the badge or the GM to continue.
6.  **DAY**: Discussion and Voting.
    - Voting logic is handled in `VoteHandler.castLynchVote`.
    - Lynch resolution triggers a return to **NIGHT**.
7.  **GAME_OVER**: Win condition met.

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
