import { View } from '../../base-view';
import dayHtml from './day.html?raw';
import { getState, subscribeSelector } from '../../store';
import { socketService } from '../../socket.service';
import { audioService } from '../../audio.service';

export class DayPhase extends View {
    private selectedTargetUUID: string | null = null;

    mount(container: HTMLElement): void {
        this.container = container;
        this.container.innerHTML = dayHtml;

        audioService.playNarration('morning', 'overwrite');
        audioService.setAtmosphere('Village');

        // Switch to Light Mode for Day
        document.body.classList.add('light-mode');

        // Reactive Subscriptions
        subscribeSelector(this, s => s.lynchDone, () => {
            audioService.playNarration('end_of_day', 'overwrite');
            audioService.setAtmosphere('Evening');
            this.updateUI()}
        );
        subscribeSelector(this, s => s.myVoteTargetUUID, () => this.updateUI());
        subscribeSelector(this, s => s.readyForNight, () => this.updateUI());
        subscribeSelector(this, s => s.players, () => this.updateUI());

        this.setupEventListeners();
        
        // Initial render
        this.updateUI();
    }

    private setupEventListeners() {
        const confirmBtn = document.getElementById('confirm-vote-btn');
        if (confirmBtn) {
            confirmBtn.addEventListener('click', () => {
                if (this.selectedTargetUUID) {
                    socketService.vote(this.selectedTargetUUID);
                }
            });
        }

        const readyBtn = document.getElementById('ready-for-night-btn');
        if (readyBtn) {
            readyBtn.addEventListener('click', () => {
                socketService.readyForNight();
            });
        }
    }

    private updateUI() {
        const state = getState();
        const votingView = document.getElementById('day-voting-view');
        const resultView = document.getElementById('day-result-view');

        if (state.lynchDone) {
            // STATE: RESULTS
            if (votingView) votingView.style.display = 'none';
            if (resultView) resultView.style.display = 'block';
            this.renderResultView();
        } else {
            // STATE: VOTING
            if (votingView) votingView.style.display = 'block';
            if (resultView) resultView.style.display = 'none';
            this.renderVotingView();
        }
    }

    private renderVotingView() {
        const state = getState();
        const me = state.players.find(p => p.playerUUID === state.playerUUID);
        const isDead = me && !me.isAlive;
        const hasVoted = !!state.myVoteTargetUUID;

        const controls = document.getElementById('day-voting-controls');
        const waitingMsg = document.getElementById('vote-confirmed-message');
        const listEl = document.getElementById('day-vote-list');

        if (isDead) {
            if (controls) controls.style.display = 'none';
            if (waitingMsg) {
                waitingMsg.style.display = 'block';
                waitingMsg.innerHTML = '<p class="fog-text">The dead cannot vote. Observe the village...</p>';
            }
            if (listEl) listEl.style.pointerEvents = 'none';
        } else if (hasVoted) {
            if (controls) controls.style.display = 'none';
            if (waitingMsg) {
                waitingMsg.style.display = 'block';
                waitingMsg.innerHTML = '<p class="fog-text">Vote Cast. Waiting for others...</p>';
            }
            if (listEl) {
                listEl.style.pointerEvents = 'none';
                listEl.style.opacity = '0.7';
            }
        } else {
            if (controls) controls.style.display = 'block';
            if (waitingMsg) waitingMsg.style.display = 'none';
            if (listEl) {
                listEl.style.pointerEvents = 'auto';
                listEl.style.opacity = '1';
            }
        }

        if (listEl) this.renderPlayerList(listEl);
    }

    private renderResultView() {
        const state = getState();
        const me = state.players.find(p => p.playerUUID === state.playerUUID);
        const isDead = me && !me.isAlive;
        const isReady = state.readyForNight;

        const controls = document.getElementById('day-result-controls');
        const waitingMsg = document.getElementById('night-waiting-message');

        if (isDead) {
            if (controls) controls.style.display = 'none';
            if (waitingMsg) {
                waitingMsg.style.display = 'block';
                waitingMsg.innerHTML = '<p class="fog-text">The dead have no say in the coming night. Waiting for the living...</p>';
            }
        } else if (isReady) {
            if (controls) controls.style.display = 'none';
            if (waitingMsg) waitingMsg.style.display = 'block';
        } else {
            if (controls) controls.style.display = 'block';
            if (waitingMsg) waitingMsg.style.display = 'none';
        }

        this.renderResultData();
    }

