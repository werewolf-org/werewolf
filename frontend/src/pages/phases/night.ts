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
    // Narration must be idempotent: re-syncs and the extra first paint of a mount
    // re-enter these paths, and the GM must not hear a line restart.
    private announcedNightRole: Role | null = null;
    private lovePartnersAnnounced = false;

    mount(container: HTMLElement): void {
        this.container = container;
        this.container.innerHTML = nightHtml;

        // Reactive Subscriptions. subscribeSelector paints once at subscribe time,
        // so there is no separate initial render below.
        subscribeSelector(this, s => s.activeNightRole, (role) => {
            if (role) this.playRoleWakingAudio(role);
            this.updateNightView();
        });
        
        subscribeSelector(this, s => s.cupidSelectedLovers, (selected) => {
            if (selected) this.playLovePartnersAudio();
        });
        subscribeSelector(this, s => s.players, () => this.updateNightView());
        subscribeSelector(this, s => s.role, () => this.updateNightView());
        subscribeSelector(this, s => s.lovePartnerUUID, () => this.updateNightView());
    }

    unmount(): void {
        super.unmount();
        this.clearSubView();
    }

    private playRoleWakingAudio(role: Role) {
        // One wake-up call per role per night: a repeated role value (re-sync, the
        // immediate first invoke plus a later one) must not restart the narration.
        if (this.announcedNightRole === role) return;
        this.announcedNightRole = role;

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

    private playLovePartnersAudio() {
        if (this.lovePartnersAnnounced) return;
        this.lovePartnersAnnounced = true;
        audioService.playNarration('love_partners', 'overwrite');
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

        // 0. Update turn display text. The role name is a leak for sleeping players:
        // it tells every villager exactly which roles exist in this game, so only the
        // game manager (who runs the night) sees it.
        if (activeRole) {
            const roleDef = ROLES[activeRole as Role];
            const text = state.isManager
                ? `Current Turn: ${roleDef?.pluralName || activeRole}`
                : 'Close your eyes…';
            if (turnDisplay) turnDisplay.innerText = text;
            if (deadTurnDisplay) deadTurnDisplay.innerText = text;
        }

        // 1. Handle Dead Player
        if (isDead) {
            if (deadView) deadView.style.display = 'block';
            this.clearSubView();
            return;
        }

        // 2. Handle NULL/Error case
        if (activeRole === null) {
            if (errorView) errorView.style.display = 'block';
            this.clearSubView();
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
            // The cupid's status view is unmounted the moment the night moves on, so repeat the
            // confirmation in the sleep view. Without this the cupid never learns that the second
            // lover accepted - the night simply ends for them.
            const cupidSealed = document.getElementById('night-cupid-sealed');
            if (cupidSealed) {
                const isCupid = state.role === Role.CUPID && state.cupidSelectedLovers
                    && state.cupidFirstLoverConfirmed && state.cupidSecondLoverConfirmed;
                cupidSealed.style.display = isCupid ? 'block' : 'none';
            }
            // The previous role's sub-view is hidden but would keep its store
            // subscriptions alive; drop it so the next turn starts from a clean slate.
            this.clearSubView();
        }
    }

    private clearSubView() {
        if (this.currentSubView) {
            this.currentSubView.unmount();
            this.currentSubView = null;
        }
        const actionContainer = document.getElementById('night-action-container');
        if (actionContainer) actionContainer.innerHTML = '';
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