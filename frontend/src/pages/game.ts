import gameHtml from './game.html?raw';
import { subscribeSelector, getState, resetState, setState, getStoredPlayerUUID, clearStoredPlayerUUID } from '../store';
import { escapeHtml } from '../html';
import { navigate } from '../router';
import { Phase } from '@shared/phases';
import { LobbyPhase } from './phases/lobby';
import { View } from '../base-view';
import { RoleSelectionPhase } from './phases/role-selection';
import { socketService } from '../socket.service';
import { RoleDistributionPhase } from './phases/role-distribution';
import { NightPhase } from './phases/night';
import { DayPhase } from './phases/day';
import { SheriffElectionPhase } from './phases/sheriff-election';
import { GameOverPhase } from './phases/game-over';
import { ROLES, Role } from '@shared/roles.js';

export class GamePage extends View {
    private gameId: string;
    private phaseContainer: HTMLElement | null = null;
    private errorView: HTMLElement | null = null;
    private knownDeadUUIDs: Set<string> = new Set();
    private deathsInitialized: boolean = false;

    // GM escape hatch
    private advanceView: HTMLElement | null = null;
    private advanceBtn: HTMLButtonElement | null = null;
    private advanceConfirmEl: HTMLElement | null = null;
    private advanceConfirmBtn: HTMLButtonElement | null = null;
    private advanceCancelBtn: HTMLButtonElement | null = null;
    private advancePending = false;

    // Connection banner and persistent role chip
    private connectionBanner: HTMLElement | null = null;
    private roleChip: HTMLElement | null = null;
    private roleChipName: HTMLElement | null = null;

    // Non-blocking feedback for a rejected action
    private toastEl: HTMLElement | null = null;
    private toastMessageEl: HTMLElement | null = null;
    private toastTimer: number | null = null;
    
    // Track the current sub-view
    private currentPhaseView: View | null = null;

    constructor(gameId: string) {
        super();
        this.gameId = gameId;
    }

    mount(container: HTMLElement): void {
        this.container = container;
        this.container.innerHTML = gameHtml;

        this.phaseContainer = document.getElementById('phase-view-container');
        this.errorView = document.getElementById('game-error-view');

        this.connectionBanner = document.getElementById('connection-banner');
        this.roleChip = document.getElementById('my-role-chip');
        this.roleChipName = document.getElementById('my-role-chip-name');
        this.toastEl = document.getElementById('game-toast');
        this.toastMessageEl = document.getElementById('game-toast-message');

        this.advanceView = document.getElementById('manager-advance-view');
        this.advanceBtn = document.getElementById('manager-advance-btn') as HTMLButtonElement | null;
        this.advanceConfirmEl = document.getElementById('manager-advance-confirm');
        this.advanceConfirmBtn = document.getElementById('manager-advance-confirm-btn') as HTMLButtonElement | null;
        this.advanceCancelBtn = document.getElementById('manager-advance-cancel-btn') as HTMLButtonElement | null;

        if (this.advanceBtn) {
            this.advanceBtn.addEventListener('click', () => this.armAdvance());
        }
        if (this.advanceConfirmBtn) {
            this.advanceConfirmBtn.addEventListener('click', () => this.confirmAdvance());
        }
        if (this.advanceCancelBtn) {
            this.advanceCancelBtn.addEventListener('click', () => this.disarmAdvance());
        }
        this.advancePending = false;
        
        // cleanup state
        resetState();
        // The route's gameId decides which seat we may resume, so resolve it
        // before emitting joinGame: this is what makes a reload rejoin the right
        // game (and only that game). Without a stored id we send null so the
        // backend creates a fresh player instead of guessing.
        const playerUUID = getStoredPlayerUUID(this.gameId);
        // Keep the gameId in the store as well. A reconnect that fires before the first
        // snapshot arrives reads gameId from here; without it the socket layer skipped the
        // re-announce and the phone stayed on a stale screen until the next manual refresh.
        setState({ gameId: this.gameId, playerUUID });

        this.deathsInitialized = false;
        this.knownDeadUUIDs.clear();

        // Leave the error state via the router so the whole page is torn down.
        const backBtn = document.getElementById('game-error-back-btn');
        if (backBtn) {
            backBtn.onclick = () => {
                setState({ lastError: null });
                navigate('#/');
            };
        }

        console.log(`joining or re-joining (with playerUUID: ${playerUUID}) ...`);
        socketService.joinGame(this.gameId, playerUUID);

        console.log(`GamePage mounted for ${this.gameId}`);

        subscribeSelector(this, s => s.phase, (phase) => {
            if (phase) this.renderPhase(phase);
        });

        // A join that throws only emits `error`, so without this the page stays blank.
        subscribeSelector(this, s => s.lastError, (message) => {
            if (!message) return;

            if (getState().phase === null) {
                this.renderJoinError(message);
                return;
            }

            // Mid-game rejection (double tap, a candidate that was already taken, an
            // action the server does not allow). It must not block the page: an alert()
            // freezes timers, and a frozen socket cannot answer its ping, which drops
            // the connection and makes the phone look stuck until it is refreshed.
            this.showToast(message);

            // The rejected advance (e.g. no longer the manager's turn to skip) must
            // not leave the button stuck in its disabled state.
            this.advancePending = false;
            if (this.advanceBtn) this.advanceBtn.disabled = false;
        });

        // GM escape hatch: visible for the manager only, and only where a phase can
        // get stuck. The composite key also releases the in-flight guard as soon as
        // an advance actually moves the game on.
        subscribeSelector(this, s => [
            s.isManager,
            s.phase,
            s.activeNightRole,
            s.nominationsFinished,
            s.lynchDone,
            s.sheriffElectionDone,
        ].join('|'), () => this.updateManagerAdvance());

        // Connection banner + persistent role chip. Both used to be missing: a lost socket
        // looked like "nobody has acted yet", and a player who was offline during the role
        // distribution never learned their role at all.
        subscribeSelector(this, s => `${s.isConnected}|${s.phase}|${s.role}`, () => this.updateStatusStrip());

        // Global death tracking
        subscribeSelector(this, s => s.players, (players) => {
            if (players.length === 0) return;

            // On first sync after join/rejoin, just mark currently dead players as "known"
            if (!this.deathsInitialized) {
                players.forEach(p => {
                    if (!p.isAlive) this.knownDeadUUIDs.add(p.playerUUID);
                });
                this.deathsInitialized = true;
                return;
            }

            this.checkForNewDeaths(players);
        });

        // Setup close button for global popup
        const closeBtn = document.getElementById('close-death-popup');
        if (closeBtn) {
            closeBtn.onclick = () => {
                const overlay = document.getElementById('death-popup-overlay');
                if (overlay) overlay.style.display = 'none';
            };
        }
    }

