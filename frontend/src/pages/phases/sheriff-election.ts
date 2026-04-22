import { View } from '../../base-view';
import sheriffElectionHtml from './sheriff-election.html?raw';
import { getState, subscribeSelector } from '../../store';
import { socketService } from '../../socket.service';
import { audioService } from '../../audio.service';

export class SheriffElectionPhase extends View {
    private selectedNominationUUID: string | false | null = null;
    private selectedVoteUUID: string | false | null = null;

    mount(container: HTMLElement): void {
        this.container = container;
        this.container.innerHTML = sheriffElectionHtml;

        document.body.classList.add('light-mode');
        audioService.setAtmosphere('Village');
        audioService.playNarration('sheriff_voting', 'overwrite');

        subscribeSelector(this, s => s.nominationsFinished, () => this.updateUI());
        subscribeSelector(this, s => s.sheriffElectionDone, () => {
            if (getState().sheriffElectionDone) {
                const anySheriff = getState().players.some(p => p.isSheriff);
                audioService.playNarration(anySheriff ? 'sheriff_found' : 'sheriff_not_found', 'overwrite');
            }
            this.updateUI();
        });
        subscribeSelector(this, s => s.myNominationUUID, () => this.updateUI());
        subscribeSelector(this, s => s.myVoteTargetUUID, () => this.updateUI());
        subscribeSelector(this, s => s.voteProgress, () => this.updateUI());
        subscribeSelector(this, s => s.players, () => this.updateUI());

        this.setupEventListeners();
        this.updateUI();
    }

    private setupEventListeners() {
        // Nomination confirm
        const confirmNomBtn = document.getElementById('confirm-sheriff-nomination-btn');
        if (confirmNomBtn) {
            confirmNomBtn.addEventListener('click', () => {
                if (this.selectedNominationUUID !== null) {
                    socketService.nominate(this.selectedNominationUUID);
                }
            });
        }
        // Vote confirm
        const confirmVoteBtn = document.getElementById('confirm-sheriff-vote-btn');
        if (confirmVoteBtn) {
            confirmVoteBtn.addEventListener('click', () => {
                if (this.selectedVoteUUID !== null) {
                    socketService.vote(this.selectedVoteUUID);
                }
            });
        }
        // Accept / Continue
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
        const nomView = document.getElementById('sheriff-nomination-view');
        const voteView = document.getElementById('sheriff-voting-view');
        const resultView = document.getElementById('sheriff-result-view');

        if (state.sheriffElectionDone) {
            if (nomView) nomView.style.display = 'none';
            if (voteView) voteView.style.display = 'none';
            if (resultView) resultView.style.display = 'block';
            this.renderResultView();
        } else if (state.nominationsFinished) {
            if (nomView) nomView.style.display = 'none';
            if (voteView) voteView.style.display = 'block';
            if (resultView) resultView.style.display = 'none';
            this.renderVotingView();
        } else {
            if (nomView) nomView.style.display = 'block';
            if (voteView) voteView.style.display = 'none';
            if (resultView) resultView.style.display = 'none';
            this.renderNominationView();
        }
    }

    private renderNominationView() {
        const state = getState();
        const me = state.players.find(p => p.playerUUID === state.playerUUID);
        const isDead = me && !me.isAlive;
        const hasNominated = state.myNominationUUID !== null;

        const controls = document.getElementById('sheriff-nomination-controls');
        const waitingMsg = document.getElementById('sheriff-nomination-confirmed-message');
        const listEl = document.getElementById('sheriff-nomination-list');

        if (isDead || hasNominated) {
            if (controls) controls.style.display = 'none';
            if (waitingMsg) {
                waitingMsg.style.display = 'block';
                if (isDead) waitingMsg.querySelector('p')!.innerText = 'The dead cannot nominate.';
            }
            if (listEl) listEl.style.pointerEvents = 'none';
        } else {
            if (controls) controls.style.display = 'flex';
            if (waitingMsg) waitingMsg.style.display = 'none';
            if (listEl) listEl.style.pointerEvents = 'auto';
        }

        if (listEl) this.renderNominationList(listEl);
    }

