import type { WeaponId } from '../shared/protocol';

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
interface TouchTap { x: number; y: number; time: number }
interface TouchPointer { element: HTMLElement; x: number; y: number; firing: boolean; tap?: TouchTap }

export class TouchControls {
  moveX = 0;
  moveZ = 0;
  jump = false;
  sprint = false;
  private enabled = false;
  private weapon: WeaponId = 'ak47';
  private aiming = false;
  private firing = false;
  private lastTap?: TouchTap;
  private readonly pointers = new Map<number, TouchPointer>();
  private readonly stick: HTMLElement;
  private readonly moveElement: HTMLElement;
  private readonly fireElement: HTMLElement;
  private readonly altElement: HTMLElement;

  constructor(private readonly root: HTMLElement, private readonly callbacks: TouchControlsCallbacks) {
    this.stick = root.querySelector<HTMLElement>('#touch-stick')!;
    this.moveElement = root.querySelector<HTMLElement>('#touch-move')!;
    this.fireElement = root.querySelector<HTMLElement>('#touch-fire')!;
    this.altElement = root.querySelector<HTMLElement>('#touch-alt')!;
    this.bind(this.moveElement, 'move');
    this.bind(root.querySelector<HTMLElement>('#touch-look')!, 'look');
    for (const element of root.querySelectorAll<HTMLElement>('[data-touch-action]')) {
      this.bind(element, element.dataset.touchAction as TouchAction);
    }
    this.updateAltVisual();
    root.hidden = true;
  }

  setEnabled(enabled: boolean): void {
    const wasEnabled = this.enabled;
    this.enabled = enabled;
    this.root.hidden = !enabled;
    if (!enabled) {
      this.clear();
      if (wasEnabled) this.callbacks.cancel();
    }
  }

  setWeapon(weapon: WeaponId): void {
    if (this.weapon === weapon) return;
    const movement = [...this.pointers].find(([, pointer]) => pointer.element === this.moveElement);
    if (movement) this.pointers.delete(movement[0]);
    this.clear();
    if (movement) {
      this.pointers.set(...movement);
      this.move(this.moveElement, movement[1].x, movement[1].y);
    }
    this.weapon = weapon;
    this.updateAltVisual();
    this.callbacks.cancel();
  }

  clear(): void {
    const pointers = [...this.pointers];
    this.pointers.clear();
    this.moveX = this.moveZ = 0;
    this.jump = this.sprint = false;
    this.aiming = this.firing = false;
    this.lastTap = undefined;
    this.stick.style.transform = '';
    for (const [id, pointer] of pointers) {
      pointer.element.classList.remove('active');
      if (pointer.element.hasPointerCapture(id)) pointer.element.releasePointerCapture(id);
    }
    this.fireElement.classList.remove('active');
    this.updateAltVisual();
  }

  private bind(element: HTMLElement, action: TouchAction): void {
    element.addEventListener('pointerdown', event => {
      if (!this.enabled || element.matches(':disabled') || event.button !== 0 || this.pointers.has(event.pointerId)
        || [...this.pointers.values()].some(pointer => pointer.element === element)) return;
      if (action === 'alt' && this.weapon !== 'ak47' && this.weapon !== 'awp' && this.weapon !== 'shovel') return;
      event.preventDefault();
      if (action !== 'move' && action !== 'look') {
        this.lastTap = undefined;
        for (const pointer of this.pointers.values()) pointer.tap = undefined;
      }
      const pointer: TouchPointer = { element, x: event.clientX, y: event.clientY, firing: action === 'fire' };
      if (action === 'look') {
        const elapsed = event.timeStamp - (this.lastTap?.time ?? -Infinity);
        pointer.firing = !!this.lastTap && elapsed >= 0 && elapsed <= 280
          && Math.hypot(event.clientX - this.lastTap.x, event.clientY - this.lastTap.y) <= 40;
        this.lastTap = undefined;
        if (!pointer.firing) pointer.tap = { x: event.clientX, y: event.clientY, time: event.timeStamp };
      }
      element.setPointerCapture(event.pointerId);
      element.classList.add('active');
      this.pointers.set(event.pointerId, pointer);
      if (action === 'move') this.move(element, event.clientX, event.clientY);
      else if (action === 'fire' || action === 'look') this.updateFire();
      else if (action === 'alt') {
        if (this.weapon === 'shovel') this.callbacks.alt(true);
        else {
          this.aiming = !this.aiming;
          this.callbacks.alt(this.aiming);
        }
        this.updateAltVisual();
      }
      else if (action === 'jump') this.jump = true;
      else if (action === 'scores') this.callbacks.scores(true);
      else if (action === 'previous' || action === 'next') this.callbacks.weapon(action === 'next' ? 1 : -1);
      else if (action === 'pause') this.callbacks.pause();
    });
    element.addEventListener('pointermove', event => {
      const pointer = this.pointers.get(event.pointerId);
      if (!pointer || pointer.element !== element) return;
      event.preventDefault();
      if (pointer.tap && Math.hypot(event.clientX - pointer.tap.x, event.clientY - pointer.tap.y) > 12) pointer.tap = undefined;
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
      if (pointer.tap) {
        const elapsed = event.timeStamp - pointer.tap.time;
        if (elapsed >= 0 && elapsed <= 200
          && Math.hypot(event.clientX - pointer.tap.x, event.clientY - pointer.tap.y) <= 12) {
          this.lastTap = { x: event.clientX, y: event.clientY, time: event.timeStamp };
        }
      }
      this.pointers.delete(event.pointerId);
      element.classList.remove('active');
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
      if (action === 'move') {
        this.moveX = this.moveZ = 0;
        this.sprint = false;
        this.stick.style.transform = '';
      } else if (action === 'fire' || action === 'look') this.updateFire();
      else if (action === 'alt') {
        if (this.weapon === 'shovel') this.callbacks.alt(false);
        this.updateAltVisual();
      }
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

  private updateFire(): void {
    const firing = [...this.pointers.values()].some(pointer => pointer.firing);
    this.fireElement.classList.toggle('active', firing);
    if (this.firing === firing) return;
    this.firing = firing;
    this.callbacks.fire(firing);
  }

  private updateAltVisual(): void {
    const toggle = this.weapon === 'ak47' || this.weapon === 'awp';
    if (toggle) this.altElement.setAttribute('aria-pressed', String(this.aiming));
    else this.altElement.removeAttribute('aria-pressed');
    this.altElement.classList.toggle('active', this.aiming
      || [...this.pointers.values()].some(pointer => pointer.element === this.altElement));
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
