import startHtml from './start.html?raw'
import { socketService } from '../socket.service';
import { View } from '../base-view';
import { audioService } from '../audio.service';
import { ServerGate } from '../server-gate';
import { getState, resetState, subscribeSelector } from '../store';

export class StartPage extends View {
  private createBtn: HTMLButtonElement | null = null;
  private gateContainer: HTMLElement | null = null;
  private gate: ServerGate | null = null;
  private isGated = false;
  private isCreating = false;

  mount(container: HTMLElement): void {
    // Ensure we start in Dark Mode
    document.body.classList.remove('light-mode');

    // Stop any leftover narration when returning to start
    audioService.stopAllAudio();

    // We are no longer in a game: drop the mirror so a later reconnect does not
    // re-emit joinGame for the game we just left.
    resetState();

    this.container = container;
    this.container.innerHTML = startHtml;

    this.createBtn = document.getElementById("create-game") as HTMLButtonElement;
    const sourceCodeBtn = document.getElementById("source-code") as HTMLButtonElement;
    const buyCoffeeBtn = document.getElementById("buy-coffee") as HTMLButtonElement;

    if (this.createBtn) {
      this.createBtn.addEventListener("click", this.handleCreateGame);
    }
    if (sourceCodeBtn) {
      sourceCodeBtn.addEventListener("click", () => window.open("https://github.com/werewolf-org/werewolf", "_blank"));
    }
    if (buyCoffeeBtn) {
      buyCoffeeBtn.addEventListener("click", () => window.open("https://buymeacoffee.com/benhauptvogel", "_blank"));
    }

    // A failed createGame only emits `error`: release the in-flight guard so the
    // player can tap again instead of being stuck with a dead button.
    subscribeSelector(this, s => s.lastError, (message) => {
      if (!message) return;
      this.isCreating = false;
      if (this.createBtn) this.createBtn.disabled = false;
    });
  }

  private handleCreateGame = () => {
    // The guard also applies to a warm connection: a double tap creates two
    // games and the second `gameCreated` wins.
    if (this.isCreating || this.isGated) return;
    this.isCreating = true;

    // If already connected, fire immediately
    if (getState().isConnected) {
      if (this.createBtn) this.createBtn.disabled = true;
      socketService.createGame();
      return;
    }

    this.isGated = true;

    // Hide the create-game button
    if (this.createBtn) {
      this.createBtn.style.display = 'none';
    }

    // Create an inline container for the progress bar and insert it where the button was
    this.gateContainer = document.createElement('div');
    this.gateContainer.id = 'create-game-gate';
    this.createBtn?.parentNode?.insertBefore(this.gateContainer, this.createBtn?.nextSibling ?? null);

    this.gate = new ServerGate('inline', () => {
      // Server is ready: clean up the gate and create the game
      this.cleanupGate();
      socketService.createGame();
    }, () => {
      // Timeout: the gate UI itself turns red and shows a Retry button.
      // Nothing extra needed here.
    });

    this.gate.mount(this.gateContainer);
  };

  private cleanupGate(): void {
    if (this.gate) {
      this.gate.unmount();
      this.gate = null;
    }
    if (this.gateContainer?.parentNode) {
      this.gateContainer.parentNode.removeChild(this.gateContainer);
    }
    this.gateContainer = null;

    if (this.createBtn) {
      this.createBtn.style.display = '';
    }
    this.isGated = false;
  }

  unmount(): void {
    super.unmount();
    this.cleanupGate();
  }
}
