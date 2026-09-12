export interface TouchControlsCallbacks {
  look(dx: number, dy: number): void;
  fire(down: boolean): void;
  alt(down: boolean): void;
  weapon(direction: number): void;
  pause(): void;
  scores(down: boolean): void;
  cancel(): void;
}

type TouchAction = 'move' | 'look' | 'fire' | 'alt' | 'jump' | 'previous' | 'next' | 'pause' | 'scores';
interface TouchPointer { element: HTMLElement; x: number; y: number }

export class TouchControls {
  moveX = 0;
  moveZ = 0;
  jump = false;
  sprint = false;
  private enabled = false;
  private readonly pointers = new Map<number, TouchPointer>();
  private readonly stick: HTMLElement;

  constructor(private readonly root: HTMLElement, private readonly callbacks: TouchControlsCallbacks) {
    this.stick = root.querySelector<HTMLElement>('#touch-stick')!;
    this.bind(root.querySelector<HTMLElement>('#touch-move')!, 'move');
    this.bind(root.querySelector<HTMLElement>('#touch-look')!, 'look');
    for (const element of root.querySelectorAll<HTMLElement>('[data-touch-action]')) {
      this.bind(element, element.dataset.touchAction as TouchAction);
    }
    root.hidden = true;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.root.hidden = !enabled;
    if (!enabled) this.clear();
  }

  clear(): void {
    const pointers = [...this.pointers];
    this.pointers.clear();
    this.moveX = this.moveZ = 0;
    this.jump = this.sprint = false;
    this.stick.style.transform = '';
    for (const [id, pointer] of pointers) {
      pointer.element.classList.remove('active');
      if (pointer.element.hasPointerCapture(id)) pointer.element.releasePointerCapture(id);
    }
  }

  private bind(element: HTMLElement, action: TouchAction): void {
    element.addEventListener('pointerdown', event => {
      if (!this.enabled || element.matches(':disabled') || event.button !== 0 || this.pointers.has(event.pointerId)
        || [...this.pointers.values()].some(pointer => pointer.element === element)) return;
      event.preventDefault();
      element.setPointerCapture(event.pointerId);
      element.classList.add('active');
      this.pointers.set(event.pointerId, { element, x: event.clientX, y: event.clientY });
      if (action === 'move') this.move(element, event.clientX, event.clientY);
      else if (action === 'fire') this.callbacks.fire(true);
      else if (action === 'alt') this.callbacks.alt(true);
      else if (action === 'jump') this.jump = true;
      else if (action === 'scores') this.callbacks.scores(true);
      else if (action === 'previous' || action === 'next') this.callbacks.weapon(action === 'next' ? 1 : -1);
      else if (action === 'pause') this.callbacks.pause();
    });
    element.addEventListener('pointermove', event => {
      const pointer = this.pointers.get(event.pointerId);
      if (!pointer || pointer.element !== element) return;
      event.preventDefault();
      if (action === 'move') this.move(element, event.clientX, event.clientY);
      else if (action === 'look' || action === 'fire') {
        this.callbacks.look(event.clientX - pointer.x, event.clientY - pointer.y);
      }
      pointer.x = event.clientX;
      pointer.y = event.clientY;
    });
    element.addEventListener('pointerup', event => {
      const pointer = this.pointers.get(event.pointerId);
      if (!pointer || pointer.element !== element) return;
      event.preventDefault();
      this.pointers.delete(event.pointerId);
      element.classList.remove('active');
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
      if (action === 'move') {
        this.moveX = this.moveZ = 0;
        this.sprint = false;
        this.stick.style.transform = '';
      } else if (action === 'fire') this.callbacks.fire(false);
      else if (action === 'alt') this.callbacks.alt(false);
      else if (action === 'jump') this.jump = false;
      else if (action === 'scores') this.callbacks.scores(false);
    });
    const cancel = (event: PointerEvent) => {
      if (this.pointers.get(event.pointerId)?.element !== element) return;
      // A cancelled grenade hold must be discarded, never converted into a throw.
      this.clear();
      this.callbacks.cancel();
    };
    element.addEventListener('pointercancel', cancel);
    element.addEventListener('lostpointercapture', cancel);
  }

  private move(element: HTMLElement, x: number, y: number): void {
    const bounds = element.getBoundingClientRect();
    const thumb = this.stick.getBoundingClientRect();
    const radius = Math.max(1, (Math.min(bounds.width, bounds.height) - Math.max(thumb.width, thumb.height)) / 2);
    const dx = (x - bounds.left - bounds.width / 2) / radius;
    const dy = (y - bounds.top - bounds.height / 2) / radius;
    const distance = Math.hypot(dx, dy);
    const magnitude = Math.min(1, distance);
    const speed = Math.max(0, (magnitude - 0.12) / 0.88);
    this.moveX = distance ? dx / distance * speed : 0;
    this.moveZ = distance ? -dy / distance * speed : 0;
    this.sprint = magnitude >= 0.9;
    const scale = distance > 1 ? 1 / distance : 1;
    this.stick.style.transform = `translate(${dx * scale * radius}px, ${dy * scale * radius}px)`;
  }
}
