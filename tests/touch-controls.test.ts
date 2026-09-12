import { expect, test } from 'bun:test';
import { InputButton } from '../src/client/input-button';
import { TouchControls } from '../src/client/touch-controls';

class TouchElement extends EventTarget {
  hidden = false;
  disabled = false;
  dataset: { touchAction?: string } = {};
  style = { transform: '' };
  readonly classes = new Set<string>();
  readonly captures = new Set<number>();
  readonly classList = {
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
  };
  bounds = { left: 20, top: 30, width: 160, height: 160 };
  getBoundingClientRect() { return this.bounds; }
  matches(selector: string) { return selector === ':disabled' && this.disabled; }
  setPointerCapture(id: number) { this.captures.add(id); }
  hasPointerCapture(id: number) { return this.captures.has(id); }
  releasePointerCapture(id: number) {
    this.captures.delete(id);
    pointer(this, 'lostpointercapture', id);
  }
}

function pointer(element: TouchElement, type: string, pointerId: number, x = 100, y = 110, button = 0): Event {
  const event = Object.assign(new Event(type, { cancelable: true }), { pointerId, clientX: x, clientY: y, button });
  element.dispatchEvent(event);
  return event;
}

function fixture() {
  const root = new TouchElement();
  const elements = {
    move: new TouchElement(), look: new TouchElement(), stick: new TouchElement(),
    fire: new TouchElement(), alt: new TouchElement(), jump: new TouchElement(),
    previous: new TouchElement(), next: new TouchElement(), pause: new TouchElement(), scores: new TouchElement(),
  };
  elements.stick.bounds.width = elements.stick.bounds.height = 40;
  const actions = ['fire', 'alt', 'jump', 'previous', 'next', 'pause', 'scores'] as const;
  for (const action of actions) elements[action].dataset.touchAction = action;
  Object.assign(root, {
    querySelector: (selector: string) => elements[selector.slice('#touch-'.length) as keyof typeof elements],
    querySelectorAll: () => actions.map(action => elements[action]),
  });
  const fire = new InputButton();
  const alt = new InputButton();
  const events: unknown[] = [];
  const controls = new TouchControls(root as unknown as HTMLElement, {
    look: (x, y) => events.push(['look', x, y]),
    fire: down => { events.push(['fire', down]); fire.set(down); },
    alt: down => { events.push(['alt', down]); alt.set(down); },
    weapon: direction => events.push(['weapon', direction]),
    pause: () => events.push(['pause']),
    scores: down => events.push(['scores', down]),
    cancel: () => { events.push(['cancel']); fire.clear(); alt.clear(); },
  });
  return { root, elements, controls, events, fire, alt };
}

test('touch controls are inert until enabled and disabling clears their captures and visuals', () => {
  const { root, elements, controls, events } = fixture();
  expect(root.hidden).toBe(true);
  pointer(elements.fire, 'pointerdown', 1);
  expect(events).toEqual([]);
  controls.setEnabled(true);
  expect(root.hidden).toBe(false);
  pointer(elements.move, 'pointerdown', 2, 100, 50);
  pointer(elements.jump, 'pointerdown', 3);
  expect(controls.moveZ).toBe(1);
  expect(controls.jump).toBe(true);
  controls.setEnabled(false);
  expect(root.hidden).toBe(true);
  expect([controls.moveX, controls.moveZ, controls.jump, controls.sprint]).toEqual([0, 0, false, false]);
  expect(elements.move.style.transform).toBe('');
  expect(elements.move.classes.size + elements.jump.classes.size).toBe(0);
  expect(elements.move.captures.size + elements.jump.captures.size).toBe(0);
  expect(events).toEqual([]);
});

test('joystick uses its actual radius, a central deadzone, and normalized diagonal movement', () => {
  const { elements, controls } = fixture();
  controls.setEnabled(true);
  pointer(elements.move, 'pointerdown', 1, 102, 107);
  expect(Math.hypot(controls.moveX, controls.moveZ)).toBe(0);
  expect(controls.sprint).toBe(false);
  pointer(elements.move, 'pointermove', 1, 130, 110);
  expect(controls.moveX).toBeCloseTo((0.5 - 0.12) / 0.88);
  expect(controls.moveZ).toBeCloseTo(0);
  expect(controls.sprint).toBe(false);
  pointer(elements.move, 'pointermove', 1, 220, -10);
  expect(controls.moveX).toBeCloseTo(Math.SQRT1_2);
  expect(controls.moveZ).toBeCloseTo(Math.SQRT1_2);
  expect(Math.hypot(controls.moveX, controls.moveZ)).toBeCloseTo(1);
  expect(controls.sprint).toBe(true);
  const offsets = elements.stick.style.transform.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  expect(Math.hypot(...offsets)).toBeCloseTo(60);
  pointer(elements.move, 'pointerup', 1);
  expect([controls.moveX, controls.moveZ, controls.sprint]).toEqual([0, 0, false]);
});

