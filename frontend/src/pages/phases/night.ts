import { View } from '../../base-view';
import nightHtml from './night.html?raw';
import { subscribeSelector, getState } from '../../store';
import { Role, ROLES } from '@shared/roles.js';
import { WerewolvesPhase } from './werewolves';
import { SeerPhase } from './seer';
import { RedLadyPhase } from './red-lady';
import { WitchPhase } from './witch';
import { CupidPhase } from './cupid';
import { audioService } from '../../audio.service';

export class NightPhase extends View {
    private currentSubView: View | null = null;

    mount(container: HTMLElement): void {
        this.container = container;
        this.container.innerHTML = nightHtml;

        // Reactive Subscriptions
        subscribeSelector(this, s => s.activeNightRole, (role) => {
            if (role) this.playRoleWakingAudio(role);
            this.updateNightView();
        });
        
        subscribeSelector(this, s => s.cupidSelectedLovers, () => audioService.playNarration('love_partners', 'overwrite'));
        subscribeSelector(this, s => s.players, () => this.updateNightView());
        subscribeSelector(this, s => s.role, () => this.updateNightView());
        subscribeSelector(this, s => s.lovePartnerUUID, () => this.updateNightView());

        // Initial render
        const activeNightRole = getState().activeNightRole;
        if(activeNightRole) this.playRoleWakingAudio(activeNightRole);
        this.updateNightView();
    }

    unmount(): void {
        super.unmount();
        if (this.currentSubView) {
            this.currentSubView.unmount();
        }
    }

    private playRoleWakingAudio(role: Role) {
        audioService.playNarration('close_your_eyes', 'overwrite');
        switch(role) {
            case Role.CUPID: audioService.playNarration('cupid_wakes'); audioService.setAtmosphere('Amor'); break;
            case Role.RED_LADY: audioService.playNarration('red_lady_wakes'); audioService.setAtmosphere('Lady'); break;
            case Role.SEER: audioService.playNarration('seer_wakes'); audioService.setAtmosphere('Seer'); break;
            case Role.WEREWOLF: audioService.playNarration('werewolf_wakes'); audioService.setAtmosphere('Werewolf'); break;
            case Role.WITCH: audioService.playNarration('witch_wakes'); audioService.setAtmosphere('Witch'); break;
            default: break;
        }
    }

    private updateNightView() {
        const state = getState();
        const activeRole = state.activeNightRole;
        const ownRole = state.role;
        
        const me = state.players.find(p => p.playerUUID === state.playerUUID);
        const isDead = me && !me.isAlive;

        const actionContainer = document.getElementById('night-action-container');
        const sleepView = document.getElementById('night-sleep-view');
        const errorView = document.getElementById('night-error-view');
        const deadView = document.getElementById('night-dead-view');
        const turnDisplay = document.getElementById('night-current-turn-display');
        const deadTurnDisplay = document.getElementById('night-dead-turn-display');

        // Reset all displays first
        if (actionContainer) actionContainer.style.display = 'none';
        if (sleepView) sleepView.style.display = 'none';
        if (errorView) errorView.style.display = 'none';
        if (deadView) deadView.style.display = 'none';

        // 0. Update turn display text
        if (activeRole) {
            const roleDef = ROLES[activeRole as Role];
            const text = `Current Turn: ${roleDef?.pluralName || activeRole}`;
            if (turnDisplay) turnDisplay.innerText = text;
            if (deadTurnDisplay) deadTurnDisplay.innerText = text;
        }

        // 1. Handle Dead Player
        if (isDead) {
            if (deadView) deadView.style.display = 'block';
            return;
        }

        // 2. Handle NULL/Error case
        if (activeRole === null) {
            if (errorView) errorView.style.display = 'block';
            return;
        }

        // 3. Logic: Who gets to see the Action UI?
        const isMyTurn = (activeRole && activeRole === ownRole);
        const isCupidTurnForLover = (activeRole === Role.CUPID && state.lovePartnerUUID !== null);

        if (isMyTurn || isCupidTurnForLover) {
            if (actionContainer) actionContainer.style.display = 'block';
            this.renderActionUI(activeRole as Role);
        } else {
            if (sleepView) sleepView.style.display = 'block';
        }
    }

    private renderActionUI(role: Role) {
        const actionContainer = document.getElementById('night-action-container');
        if (!actionContainer) return;

        if (role === Role.WEREWOLF) {
            if (!(this.currentSubView instanceof WerewolvesPhase)) {
                if (this.currentSubView?.unmount) this.currentSubView.unmount();
                this.currentSubView = new WerewolvesPhase();
                this.currentSubView.mount(actionContainer);
            }
        } else if (role === Role.SEER) {
            if (!(this.currentSubView instanceof SeerPhase)) {
                if (this.currentSubView?.unmount) this.currentSubView.unmount();
                this.currentSubView = new SeerPhase();
                this.currentSubView.mount(actionContainer);
            }
        } else if (role === Role.RED_LADY) {
            if (!(this.currentSubView instanceof RedLadyPhase)) {
                if (this.currentSubView?.unmount) this.currentSubView.unmount();
                this.currentSubView = new RedLadyPhase();
                this.currentSubView.mount(actionContainer);
            }
        } else if (role === Role.WITCH) {
            if (!(this.currentSubView instanceof WitchPhase)) {
                if (this.currentSubView?.unmount) this.currentSubView.unmount();
                this.currentSubView = new WitchPhase();
                this.currentSubView.mount(actionContainer);
            }
        } else if (role === Role.CUPID) {
            if (!(this.currentSubView instanceof CupidPhase)) {
                if (this.currentSubView?.unmount) this.currentSubView.unmount();
                this.currentSubView = new CupidPhase();
                this.currentSubView.mount(actionContainer);
            }
        } else {
            if (this.currentSubView?.unmount) this.currentSubView.unmount();
            this.currentSubView = null;
            actionContainer.innerHTML = `
                <div class="pixel-card">
                    <h3>Wake up, ${role}!</h3>
                    <p>Performing night actions...</p>
                </div>
            `;
        }
    }
}