    unmount(): void {
        super.unmount();
        if (this.toastTimer !== null) {
            window.clearTimeout(this.toastTimer);
            this.toastTimer = null;
        }
        if (this.currentPhaseView) {
            this.currentPhaseView.unmount();
        }
    }

    private showToast(message: string): void {
        if (!this.toastEl || !this.toastMessageEl) return;
        this.toastMessageEl.textContent = message;
        this.toastEl.style.display = 'block';
        if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
        this.toastTimer = window.setTimeout(() => {
            this.toastTimer = null;
            if (this.toastEl) this.toastEl.style.display = 'none';
        }, 4000);
    }

    private updateStatusStrip(): void {
        const state = getState();

        // Only claim a connection problem once a game is on screen; before that the server
        // gate and the error card own the page.
        if (this.connectionBanner) {
            const inGame = state.phase !== null;
            this.connectionBanner.style.display = inGame && !state.isConnected ? 'block' : 'none';
        }

        // The role chip carries the role past the distribution card, so a player who was
        // offline while roles were dealt can still find out what they are.
        const chipPhases: (Phase | null)[] = [Phase.NIGHT, Phase.SHERIFF_ELECTION, Phase.DAY];
        const showChip = !!state.role && chipPhases.includes(state.phase);
        if (this.roleChip && this.roleChipName) {
            this.roleChip.style.display = showChip ? 'block' : 'none';
            if (showChip && state.role) this.roleChipName.innerText = ROLES[state.role].displayName;
        }
    }

    private updateManagerAdvance(): void {        const state = getState();
        const visible = state.isManager
            && (state.phase === Phase.NIGHT || state.phase === Phase.DAY || state.phase === Phase.SHERIFF_ELECTION);

        // A step change means the last advance landed (or the phase moved on):
        // release the in-flight guard so the GM can act again.
        this.advancePending = false;
        if (this.advanceBtn) this.advanceBtn.disabled = false;

        if (!this.advanceView) return;
        this.advanceView.style.display = visible ? 'block' : 'none';

        if (!visible) this.disarmAdvance();
    }

