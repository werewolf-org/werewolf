import startHtml from './start.html?raw'
import { socketService } from '../socket.service';
import { View } from '../base-view';
import { audioService } from '../audio.service';

export class StartPage extends View {
  private createBtn: HTMLButtonElement | null = null;

  mount(container: HTMLElement): void {
    // Ensure we start in Dark Mode
    document.body.classList.remove('light-mode');

    // Stop any leftover narration when returning to start
    audioService.stopAllAudio();

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
  }

  private handleCreateGame = () => {
    socketService.createGame();
  }
}
