import distributionHtml from './role-distribution.html?raw';
import { getState } from '../../store';
import { socketService } from '../../socket.service';
import { ROLES } from '@shared/roles.js';
import { audioService } from '../../audio.service';
import { View } from '../../base-view';
import { Phase } from '@shared/phases';

export class RoleDistributionPhase extends View {
    private lockedActions = new Set<string>();

    mount(container: HTMLElement): void {
        this.container = container;
        this.container.innerHTML = distributionHtml;

        const state = getState();
        const role = state.role;
        const isManager = state.isManager;

        audioService.playNarration('game_start', 'stack');
        audioService.setAtmosphere('Suspense');

        // 1. Display Role Info
        if (role && ROLES[role]) {
            const roleDef = ROLES[role];

            const nameDisplay = document.getElementById('role-name-display');
            if (nameDisplay) nameDisplay.innerText = roleDef.displayName;

            const descDisplay = document.getElementById('role-description');
            if (descDisplay) descDisplay.innerText = roleDef.description;

            const imgDisplay = document.getElementById('role-image') as HTMLImageElement;
            if (imgDisplay) imgDisplay.src = `/icons/${role.toUpperCase()}.png`;
        }

        // 2. Toggle Manager Controls
        const managerUi = document.getElementById('distribution-manager-controls');
        const waitingUi = document.getElementById('distribution-waiting-message');

        if (isManager) {
            if (managerUi) managerUi.style.display = 'block';
            if (waitingUi) waitingUi.style.display = 'none';

            const startBtn = document.getElementById('start-actual-game-btn') as HTMLButtonElement | null;
            if (startBtn) {
                startBtn.addEventListener('click', () => {
                    if (!this.lockAction(startBtn, () => getState().phase === Phase.DISTRIBUTION)) return;
                    socketService.startGame();
                });
            }
        } else {
            if (managerUi) managerUi.style.display = 'none';
            if (waitingUi) waitingUi.style.display = 'block';
        }
    }

    // Disable the GM button on the first tap so a double tap cannot start twice.
    // A successful action answers with a fresh snapshot; if nothing changed within
    // the grace period, treat it as a rejection (the socket service alerts) and re-arm.
    private lockAction(btn: HTMLButtonElement, stillPending: () => boolean): boolean {
        if (this.lockedActions.has('start')) return false;
        this.lockedActions.add('start');
        btn.disabled = true;
        window.setTimeout(() => {
            if (!stillPending()) return;
            this.lockedActions.delete('start');
            btn.disabled = false;
        }, 3000);
        return true;
    }
}
