export abstract class View {
  protected container: HTMLElement | null = null;
  protected unsubs: (() => void)[] = [];

  abstract mount(container: HTMLElement): void;

  addUnsub(unsub: () => void): void {
    this.unsubs.push(unsub);
  }

  unmount(): void {
    this.unsubs.forEach(unsub => unsub());
    this.unsubs = [];
    this.container = null;
  }
}