test('movement, looking, and firing have independent pointer ownership and can run together', () => {
  const { elements, controls, events, fire } = fixture();
  controls.setEnabled(true);
  expect(pointer(elements.move, 'pointerdown', 1, 100, 50).defaultPrevented).toBe(true);
  pointer(elements.look, 'pointerdown', 2, 200, 100);
  pointer(elements.fire, 'pointerdown', 3, 300, 100);
  pointer(elements.move, 'pointermove', 2, 100, 170);
  expect(controls.moveZ).toBe(1);
  pointer(elements.look, 'pointermove', 2, 220, 90);
  pointer(elements.fire, 'pointermove', 3, 305, 110);
  expect(fire.sample()).toBe(true);
  expect(events).toEqual([['fire', true], ['look', 20, -10], ['look', 5, 10]]);
  pointer(elements.look, 'pointerup', 2);
  expect(fire.sample()).toBe(true);
  expect(controls.moveZ).toBe(1);
  pointer(elements.fire, 'pointerup', 3);
  expect(fire.sample()).toBe(false);
  expect(events.at(-1)).toEqual(['fire', false]);
  expect(events).not.toContainEqual(['cancel']);
});

test('quick fire and grenade gestures preserve both edges before the next simulation tick', () => {
  const { elements, controls, fire, alt, events } = fixture();
  controls.setEnabled(true);
  pointer(elements.fire, 'pointerdown', 1);
  pointer(elements.alt, 'pointerdown', 2);
  pointer(elements.fire, 'pointerup', 1);
  pointer(elements.alt, 'pointerup', 2);
  expect([fire.sample(), fire.sample(), fire.sample()]).toEqual([true, false, false]);
  expect([alt.sample(), alt.sample(), alt.sample()]).toEqual([true, false, false]);
  expect(events).toEqual([['fire', true], ['alt', true], ['fire', false], ['alt', false]]);
});

test('a second finger cannot steal a held button or produce a premature release', () => {
  const { elements, controls, events, fire } = fixture();
  controls.setEnabled(true);
  pointer(elements.fire, 'pointerdown', 1);
  pointer(elements.fire, 'pointerdown', 2);
  pointer(elements.fire, 'pointerup', 2);
  pointer(elements.fire, 'pointermove', 2, 500, 500);
  expect(fire.sample()).toBe(true);
  expect(events).toEqual([['fire', true]]);
  pointer(elements.fire, 'pointerup', 1);
  expect(fire.sample()).toBe(false);
});

for (const cancelledEvent of ['pointercancel', 'lostpointercapture']) {
  test(`${cancelledEvent} discards every gesture without turning a held grenade into a throw`, () => {
    const { elements, controls, events, fire, alt } = fixture();
    controls.setEnabled(true);
    pointer(elements.move, 'pointerdown', 1, 100, 50);
    pointer(elements.fire, 'pointerdown', 2);
    pointer(elements.alt, 'pointerdown', 3);
    pointer(elements.jump, 'pointerdown', 4);
    expect(alt.sample()).toBe(true);
    pointer(elements.alt, cancelledEvent, 3);
    expect(events).toEqual([['fire', true], ['alt', true], ['cancel']]);
    expect([controls.moveX, controls.moveZ, controls.jump, controls.sprint]).toEqual([0, 0, false, false]);
    expect([...Object.values(elements)].every(element => element.captures.size === 0)).toBe(true);
    expect([fire.sample(), alt.sample()]).toEqual([false, false]);
    pointer(elements.fire, 'pointerup', 2);
    pointer(elements.alt, 'pointerup', 3);
    expect(events).toHaveLength(3);
    pointer(elements.alt, 'pointerdown', 5);
    expect(alt.sample()).toBe(true);
  });
}

test('jump and scores are held while weapon selection and pause fire once on press', () => {
  const { elements, controls, events } = fixture();
  controls.setEnabled(true);
  pointer(elements.jump, 'pointerdown', 1);
  pointer(elements.scores, 'pointerdown', 2);
  expect(controls.jump).toBe(true);
  pointer(elements.next, 'pointerdown', 3);
  pointer(elements.next, 'pointermove', 3);
  pointer(elements.next, 'pointerup', 3);
  pointer(elements.previous, 'pointerdown', 4);
  pointer(elements.previous, 'pointerup', 4);
  pointer(elements.pause, 'pointerdown', 5);
  pointer(elements.pause, 'pointerup', 5);
  pointer(elements.jump, 'pointerup', 1);
  pointer(elements.scores, 'pointerup', 2);
  expect(controls.jump).toBe(false);
  expect(events).toEqual([['scores', true], ['weapon', 1], ['weapon', -1], ['pause'], ['scores', false]]);
});

test('clear is silent even when releasing capture raises an immediate lost-capture event', () => {
  const { elements, controls, events } = fixture();
  controls.setEnabled(true);
  pointer(elements.alt, 'pointerdown', 1);
  controls.clear();
  pointer(elements.alt, 'pointerup', 1);
  expect(events).toEqual([['alt', true]]);
  pointer(elements.alt, 'pointerdown', 2);
  expect(events).toEqual([['alt', true], ['alt', true]]);
});

test('disabled actions ignore new presses but an existing captured gesture can still release', () => {
  const { elements, controls, events, alt } = fixture();
  controls.setEnabled(true);
  elements.alt.disabled = true;
  pointer(elements.alt, 'pointerdown', 1);
  expect(events).toEqual([]);
  elements.alt.disabled = false;
  pointer(elements.alt, 'pointerdown', 2);
  elements.alt.disabled = true;
  pointer(elements.alt, 'pointerup', 2);
  expect(events).toEqual([['alt', true], ['alt', false]]);
  expect([alt.sample(), alt.sample(), alt.sample()]).toEqual([true, false, false]);
});
