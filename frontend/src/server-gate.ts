import { getState, setState, subscribeSelector } from './store';
import { View } from './base-view';
import { socketService } from './socket.service';

const BOOT_ESTIMATE_MS = 25000;
const TIMEOUT_MS = 45000;
const UPDATE_INTERVAL_MS = 100;

export type GateMode = 'overlay' | 'inline';

export class ServerGate extends View {
    private mode: GateMode;
    private onReady: () => void;
    private onTimeout: () => void;

    private progressEl: HTMLElement | null = null;
    private labelEl: HTMLElement | null = null;
    private retryBtn: HTMLButtonElement | null = null;
    private overlayEl: HTMLElement | null = null;

    private timerId: number | null = null;
    private startTime: number;
    private isTimedOut = false;

    constructor(mode: GateMode, onReady: () => void, onTimeout: () => void) {
        super();
        this.mode = mode;
        this.onReady = onReady;
        this.onTimeout = onTimeout;
        this.startTime = getState().serverBootStartTime ?? Date.now();
    }

    mount(container: HTMLElement): void {
        this.container = container;

        if (this.mode === 'overlay') {
            this.renderOverlay();
        } else {
            this.renderInline();
        }

        this.startTimer();

        // Listen for connection
        subscribeSelector(this, (s) => s.isConnected, (isConnected) => {
            if (isConnected && !this.isTimedOut) {
                this.handleReady();
            }
        });
    }

    unmount(): void {
        super.unmount();
        if (this.timerId !== null) {
            window.clearInterval(this.timerId);
            this.timerId = null;
        }
    }

    private renderOverlay(): void {
        const existing = document.getElementById('server-gate-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'server-gate-overlay';
        overlay.className = 'server-gate-overlay';
        overlay.innerHTML = `
            <div class="pixel-card server-gate-card">
                <h2>Waking Up Server</h2>
                <p>Our server sleeps to save resources. It needs a moment to wake up...</p>
                <div class="progress-track">
                    <div class="progress-fill" id="gate-progress-fill" style="width: 0%"></div>
                </div>
                <p id="gate-status-label" class="fog-text" style="font-size: 1rem; margin-bottom: 0;">Connecting...</p>
                <button id="gate-retry-btn" class="btn" style="display: none;">Retry</button>
            </div>
        `;
        document.body.appendChild(overlay);

        this.overlayEl = overlay;
        this.progressEl = document.getElementById('gate-progress-fill');
        this.labelEl = document.getElementById('gate-status-label');
        this.retryBtn = document.getElementById('gate-retry-btn') as HTMLButtonElement;

        if (this.retryBtn) {
            this.retryBtn.addEventListener('click', () => this.handleRetry());
        }
    }

    private renderInline(): void {
        if (!this.container) return;
        this.container.innerHTML = `
            <div class="inline-progress-container">
                <div class="progress-track">
                    <div class="progress-fill" id="gate-progress-fill" style="width: 0%"></div>
                </div>
                <span id="gate-status-label" class="inline-progress-label">Waking up server...</span>
                <button id="gate-retry-btn" class="btn" style="display: none;">Retry</button>
            </div>
        `;

        this.progressEl = document.getElementById('gate-progress-fill');
        this.labelEl = document.getElementById('gate-status-label');
        this.retryBtn = document.getElementById('gate-retry-btn') as HTMLButtonElement;

        if (this.retryBtn) {
            this.retryBtn.addEventListener('click', () => this.handleRetry());
        }
    }

    private startTimer(): void {
        if (this.timerId !== null) return;

        this.timerId = window.setInterval(() => {
            const elapsed = Date.now() - this.startTime;
            const percent = Math.min(100, (elapsed / BOOT_ESTIMATE_MS) * 100);

            if (this.progressEl) {
                this.progressEl.style.width = `${percent}%`;
            }

            if (elapsed >= TIMEOUT_MS) {
                this.handleTimeout();
            }
        }, UPDATE_INTERVAL_MS);
    }

    private handleReady(): void {
        if (this.timerId !== null) {
            window.clearInterval(this.timerId);
            this.timerId = null;
        }

        if (this.progressEl) {
            this.progressEl.style.width = '100%';
        }

        if (this.mode === 'overlay') {
            // Small delay so the user sees the bar complete
            window.setTimeout(() => {
                this.destroyOverlay();
                this.onReady();
            }, 300);
        } else {
            this.onReady();
        }
    }

    private handleTimeout(): void {
        this.isTimedOut = true;
        if (this.timerId !== null) {
            window.clearInterval(this.timerId);
            this.timerId = null;
        }

        if (this.progressEl) {
            this.progressEl.classList.add('timeout');
        }

        if (this.labelEl) {
            this.labelEl.textContent = 'Server is taking too long. Please try again.';
        }

        if (this.retryBtn) {
            this.retryBtn.style.display = 'block';
        }

        this.onTimeout();
    }

    private handleRetry(): void {
        this.isTimedOut = false;
        this.startTime = Date.now();
        setState({ serverBootStartTime: this.startTime });

        if (this.progressEl) {
            this.progressEl.classList.remove('timeout');
            this.progressEl.style.width = '0%';
        }

        if (this.labelEl) {
            this.labelEl.textContent = 'Connecting...';
        }

        if (this.retryBtn) {
            this.retryBtn.style.display = 'none';
        }

        // Force a new socket connection attempt
        socketService.connect();
        this.startTimer();
    }

    private destroyOverlay(): void {
        if (this.overlayEl && this.overlayEl.parentNode) {
            this.overlayEl.parentNode.removeChild(this.overlayEl);
        }
        this.overlayEl = null;
    }
}
