import { View } from '../../base-view';
import witchHtml from './witch.html?raw';
import { getState, subscribeSelector } from '../../store';
import { socketService } from '../../socket.service';
import { escapeHtml } from '../../html';
import { Role } from '@shared/roles.js';

export class WitchPhase extends View {
    private initiallyUsedHeal = false;
    private initiallyUsedKill = false;
    private selectedKillUUID: string | null = null;

    mount(container: HTMLElement): void {
        this.container = container;
        this.container.innerHTML = witchHtml;
        
        const state = getState();
        this.initiallyUsedHeal = state.witchUsedHealingPotion;
        this.initiallyUsedKill = state.witchUsedKillingPotion;
        
        // Reactive Subscriptions
        subscribeSelector(this, s => s.werewolfVictim, () => this.updateUI());
        subscribeSelector(this, s => s.witchUsedHealingPotion, () => this.updateUI());
        subscribeSelector(this, s => s.witchUsedKillingPotion, () => this.updateUI());
        subscribeSelector(this, s => s.players, () => this.updateUI());

        this.setupListeners();
    }

    private updateUI() {
        const state = getState();
        const victimUUID = state.werewolfVictim;
        const usedHeal = state.witchUsedHealingPotion;
        const usedKill = state.witchUsedKillingPotion;

        // 1. Reveal Victim
        const victimMsg = document.getElementById('witch-victim-msg');
        const victimReveal = document.getElementById('witch-victim-reveal');
        
        if (victimUUID) {
            const victim = state.players.find(p => p.playerUUID === victimUUID);
            if (victimReveal) victimReveal.innerText = victim?.displayName || 'Unnamed Player';
            if (victimMsg) victimMsg.innerText = "The Werewolves have chosen a victim...";
        } else {
            if (victimMsg) victimMsg.innerText = "The Werewolves were peaceful tonight. No one was attacked.";
            if (victimReveal) victimReveal.innerText = "No One";
        }

        // 2. Heal Potion UI
        const healBtn = document.getElementById('use-heal-btn') as HTMLButtonElement;
        const healUsedMsg = document.getElementById('heal-used-msg');
        const healControls = document.getElementById('heal-controls');
        
        if (usedHeal) {
            if (healControls) healControls.style.display = 'none';
            if (healUsedMsg) {
                healUsedMsg.style.display = 'block';
                healUsedMsg.innerText = this.initiallyUsedHeal ? "Potion already used." : "Potion used tonight.";
            }
        } else {
            if (healControls) healControls.style.display = 'flex';
            if (healUsedMsg) healUsedMsg.style.display = 'none';
            if (healBtn) healBtn.disabled = !victimUUID; // Can't heal if no victim
        }

        // 3. Kill Potion UI
        const killUsedMsg = document.getElementById('kill-used-msg');
        const killControls = document.getElementById('kill-controls');
        const killSelection = document.getElementById('witch-kill-selection');
        
        if (usedKill) {
            if (killControls) killControls.style.display = 'none';
            if (killUsedMsg) {
                killUsedMsg.style.display = 'block';
                killUsedMsg.innerText = this.initiallyUsedKill ? "Potion already used." : "Potion used tonight.";
            }
            if (killSelection) killSelection.style.display = 'none';
        } else {
            if (killControls) killControls.style.display = 'flex';
            if (killUsedMsg) killUsedMsg.style.display = 'none';
            this.renderKillList();
        }
    }

    private setupListeners() {
        const healBtn = document.getElementById('use-heal-btn') as HTMLButtonElement | null;
        const killBtn = document.getElementById('use-kill-btn') as HTMLButtonElement | null;
        const confirmKillBtn = document.getElementById('confirm-kill-btn') as HTMLButtonElement | null;
        const confirmBtn = document.getElementById('confirm-witch-actions-btn') as HTMLButtonElement | null;

        if (healBtn) {
            healBtn.addEventListener('click', () => {
                const state = getState();
                if (!state.witchUsedHealingPotion && state.werewolfVictim) {
                    // Healing is a one-shot potion: never fire it twice from a double tap.
                    if (!this.lockAction('heal', healBtn, () => !getState().witchUsedHealingPotion)) return;
                    socketService.usePotion('HEAL', null);
                }
            });
        }

        if (killBtn) {
            killBtn.addEventListener('click', () => {
                const selection = document.getElementById('witch-kill-selection');
                if (selection) {
                    selection.style.display = selection.style.display === 'none' ? 'block' : 'none';
                }
            });
        }

        if (confirmKillBtn) {
            confirmKillBtn.addEventListener('click', () => {
                if (!this.selectedKillUUID) return;
                // Same one-shot potion: requires a deliberate select-then-confirm.
                if (!this.lockAction('kill', confirmKillBtn, () => !getState().witchUsedKillingPotion)) return;
                socketService.usePotion('KILL', this.selectedKillUUID);
            });
        }

        if (confirmBtn) {
            confirmBtn.addEventListener('click', () => {
                // Confirming ends the witch sub-turn; a second emit would skip the next role.
                if (!this.lockAction('confirm', confirmBtn, () => getState().activeNightRole === Role.WITCH)) return;
                socketService.witchConfirms();
                
                // Show waiting UI
                const controls = confirmBtn.closest('.manager-controls') as HTMLElement;
                const waitingMsg = document.getElementById('witch-waiting-message');
                if (controls) controls.style.display = 'none';
                if (waitingMsg) waitingMsg.style.display = 'block';
            });
        }
    }

    private renderKillList() {
        const listEl = document.getElementById('witch-kill-list');
        if (!listEl) return;

        const state = getState();
        const players = state.players.filter(p => p.isAlive && p.playerUUID !== state.playerUUID);

        listEl.innerHTML = players.map(p => {
            const isSelected = this.selectedKillUUID === p.playerUUID;
            return `
                <li class="pixel-list-item selectable-player ${isSelected ? 'selected' : ''}" data-uuid="${p.playerUUID}">
                    <span class="player-dot alive"></span>
                    <span class="player-name">${escapeHtml(p.displayName || 'Unnamed Player')}</span>
                </li>
            `;
        }).join('');

        const items = listEl.querySelectorAll('.selectable-player');
        items.forEach(item => {
            item.addEventListener('click', () => {
                if (getState().witchUsedKillingPotion) return;

                const targetUUID = item.getAttribute('data-uuid');
                if (!targetUUID) return;

                // Select only; the potion fires from confirm-kill-btn so a single
                // stray tap cannot burn the one-shot kill potion.
                items.forEach(i => i.classList.remove('selected'));
                item.classList.add('selected');
                this.selectedKillUUID = targetUUID;

                const confirmKillBtn = document.getElementById('confirm-kill-btn') as HTMLButtonElement;
                if (confirmKillBtn) confirmKillBtn.disabled = false;
            });
        });
    }
}
