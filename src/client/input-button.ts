export class InputButton {
  private held = false;
  private readonly transitions: boolean[] = [];

  set(down: boolean): void {
    if (down === this.held) return;
    this.held = down;
    this.transitions.push(down);
  }

  sample(): boolean {
    // Preserve a press/release that both arrive between two simulation ticks.
    return this.transitions.shift() ?? this.held;
  }

  clear(): void {
    this.held = false;
    this.transitions.length = 0;
  }
}
