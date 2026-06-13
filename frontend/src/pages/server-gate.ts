import { ServerGate } from '../server-gate';
import { navigate } from '../router';
import { socketService } from '../socket.service';
import { View } from '../base-view';

export class ServerGatePage extends View {
    private gameId: string;
    private gate: ServerGate | null = null;

    constructor(gameId: string) {
        super();
        this.gameId = gameId;
    }

    mount(container: HTMLElement): void {
        this.container = container;
        this.container.innerHTML = '';

        // The ServerGate in overlay mode appends to document.body directly,
        // but we still mount a placeholder into the container so the View lifecycle works.
        const placeholder = document.createElement('div');
        this.container.appendChild(placeholder);

        this.gate = new ServerGate('overlay', () => {
            // Ready: socket is connected, now join the game and route
            socketService.joinGame(this.gameId, null);
            navigate(`#/game/${this.gameId}`);
        }, () => {
            // Timeout: nothing extra needed, the gate UI shows retry button
        });

        this.gate.mount(placeholder);
    }

    unmount(): void {
        super.unmount();
        if (this.gate) {
            this.gate.unmount();
            this.gate = null;
        }
    }
}
