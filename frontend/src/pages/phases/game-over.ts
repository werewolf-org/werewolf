import gameOverHtml from './game-over.html?raw';
import { View } from '../../base-view';
import { subscribeSelector, getState } from '../../store';
import { Role, ROLES, Team } from '@shared/roles.js';
import { audioService } from '../../audio.service';
import { escapeHtml } from '../../html';

export class GameOverPhase extends View {
    private winningNarrationPlayed = false;

    mount(container: HTMLElement): void {
        this.container = container;
        this.container.innerHTML = gameOverHtml;

        subscribeSelector(this, s => s.winningTeam, (_winningTeam) => {
            this.render();
        });

        subscribeSelector(this, s => s.players, (_players) => {
            this.render();
        });

        const backBtn = document.getElementById('back-to-lobby-btn');
        if (backBtn) {
            backBtn.onclick = () => {
                window.location.hash = '/';
            };
        }

        // No explicit render: both subscriptions paint once at subscribe time.
    }

    private render(): void {
        const state = getState();
        const winningTeamText = document.getElementById('winner-team-text');
        const playerStatusText = document.getElementById('player-status-text');
        const rolesList = document.getElementById('final-roles-list');

        if (!winningTeamText || !playerStatusText || !rolesList) return;

        // 1. Determine the winner name
        let winnerName = "No one wins!";
        winningTeamText.classList.remove('winner-wolf', 'winner-village', 'winner-couple');
        
        // Every syncState re-renders; the win narration must only start once.
        const narration = (line: string) => {
            if (this.winningNarrationPlayed) return;
            this.winningNarrationPlayed = true;
            audioService.playNarration(line, 'overwrite');
        };

        if (state.winningTeam === 'werewolves') {
            document.body.classList.remove('light-mode');
            winnerName = "The Werewolves Win!";
            winningTeamText.classList.add('winner-wolf');
            narration('werewolves_won');
            audioService.setAtmosphere('Werewolf');
        } else if (state.winningTeam === 'village') {
            document.body.classList.add('light-mode');
            winnerName = "The Village Wins!";
            winningTeamText.classList.add('winner-village');
            narration('village_won');
            audioService.setAtmosphere('Village-Won');
        } else if (state.winningTeam === 'couple') {
            document.body.classList.add('light-mode');
            winnerName = "The Lovers Win!";
            winningTeamText.classList.add('winner-couple');
            narration('lovers_won');
            audioService.setAtmosphere('Amor');
        } else if (state.winningTeam === null) {
            document.body.classList.remove('light-mode');
            winnerName = "No one wins!";
            audioService.stopAllNarration();
            audioService.setAtmosphere('Evening');
        }
        winningTeamText.innerText = winnerName;

        // 2. Check if the player won
        const myRole = state.role;
        const myLovePartnerUUID = state.lovePartnerUUID;
        let didIWin = false;

        if (state.winningTeam === 'werewolves') {
            if (myRole && ROLES[myRole].team === Team.WOLF) didIWin = true;
        } else if (state.winningTeam === 'village') {
            if (myRole && ROLES[myRole].team === Team.VILLAGE) didIWin = true;
        } else if (state.winningTeam === 'couple') {
            if (myLovePartnerUUID !== null) didIWin = true;
        }

        playerStatusText.innerText = didIWin ? "You won!" : "You lost!";
        playerStatusText.className = didIWin ? "status-win" : "status-loss";

        // 3. Render all players and their roles (sorted by winners first, then alive status)
        const sortedPlayers = [...state.players].sort((a, b) => {
            const aWon = this.checkIfPlayerWon(a, state.winningTeam);
            const bWon = this.checkIfPlayerWon(b, state.winningTeam);
            if (aWon !== bWon) return aWon ? -1 : 1;
            if (a.isAlive !== b.isAlive) return a.isAlive ? -1 : 1;
            return 0;
        });

        rolesList.innerHTML = sortedPlayers.map(p => {
            const roleDef = p.role ? ROLES[p.role as Role] : null;
            const isWinner = this.checkIfPlayerWon(p, state.winningTeam);
            
            return `
                <li class="pixel-list-item final-role-item ${!p.isAlive ? 'dead-player' : ''}">
                    <span style="${isWinner ? 'color: #ffcc00;' : ''}">
                        ${escapeHtml(p.displayName || 'Unnamed Player')}
                    </span>
                    <span class="fog-text">${roleDef ? roleDef.displayName : 'Unknown'}</span>
                </li>
            `;
        }).join('');
    }

    private checkIfPlayerWon(player: any, winningTeam: string | null): boolean {
        if (!winningTeam) return false;
        if (!player.role) return false;

        const roleDef = ROLES[player.role as Role];
        if (winningTeam === 'werewolves' && roleDef.team === Team.WOLF) return true;
        if (winningTeam === 'village' && roleDef.team === Team.VILLAGE) return true;
        
        // If winningTeam is 'couple', we can only be sure if they are alive (as heuristic)
        // because we don't have the love partner info for others.
        if (winningTeam === 'couple') {
            return player.isAlive; 
        }

        return false;
    }
}
