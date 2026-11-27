import { View } from '../../base-view';
import dayHtml from './day.html?raw';
import { getState, subscribeSelector } from '../../store';
import { socketService } from '../../socket.service';
import { audioService } from '../../audio.service';
import { escapeHtml } from '../../html';
import { nameList, readyNamesText, waitingNamesText } from '../../vote-status';

export class DayPhase extends View {
    private selectedNominationUUID: string | false | null = null;
    private selectedTargetUUID: string | false | null = null;
    // Stage narration is one-shot per mount: the subscriptions below are invoked
    // immediately at subscribe time and again on every change, so without these
    // flags a re-render (or a mount mid-stage) would restart the line.
    private playedEndOfDayNarration = false;
    private playedVotingNarration = false;

    mount(container: HTMLElement): void {
        this.container = container;
        this.container.innerHTML = dayHtml;

        audioService.playNarration('morning', 'overwrite');
        audioService.playNarration('morning-2', 'stack');
        audioService.setAtmosphere('Village');

        // Switch to Light Mode for Day
        document.body.classList.add('light-mode');

        // Reactive Subscriptions (the first invoke paints, see subscribeSelector)
        subscribeSelector(this, s => s.lynchDone, (lynchDone) => {
            if (lynchDone && !this.playedEndOfDayNarration) {
                this.playedEndOfDayNarration = true;
                audioService.playNarration('end_of_day', 'overwrite');
                audioService.setAtmosphere('Evening');
            }
            this.updateUI();
        });
        subscribeSelector(this, s => s.nominationsFinished, (finished) => {
            if (finished && !getState().lynchDone && !this.playedVotingNarration) {
                this.playedVotingNarration = true;
                audioService.playNarration('voting', 'overwrite');
            }
            this.updateUI();
        });
        subscribeSelector(this, s => s.myNominationUUID, () => this.updateUI());
        subscribeSelector(this, s => s.myVoteTargetUUID, () => this.updateUI());
        subscribeSelector(this, s => s.readyForNight, () => this.updateUI());
        subscribeSelector(this, s => s.voteProgress, () => this.updateUI());
        subscribeSelector(this, s => s.players, () => this.updateUI());

        this.setupEventListeners();
    }

    private setupEventListeners() {
        const confirmNominationBtn = document.getElementById('confirm-nomination-btn') as HTMLButtonElement | null;
        if (confirmNominationBtn) {
            confirmNominationBtn.addEventListener('click', () => {
                const selection = this.selectedNominationUUID;
                if (selection === null) return;
                // Multi-socket seats mean two tabs can race each other. The server still
                // rejects a second nomination; locking here keeps one tab from firing twice.
                if (!this.lockAction('nominate', confirmNominationBtn, () => getState().myNominationUUID == null)) return;
                socketService.nominate(selection);
            });
        }

        // "No nomination" is a selection like a player, not an immediate submit: a mis-tap on
        // a phone must never cost someone their say without a confirming second tap.
        const noNominationBtn = document.getElementById('no-nomination-btn') as HTMLButtonElement | null;
        if (noNominationBtn) {
            noNominationBtn.addEventListener('click', () => {
                this.selectedNominationUUID = this.selectedNominationUUID === false ? null : false;
                this.updateUI();
            });
        }

        const confirmVoteBtn = document.getElementById('confirm-vote-btn') as HTMLButtonElement | null;
        if (confirmVoteBtn) {
            confirmVoteBtn.addEventListener('click', () => {
                const selection = this.selectedTargetUUID;
                if (selection === null) return;
                if (!this.lockAction('vote', confirmVoteBtn, () => getState().myVoteTargetUUID == null)) return;
                socketService.vote(selection);
            });
        }

        const readyBtn = document.getElementById('ready-for-night-btn') as HTMLButtonElement | null;
        if (readyBtn) {
            readyBtn.addEventListener('click', () => {
                if (!this.lockAction('ready', readyBtn, () => !getState().readyForNight)) return;
                socketService.readyForNight();
            });
        }
    }

    // A stage action counts as decided for both a name and an explicit "nobody".
    private isDecided(value: string | false | null | undefined): boolean {
        return value === false || typeof value === 'string';
    }

