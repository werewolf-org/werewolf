import { View } from '../../base-view';
import dayHtml from './day.html?raw';
import { getState, subscribeSelector } from '../../store';
import { socketService } from '../../socket.service';
import { audioService } from '../../audio.service';

export class DayPhase extends View {
    private selectedNominationUUID: string | false | null = null;
    private selectedTargetUUID: string | false | null = null;

    mount(container: HTMLElement): void {
        this.container = container;
        this.container.innerHTML = dayHtml;

        audioService.playNarration('morning', 'overwrite');
        audioService.playNarration('morning-2', 'stack');
        audioService.setAtmosphere('Village');

        // Switch to Light Mode for Day
        document.body.classList.add('light-mode');

        // Reactive Subscriptions
        subscribeSelector(this, s => s.lynchDone, (lynchDone) => {
            if (lynchDone) {
                audioService.playNarration('end_of_day', 'overwrite');
                audioService.setAtmosphere('Evening');
            }
            this.updateUI();
        });
        subscribeSelector(this, s => s.nominationsFinished, (finished) => {
            if (finished && !getState().lynchDone) {
                audioService.playNarration('voting', 'overwrite');
            }
            this.updateUI();
        });
        subscribeSelector(this, s => s.myVoteTargetUUID, () => this.updateUI());
        subscribeSelector(this, s => s.readyForNight, () => this.updateUI());
        subscribeSelector(this, s => s.voteProgress, () => this.updateUI());
        subscribeSelector(this, s => s.players, () => this.updateUI());

        this.setupEventListeners();
        
        // Initial render
        this.updateUI();
    }

