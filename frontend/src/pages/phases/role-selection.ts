import selectionHtml from './role-selection.html?raw';
import { getState } from '../../store';
import { socketService } from '../../socket.service';
import { Role, ROLES } from '@shared/roles.js';
import rsaData from '../../data/role-presets.json';
import { View } from '../../base-view';
interface RoleCount {
    role: Role;
    name: string;
    count: number;
}

export class RoleSelectionPhase extends View {
    private roles: RoleCount[] = [];
    private playerCnt: number = 0;

    mount(container: HTMLElement): void {
        this.container = container;
        this.container.innerHTML = selectionHtml;

        const state = getState();
        this.playerCnt = state.players.length;
        const isManager = state.isManager;

        const adminUi = document.getElementById('role-selection-admin-ui');
        const waitingUi = document.getElementById('role-selection-waiting-ui');

        if (isManager) {
            if (adminUi) adminUi.style.display = 'block';
            this.initAdminLogic();
        } else {
            if (waitingUi) waitingUi.style.display = 'block';
        }
    }

    private initAdminLogic() {


        // --- PRE-CONFIGURATION LOGIC ---
        const maxKeyinRSA = Math.max(...Object.keys(rsaData).map(Number));
        const configKey = Math.min(this.playerCnt, maxKeyinRSA).toString();
        const standardAssignment = (rsaData as any)[configKey] || {};

        // Explicit order as requested
        const order = [
            Role.VILLAGER,
            Role.WEREWOLF,
            Role.SEER,
            Role.WITCH,
            Role.CUPID,
            Role.RED_LADY,
            Role.LITTLE_GIRL,
            // Role.HUNTER
        ];

        this.roles = order.map((roleKey) => {
            const roleDef = ROLES[roleKey];
            let count = standardAssignment[roleDef.displayName] || 0;
            
            // Ensure at least 1 werewolf if we have players
            if (roleKey === Role.WEREWOLF && count < 1 && this.playerCnt > 0) {
                count = 1;
                // If we forced a werewolf, we might need to reduce villagers to keep total correct
                // But initAdminLogic runs before renderList, and the user will adjust manually anyway
                // if the total is wrong. standardAssignment usually handles this correctly.
            }

            return {
                role: roleKey,
                name: roleDef.displayName,
                count: count
            };
        });

        const totalEl = document.getElementById('total-player-count');
        if (totalEl) totalEl.innerText = this.playerCnt.toString();

        const requiredEl = document.getElementById('required-role-count');
        if (requiredEl) requiredEl.innerText = this.playerCnt.toString();

        this.renderList();

        const startBtn = document.getElementById('confirm-roles-btn');
        if (startBtn) {
            startBtn.addEventListener('click', () => {
                const rolesMap: Record<string, number> = {};
                this.roles.forEach(r => {
                    if (r.count > 0) rolesMap[r.role] = r.count; // Use Enum Value as key
                });
                socketService.roleDistribution(rolesMap);
            });
        }
    }

    private renderList() {
        const listContainer = document.getElementById('roles-list');
        const selectedCountEl = document.getElementById('selected-role-count');
        const startBtn = document.getElementById('confirm-roles-btn') as HTMLButtonElement;

        const currentTotal = this.roles.reduce((sum, role) => sum + role.count, 0);

        if (selectedCountEl) selectedCountEl.innerText = currentTotal.toString();
        if (startBtn) startBtn.disabled = (currentTotal !== this.playerCnt);

        if (!listContainer) return;
        listContainer.innerHTML = '';

        this.roles.forEach((role, index) => {
            const roleDef = ROLES[role.role];
            const widget = document.createElement('div');
            widget.className = 'counter-widget';

            const minusBtn = document.createElement('button');
            minusBtn.className = 'counter-btn';
            minusBtn.innerText = '-';
            
            // Disable minus if 0, OR if it's a werewolf and count is 1
            const isMinWerewolf = role.role === Role.WEREWOLF && role.count <= 1;
            minusBtn.disabled = role.count <= 0 || isMinWerewolf;
            minusBtn.onclick = () => this.updateCount(index, -1);

            const display = document.createElement('div');
            display.className = 'counter-display';
            display.innerHTML = `${role.name}: <strong>${role.count}</strong>`;

            const plusBtn = document.createElement('button');
            plusBtn.className = 'counter-btn';
            plusBtn.innerText = '+';
            
            const isAtMax = roleDef && roleDef.maxAmount !== undefined && role.count >= roleDef.maxAmount;
            plusBtn.disabled = currentTotal >= this.playerCnt || !!isAtMax;
            plusBtn.onclick = () => this.updateCount(index, 1);

            widget.append(minusBtn, display, plusBtn);
            listContainer.appendChild(widget);
        });
    }

    private updateCount(index: number, delta: number) {
        const role = this.roles[index];
        const roleDef = ROLES[role.role];
        const currentTotal = this.roles.reduce((sum, role) => sum + role.count, 0);

        if (delta > 0) {
            if (currentTotal >= this.playerCnt) return;
            if (roleDef && roleDef.maxAmount !== undefined && role.count >= roleDef.maxAmount) return;
        }
        
        if (delta < 0) {
            if (role.count <= 0) return;
            if (role.role === Role.WEREWOLF && role.count <= 1) return;
        }

        role.count += delta;
        this.renderList();
    }
}
