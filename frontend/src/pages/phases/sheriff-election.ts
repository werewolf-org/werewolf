import { View } from '../../base-view';
import sheriffElectionHtml from './sheriff-election.html?raw';
import { getState, subscribeSelector } from '../../store';
import { socketService } from '../../socket.service';
import { audioService } from '../../audio.service';

export class SheriffElectionPhase extends View {
    private selectedTargetUUID: string | null = null;

    mount(container: HTMLElement): void {
        this.container = container;
        this.container.innerHTML = sheriffElectionHtml;

        // Switch to Light Mode for Election (Daylight feel)
        document.body.classList.add('light-mode');

        audioService.setAtmosphere('Village');
        audioService.playNarration('sheriff_voting', 'overwrite');

        // Reactive Subscriptions
        subscribeSelector(this, s => s.sheriffElectionDone, (done) => {
            if (done) {
                const state = getState();
                const anySheriff = state.players.some(p => p.isSheriff);
                if (anySheriff) {
                    audioService.playNarration('sheriff_found', 'overwrite');
                } else {
                    audioService.playNarration('sheriff_not_found', 'overwrite');
                }
            }
            this.updateUI();
        });
        subscribeSelector(this, s => s.myVoteTargetUUID, () => this.updateUI());
        subscribeSelector(this, s => s.voteProgress, () => this.updateUI());
        subscribeSelector(this, s => s.players, () => this.updateUI());

        this.setupEventListeners();
        
        // Initial render
        this.updateUI();
    }

    private setupEventListeners() {
        const confirmBtn = document.getElementById('confirm-sheriff-vote-btn');
        if (confirmBtn) {
            confirmBtn.addEventListener('click', () => {
                if (this.selectedTargetUUID) {
                    socketService.vote(this.selectedTargetUUID);
                }
            });
        }

        const acceptBtn = document.getElementById('accept-sheriff-btn');
        if (acceptBtn) {
            acceptBtn.addEventListener('click', () => {
                socketService.acceptSheriffRole();
            });
        }

        const gmContinueBtn = document.getElementById('gm-continue-btn');
        if (gmContinueBtn) {
            gmContinueBtn.addEventListener('click', () => {
                socketService.acceptSheriffRole();
            });
        }
    }

    private updateUI() {
        const state = getState();
        const votingView = document.getElementById('sheriff-voting-view');
        const resultView = document.getElementById('sheriff-result-view');

        if (state.sheriffElectionDone) {
            if (votingView) votingView.style.display = 'none';
            if (resultView) resultView.style.display = 'block';
            this.renderResultView();
        } else {
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

        const controls = document.getElementById('sheriff-voting-controls');
        const waitingMsg = document.getElementById('sheriff-vote-confirmed-message');
        const listEl = document.getElementById('sheriff-vote-list');
        const progressEl = document.getElementById('sheriff-vote-progress');

        if (progressEl && state.voteProgress) {
            progressEl.innerText = `${state.voteProgress.voted}/${state.voteProgress.total} players have voted`;
        }

        if (isDead) {
            if (controls) controls.style.display = 'none';
            if (waitingMsg) {
                waitingMsg.style.display = 'block';
                waitingMsg.innerHTML = '<p class="fog-text">The dead have no voice in the election.</p>';
            }
            if (listEl) listEl.style.pointerEvents = 'none';
        } else if (hasVoted) {
            if (controls) controls.style.display = 'none';
            if (waitingMsg) {
                waitingMsg.style.display = 'block';
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
        const isSheriff = me?.isSheriff ?? false;
        const isManager = state.isManager;
        const anySheriff = state.players.some(p => p.isSheriff);

        const acceptControls = document.getElementById('sheriff-accept-controls');
        const gmContinueControls = document.getElementById('gm-continue-controls');
        const waitingMsg = document.getElementById('sheriff-waiting-message');
        const noSheriffMsg = document.getElementById('no-sheriff-waiting-message');

        if (anySheriff) {
            if (isSheriff) {
                if (acceptControls) acceptControls.style.display = 'block';
                if (gmContinueControls) gmContinueControls.style.display = 'none';
                if (waitingMsg) waitingMsg.style.display = 'none';
            } else {
                if (acceptControls) acceptControls.style.display = 'none';
                if (gmContinueControls) gmContinueControls.style.display = 'none';
                if (waitingMsg) waitingMsg.style.display = 'block';
            }
            if (noSheriffMsg) noSheriffMsg.style.display = 'none';
        } else {
            // No sheriff elected
            if (isManager) {
                if (gmContinueControls) gmContinueControls.style.display = 'block';
            } else {
                if (noSheriffMsg) noSheriffMsg.style.display = 'block';
            }
            if (acceptControls) acceptControls.style.display = 'none';
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
                
                const confirmBtn = document.getElementById('confirm-sheriff-vote-btn') as HTMLButtonElement;
                if (confirmBtn) confirmBtn.disabled = false;
            });
        });
    }

    private renderResultData() {
        const state = getState();
        const votes = state.voteResults;
        const players = state.players;
        const sheriff = players.find(p => p.isSheriff);

        const electedNameEl = document.getElementById('elected-sheriff-name');
        const electionTextEl = document.getElementById('sheriff-election-text');
        const noSheriffTextEl = document.getElementById('no-sheriff-text');
        
        if (sheriff) {
            if (electedNameEl) electedNameEl.innerText = sheriff.displayName || 'Unnamed Player';
            if (electionTextEl) electionTextEl.style.display = 'block';
            if (noSheriffTextEl) noSheriffTextEl.style.display = 'none';
        } else {
            if (electedNameEl) electedNameEl.innerText = "No One";
            if (electionTextEl) electionTextEl.style.display = 'none';
            if (noSheriffTextEl) noSheriffTextEl.style.display = 'block';
        }

        const breakdownEl = document.getElementById('sheriff-vote-breakdown');
        if (!breakdownEl || !votes) return;

        const votesByTarget: Record<string, string[]> = {};
        Object.entries(votes).forEach(([voterUUID, targetUUID]) => {
            if (!targetUUID) return;
            if (!votesByTarget[targetUUID]) votesByTarget[targetUUID] = [];
            const voter = players.find(p => p.playerUUID === voterUUID);
            const name = voter?.displayName || 'Unnamed Player';
            votesByTarget[targetUUID].push(name);
        });

        const sortedTargets = Object.entries(votesByTarget).sort((a, b) => b[1].length - a[1].length);

        breakdownEl.innerHTML = sortedTargets.map(([targetUUID, voterNames]) => {
            const target = players.find(p => p.playerUUID === targetUUID);
            const targetName = target?.displayName || 'Unnamed Player';
            const isWinner = targetUUID === sheriff?.playerUUID;

            return `
                <li class="pixel-list-item" style="flex-direction: column; align-items: flex-start;">
                    <div style="width: 100%; display: flex; justify-content: space-between;">
                        <span style="${isWinner ? 'color: var(--highlight); font-weight: bold;' : ''}">
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