    // Everyone who named this player today. Used both to explain "already on trial" and to
    // show the tally on the ballot, because several players may name the same person.
    private nominatorsOf(playerUUID: string): string[] {
        return getState().players
            .filter(p => p.nomination === playerUUID)
            .map(p => p.displayName || 'Unnamed Player');
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
        const isDead = !!me && !me.isAlive;
        const hasNominated = !!me && this.isDecided(me.nomination);

        const controls = document.getElementById('day-nomination-controls');
        const waitingMsg = document.getElementById('nomination-confirmed-message');
        const progressEl = document.getElementById('nomination-progress');
        const waitingEl = document.getElementById('nomination-waiting');

        // Progress is by name, not just a number: "waiting for Ben" is what a table actually
        // needs, and it exposes the phone that is holding the stage up.
        const alivePlayers = state.players.filter(p => p.isAlive);
        const undecided = alivePlayers.filter(p => !this.isDecided(p.nomination));
        if (progressEl) progressEl.innerText = `${alivePlayers.length - undecided.length} of ${alivePlayers.length} decided`;
        if (waitingEl) {
            waitingEl.innerText = undecided.length === 0
                ? 'Everyone has decided.'
                : `Waiting for ${nameList(undecided.map(p => p.displayName || 'Unnamed Player'))}`;
        }

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
                const target = me?.nomination === false ? null : state.players.find(p => p.playerUUID === me?.nomination);
                const targetName = target?.displayName || 'Unnamed Player';
                const what = me?.nomination === false ? 'You nominated no one.' : `You nominated ${escapeHtml(targetName)}.`;
                const stillWaiting = undecided.filter(p => p.playerUUID !== state.playerUUID).map(p => p.displayName || 'Unnamed Player');
                const tail = stillWaiting.length > 0
                    ? ` Waiting for ${escapeHtml(nameList(stillWaiting))}.`
                    : ' Everyone has decided.';
                waitingMsg.innerHTML = `<p class="fog-text">${what}${tail}</p>`;
            }
        } else {
            if (controls) controls.style.display = 'block';
            if (waitingMsg) waitingMsg.style.display = 'none';
        }

        this.renderNominationControls();
        this.renderNominationList();
    }

    private renderNominationControls() {
        const state = getState();
        const confirmBtn = document.getElementById('confirm-nomination-btn') as HTMLButtonElement | null;
        const noBtn = document.getElementById('no-nomination-btn') as HTMLButtonElement | null;
        const hintEl = document.getElementById('nomination-selection-hint');

        const selection = this.selectedNominationUUID;
        const selectedPlayer = typeof selection === 'string'
            ? state.players.find(p => p.playerUUID === selection) ?? null
            : null;
        const others = selectedPlayer ? this.nominatorsOf(selectedPlayer.playerUUID) : [];
        // An in-flight nomination must stay visibly disabled: every snapshot re-renders this
        // button, so the lock has to be part of the render, not just of the click handler.
        const locked = this.isActionLocked('nominate');

        if (noBtn) {
            noBtn.classList.toggle('selected', selection === false);
            noBtn.setAttribute('aria-pressed', selection === false ? 'true' : 'false');
            noBtn.disabled = locked;
        }

        if (confirmBtn) {
            confirmBtn.disabled = locked || selection === null || (selection !== false && !selectedPlayer);
            confirmBtn.innerText = selection === false
                ? 'Confirm no nomination'
                : selectedPlayer
                    ? (others.length > 0 ? `Nominate ${selectedPlayer.displayName} too` : `Nominate ${selectedPlayer.displayName}`)
                    : 'Nominate';
        }

        // One sentence that answers "why can I not nominate this person". With seconds allowed
        // there is no dead end left, so the hint explains what the tap will do instead of
        // refusing it. It is blank once the player cannot act any more (nominated or dead),
        // because the list is not tappable then.
        const me = state.players.find(p => p.playerUUID === state.playerUUID);
        const canAct = !!me && me.isAlive && !this.isDecided(me.nomination);
        if (hintEl && !canAct) {
            hintEl.innerText = '';
        } else if (hintEl) {
            if (selection === false) {
                hintEl.innerText = 'You are sitting this nomination out. You will still vote in the trial.';
            } else if (selectedPlayer && others.length > 0) {
                hintEl.innerText = `${selectedPlayer.displayName} is already on trial. Nominating adds your name to theirs.`;
            } else if (selectedPlayer) {
                hintEl.innerText = `Nominating puts ${selectedPlayer.displayName} on trial.`;
            } else {
                hintEl.innerText = 'Tap a player to nominate them, or choose No nomination.';
            }
        }
    }

    private renderNominationList() {
        const state = getState();
        const listEl = document.getElementById('day-nomination-list');
        if (!listEl) return;

        const me = state.players.find(p => p.playerUUID === state.playerUUID);
        const isDead = !!me && !me.isAlive;
        const hasNominated = !!me && this.isDecided(me.nomination);

        const counts = new Map<string, number>();
        state.players.forEach(p => {
            if (typeof p.nomination === 'string') counts.set(p.nomination, (counts.get(p.nomination) ?? 0) + 1);
        });

        // Seat order, never re-sorted: a list that reshuffles while people are tapping moves
        // the row under their finger.
        listEl.innerHTML = state.players.filter(p => p.isAlive).map(p => {
            const isMe = p.playerUUID === state.playerUUID;
            const isSelected = this.selectedNominationUUID === p.playerUUID;
            const count = counts.get(p.playerUUID) ?? 0;
            return `
                <li class="pixel-list-item selectable-player nomination-item ${isSelected ? 'selected' : ''}" data-uuid="${p.playerUUID}">
                    <span class="player-dot alive"></span>
                    <span class="player-name">${escapeHtml(p.displayName || 'Unnamed Player')}${isMe ? ' (You)' : ''} ${p.isSheriff ? '<span class="sheriff-badge" title="Sheriff">🎖️</span>' : ''}</span>
                    ${count > 0 ? `<span class="nomination-chip">On trial${count > 1 ? ` · ${count}` : ''}</span>` : ''}
                </li>
            `;
        }).join('');

        const interactive = !hasNominated && !isDead;
        listEl.style.pointerEvents = interactive ? 'auto' : 'none';
        listEl.style.opacity = interactive ? '1' : '0.7';

        if (interactive) {
            listEl.querySelectorAll('.nomination-item').forEach(item => {
                item.addEventListener('click', () => {
                    const uuid = item.getAttribute('data-uuid');
                    if (!uuid) return;
                    this.selectedNominationUUID = uuid;
                    this.updateUI();
                });
            });
        }
    }

    private renderVotingView() {
        const state = getState();
        const me = state.players.find(p => p.playerUUID === state.playerUUID);
        const isDead = !!me && !me.isAlive;
        const hasVoted = state.myVoteTargetUUID !== null && state.myVoteTargetUUID !== undefined;

        const controls = document.getElementById('day-voting-controls');
        const waitingMsg = document.getElementById('vote-confirmed-message');
        const listEl = document.getElementById('day-vote-list');
        const progressEl = document.getElementById('vote-progress');
        const waitingEl = document.getElementById('vote-waiting');
        const confirmBtn = document.getElementById('confirm-vote-btn') as HTMLButtonElement | null;

        if (progressEl && state.voteProgress) {
            // Abstains count as decided; "voted" would imply everyone named someone.
            progressEl.innerText = `${state.voteProgress.voted} of ${state.voteProgress.total} decided`;
        }
        // Participation is public, the ballot is not: this names who still has to act.
        if (waitingEl) waitingEl.innerText = waitingNamesText(state);

        if (confirmBtn) {
            const selection = this.selectedTargetUUID;
            const target = typeof selection === 'string'
                ? state.players.find(p => p.playerUUID === selection) ?? null
                : null;
            confirmBtn.innerText = selection === false
                ? 'Abstain'
                : target ? `Vote to lynch ${target.displayName}` : 'Vote to Lynch';
            confirmBtn.disabled = this.isActionLocked('vote') || selection === null;
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
                // Votes are private until the tally resolves, but who is still deciding is
                // public, so the wait can name names without giving a ballot away.
                const target = state.myVoteTargetUUID === false
                    ? null
                    : state.players.find(p => p.playerUUID === state.myVoteTargetUUID);
                const what = state.myVoteTargetUUID === false
                    ? 'You abstained.'
                    : `You voted for ${escapeHtml(target?.displayName || 'Unnamed Player')}.`;
                waitingMsg.innerHTML = `<p class="fog-text">${what} ${escapeHtml(waitingNamesText(state))}</p>`;
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

        // Who put each candidate on trial. Several players may have named the same person,
        // so this is a list per target, not a single name.
        const nominatorsByTarget = new Map<string, string[]>();
        state.players.forEach(p => {
            if (typeof p.nomination === 'string') {
                const names = nominatorsByTarget.get(p.nomination) ?? [];
                names.push(p.displayName || 'Unnamed Player');
                nominatorsByTarget.set(p.nomination, names);
            }
        });

        // Seat order, deduped: a candidate appears once no matter how many nominated them.
        const nominatedPlayers = state.players.filter(p => p.isAlive && nominatorsByTarget.has(p.playerUUID));

        if (nominatedPlayers.length === 0) {
            listEl.innerHTML = '<li class="pixel-list-item no-nomination">No players were nominated today. The village is peaceful...</li>';
            return;
        }

        const abstainSelected = this.selectedTargetUUID === false || state.myVoteTargetUUID === false;

        listEl.innerHTML = nominatedPlayers.map(p => {
            const isMe = p.playerUUID === state.playerUUID;
            const isSelected = this.selectedTargetUUID === p.playerUUID || state.myVoteTargetUUID === p.playerUUID;
            const nominators = nominatorsByTarget.get(p.playerUUID) ?? [];

            return `
                <li class="pixel-list-item selectable-player voting-item ${isSelected ? 'selected' : ''}" data-uuid="${p.playerUUID}">
                    <div style="display: flex; justify-content: space-between; width: 100%; align-items: center; gap: 8px;">
                        <span class="player-name">
                            ${escapeHtml(p.displayName || 'Unnamed Player')}${isMe ? ' (You)' : ''}
                            ${p.isSheriff ? '<span class="sheriff-badge" title="Sheriff">🎖️</span>' : ''}
                        </span>
                        <span class="fog-text" style="font-size: 0.8rem; text-align: right;">Nominated by ${escapeHtml(nameList(nominators))}</span>
                    </div>
                </li>
            `;
        }).join('') + `
            <li class="pixel-list-item selectable-player voting-item ${abstainSelected ? 'selected' : ''}" data-uuid="false" style="margin-top: 10px; border-top: 1px dashed var(--border-main);">
                <span class="player-dot" style="background: var(--text-muted)"></span>
                <span class="player-name">Abstain</span>
            </li>
        `;

        const items = listEl.querySelectorAll('.voting-item');
        items.forEach(item => {
            item.addEventListener('click', () => {
                const me = getState().players.find(p => p.playerUUID === getState().playerUUID);
                if (getState().myVoteTargetUUID != null || !me?.isAlive) return;

                const uuid = item.getAttribute('data-uuid');
                this.selectedTargetUUID = uuid === 'false' ? false : uuid;
                this.updateUI();
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
        const waitingText = document.getElementById('night-waiting-text');
        const waitingNames = document.getElementById('night-waiting-names');

        // Readiness is public, exactly like participation in the trial: the point of the
        // stage is to find the phone that has not tapped yet, so every player sees the same
        // count and the same names. A dead player is not asked, so the tally is living only.
        const alivePlayers = state.players.filter(p => p.isAlive);
        const missing = alivePlayers.filter(p => !p.readyForNight);
        const progressEl = document.getElementById('ready-progress');
        const readyEl = document.getElementById('ready-waiting');
        if (progressEl) progressEl.innerText = `${alivePlayers.length - missing.length} of ${alivePlayers.length} ready`;
        if (readyEl) readyEl.innerText = readyNamesText(state);

        if (isDead) {
            if (controls) controls.style.display = 'none';
            if (waitingMsg) waitingMsg.style.display = 'block';
            if (waitingText) waitingText.innerText = 'The dead have no say in the coming night. Waiting for the living...';
            if (waitingNames) waitingNames.innerText = readyNamesText(state);
        } else if (isReady) {
            if (controls) controls.style.display = 'none';
            if (waitingMsg) waitingMsg.style.display = 'block';
            if (waitingText) waitingText.innerText = 'Waiting for the sun to set... Close your eyes and surrender to the night.';
            if (waitingNames) waitingNames.innerText = readyNamesText(state);
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
            // Escaped here already: the names are joined into the template below.
            const name = (voter?.isSheriff ? '🎖️ ' : '') + escapeHtml(voter?.displayName || 'Unnamed Player');
            votesByTarget[targetUUID].push(name);
        });

        const sortedTargets = Object.entries(votesByTarget).sort((a, b) => b[1].length - a[1].length);

        breakdownEl.innerHTML = sortedTargets.map(([targetUUID, voterNames]) => {
            const target = players.find(p => p.playerUUID === targetUUID);
            const targetName = (target?.isSheriff ? '🎖️ ' : '') + escapeHtml(target?.displayName || 'Unnamed Player');
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
