import { View } from '../../base-view';
import seerHtml from './seer.html?raw';
import { getState, subscribeSelector } from '../../store';
import { socketService } from '../../socket.service';
import { Role, ROLES } from '@shared/roles.js';

export class SeerPhase extends View {
    private selectedTargetUUID: string | null = null;

    mount(container: HTMLElement): void {
        this.container = container;
        this.container.innerHTML = seerHtml;

        // Reactive Subscriptions
        subscribeSelector(this, s => s.seerRevealUUID, () => this.updateUI());
        subscribeSelector(this, s => s.seerRevealRole, () => this.updateUI());
        subscribeSelector(this, s => s.players, () => this.updateUI());

        this.setupSelectionListeners();
        this.setupDismissListener();

        // Initial render
        this.updateUI();
    }

    private updateUI() {
        const state = getState();
        const revealUUID = state.seerRevealUUID;
        const revealRole = state.seerRevealRole;
        
        const selectionView = document.getElementById('seer-selection-view');
        const revealView = document.getElementById('seer-reveal-view');
        const controls = document.getElementById('seer-controls');
        const waitingMsg = document.getElementById('seer-waiting-message');
        const listEl = document.getElementById('seer-target-list');

        if (revealUUID && revealRole) {
            // STATE: REVEAL
            if (selectionView) selectionView.style.display = 'none';
            if (revealView) {
                revealView.style.display = 'block';
                this.renderRevealData(revealUUID, revealRole);
            }
        } else if (revealUUID) {
            // STATE: WAITING FOR SERVER ROLE
            if (controls) controls.style.display = 'none';
            if (waitingMsg) waitingMsg.style.display = 'block';
            if (listEl) {
                listEl.style.pointerEvents = 'none';
                listEl.style.opacity = '0.7';
            }
        } else {
            // STATE: SELECTION
            if (selectionView) selectionView.style.display = 'block';
            if (revealView) revealView.style.display = 'none';
            if (controls) controls.style.display = 'block';
            if (waitingMsg) waitingMsg.style.display = 'none';
            if (listEl) {
                listEl.style.pointerEvents = 'auto';
                listEl.style.opacity = '1';
            }
            this.renderPlayerList();
        }
    }

    private renderRevealData(playerUUID: string, role: Role) {
        const state = getState();
        const targetPlayer = state.players.find(p => p.playerUUID === playerUUID);
        const targetName = targetPlayer?.displayName || 'Unnamed Player';
        const roleDef = ROLES[role];

        const imgEl = document.getElementById('reveal-role-image') as HTMLImageElement;
        const roleNameEl = document.getElementById('reveal-role-name');
        const playerNameEl = document.getElementById('reveal-player-name');

        if (imgEl) imgEl.src = `/icons/${role.toUpperCase()}.png`;
        if (roleNameEl) roleNameEl.innerText = roleDef?.displayName || role;
        if (playerNameEl) playerNameEl.innerText = `${targetName} is...`;
    }

    private setupDismissListener() {
        const btn = document.getElementById('dismiss-reveal-btn');
        if (btn) {
            btn.addEventListener('click', () => {
                socketService.seerConfirmed();
            });
        }
    }

    private setupSelectionListeners() {
        const confirmBtn = document.getElementById('confirm-seer-target-btn');
        if (confirmBtn) {
            confirmBtn.addEventListener('click', () => {
                if (this.selectedTargetUUID) {
                    socketService.revealRole(this.selectedTargetUUID);
                }
            });
        }
    }

    private renderPlayerList() {
        const listEl = document.getElementById('seer-target-list');
        if (!listEl) return;

        const state = getState();
        const players = state.players.filter(p => p.isAlive && p.playerUUID !== state.playerUUID);
        
        listEl.innerHTML = players.map(p => {
            const isSelected = this.selectedTargetUUID === p.playerUUID;
            return `
                <li class="pixel-list-item selectable-player ${isSelected ? 'selected' : ''}" data-uuid="${p.playerUUID}">
                    <span class="player-dot alive"></span>
                    <span class="player-name">${p.displayName || 'Unnamed Player'}</span>
                </li>
            `;
        }).join('');

        const items = listEl.querySelectorAll('.selectable-player');
        items.forEach(item => {
            item.addEventListener('click', () => {
                if (getState().seerRevealUUID) return;

                items.forEach(i => i.classList.remove('selected'));
                item.classList.add('selected');
                this.selectedTargetUUID = item.getAttribute('data-uuid');
                
                const confirmBtn = document.getElementById('confirm-seer-target-btn') as HTMLButtonElement;
                if (confirmBtn) confirmBtn.disabled = false;
            });
        });
    }
}
