import { View } from '../../base-view';
import lobbyHtml from './lobby.html?raw';
import { subscribeSelector, getState } from '../../store';
import QRCode from 'qrcode';
import { socketService } from '../../socket.service';

export class LobbyPhase extends View {

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

        // Initial render
        this.setupNameInput(state);
        this.updatePlayerList(state.players);
        this.toggleManagerUI(state.isManager);

        // 4. Setup Action Listeners
        const startBtn = document.getElementById('start-game-btn');
        if (startBtn) {
            startBtn.addEventListener('click', () => socketService.closeJoining());
        }
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
                    <span>${p.displayName || 'Unnamed Player'}</span>
                </li>
            `;
        }).join('');
    }
}
