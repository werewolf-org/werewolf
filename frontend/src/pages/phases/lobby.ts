import { View } from '../../base-view';
import lobbyHtml from './lobby.html?raw';
import { subscribeSelector, getState } from '../../store';
import QRCode from 'qrcode';
import { socketService } from '../../socket.service';
import { escapeHtml } from '../../html';
import { Phase } from '@shared/phases';

export class LobbyPhase extends View {
    private lockedActions = new Set<string>();

    mount(container: HTMLElement): void {
        this.container = container;
        this.container.innerHTML = lobbyHtml;

        const state = getState();
        const gameId = state.gameId;
        
        // 1. Setup Game ID, Link & QR Code
        if (gameId) {
            const idEl = document.getElementById('lobby-game-id');
            if (idEl) idEl.innerText = gameId;

            const joinUrl = `${window.location.origin}/#/game/${gameId}`;
            const linkEl = document.getElementById('lobby-game-link');
            if (linkEl) linkEl.innerText = joinUrl;

            const qrContainer = document.getElementById('lobby-qr-code');
            if (qrContainer) {
                this.generateQRCode(joinUrl, qrContainer);
            }
        }

        // 2. Reactive Subscriptions
        subscribeSelector(this, s => s.players, (players) => {
            this.updatePlayerList(players);
        });

        subscribeSelector(this, s => s.isManager, (isManager) => {
            this.toggleManagerUI(isManager);
        });

        // Initial name sync only; the player list and the manager UI are painted by
        // their subscriptions (which invoke once at subscribe time).
        this.setupNameInput(state);

        // 4. Setup Action Listeners
        const startBtn = document.getElementById('start-game-btn') as HTMLButtonElement | null;
        if (startBtn) {
            startBtn.addEventListener('click', () => {
                if (!this.lockAction('closeJoining', startBtn, () => getState().phase === Phase.LOBBY)) return;
                socketService.closeJoining();
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

    private toggleManagerUI(isManager: boolean) {
        const controls = document.getElementById('manager-controls');
        const waitingMsg = document.getElementById('player-waiting-message');
        
        if (controls) controls.style.display = isManager ? 'block' : 'none';
        if (waitingMsg) waitingMsg.style.display = isManager ? 'none' : 'block';
    }

    private setupNameInput(state: any) {
        const nameInput = document.getElementById('my-name-input') as HTMLInputElement;
        const myPlayerSlot = document.getElementById('my-player-slot');
        
        if (nameInput && state.playerUUID) {
            if (myPlayerSlot) myPlayerSlot.style.display = 'flex';
            
            const me = state.players.find((p: any) => p.playerUUID === state.playerUUID);
            if (me) {
                nameInput.value = me.displayName || '';
            }

            nameInput.addEventListener('change', (e) => {
                const newName = (e.target as HTMLInputElement).value.trim();
                if (state.playerUUID) socketService.changeName(newName);
            });
        }
    }

    private async generateQRCode(url: string, container: HTMLElement) {
        try {
            const style = getComputedStyle(document.documentElement);
            const colorLight = style.getPropertyValue('--card-bg').trim() || '#1a1c29';

            const canvas = document.createElement('canvas');
            await QRCode.toCanvas(canvas, url, {
                width: 200,
                margin: 2,
                color: {
                    dark: '#ffffff',
                    light: colorLight
                }
            });
            container.appendChild(canvas);
        } catch (err) {
            console.error('QR Code generation failed', err);
            container.innerText = 'Failed to load QR Code';
        }
    }

    private updatePlayerList(players: any[]) {
        const listEl = document.getElementById('lobby-players-list');
        const countEl = document.getElementById('player-count');
        const state = getState();
        
        if (countEl) countEl.innerText = players.length.toString();
        if (!listEl) return;

        const otherPlayers = players.filter(p => p.playerUUID !== state.playerUUID);

        listEl.innerHTML = otherPlayers.map(p => {
            return `
                <li class="pixel-list-item">
                    <span class="player-dot alive"></span>
                    <span>${escapeHtml(p.displayName || 'Unnamed Player')}</span>
                </li>
            `;
        }).join('');
    }
}