    private renderPlayerList(listEl: HTMLElement) {
        const state = getState();
        const players = state.players.filter(p => p.isAlive);
        
        listEl.innerHTML = players.map(p => {
            const isMe = p.playerUUID === state.playerUUID;
            const isSelected = this.selectedTargetUUID === p.playerUUID || state.myVoteTargetUUID === p.playerUUID;
            return `
                <li class="pixel-list-item selectable-player ${isSelected ? 'selected' : ''}" data-uuid="${p.playerUUID}">
                    <span class="player-dot alive"></span>
                    <span class="player-name">
                        ${p.displayName || 'Unnamed Player'}${isMe ? ' (You)' : ''}
                        ${p.isSheriff ? '<span class="sheriff-badge" title="Sheriff">🎖️</span>' : ''}
                    </span>
                </li>
            `;
        }).join('');

        const items = listEl.querySelectorAll('.selectable-player');
        items.forEach(item => {
            item.addEventListener('click', () => {
                const me = getState().players.find(p => p.playerUUID === getState().playerUUID);
                if (getState().myVoteTargetUUID || !me?.isAlive) return;

                items.forEach(i => i.classList.remove('selected'));
                item.classList.add('selected');
                this.selectedTargetUUID = item.getAttribute('data-uuid');
                
                const confirmBtn = document.getElementById('confirm-vote-btn') as HTMLButtonElement;
                if (confirmBtn) confirmBtn.disabled = false;
            });
        });
    }

    private renderResultData() {
        const state = getState();
        const votes = state.voteResults;
        const lynchedUUID = state.votedOutUUID;
        const players = state.players;

        const lynchedNameEl = document.getElementById('lynched-player-name');
        const lynchTextEl = document.getElementById('lynch-result-text');
        
        if (lynchedUUID) {
            const victim = players.find(p => p.playerUUID === lynchedUUID);
            if (lynchedNameEl) lynchedNameEl.innerText = victim?.displayName || 'Unnamed Player';
            if (lynchTextEl) lynchTextEl.innerText = '...was sent to the gallows.';
        } else {
            if (lynchedNameEl) {
                lynchedNameEl.innerText = "No One";
                lynchedNameEl.style.color = 'var(--text-main)';
            }
            if (lynchTextEl) lynchTextEl.innerText = '...was harmed this day.';
        }

        const breakdownEl = document.getElementById('day-vote-breakdown');
        if (!breakdownEl || !votes) return;

        const votesByTarget: Record<string, string[]> = {};
        Object.entries(votes).forEach(([voterUUID, targetUUID]) => {
            if (!targetUUID) return;
            if (!votesByTarget[targetUUID]) votesByTarget[targetUUID] = [];
            const voter = players.find(p => p.playerUUID === voterUUID);
            const name = (voter?.isSheriff ? '🎖️ ' : '') + (voter?.displayName || 'Unnamed Player');
            votesByTarget[targetUUID].push(name);
        });

        const sortedTargets = Object.entries(votesByTarget).sort((a, b) => b[1].length - a[1].length);

        breakdownEl.innerHTML = sortedTargets.map(([targetUUID, voterNames]) => {
            const target = players.find(p => p.playerUUID === targetUUID);
            const targetName = (target?.isSheriff ? '🎖️ ' : '') + (target?.displayName || 'Unnamed Player');
            const isDead = targetUUID === lynchedUUID;

            return `
                <li class="pixel-list-item" style="flex-direction: column; align-items: flex-start;">
                    <div style="width: 100%; display: flex; justify-content: space-between;">
                        <span style="${isDead ? 'color: var(--accent); text-decoration: line-through;' : ''}">
                            ${targetName}
                        </span>
                        <span class="highlight-text">${voterNames.length} Votes</span>
                    </div>
                    <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 4px;">
                        ${voterNames.join(', ')}
                    </div>
                </li>
            `;
        }).join('');
    }
}
