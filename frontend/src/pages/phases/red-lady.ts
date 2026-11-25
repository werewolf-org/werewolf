import { View } from '../../base-view';
import redLadyHtml from './red-lady.html?raw';
import { getState, subscribeSelector } from '../../store';
import { socketService } from '../../socket.service';
import { escapeHtml } from '../../html';

export class RedLadyPhase extends View {
    private selectedTargetUUID: string | null = null;
    private lockedActions = new Set<string>();

    mount(container: HTMLElement): void {
        this.container = container;
        this.container.innerHTML = redLadyHtml;

        console.log('mount red lady with id: ', getState().redLadySleepoverUUID);

        // Reactive Subscriptions
        subscribeSelector(this, s => s.redLadySleepoverUUID, () => this.updateUI());
        subscribeSelector(this, s => s.players, () => this.updateUI());

        const confirmBtn = document.getElementById('confirm-sleepover-btn') as HTMLButtonElement | null;
        if (confirmBtn) {
            confirmBtn.addEventListener('click', () => {
                if (this.selectedTargetUUID) {
                    // Locked synchronously: a second tap would advance nextRole again.
                    if (!this.lockAction('sleepover', confirmBtn, () => !getState().redLadySleepoverUUID)) return;
                    console.log('sleepover at: ', this.selectedTargetUUID);
                    socketService.sleepOver(this.selectedTargetUUID);
                }
            });
        }
    }

    // Disable an action button on the first tap so a double tap cannot emit twice.
    // A successful action answers with a fresh snapshot; if nothing changed within
    // the grace period, treat it as a rejection (the socket service alerts) and re-arm.
    private lockAction(key: string, btn: HTMLButtonElement | null, stillPending: () => boolean): boolean {
        if (this.lockedActions.has(key)) return false;
        this.lockedActions.add(key);
        if (btn) btn.disabled = true;
        window.setTimeout(() => {
            if (!stillPending()) return;
            this.lockedActions.delete(key);
            if (btn) btn.disabled = false;
        }, 3000);
        return true;
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
                    <span class="player-name">${escapeHtml(p.displayName || 'Unnamed Player')}</span>
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