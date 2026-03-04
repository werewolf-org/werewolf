import gameHtml from './game.html?raw';
import { subscribeSelector, getState, resetState } from '../store';
import { Phase } from '@shared/phases';
import { LobbyPhase } from './phases/lobby';
import { PlaceholderPhase } from './phases/placeholder';
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
    private knownDeadUUIDs: Set<string> = new Set();
    private deathsInitialized: boolean = false;
    
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
        
        // cleanup state
        resetState();
        this.deathsInitialized = false;
        this.knownDeadUUIDs.clear();

        console.log(`joining or re-joining (with playerUUID: ${getState().playerUUID}) ...`);
        socketService.joinGame(this.gameId, getState().playerUUID ?? null);

        console.log(`GamePage mounted for ${this.gameId}`);

        subscribeSelector(this, s => s.phase, (phase) => {
            if (phase) this.renderPhase(phase);
        });

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
        if (this.currentPhaseView) {
            this.currentPhaseView.unmount();
        }
    }

    private checkForNewDeaths(players: any[]) {
        const newlyDead = players.filter(p => !p.isAlive && !this.knownDeadUUIDs.has(p.playerUUID));
        if (newlyDead.length > 0) {
            newlyDead.forEach(p => this.knownDeadUUIDs.add(p.playerUUID));
            this.renderNewDeaths(newlyDead);
        }
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
                        ${p.displayName}
                    </span>
                    <span class="fog-text" style="font-size: 1.2rem;">${roleName}</span>
                </li>
            `;
        }).join('');

        overlay.style.display = 'flex';
    }

    private renderPhase(phase: Phase): void {
        if (!this.phaseContainer) return;

        // Safety: Ensure Dark Mode if not in Day Phase or Sheriff Election
        if (phase !== Phase.DAY && phase !== Phase.SHERIFF_ELECTION) {
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
            default:
                this.currentPhaseView = new PlaceholderPhase(phase);
                break;
        }

        this.phaseContainer.innerHTML = '';
        this.currentPhaseView.mount(this.phaseContainer);
    }
}