    private setupEventListeners() {
        const confirmNominationBtn = document.getElementById('confirm-nomination-btn');
        if (confirmNominationBtn) {
            confirmNominationBtn.addEventListener('click', () => {
                if (this.selectedNominationUUID !== null) {
                    socketService.nominate(this.selectedNominationUUID);
                }
            });
        }

        const confirmVoteBtn = document.getElementById('confirm-vote-btn');
        if (confirmVoteBtn) {
            confirmVoteBtn.addEventListener('click', () => {
                if (this.selectedTargetUUID !== null) {
                    socketService.vote(this.selectedTargetUUID);
                }
            });
        }

        const abstainBtn = document.getElementById('abstain-vote-btn');
        if (abstainBtn) {
            abstainBtn.addEventListener('click', () => {
                socketService.vote(false);
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
        const nominationView = document.getElementById('day-nomination-view');
        const votingView = document.getElementById('day-voting-view');
        const resultView = document.getElementById('day-result-view');

        if (!nominationView || !votingView || !resultView) return;

        if (state.lynchDone) {
            // STATE: RESULTS
            nominationView.style.display = 'none';
            votingView.style.display = 'none';
            resultView.style.display = 'block';
            this.renderResultView();
        } else if (state.nominationsFinished) {
            // STATE: VOTING
            nominationView.style.display = 'none';
            votingView.style.display = 'block';
            resultView.style.display = 'none';
            this.renderVotingView();
        } else {
            // STATE: NOMINATIONS
            nominationView.style.display = 'block';
            votingView.style.display = 'none';
            resultView.style.display = 'none';
            this.renderNominationView();
        }
    }

    private renderNominationView() {
        const state = getState();
        const me = state.players.find(p => p.playerUUID === state.playerUUID);
        const isDead = me && !me.isAlive;
        const myNomination = me?.nomination;
        const hasNominated = myNomination !== null;

        const controls = document.getElementById('day-nomination-controls');
        const waitingMsg = document.getElementById('nomination-confirmed-message');
        const progressEl = document.getElementById('nomination-progress');

        // Progress Calculation
        const alivePlayers = state.players.filter(p => p.isAlive);
        const nominatedCount = alivePlayers.filter(p => p.nomination !== null).length;
        const totalCount = alivePlayers.length;

        if (progressEl) progressEl.innerText = `${nominatedCount}/${totalCount} players have nominated`;

        if (isDead) {
            if (controls) controls.style.display = 'none';
            if (waitingMsg) {
                waitingMsg.style.display = 'block';
                waitingMsg.innerHTML = '<p class="fog-text">The dead cannot nominate. Watch the living discuss...</p>';
            }
        } else if (hasNominated) {
            if (controls) controls.style.display = 'none';
            if (waitingMsg) {
                waitingMsg.style.display = 'block';
                const targetName = myNomination === false ? 'no one' : state.players.find(p => p.playerUUID === myNomination)?.displayName;
                waitingMsg.innerHTML = `<p class="fog-text">You have nominated ${targetName}. Waiting for others...</p>`;
            }
        } else {
            if (controls) controls.style.display = 'block';
            if (waitingMsg) waitingMsg.style.display = 'none';
        }

        this.renderNominationLists();
    }

    private renderNominationLists() {
        const state = getState();
        const alivePlayers = state.players.filter(p => p.isAlive);
        const nominatedListEl = document.getElementById('day-nominated-list');
        const availableListEl = document.getElementById('day-available-list');

        if (!nominatedListEl || !availableListEl) return;

        // Map who nominated whom (since a target can only be nominated once)
        const nominatorByTarget: Record<string, string> = {};
        state.players.forEach(p => {
            if (typeof p.nomination === 'string') {
                nominatorByTarget[p.nomination] = p.displayName;
            }
        });

        const nominatedPlayers = alivePlayers.filter(p => nominatorByTarget[p.playerUUID]);
        const nonNominatedPlayers = alivePlayers.filter(p => !nominatorByTarget[p.playerUUID]);

        // 1. Render Nominated Players (Trial List)
        nominatedListEl.innerHTML = nominatedPlayers.map(p => {
            const nominatorName = nominatorByTarget[p.playerUUID];
            return `
                <li class="pixel-list-item" style="opacity: 0.8; background: rgba(0,0,0,0.1);">
                    <div style="display: flex; justify-content: space-between; width: 100%; align-items: center;">
                        <span class="player-name">${p.displayName}</span>
                        <span class="fog-text" style="font-size: 0.85rem;">Nominated by ${nominatorName}</span>
                    </div>
                </li>
            `;
        }).join('') || '<li class="pixel-list-item no-nomination">No one is on trial yet.</li>';

        // 2. Render Available Players
        let availableHtml = nonNominatedPlayers.map(p => {
            const isMe = p.playerUUID === state.playerUUID;
            const isSelected = this.selectedNominationUUID === p.playerUUID;
            return `
                <li class="pixel-list-item selectable-player nomination-item ${isSelected ? 'selected' : ''}" data-uuid="${p.playerUUID}">
                    <span class="player-dot alive"></span>
                    <span class="player-name">
                        ${p.displayName || 'Unnamed Player'}${isMe ? ' (You)' : ''}
                        ${p.isSheriff ? '<span class="sheriff-badge" title="Sheriff">🎖️</span>' : ''}
                    </span>
                </li>
            `;
        }).join('');

        // Special "Nominate No One" item
        const noOneSelected = this.selectedNominationUUID === false;
        availableHtml += `
            <li class="pixel-list-item selectable-player nomination-item ${noOneSelected ? 'selected' : ''}" data-uuid="false" style="margin-top: 10px; border-top: 1px dashed var(--border-main);">
                <span class="player-dot" style="background: var(--text-muted)"></span>
                <span class="player-name">Nominate No One</span>
            </li>
        `;

        availableListEl.innerHTML = availableHtml;

        // Setup Event Listeners for Available List
        const me = state.players.find(p => p.playerUUID === state.playerUUID);
        const hasNominated = me?.nomination !== null;
        const isDead = me && !me.isAlive;

        if (!hasNominated && !isDead) {
            const items = availableListEl.querySelectorAll('.nomination-item');
            items.forEach(item => {
                item.addEventListener('click', () => {
                    items.forEach(i => i.classList.remove('selected'));
                    item.classList.add('selected');
                    const uuid = item.getAttribute('data-uuid');
                    this.selectedNominationUUID = uuid === 'false' ? false : uuid;
                    
                    const confirmBtn = document.getElementById('confirm-nomination-btn') as HTMLButtonElement;
                    if (confirmBtn) confirmBtn.disabled = false;
                });
            });
        } else {
            availableListEl.style.pointerEvents = 'none';
            availableListEl.style.opacity = '0.7';
        }
    }

    private renderVotingView() {
        const state = getState();
        const me = state.players.find(p => p.playerUUID === state.playerUUID);
        const isDead = me && !me.isAlive;
        const hasVoted = state.myVoteTargetUUID !== null;

        const controls = document.getElementById('day-voting-controls');
        const waitingMsg = document.getElementById('vote-confirmed-message');
        const listEl = document.getElementById('day-vote-list');
        const progressEl = document.getElementById('vote-progress');

        if (progressEl && state.voteProgress) {
            progressEl.innerText = `${state.voteProgress.voted}/${state.voteProgress.total} players have voted`;
        }

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

        if (listEl) this.renderVotingList(listEl);
    }

    private renderVotingList(listEl: HTMLElement) {
        const state = getState();
        
        // Map who nominated whom
        const nominatorByTarget: Record<string, string> = {};
        state.players.forEach(p => {
            if (typeof p.nomination === 'string') {
                nominatorByTarget[p.nomination] = p.displayName;
            }
        });

        const nominatedPlayers = state.players.filter(p => nominatorByTarget[p.playerUUID] && p.isAlive);
        
        if (nominatedPlayers.length === 0) {
            listEl.innerHTML = '<li class="pixel-list-item no-nomination">No players were nominated today. The village is peaceful...</li>';
            return;
        }

        const abstainSelected = this.selectedTargetUUID === false || state.myVoteTargetUUID === false;

        listEl.innerHTML = nominatedPlayers.map(p => {
            const isMe = p.playerUUID === state.playerUUID;
            const isSelected = this.selectedTargetUUID === p.playerUUID || state.myVoteTargetUUID === p.playerUUID;
            const nominatorName = nominatorByTarget[p.playerUUID];

            return `
                <li class="pixel-list-item selectable-player voting-item ${isSelected ? 'selected' : ''}" data-uuid="${p.playerUUID}">
                    <div style="display: flex; justify-content: space-between; width: 100%; align-items: center;">
                        <span class="player-name">
                            ${p.displayName || 'Unnamed Player'}${isMe ? ' (You)' : ''}
                            ${p.isSheriff ? '<span class="sheriff-badge" title="Sheriff">🎖️</span>' : ''}
                        </span>
                        <span class="fog-text" style="font-size: 0.85rem;">Nominated by ${nominatorName}</span>
                    </div>
                </li>
            `;
        }).join('') + `
            <li class="pixel-list-item selectable-player voting-item ${abstainSelected ? 'selected' : ''}" data-uuid="false" style="margin-top: 10px; border-top: 1px dashed var(--border-main);">
                <span class="player-dot" style="background: var(--text-muted)"></span>
                <span class="player-name">Abstain from Vote</span>
            </li>
        `;

        const items = listEl.querySelectorAll('.voting-item');
        items.forEach(item => {
            item.addEventListener('click', () => {
                const me = getState().players.find(p => p.playerUUID === getState().playerUUID);
                if (getState().myVoteTargetUUID !== null || !me?.isAlive) return;

                items.forEach(i => i.classList.remove('selected'));
                item.classList.add('selected');
                const uuid = item.getAttribute('data-uuid');
                this.selectedTargetUUID = uuid === 'false' ? false : uuid;
                
                const confirmBtn = document.getElementById('confirm-vote-btn') as HTMLButtonElement;
                if (confirmBtn) confirmBtn.disabled = false;
            });
        });
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
            if (waitingMsg) {
                waitingMsg.style.display = 'block';
            }
        } else {
            if (controls) controls.style.display = 'block';
            if (waitingMsg) waitingMsg.style.display = 'none';
        }

        this.renderResultData();
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
