export abstract class View {
  protected container: HTMLElement | null = null;
  protected unsubs: (() => void)[] = [];
  private lockedActions = new Set<string>();
  private lockTimers = new Map<string, number>();

  abstract mount(container: HTMLElement): void;

  addUnsub(unsub: () => void): void {
    this.unsubs.push(unsub);
  }

  /**
   * Disable an action button on the first tap so a double tap cannot emit twice.
   * A successful action answers with a fresh snapshot; if nothing changed within
   * the grace period, treat it as a rejection (the socket service alerts) and re-arm.
   * Returns false when the action is already locked, so the caller can stop.
   */
  protected lockAction(key: string, button: HTMLButtonElement | null, stillPending: () => boolean): boolean {
    if (this.lockedActions.has(key)) return false;
    this.lockedActions.add(key);
    if (button) button.disabled = true;

    const timer = window.setTimeout(() => {
      this.lockTimers.delete(key);
      if (!stillPending()) return;
      this.lockedActions.delete(key);
      if (button) button.disabled = false;
    }, 3000);
    this.lockTimers.set(key, timer);
    return true;
  }

  /** Whether an action is still in flight from this view. Renders use it to keep a button disabled. */
  protected isActionLocked(key: string): boolean {
    return this.lockedActions.has(key);
  }

  unmount(): void {
    this.unsubs.forEach(unsub => unsub());
    this.unsubs = [];
    this.lockTimers.forEach(timer => window.clearTimeout(timer));
    this.lockTimers.clear();
    this.lockedActions.clear();
    this.container = null;
  }
}
