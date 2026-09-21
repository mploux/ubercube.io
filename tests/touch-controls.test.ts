import { expect, test } from 'bun:test';
import { InputButton } from '../src/client/input-button';
import { TouchControls } from '../src/client/touch-controls';
import type { WeaponId } from '../src/shared/protocol';

class TouchElement extends EventTarget {
  hidden = false;
  disabled = false;
  dataset: { touchAction?: string } = {};
  style = { transform: '' };
  readonly classes = new Set<string>();
  readonly captures = new Set<number>();
  readonly attributes = new Map<string, string>();
  readonly classList = {
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
    toggle: (name: string, force: boolean) => force ? this.classes.add(name) : this.classes.delete(name),
  };
  bounds = { left: 20, top: 30, width: 160, height: 160 };
  getBoundingClientRect() { return this.bounds; }
  matches(selector: string) { return selector === ':disabled' && this.disabled; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  setPointerCapture(id: number) { this.captures.add(id); }
  hasPointerCapture(id: number) { return this.captures.has(id); }
  releasePointerCapture(id: number) {
    this.captures.delete(id);
    pointer(this, 'lostpointercapture', id);
  }
}

function pointer(element: TouchElement, type: string, pointerId: number, x = 100, y = 110, button = 0, timeStamp = 0): Event {
  const event = Object.assign(new Event(type, { cancelable: true }), { pointerId, clientX: x, clientY: y, button });
  Object.defineProperty(event, 'timeStamp', { value: timeStamp });
  element.dispatchEvent(event);
  return event;
}

function fixture(weapon: WeaponId = 'ak47') {
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
  controls.setWeapon(weapon);
  events.length = 0;
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
  expect(events).toEqual([['cancel']]);
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

test('quick primary and secondary gestures preserve both edges before the next simulation tick', () => {
  const { elements, controls, fire, alt, events } = fixture('shovel');
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
    const { elements, controls, events, fire, alt } = fixture('shovel');
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
  const { elements, controls, events } = fixture('shovel');
  controls.setEnabled(true);
  pointer(elements.alt, 'pointerdown', 1);
  controls.clear();
  pointer(elements.alt, 'pointerup', 1);
  expect(events).toEqual([['alt', true]]);
  pointer(elements.alt, 'pointerdown', 2);
  expect(events).toEqual([['alt', true], ['alt', true]]);
});

test('disabled actions ignore new presses but an existing captured gesture can still release', () => {
  const { elements, controls, events, alt } = fixture('shovel');
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

test('exactly two contacts can move, turn, and fire immediately on a held second tap', () => {
  const { elements, controls, events, fire } = fixture();
  controls.setEnabled(true);
  pointer(elements.move, 'pointerdown', 1, 100, 50);
  pointer(elements.look, 'pointerdown', 2, 300, 100, 0, 100);
  pointer(elements.look, 'pointerup', 2, 300, 100, 0, 160);
  expect(events).toEqual([]);
  pointer(elements.look, 'pointerdown', 2, 302, 103, 0, 230);
  expect(events).toEqual([['fire', true]]);
  expect(fire.sample()).toBe(true);
  expect(elements.move.captures.size + elements.look.captures.size).toBe(2);
  expect(elements.fire.classes.has('active')).toBe(true);
  pointer(elements.look, 'pointermove', 2, 360, 80, 0, 260);
  pointer(elements.move, 'pointermove', 1, 160, 110);
  expect(events.at(-1)).toEqual(['look', 58, -23]);
  expect(controls.moveX).toBe(1);
  pointer(elements.look, 'pointerup', 2, 600, 200, 0, 900);
  expect(events.at(-1)).toEqual(['fire', false]);
  expect(fire.sample()).toBe(false);
  expect(elements.fire.classes.has('active')).toBe(false);
  expect(controls.moveX).toBe(1);
  pointer(elements.look, 'pointerdown', 2, 600, 200, 0, 950);
  expect(fire.sample()).toBe(false);
});

test('a camera drag that returns to its origin never arms a firing tap', () => {
  const { elements, controls, events } = fixture();
  controls.setEnabled(true);
  pointer(elements.look, 'pointerdown', 1, 300, 100, 0, 10);
  pointer(elements.look, 'pointermove', 1, 350, 100, 0, 30);
  pointer(elements.look, 'pointermove', 1, 300, 100, 0, 50);
  pointer(elements.look, 'pointerup', 1, 300, 100, 0, 70);
  pointer(elements.look, 'pointerdown', 1, 300, 100, 0, 90);
  pointer(elements.look, 'pointermove', 1, 320, 100, 0, 110);
  expect(events).toEqual([['look', 50, 0], ['look', -50, 0], ['look', 20, 0]]);
});

for (const scenario of [
  { name: 'inclusive duration, interval, and radius limits', duration: 200, wait: 280, tapDistance: 12, secondDistance: 40, fires: true },
  { name: 'a long first hold', duration: 201, wait: 50, tapDistance: 0, secondDistance: 0, fires: false },
  { name: 'a late second tap', duration: 60, wait: 281, tapDistance: 0, secondDistance: 0, fires: false },
  { name: 'movement beyond the first tap radius', duration: 60, wait: 50, tapDistance: 13, secondDistance: 0, fires: false },
  { name: 'a distant second tap', duration: 60, wait: 50, tapDistance: 0, secondDistance: 41, fires: false },
  { name: 'reversed tap timestamps', duration: -1, wait: 50, tapDistance: 0, secondDistance: 0, fires: false },
  { name: 'reversed second-press timestamps', duration: 60, wait: -1, tapDistance: 0, secondDistance: 0, fires: false },
]) {
  test(`double-tap recognition handles ${scenario.name}`, () => {
    const { elements, controls, events } = fixture();
    controls.setEnabled(true);
    pointer(elements.look, 'pointerdown', 1, 100, 110, 0, 100);
    pointer(elements.look, 'pointerup', 1, 100 + scenario.tapDistance, 110, 0, 100 + scenario.duration);
    pointer(elements.look, 'pointerdown', 1, 100 + scenario.tapDistance + scenario.secondDistance, 110,
      0, 100 + scenario.duration + scenario.wait);
    expect(events).toEqual(scenario.fires ? [['fire', true]] : []);
  });
}

for (const action of ['alt', 'fire', 'jump', 'scores', 'previous', 'next', 'pause'] as const) {
  test(`${action} invalidates a completed first tap and an unfinished candidate`, () => {
    for (const releaseFirst of [true, false]) {
      const { elements, controls, events } = fixture();
      controls.setEnabled(true);
      pointer(elements.look, 'pointerdown', 1, 100, 110, 0, 100);
      if (releaseFirst) pointer(elements.look, 'pointerup', 1, 100, 110, 0, 150);
      pointer(elements[action], 'pointerdown', 2, 100, 110, 0, 160);
      pointer(elements[action], 'pointerup', 2, 100, 110, 0, 170);
      if (!releaseFirst) pointer(elements.look, 'pointerup', 1, 100, 110, 0, 180);
      events.length = 0;
      pointer(elements.look, 'pointerdown', 1, 100, 110, 0, 200);
      expect(events).toEqual([]);
    }
  });
}

for (const releaseFirst of ['look', 'fire'] as const) {
  test(`overlapping firing pointers remain held when ${releaseFirst} releases first`, () => {
    const { elements, controls, events, fire } = fixture();
    controls.setEnabled(true);
    pointer(elements.look, 'pointerdown', 1, 100, 110, 0, 100);
    pointer(elements.look, 'pointerup', 1, 100, 110, 0, 160);
    pointer(elements.look, 'pointerdown', 1, 100, 110, 0, 200);
    pointer(elements.fire, 'pointerdown', 2);
    expect(fire.sample()).toBe(true);
    pointer(elements[releaseFirst], 'pointerup', releaseFirst === 'look' ? 1 : 2);
    expect(fire.sample()).toBe(true);
    expect(elements.fire.classes.has('active')).toBe(true);
    expect(events).toEqual([['fire', true]]);
    const last = releaseFirst === 'look' ? 'fire' : 'look';
    pointer(elements[last], 'pointerup', last === 'look' ? 1 : 2);
    expect(events).toEqual([['fire', true], ['fire', false]]);
    expect(fire.sample()).toBe(false);
    expect(elements.fire.classes.has('active')).toBe(false);
  });
}

for (const weapon of ['ak47', 'grenade', 'rpg'] as const) {
  test(`a quick ${weapon} double tap preserves the press and release edges`, () => {
    const { elements, controls, fire } = fixture(weapon);
    controls.setEnabled(true);
    pointer(elements.look, 'pointerdown', 1, 100, 110, 0, 100);
    pointer(elements.look, 'pointerup', 1, 100, 110, 0, 130);
    pointer(elements.look, 'pointerdown', 1, 100, 110, 0, 160);
    pointer(elements.look, 'pointerup', 1, 100, 110, 0, 180);
    expect([fire.sample(), fire.sample(), fire.sample()]).toEqual([true, false, false]);
  });
}

for (const weapon of ['ak47', 'awp', 'rpg'] as const) {
  test(`${weapon} aim stays active after release and toggles off on the next press`, () => {
    const { elements, controls, events, alt } = fixture(weapon);
    controls.setEnabled(true);
    expect(elements.alt.attributes.get('aria-pressed')).toBe('false');
    pointer(elements.alt, 'pointerdown', 1);
    pointer(elements.alt, 'pointerup', 1);
    expect(alt.sample()).toBe(true);
    expect(elements.alt.classes.has('active')).toBe(true);
    expect(elements.alt.attributes.get('aria-pressed')).toBe('true');
    pointer(elements.look, 'pointerdown', 1);
    pointer(elements.look, 'pointermove', 1, 120, 90);
    pointer(elements.look, 'pointerup', 1);
    pointer(elements.alt, 'pointerdown', 1);
    expect(alt.sample()).toBe(false);
    expect(elements.alt.attributes.get('aria-pressed')).toBe('false');
    pointer(elements.alt, 'pointerup', 1);
    expect(elements.alt.classes.has('active')).toBe(false);
    expect(events).toEqual([['alt', true], ['look', 20, -20], ['alt', false]]);
  });
}

for (const weapon of ['grenade', 'medic'] as const) {
  test(`${weapon} ignores secondary actions rather than latching an unsupported aim`, () => {
    const { elements, controls, events } = fixture(weapon);
    controls.setEnabled(true);
    pointer(elements.alt, 'pointerdown', 1);
    pointer(elements.alt, 'pointerup', 1);
    expect(events).toEqual([]);
    expect(elements.alt.captures.size).toBe(0);
    expect(elements.alt.classes.has('active')).toBe(false);
    expect(elements.alt.attributes.has('aria-pressed')).toBe(false);
  });
}

test('repeating the selected weapon preserves held inputs but changing it discards a grenade', () => {
  const { elements, controls, events, fire } = fixture('grenade');
  controls.setEnabled(true);
  pointer(elements.fire, 'pointerdown', 1);
  controls.setWeapon('grenade');
  expect(fire.sample()).toBe(true);
  expect(elements.fire.captures.has(1)).toBe(true);
  expect(events).toEqual([['fire', true]]);
  controls.setWeapon('ak47');
  expect(fire.sample()).toBe(false);
  pointer(elements.fire, 'pointerup', 1);
  expect(events).toEqual([['fire', true], ['cancel']]);
  expect(elements.fire.captures.size).toBe(0);
  expect(elements.fire.classes.has('active')).toBe(false);
  expect(elements.alt.attributes.get('aria-pressed')).toBe('false');
});

test('changing weapons discards the grenade but preserves the left joystick contact', () => {
  const { elements, controls, events, fire } = fixture('grenade');
  controls.setEnabled(true);
  pointer(elements.move, 'pointerdown', 1, 100, 50);
  pointer(elements.fire, 'pointerdown', 2);
  const transform = elements.stick.style.transform;
  controls.setWeapon('shovel');
  expect(events).toEqual([['fire', true], ['cancel']]);
  expect(fire.sample()).toBe(false);
  expect(elements.fire.captures.size).toBe(0);
  expect(elements.move.captures.has(1)).toBe(true);
  expect(elements.move.classes.has('active')).toBe(true);
  expect(elements.stick.style.transform).toBe(transform);
  expect([controls.moveX, controls.moveZ, controls.sprint]).toEqual([0, 1, true]);
  pointer(elements.fire, 'pointerup', 2);
  expect(events).toEqual([['fire', true], ['cancel']]);
  pointer(elements.move, 'pointermove', 1, 160, 110);
  expect([controls.moveX, controls.moveZ, controls.sprint]).toEqual([1, -0, true]);
  pointer(elements.move, 'pointerup', 1);
  expect([controls.moveX, controls.moveZ, controls.sprint]).toEqual([0, 0, false]);
  expect(elements.stick.style.transform).toBe('');
});

for (const action of ['clear', 'disable', 'weapon', 'pointercancel', 'lostpointercapture'] as const) {
  test(`${action} discards a double-tap grenade hold and its future release`, () => {
    const { elements, controls, events, fire, alt } = fixture('grenade');
    controls.setEnabled(true);
    pointer(elements.look, 'pointerdown', 1, 100, 110, 0, 100);
    pointer(elements.look, 'pointerup', 1, 100, 110, 0, 140);
    pointer(elements.look, 'pointerdown', 1, 100, 110, 0, 180);
    expect(fire.sample()).toBe(true);
    if (action === 'clear') {
      controls.clear();
      fire.clear(); alt.clear();
    } else if (action === 'disable') controls.setEnabled(false);
    else if (action === 'weapon') controls.setWeapon('ak47');
    else pointer(elements.look, action, 1);
    pointer(elements.look, 'pointerup', 1, 100, 110, 0, 200);
    expect(events).toEqual(action === 'clear' ? [['fire', true]] : [['fire', true], ['cancel']]);
    expect(fire.sample()).toBe(false);
    expect(elements.fire.classes.has('active')).toBe(false);
    expect(elements.look.captures.size).toBe(0);
    controls.setEnabled(true);
    pointer(elements.look, 'pointerdown', 1, 100, 110, 0, 230);
    expect(fire.sample()).toBe(false);
  });
}

test('clearing or changing weapons resets latched aim and completed tap recognition', () => {
  for (const changeWeapon of [false, true]) {
    const { elements, controls, events } = fixture();
    controls.setEnabled(true);
    pointer(elements.alt, 'pointerdown', 1);
    pointer(elements.alt, 'pointerup', 1);
    pointer(elements.look, 'pointerdown', 1, 100, 110, 0, 100);
    pointer(elements.look, 'pointerup', 1, 100, 110, 0, 140);
    if (changeWeapon) controls.setWeapon('awp');
    else controls.clear();
    expect(elements.alt.classes.has('active')).toBe(false);
    expect(elements.alt.attributes.get('aria-pressed')).toBe('false');
    events.length = 0;
    pointer(elements.look, 'pointerdown', 1, 100, 110, 0, 180);
    expect(events).toEqual([]);
  }
});

test('repeated enable updates preserve gestures and repeated disable updates cancel only once', () => {
  const { elements, controls, events, fire } = fixture();
  controls.setEnabled(false);
  controls.setEnabled(true);
  pointer(elements.fire, 'pointerdown', 1);
  controls.setEnabled(true);
  expect(fire.sample()).toBe(true);
  expect(elements.fire.captures.has(1)).toBe(true);
  controls.setEnabled(false);
  controls.setEnabled(false);
  expect(events).toEqual([['fire', true], ['cancel']]);
  expect(fire.sample()).toBe(false);
});