    private armAdvance(): void {
        if (this.advancePending) return;
        if (!this.advanceConfirmEl || !this.advanceBtn) return;

        this.advanceConfirmEl.style.display = 'block';
        this.advanceBtn.style.display = 'none';
    }

    private disarmAdvance(): void {
        if (this.advanceConfirmEl) this.advanceConfirmEl.style.display = 'none';
        if (this.advanceBtn) this.advanceBtn.style.display = '';
        if (this.advanceConfirmBtn) this.advanceConfirmBtn.disabled = false;
        if (this.advanceCancelBtn) this.advanceCancelBtn.disabled = false;
    }

    private confirmAdvance(): void {
        if (this.advancePending) return;
        this.advancePending = true;

        this.disarmAdvance();
        if (this.advanceBtn) this.advanceBtn.disabled = true;

        socketService.managerAdvance();
    }

    private checkForNewDeaths(players: any[]) {
        const newlyDead = players.filter(p => !p.isAlive && !this.knownDeadUUIDs.has(p.playerUUID));
        if (newlyDead.length > 0) {
            newlyDead.forEach(p => this.knownDeadUUIDs.add(p.playerUUID));
            this.renderNewDeaths(newlyDead);
        }
    }

    private renderJoinError(message: string): void {
        // A stale UUID makes every retry fail the same way: forget this game's seat
        // (and only this game's) so the next join goes through as a new player.
        clearStoredPlayerUUID(this.gameId);
        setState({ playerUUID: null });

        if (this.currentPhaseView) {
            this.currentPhaseView.unmount();
            this.currentPhaseView = null;
        }
        if (this.phaseContainer) {
            this.phaseContainer.innerHTML = '';
            this.phaseContainer.style.display = 'none';
        }

        const overlay = document.getElementById('death-popup-overlay');
        if (overlay) overlay.style.display = 'none';

        const messageEl = document.getElementById('game-error-message');
        if (messageEl) messageEl.textContent = message;

        if (this.errorView) this.errorView.style.display = 'block';
    }

    private renderNewDeaths(newlyDead: any[]) {
        const overlay = document.getElementById('death-popup-overlay');
        const listEl = document.getElementById('newly-dead-list');
        if (!overlay || !listEl) return;

        listEl.innerHTML = newlyDead.map(p => {
            const roleName = p.role ? ROLES[p.role as Role].displayName : 'Unknown';
            return `
                <li class="pixel-list-item" style="justify-content: space-between;">
                    <span class="highlight-text" style="font-family: 'Press Start 2P'; font-size: 0.7rem;">
                        ${escapeHtml(p.displayName)}
                    </span>
                    <span class="fog-text" style="font-size: 1.2rem;">${roleName}</span>
                </li>
            `;
        }).join('');

        overlay.style.display = 'flex';
    }

    private renderPhase(phase: Phase): void {
        if (!this.phaseContainer) return;

        // A snapshot arrived: we are in the game, so any join error is history.
        if (this.errorView) this.errorView.style.display = 'none';
        this.phaseContainer.style.display = '';

        // Safety: Ensure Dark Mode if not in Day Phase, Sheriff Election, or Game Over (which handles it dynamically)
        if (phase !== Phase.DAY && phase !== Phase.SHERIFF_ELECTION && phase !== Phase.GAME_OVER) {
            document.body.classList.remove('light-mode');
        }

        // Cleanup previous sub-view
        if (this.currentPhaseView?.unmount) {
            this.currentPhaseView.unmount();
        }

        switch (phase) {
            case Phase.LOBBY:
                this.currentPhaseView = new LobbyPhase();
                break;
            case Phase.ROLE_SELECTION:
                this.currentPhaseView = new RoleSelectionPhase();
                break;
            case Phase.DISTRIBUTION:
                this.currentPhaseView = new RoleDistributionPhase();
                break;
            case Phase.NIGHT:
                this.currentPhaseView = new NightPhase();
                break;
            case Phase.SHERIFF_ELECTION:
                this.currentPhaseView = new SheriffElectionPhase();
                break;
            case Phase.DAY:
                this.currentPhaseView = new DayPhase();
                break;
            case Phase.GAME_OVER:
                this.currentPhaseView = new GameOverPhase();
                break;
            default: {
                // Every Phase has a view. If a new enum value is added, this line fails the
                // type check instead of silently rendering nothing.
                const exhaustive: never = phase;
                throw new Error(`No view for phase ${exhaustive}`);
            }
        }

        this.phaseContainer.innerHTML = '';
        this.currentPhaseView.mount(this.phaseContainer);
    }
}