    private renderNominationList(listEl: HTMLElement) {
        const state = getState();
        const players = state.players.filter(p => p.isAlive);
        const abstainSelected = this.selectedNominationUUID === false || state.myNominationUUID === false;

        listEl.innerHTML = players.map(p => {
            const isMe = p.playerUUID === state.playerUUID;
            const isSelected = this.selectedNominationUUID === p.playerUUID || state.myNominationUUID === p.playerUUID;
            return `
                <li class="pixel-list-item selectable-player ${isSelected ? 'selected' : ''}" data-uuid="${p.playerUUID}">
                    <span class="player-dot alive"></span>
                    <span class="player-name">
                        ${p.displayName || 'Unnamed Player'}${isMe ? ' (You)' : ''}
                    </span>
                </li>
            `;
        }).join('') + `
            <li class="pixel-list-item selectable-player ${abstainSelected ? 'selected' : ''}" data-uuid="false" style="margin-top: 10px; border-top: 1px dashed var(--border-main);">
                <span class="player-dot" style="background: var(--text-muted)"></span>
                <span class="player-name">Abstain from Nomination</span>
            </li>
        `;

        const items = listEl.querySelectorAll('.selectable-player');
        items.forEach(item => {
            item.addEventListener('click', () => {
                const me = getState().players.find(p => p.playerUUID === getState().playerUUID);
                if (getState().myNominationUUID !== null || !me?.isAlive) return;
                items.forEach(i => i.classList.remove('selected'));
                item.classList.add('selected');
                const uuid = item.getAttribute('data-uuid');
                this.selectedNominationUUID = uuid === 'false' ? false : uuid;
                const confirmBtn = document.getElementById('confirm-sheriff-nomination-btn') as HTMLButtonElement;
                if (confirmBtn) confirmBtn.disabled = false;
            });
        });
    }

    private renderVotingView() {
        const state = getState();
        const me = state.players.find(p => p.playerUUID === state.playerUUID);
        const isDead = me && !me.isAlive;
        const hasVoted = state.myVoteTargetUUID !== null;

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
                waitingMsg.querySelector('p')!.innerHTML = '<p class="fog-text">The dead have no voice in the election.</p>';
            }
            if (listEl) listEl.style.pointerEvents = 'none';
        } else if (hasVoted) {
            if (controls) controls.style.display = 'none';
            if (waitingMsg) waitingMsg.style.display = 'block';
            if (listEl) { listEl.style.pointerEvents = 'none'; listEl.style.opacity = '0.7'; }
        } else {
            if (controls) controls.style.display = 'flex';
            if (waitingMsg) waitingMsg.style.display = 'none';
            if (listEl) { listEl.style.pointerEvents = 'auto'; listEl.style.opacity = '1'; }
        }

        if (listEl) this.renderVoteList(listEl);
    }

    private renderVoteList(listEl: HTMLElement) {
        const state = getState();
        const nominatedPlayers = state.players.filter(p => p.isAlive && (typeof p.nomination === 'string'));
        const abstainSelected = this.selectedVoteUUID === false || state.myVoteTargetUUID === false;

        listEl.innerHTML = nominatedPlayers.map(p => {
            const isMe = p.playerUUID === state.playerUUID;
            const isSelected = this.selectedVoteUUID === p.playerUUID || state.myVoteTargetUUID === p.playerUUID;
            return `
                <li class="pixel-list-item selectable-player ${isSelected ? 'selected' : ''}" data-uuid="${p.playerUUID}">
                    <span class="player-dot alive"></span>
                    <span class="player-name">
                        ${p.displayName || 'Unnamed Player'}${isMe ? ' (You)' : ''}
                    </span>
                </li>
            `;
        }).join('') + `
            <li class="pixel-list-item selectable-player ${abstainSelected ? 'selected' : ''}" data-uuid="false" style="margin-top: 10px; border-top: 1px dashed var(--border-main);">
                <span class="player-dot" style="background: var(--text-muted)"></span>
                <span class="player-name">Abstain from Vote</span>
            </li>
        `;

        const items = listEl.querySelectorAll('.selectable-player');
        items.forEach(item => {
            item.addEventListener('click', () => {
                const me = getState().players.find(p => p.playerUUID === getState().playerUUID);
                if (getState().myVoteTargetUUID !== null || !me?.isAlive) return;
                items.forEach(i => i.classList.remove('selected'));
                item.classList.add('selected');
                const uuid = item.getAttribute('data-uuid');
                this.selectedVoteUUID = uuid === 'false' ? false : uuid;
                const confirmBtn = document.getElementById('confirm-sheriff-vote-btn') as HTMLButtonElement;
                if (confirmBtn) confirmBtn.disabled = false;
            });
        });
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
            if (!targetUUID || typeof targetUUID !== 'string') return;
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
