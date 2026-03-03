import gameOverHtml from './game-over.html?raw';
import { View } from '../../base-view';
import { subscribeSelector, getState } from '../../store';
import { Role, ROLES, Team } from '@shared/roles.js';
import { audioService } from '../../audio.service';

export class GameOverPhase extends View {
    mount(container: HTMLElement): void {
        this.container = container;
        this.container.innerHTML = gameOverHtml;

        this.unsubs.push(subscribeSelector(s => s.winningTeam, (_winningTeam) => {
            this.render();
        }));

        this.unsubs.push(subscribeSelector(s => s.players, (_players) => {
            this.render();
        }));

        const backBtn = document.getElementById('back-to-lobby-btn');
        if (backBtn) {
            backBtn.onclick = () => {
                window.location.hash = '/';
            };
        }

        this.render();
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
        
        if (state.winningTeam === 'werewolves') {
            winnerName = "The Werewolves Win!";
            winningTeamText.classList.add('winner-wolf');
            audioService.playNarration('werewolves_won', 'overwrite');
            audioService.setAtmosphere('Werewolf');
        } else if (state.winningTeam === 'village') {
            winnerName = "The Village Wins!";
            winningTeamText.classList.add('winner-village');
            audioService.playNarration('village_won', 'overwrite');
            audioService.setAtmosphere('Village-Won');
        } else if (state.winningTeam === 'couple') {
            winnerName = "The Lovers Win!";
            winningTeamText.classList.add('winner-couple');
            audioService.playNarration('lovers_won', 'overwrite');
            audioService.setAtmosphere('Amor');
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
                        ${p.displayName} ${p.isSheriff ? '🤠' : ''}
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
