import { View } from '../../base-view';
import werewolvesHtml from './werewolves.html?raw';
import { getState, subscribeSelector } from '../../store';
import { socketService } from '../../socket.service';

export class WerewolvesPhase extends View {
    private selectedTargetUUID: string | null = null;

    mount(container: HTMLElement): void {
        this.container = container;
        this.container.innerHTML = werewolvesHtml;

        // Reactive updates
        subscribeSelector(this, s => s.werewolfVotes, () => this.updateUI());
        subscribeSelector(this, s => s.players, () => this.updateUI());

        const confirmBtn = document.getElementById('confirm-werewolf-target-btn');
        if (confirmBtn) {
            confirmBtn.addEventListener('click', () => {
                const state = getState();
                const myUUID = state.playerUUID;
                const alreadyVoted = state.werewolfVotes && myUUID && state.werewolfVotes[myUUID];

                if (this.selectedTargetUUID && !alreadyVoted) {
                    socketService.werewolfVote(this.selectedTargetUUID);
                }
            });
        }

        this.updateUI();
    }

    private updateUI() {
        const state = getState();
        const myUUID = state.playerUUID;
        const votes = state.werewolfVotes || {};
        const hasVoted = !!(myUUID && votes[myUUID]);

        const controls = document.getElementById('werewolf-controls');
        const waitingMsg = document.getElementById('werewolf-waiting-message');
        const listEl = document.getElementById('werewolf-target-list');

        if (hasVoted) {
            if (controls) controls.style.display = 'none';
            if (waitingMsg) waitingMsg.style.display = 'block';
            if (listEl) {
                listEl.style.pointerEvents = 'none';
                listEl.style.opacity = '0.8';
            }
        } else {
            if (controls) controls.style.display = 'block';
            if (waitingMsg) waitingMsg.style.display = 'none';
            if (listEl) {
                listEl.style.pointerEvents = 'auto';
                listEl.style.opacity = '1';
            }
        }

        this.renderPlayerList();
    }

    private renderPlayerList() {
        const listEl = document.getElementById('werewolf-target-list');
        if (!listEl) return;

        const state = getState();
        const players = state.players.filter(p => p.isAlive);
        const votes = state.werewolfVotes || {};
        
        listEl.innerHTML = players.map(p => {
            const isSelected = this.selectedTargetUUID === p.playerUUID;
            
            // Find who is voting for this player
            const votersForThisPlayer = Object.entries(votes)
                .filter(([, targetUUID]) => targetUUID === p.playerUUID)
                .map(([voterUUID]) => {
                    const voter = state.players.find(v => v.playerUUID === voterUUID);
                    return voter?.displayName || 'Unnamed Player';
                });

            const voteDisplay = votersForThisPlayer.length > 0 
                ? `<div class="vote-indicators">${votersForThisPlayer.map(() => '<span class="wolf-icon">🐺</span>').join('')}</div>`
                : '';

            return `
                <li class="pixel-list-item selectable-player ${isSelected ? 'selected' : ''}" data-uuid="${p.playerUUID}">
                    <div style="display: flex; justify-content: space-between; width: 100%; align-items: center;">
                        <span>${p.displayName || 'Unnamed Player'}</span>
                        ${voteDisplay}
                    </div>
                </li>
            `;
        }).join('');

        // Selection logic
        const items = listEl.querySelectorAll('.selectable-player');
        items.forEach(item => {
            item.addEventListener('click', () => {
                const myUUID = state.playerUUID;
                if (myUUID && votes[myUUID]) return;

                items.forEach(i => i.classList.remove('selected'));
                item.classList.add('selected');
                this.selectedTargetUUID = item.getAttribute('data-uuid');
                
                const confirmBtn = document.getElementById('confirm-werewolf-target-btn') as HTMLButtonElement;
                if (confirmBtn) confirmBtn.disabled = false;
            });
        });
    }
}
