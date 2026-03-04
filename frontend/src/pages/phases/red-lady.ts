import { View } from '../../base-view';
import redLadyHtml from './red-lady.html?raw';
import { getState, subscribeSelector } from '../../store';
import { socketService } from '../../socket.service';

export class RedLadyPhase extends View {
    private selectedTargetUUID: string | null = null;

    mount(container: HTMLElement): void {
        this.container = container;
        this.container.innerHTML = redLadyHtml;

        console.log('mount red lady with id: ', getState().redLadySleepoverUUID);

        // Reactive Subscriptions
        subscribeSelector(this, s => s.redLadySleepoverUUID, () => this.updateUI());
        subscribeSelector(this, s => s.players, () => this.updateUI());

        const confirmBtn = document.getElementById('confirm-sleepover-btn');
        if (confirmBtn) {
            confirmBtn.addEventListener('click', () => {
                if (this.selectedTargetUUID) {
                    console.log('sleepover at: ', this.selectedTargetUUID);
                    socketService.sleepOver(this.selectedTargetUUID);
                }
            });
        }

        // Initial render
        this.updateUI();
    }

    private updateUI() {
        const state = getState();
        const hasActed = !!state.redLadySleepoverUUID;

        const controls = document.getElementById('red-lady-controls');
        const waitingMsg = document.getElementById('red-lady-waiting-message');
        const listEl = document.getElementById('red-lady-target-list');

        if (hasActed) {
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
        const listEl = document.getElementById('red-lady-target-list');
        if (!listEl) return;

        const state = getState();
        const players = state.players.filter(p => p.isAlive && p.playerUUID !== state.playerUUID);
        
        listEl.innerHTML = players.map(p => {
            const isSelected = this.selectedTargetUUID === p.playerUUID;
            const isPersistedSelected = state.redLadySleepoverUUID === p.playerUUID;

            return `
                <li class="pixel-list-item selectable-player ${isSelected || isPersistedSelected ? 'selected' : ''}" data-uuid="${p.playerUUID}">
                    <span class="player-dot alive"></span>
                    <span class="player-name">${p.displayName}</span>
                </li>
            `;
        }).join('');

        // Selection logic
        const items = listEl.querySelectorAll('.selectable-player');
        items.forEach(item => {
            item.addEventListener('click', () => {
                if (getState().redLadySleepoverUUID) return;

                items.forEach(i => i.classList.remove('selected'));
                item.classList.add('selected');
                this.selectedTargetUUID = item.getAttribute('data-uuid');
                
                const confirmBtn = document.getElementById('confirm-sleepover-btn') as HTMLButtonElement;
                if (confirmBtn) confirmBtn.disabled = false;
            });
        });
    }
}