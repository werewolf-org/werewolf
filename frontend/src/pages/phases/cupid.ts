import { View } from '../../base-view';
import cupidHtml from './cupid.html?raw';
import { getState, subscribeSelector } from '../../store';
import { socketService } from '../../socket.service';
import { Role } from '@shared/roles.js';

export class CupidPhase extends View {
    private selectedTargetUUIDs: string[] = [];

    mount(container: HTMLElement): void {
        this.container = container;
        this.container.innerHTML = cupidHtml;

        // Reactive Subscriptions
        subscribeSelector(this, s => s.lovePartnerUUID, () => this.updateUI());
        subscribeSelector(this, s => s.lovePartnerConfirmed, () => this.updateUI());
        subscribeSelector(this, s => s.cupidFirstLoverUUID, () =>  this.updateUI());
        subscribeSelector(this, s => s.cupidFirstLoverConfirmed, () => this.updateUI());
        subscribeSelector(this, s => s.cupidSecondLoverConfirmed, () => this.updateUI());
        subscribeSelector(this, s => s.players, () => this.updateUI());

        this.setupCupidListeners();
        this.setupLoverListeners();
        
        // Initial render
        this.updateUI();
    }

    private updateUI() {
        const state = getState();
        const selectionView = document.getElementById('cupid-selection-view');
        const statusView = document.getElementById('cupid-status-view');
        const loversView = document.getElementById('lovers-view');
        const waitingMsg = document.getElementById('cupid-waiting-message');

        // Reset visibility
        if (selectionView) selectionView.style.display = 'none';
        if (statusView) statusView.style.display = 'none';
        if (loversView) loversView.style.display = 'none';
        if (waitingMsg) waitingMsg.style.display = 'none';

        // 1. IF I AM A LOVER
        if (state.lovePartnerUUID) {
            if (!state.lovePartnerConfirmed) {
                if (loversView) {
                    loversView.style.display = 'block';
                    const partnerNameEl = document.getElementById('partner-name');
                    if (partnerNameEl) {
                        partnerNameEl.innerText = state.players.find((player) => player.playerUUID == state.lovePartnerUUID)?.displayName ?? '';
                    }
                }
            } else {
                if (waitingMsg) {
                    waitingMsg.style.display = 'block';
                    const waitText = document.getElementById('cupid-wait-text');
                    if (waitText) waitText.innerText = "You have accepted your love. Waiting for your partner...";
                }
            }
        } 
        // 2. IF I AM CUPID
        else if (state.role === Role.CUPID) {
            if (!state.cupidFirstLoverUUID) {
                // Not acted yet: Selection mode
                if (selectionView) {
                    selectionView.style.display = 'block';
                    this.renderPlayerList();
                }
            } else {
                // Acted: Show progress status
                if (statusView) {
                    statusView.style.display = 'block';
                    this.renderLoverStatus();
                }
            }
        }
        // 3. OTHERS
        else {
            if (waitingMsg) waitingMsg.style.display = 'block';
        }
    }

    private renderLoverStatus() {
        const state = getState();
        const listEl = document.getElementById('lover-status-list');
        if (!listEl) return;

        const lovers = [
            { uuid: state.cupidFirstLoverUUID, confirmed: state.cupidFirstLoverConfirmed },
            { uuid: state.cupidSecondLoverUUID, confirmed: state.cupidSecondLoverConfirmed }
        ];

        listEl.innerHTML = lovers.map(l => {
            return `
                <li class="pixel-list-item" style="justify-content: space-between;">
                    <span>${state.players.find((player) => player.playerUUID == l.uuid)?.displayName}</span>
                    <span class="highlight-text">${l.confirmed ? 'READY' : 'AWAKENING...'}</span>
                </li>
            `;
        }).join('');
    }

    private setupCupidListeners() {
        const confirmBtn = document.getElementById('confirm-cupid-target-btn') as HTMLButtonElement;
        if (confirmBtn) {
            confirmBtn.addEventListener('click', () => {
                if (this.selectedTargetUUIDs.length === 2) {
                    socketService.bindLovers(this.selectedTargetUUIDs[0]!, this.selectedTargetUUIDs[1]!);
                }
            });
        }
    }

    private setupLoverListeners() {
        const confirmBtn = document.getElementById('confirm-love-btn');
        if (confirmBtn) {
            confirmBtn.addEventListener('click', () => {
                socketService.confirmLoverBond();
            });
        }
    }

    private renderPlayerList() {
        const listEl = document.getElementById('cupid-target-list');
        if (!listEl) return;

        const state = getState();
        const players = state.players.filter(p => p.isAlive);
        
        listEl.innerHTML = players.map(p => {
            const isSelected = this.selectedTargetUUIDs.includes(p.playerUUID);
            return `
                <li class="pixel-list-item selectable-player ${isSelected ? 'selected' : ''}" data-uuid="${p.playerUUID}">
                    <span class="player-dot alive"></span>
                    <span class="player-name">${p.displayName}</span>
                </li>
            `;
        }).join('');

        const items = listEl.querySelectorAll('.selectable-player');
        items.forEach(item => {
            item.addEventListener('click', () => {
                if (getState().cupidFirstLoverUUID) return; // Already acted

                const uuid = item.getAttribute('data-uuid');
                if (!uuid) return;

                if (this.selectedTargetUUIDs.includes(uuid)) {
                    this.selectedTargetUUIDs = this.selectedTargetUUIDs.filter(id => id !== uuid);
                    item.classList.remove('selected');
                } else if (this.selectedTargetUUIDs.length < 2) {
                    this.selectedTargetUUIDs.push(uuid);
                    item.classList.add('selected');
                }

                this.updateSelectionUI();
            });
        });
    }

    private updateSelectionUI() {
        const countEl = document.getElementById('cupid-selection-count');
        const confirmBtn = document.getElementById('confirm-cupid-target-btn') as HTMLButtonElement;
        
        if (countEl) countEl.innerText = `${this.selectedTargetUUIDs.length} / 2 Selected`;
        if (confirmBtn) confirmBtn.disabled = this.selectedTargetUUIDs.length !== 2;
    }
}
