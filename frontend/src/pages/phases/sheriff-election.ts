import { View } from '../../base-view';
import sheriffElectionHtml from './sheriff-election.html?raw';
import { getState, subscribeSelector } from '../../store';
import { socketService } from '../../socket.service';
import { audioService } from '../../audio.service';
import { escapeHtml } from '../../html';
import { Phase } from '@shared/phases';

export class SheriffElectionPhase extends View {
    private selectedNominationUUID: string | false | null = null;
    private selectedVoteUUID: string | false | null = null;
    private lockedActions = new Set<string>();
    // The result line is one-shot per mount; the subscription also fires on the
    // initial invoke and on every re-sync while the election stays done.
    private playedResultNarration = false;

    mount(container: HTMLElement): void {
        this.container = container;
        this.container.innerHTML = sheriffElectionHtml;

        document.body.classList.add('light-mode');
        audioService.setAtmosphere('Village');
        audioService.playNarration('sheriff_voting', 'overwrite');

        // Reactive Subscriptions (the first invoke paints, see subscribeSelector)
        subscribeSelector(this, s => s.nominationsFinished, () => this.updateUI());
        subscribeSelector(this, s => s.sheriffElectionDone, () => {
            if (getState().sheriffElectionDone && !this.playedResultNarration) {
                this.playedResultNarration = true;
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
    }

    private setupEventListeners() {
        // Nomination confirm
        const confirmNomBtn = document.getElementById('confirm-sheriff-nomination-btn') as HTMLButtonElement | null;
        if (confirmNomBtn) {
            confirmNomBtn.addEventListener('click', () => {
                const selection = this.selectedNominationUUID;
                if (selection === null) return;
                // Someone else may have nominated that player while we were selecting:
                // the backend rejects both an already-nominated target and a second
                // nomination, so re-check against the latest snapshot instead of
                // letting the socket error alert fire.
                if (this.isAlreadyNominated(selection)) {
                    this.selectedNominationUUID = null;
                    confirmNomBtn.disabled = true;
                    this.updateUI();
                    return;
                }
                if (!this.lockAction('nominate', confirmNomBtn, () => getState().myNominationUUID == null)) return;
                socketService.nominate(selection);
            });
        }
        // Vote confirm
        const confirmVoteBtn = document.getElementById('confirm-sheriff-vote-btn') as HTMLButtonElement | null;
        if (confirmVoteBtn) {
            confirmVoteBtn.addEventListener('click', () => {
                const selection = this.selectedVoteUUID;
                if (selection === null) return;
                if (!this.lockAction('vote', confirmVoteBtn, () => getState().myVoteTargetUUID == null)) return;
                socketService.vote(selection);
            });
        }
        // Accept / Continue
        const acceptBtn = document.getElementById('accept-sheriff-btn') as HTMLButtonElement | null;
        if (acceptBtn) {
            acceptBtn.addEventListener('click', () => {
                if (!this.lockAction('accept', acceptBtn, () => getState().phase === Phase.SHERIFF_ELECTION)) return;
                socketService.acceptSheriffRole();
            });
        }
        const gmContinueBtn = document.getElementById('gm-continue-btn') as HTMLButtonElement | null;
        if (gmContinueBtn) {
            gmContinueBtn.addEventListener('click', () => {
                if (!this.lockAction('accept', gmContinueBtn, () => getState().phase === Phase.SHERIFF_ELECTION)) return;
                socketService.acceptSheriffRole();
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

    // Backend truth: getNominatedPlayers collects every `nominationUUID` that is a
    // string, so this map's keys are exactly the players that may be voted for.
    private nominatorByTarget(): Record<string, string> {
        const state = getState();
        const map: Record<string, string> = {};
        state.players.forEach(p => {
            if (typeof p.nomination === 'string') map[p.nomination] = p.displayName;
        });
        return map;
    }

    private isAlreadyNominated(playerUUID: string | false): boolean {
        if (playerUUID === false) return false;
        return !!this.nominatorByTarget()[playerUUID];
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
        const isDead = !!me && !me.isAlive;
        const hasNominated = state.myNominationUUID !== null && state.myNominationUUID !== undefined;

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
        const nominatorByTarget = this.nominatorByTarget();
        const abstainSelected = this.selectedNominationUUID === false || state.myNominationUUID === false;

        listEl.innerHTML = players.map(p => {
            const isMe = p.playerUUID === state.playerUUID;
            const takenBy = nominatorByTarget[p.playerUUID];

            // A target can only be nominated once (VoteHandler.nominate rejects the
            // rest), so show taken candidates as a read-only hint instead of offering
            // a choice that would end in a raw socket error alert.
            if (takenBy) {
                return `
                    <li class="pixel-list-item" style="opacity: 0.6;" data-uuid="${p.playerUUID}">
                        <div style="display: flex; justify-content: space-between; width: 100%; align-items: center;">
                            <span class="player-name">${escapeHtml(p.displayName || 'Unnamed Player')}${isMe ? ' (You)' : ''}</span>
                            <span class="fog-text" style="font-size: 0.85rem;">Nominated by ${escapeHtml(takenBy)}</span>
                        </div>
                    </li>
                `;
            }

            const isSelected = this.selectedNominationUUID === p.playerUUID || state.myNominationUUID === p.playerUUID;
            return `
                <li class="pixel-list-item selectable-player ${isSelected ? 'selected' : ''}" data-uuid="${p.playerUUID}">
                    <span class="player-dot alive"></span>
                    <span class="player-name">
                        ${escapeHtml(p.displayName || 'Unnamed Player')}${isMe ? ' (You)' : ''}
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
                const myNomination = getState().myNominationUUID;
                if ((myNomination !== null && myNomination !== undefined) || !me?.isAlive) return;
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
        const isDead = !!me && !me.isAlive;
        const hasVoted = state.myVoteTargetUUID !== null && state.myVoteTargetUUID !== undefined;

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
        // `p.nomination` is the target that player nominated, so the ballot has to be
        // filtered by the *reverse* map (same as day.ts). Filtering on
        // `typeof p.nomination === 'string'` listed the nominators instead, and every
        // vote for them then failed the backend's getNominatedPlayers() check.
        const nominatorByTarget = this.nominatorByTarget();
        const nominatedPlayers = state.players.filter(p => p.isAlive && nominatorByTarget[p.playerUUID]);
        const abstainSelected = this.selectedVoteUUID === false || state.myVoteTargetUUID === false;

        listEl.innerHTML = nominatedPlayers.map(p => {
            const isMe = p.playerUUID === state.playerUUID;
            const isSelected = this.selectedVoteUUID === p.playerUUID || state.myVoteTargetUUID === p.playerUUID;
            return `
                <li class="pixel-list-item selectable-player ${isSelected ? 'selected' : ''}" data-uuid="${p.playerUUID}">
                    <span class="player-dot alive"></span>
                    <span class="player-name">
                        ${escapeHtml(p.displayName || 'Unnamed Player')}${isMe ? ' (You)' : ''}
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
                if (getState().myVoteTargetUUID != null || !me?.isAlive) return;
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
            // Escaped here already: the names are joined into the template below.
            votesByTarget[targetUUID].push(escapeHtml(voter?.displayName || 'Unnamed Player'));
        });

        const sortedTargets = Object.entries(votesByTarget).sort((a, b) => b[1].length - a[1].length);

        breakdownEl.innerHTML = sortedTargets.map(([targetUUID, voterNames]) => {
            const target = players.find(p => p.playerUUID === targetUUID);
            const targetName = escapeHtml(target?.displayName || 'Unnamed Player');
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
