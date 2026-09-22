import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { InputButton } from '../src/client/input-button';
import { KITS } from '../src/shared/protocol';

// Execute the production handlers without initializing their Three.js/WebGL scene.
const source = ts.createSourceFile('main.ts', readFileSync(new URL('../src/client/main.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const functions = new Set(['clearInput', 'clearActions', 'showScreen', 'setPaused', 'lockPointer', 'unlockKeyboard', 'rotateView', 'cycleWeapon', 'updateTouchControls']);
const events = new Set(['pointerlockchange', 'pointerlockerror', 'fullscreenchange', 'mousemove', 'keydown', 'keyup', 'mousedown', 'mouseup', 'contextmenu', 'wheel', 'blur', 'visibilitychange']);
const statements = source.statements.filter(node => {
  if (ts.isFunctionDeclaration(node)) return !!node.name && functions.has(node.name.text);
  if (ts.isVariableStatement(node)) return node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && ['keyboard', 'keyboardCaptureRequested', 'fullscreenButton'].includes(declaration.name.text));
  if (!ts.isExpressionStatement(node)) return false;
  if (ts.isBinaryExpression(node.expression)) {
    const { left } = node.expression;
    return ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression) && left.expression.text === 'fullscreenButton' && left.name.text === 'disabled';
  }
  if (!ts.isCallExpression(node.expression)) return false;
  const { expression, arguments: args } = node.expression;
  return ts.isPropertyAccessExpression(expression) && expression.name.text === 'addEventListener'
    && ts.isIdentifier(expression.expression) && !!args[0] && ts.isStringLiteral(args[0])
    && ((['document', 'window'].includes(expression.expression.text) && events.has(args[0].text))
      || (expression.expression.text === 'fullscreenButton' && args[0].text === 'click'));
});
const controlsCode = ts.transpileModule(statements.map(node => node.getText(source)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

class Element extends EventTarget {
  hidden = true;
  disabled = false;
  textContent = '';
  editable = false;
  dataset: Record<string, string> = {};
  classList = { toggle: () => {} };
  closest() { return this.editable ? this : null; }
}

function emit(target: EventTarget, type: string, properties: Record<string, unknown> = {}) {
  const event = Object.assign(new Event(type, { cancelable: true }), properties);
  target.dispatchEvent(event);
  return event;
}

function fixture(options: { keyboard?: 'unsupported' | 'reject'; fullscreen?: 'unsupported' | 'reject'; touch?: boolean; keyboardLock?: () => Promise<void> } = {}) {
  const calls: string[] = [];
  const notices: string[] = [];
  const elements = new Map<string, Element>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const canvas = Object.assign(element('viewport'), {
    requestPointerLock: () => { calls.push('pointer.lock'); document.pointerLockElement = canvas; emit(document, 'pointerlockchange'); return Promise.resolve(); },
  });
  const document = Object.assign(new EventTarget(), {
    body: new Element(),
    documentElement: { requestFullscreen: undefined as undefined | (() => Promise<void>) },
    pointerLockElement: null as Element | null,
    fullscreenElement: null as object | null,
    hidden: false,
    focused: true,
    hasFocus: () => document.focused,
    exitPointerLock: () => { calls.push('pointer.unlock'); document.pointerLockElement = null; emit(document, 'pointerlockchange'); },
    exitFullscreen: () => { calls.push('fullscreen.exit'); document.fullscreenElement = null; emit(document, 'fullscreenchange'); return Promise.resolve(); },
  });
  if (options.fullscreen !== 'unsupported') document.documentElement.requestFullscreen = () => {
    calls.push('fullscreen');
    if (options.fullscreen === 'reject') return Promise.reject(new Error('denied'));
    document.fullscreenElement = document.documentElement;
    emit(document, 'fullscreenchange');
    return Promise.resolve();
  };
  const keyboard = options.keyboard === 'unsupported' ? undefined : {
    lock: () => { calls.push('keyboard.lock'); return options.keyboardLock?.() ?? (options.keyboard === 'reject' ? Promise.reject(new Error('denied')) : Promise.resolve()); },
    unlock: () => { calls.push('keyboard.unlock'); },
  };
  const window = new EventTarget();
  const state = {
    document, window, canvas, HTMLElement: Element, navigator: { keyboard }, element, KITS,
    screen: 'entry', paused: false, muted: false, spawning: false, touchMode: options.touch ?? false,
    keys: new Set<string>(), rightMouse: false, cancelActions: false,
    fireButton: new InputButton(), altButton: new InputButton(),
    selectedKit: 'assault', selectedWeapon: 'ak47', terrain: null,
    weaponMouseDX: 0, weaponMouseDY: 0, weaponLookYaw: 0, weaponLookPitch: 0, yaw: 0, pitch: 0,
    sensitivity: 1, zoomSensitivity: 1, innerWidth: 1280, innerHeight: 720,
    lastFrame: 0, accumulator: 0, performance: { now: () => 1 },
    audio: { activate: () => calls.push('audio.activate'), setEnabled: (enabled: boolean) => calls.push(`audio.${enabled}`) },
    weaponView: { setWeapon: () => calls.push('weapon') },
    touchControls: { clear: () => {}, setWeapon: () => {}, setEnabled: () => {} },
    updateUI: () => {}, toast: (message: string) => notices.push(message),
  };
  const controls = runInNewContext(`${controlsCode}\n({ showScreen, setPaused, lockPointer })`, state) as {
    showScreen(screen: string): void; setPaused(paused: boolean): void; lockPointer(): void;
  };
  return { ...controls, state, calls, notices, document, window, canvas, element,
    key: (type: 'keydown' | 'keyup', code: string, properties: Record<string, unknown> = {}) => emit(document, type, { code, ...properties }),
  };
}

test('death and killcam retain capture, clear held actions, and release capture at the lobby', async () => {
  const f = fixture();
  f.document.fullscreenElement = f.document.documentElement;
  f.showScreen('game'); f.lockPointer();
  await Promise.resolve();
  f.key('keydown', 'ControlLeft');
  emit(f.document, 'mousedown', { button: 0 });
  emit(f.document, 'mousedown', { button: 2 });
  f.calls.length = 0;
  for (const screen of ['death', 'killcam']) {
    f.showScreen(screen);
    expect(f.document.pointerLockElement).toBe(f.canvas);
    expect(f.calls).not.toContain('keyboard.unlock');
    expect(f.state.keys.size).toBe(0);
    expect(f.state.fireButton.sample()).toBe(false);
    expect(f.state.altButton.sample()).toBe(false);
    expect(f.state.rightMouse).toBe(false);
  }
  f.showScreen('lobby');
  expect(f.document.pointerLockElement).toBeNull();
  expect(f.calls).toContain('keyboard.unlock');
});

test.each(['death', 'killcam'])('%s cancels browser input without moving, shooting, aiming or changing weapon', screen => {
  const f = fixture();
  f.showScreen(screen); f.document.pointerLockElement = f.canvas;
  for (const code of ['ControlLeft', 'KeyW', 'Tab', 'KeyR']) expect(f.key('keydown', code, { ctrlKey: true }).defaultPrevented).toBe(true);
  emit(f.document, 'mousedown', { button: 0 });
  emit(f.document, 'mousedown', { button: 2 });
  emit(f.document, 'mousemove', { movementX: 30, movementY: 20 });
  expect(emit(f.document, 'contextmenu').defaultPrevented).toBe(true);
  expect(emit(f.document, 'wheel', { deltaY: 1 }).defaultPrevented).toBe(true);
  expect(f.state.keys.size).toBe(0);
  expect(f.state.fireButton.sample()).toBe(false);
  expect(f.state.altButton.sample()).toBe(false);
  expect(f.state.rightMouse).toBe(false);
  expect([f.state.yaw, f.state.pitch]).toEqual([0, 0]);
  expect(f.state.selectedWeapon).toBe('ak47');
  expect(f.element('score-screen').hidden).toBe(true);
});

test('Ctrl+Tab shows scores without losing sprint and gameplay shortcuts cancel browser defaults', () => {
  const f = fixture(); f.showScreen('game');
  expect(f.key('keydown', 'ControlLeft').defaultPrevented).toBe(true);
  expect(f.key('keydown', 'Tab', { ctrlKey: true }).defaultPrevented).toBe(true);
  expect(f.element('score-screen').hidden).toBe(false);
  expect(f.state.keys.has('ControlLeft')).toBe(true);
  expect(f.key('keyup', 'Tab', { ctrlKey: true }).defaultPrevented).toBe(true);
  expect(f.element('score-screen').hidden).toBe(true);
  expect(f.state.keys.has('ControlLeft')).toBe(true);
  for (const code of ['KeyR', 'KeyL', 'KeyW', 'KeyF', 'Equal', 'Minus', 'F5']) {
    expect(f.key('keydown', code, { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(f.key('keyup', code, { ctrlKey: true }).defaultPrevented).toBe(true);
  }
  f.key('keyup', 'ControlLeft');
  expect(f.state.keys.size).toBe(0);
});

test.each(['game', 'death', 'killcam'])('Escape releases capture from %s and exposes the game menu', screen => {
  const f = fixture(); f.showScreen(screen); f.document.pointerLockElement = f.canvas;
  f.key('keydown', 'Escape');
  expect(f.document.pointerLockElement).toBeNull();
  expect(f.calls).toContain('keyboard.unlock');
  expect(f.state.keys.size).toBe(0);
  if (screen === 'game') {
    expect(f.state.paused).toBe(true);
    expect(f.element('pause-screen').hidden).toBe(false);
  }
});

test.each(['entry', 'lobby', 'disconnected'])('%s keeps ordinary browser and menu input available', screen => {
  const f = fixture(); f.showScreen(screen);
  for (const code of ['Tab', 'KeyR', 'ControlLeft']) {
    expect(f.key('keydown', code, { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(f.key('keyup', code, { ctrlKey: true }).defaultPrevented).toBe(false);
  }
  expect(emit(f.document, 'contextmenu').defaultPrevented).toBe(false);
  expect(emit(f.document, 'wheel', { deltaY: 1 }).defaultPrevented).toBe(false);
  expect(f.state.keys.size).toBe(0);
});

test.each([false, true])('editable inputs retain keyboard editing and shortcuts with paused=%j', paused => {
  const f = fixture(); f.showScreen('game'); f.setPaused(paused);
  const input = new Element(); input.editable = true;
  for (const code of ['Tab', 'Space', 'KeyA', 'KeyR']) {
    for (const type of ['keydown', 'keyup']) {
      const event = Object.assign(new Event(type, { cancelable: true }), { code, ctrlKey: true });
      Object.defineProperty(event, 'target', { value: input });
      f.document.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
  }
  expect(f.state.keys.size).toBe(0);
  expect(f.element('score-screen').hidden).toBe(true);
});

test.each(['fullscreenchange', 'pointerlockchange', 'blur', 'visibilitychange'])('%s releases keyboard capture and clears active gameplay input', type => {
  const f = fixture(); f.showScreen('game'); f.document.pointerLockElement = f.canvas;
  f.key('keydown', 'ControlLeft'); f.key('keydown', 'Tab');
  emit(f.document, 'mousedown', { button: 0 });
  if (type === 'pointerlockchange') f.document.pointerLockElement = null;
  if (type === 'visibilitychange') f.document.hidden = true;
  emit(type === 'blur' ? f.window : f.document, type);
  expect(f.calls).toContain('keyboard.unlock');
  expect(f.state.paused).toBe(true);
  expect(f.state.keys.size).toBe(0);
  expect(f.state.fireButton.sample()).toBe(false);
  expect(f.element('score-screen').hidden).toBe(true);
});

test('entry, resume and respawn capture only the mouse in windowed mode', async () => {
  const f = fixture();
  for (const action of ['entry', 'resume', 'respawn']) {
    if (action === 'resume') f.setPaused(true);
    else { f.showScreen('lobby'); f.showScreen('game'); }
    f.calls.length = 0; f.lockPointer(); await Promise.resolve();
    expect(f.document.pointerLockElement).toBe(f.canvas);
    expect(f.document.fullscreenElement).toBeNull();
    expect(f.state.paused).toBe(false);
    expect(f.calls).not.toContain('keyboard.lock');
    expect(f.calls).not.toContain('fullscreen');
    expect(f.notices).toEqual([]);
  }
});

test('desktop captures the keyboard only in fullscreen; touch requests neither capture', async () => {
  const desktop = fixture(); desktop.document.fullscreenElement = desktop.document.documentElement;
  desktop.showScreen('game'); desktop.calls.length = 0; desktop.lockPointer(); await Promise.resolve();
  expect(desktop.calls.filter(call => ['pointer.lock', 'keyboard.lock', 'fullscreen'].includes(call))).toEqual(['pointer.lock', 'keyboard.lock']);
  const touch = fixture({ touch: true }); touch.showScreen('game'); touch.setPaused(true); touch.calls.length = 0; touch.lockPointer();
  expect(touch.state.paused).toBe(false);
  expect(touch.calls).not.toContain('pointer.lock');
  expect(touch.calls).not.toContain('keyboard.lock');
  expect(touch.calls).not.toContain('fullscreen');
});

test.each([{ keyboard: 'unsupported' }, { keyboard: 'reject' }, { fullscreen: 'unsupported' }, { fullscreen: 'reject' }] as const)('windowed gameplay does not request optional APIs or show capture warnings with %j', async options => {
  const f = fixture(options); f.showScreen('game');
  expect(() => f.lockPointer()).not.toThrow();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.notices).toEqual([]);
  expect(f.calls).not.toContain('keyboard.lock');
  expect(f.calls).not.toContain('fullscreen');
  expect(f.document.pointerLockElement).toBe(f.canvas);
  expect(f.state.paused).toBe(false);
});

test.each(['unsupported', 'reject'] as const)('fullscreen keyboard API %s is handled without breaking the game', async keyboard => {
  const f = fixture({ keyboard }); f.document.fullscreenElement = f.document.documentElement; f.showScreen('game');
  expect(() => f.lockPointer()).not.toThrow();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.notices.length).toBeGreaterThan(0);
  expect(f.document.pointerLockElement).toBe(f.canvas);
  expect(f.state.paused).toBe(false);
});

test('Options toggles fullscreen only on demand and keeps the menu open', async () => {
  const f = fixture(); f.showScreen('game'); f.setPaused(true); f.calls.length = 0;
  const button = f.element('fullscreen-button');
  expect(button.disabled).toBe(false);
  emit(button, 'click'); await Promise.resolve();
  expect(f.document.fullscreenElement).toBe(f.document.documentElement);
  expect(button.textContent).toBe('Exit fullscreen');
  expect(f.state.paused).toBe(true);
  expect(f.calls).toEqual(['fullscreen']);
  emit(button, 'click'); await Promise.resolve();
  expect(f.document.fullscreenElement).toBeNull();
  expect(button.textContent).toBe('Fullscreen');
  expect(f.calls).toContain('fullscreen.exit');
  expect(f.state.paused).toBe(true);
  expect(f.notices).toEqual([]);
});

test('leaving fullscreen externally updates Options and resuming stays windowed', async () => {
  const f = fixture(); f.showScreen('game'); f.setPaused(true);
  emit(f.element('fullscreen-button'), 'click'); await Promise.resolve();
  f.lockPointer(); await Promise.resolve();
  await f.document.exitFullscreen();
  expect(f.element('fullscreen-button').textContent).toBe('Fullscreen');
  expect(f.state.paused).toBe(true);
  expect(f.document.pointerLockElement).toBeNull();
  f.calls.length = 0; f.lockPointer(); await Promise.resolve();
  expect(f.document.fullscreenElement).toBeNull();
  expect(f.calls).not.toContain('fullscreen');
  expect(f.calls).not.toContain('keyboard.lock');
  expect(f.state.paused).toBe(false);
});

test('Options handles a refused fullscreen request without leaving the menu', async () => {
  const f = fixture({ fullscreen: 'reject' }); f.showScreen('game'); f.setPaused(true); f.calls.length = 0;
  emit(f.element('fullscreen-button'), 'click');
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.document.fullscreenElement).toBeNull();
  expect(f.state.paused).toBe(true);
  expect(f.calls).toEqual(['fullscreen']);
  expect(f.notices.length).toBe(1);
});

test('Options disables fullscreen when the browser has no fullscreen API', () => {
  const f = fixture({ fullscreen: 'unsupported' });
  expect(f.element('fullscreen-button').disabled).toBe(true);
  expect(f.calls).toEqual([]);
  expect(f.notices).toEqual([]);
});

test.each(['lobby', 'blur', 'pause', 'fullscreen exit'])('keyboard permission resolving after %s is released again', async transition => {
  let resolve!: () => void;
  const permission = new Promise<void>(done => { resolve = done; });
  const f = fixture({ keyboardLock: () => permission }); f.document.fullscreenElement = f.document.documentElement; f.showScreen('game'); f.lockPointer();
  if (transition === 'lobby') f.showScreen('lobby');
  else if (transition === 'pause') f.setPaused(true);
  else if (transition === 'fullscreen exit') await f.document.exitFullscreen();
  else { f.document.focused = false; emit(f.window, 'blur'); }
  f.calls.length = 0;
  resolve(); await Promise.resolve();
  expect(f.calls).toContain('keyboard.unlock');
});

test.each(['death', 'killcam'])('keyboard permission resolving after Escape in %s is released again', async screen => {
  let resolve!: () => void;
  const permission = new Promise<void>(done => { resolve = done; });
  const f = fixture({ keyboardLock: () => permission }); f.document.fullscreenElement = f.document.documentElement; f.showScreen(screen); f.lockPointer();
  f.key('keydown', 'Escape');
  f.calls.length = 0;
  resolve(); await Promise.resolve();
  expect(f.calls).toContain('keyboard.unlock');
});

test('an older keyboard permission resolving during a new capture does not cancel it', async () => {
  const approvals: (() => void)[] = [];
  const f = fixture({ keyboardLock: () => new Promise<void>(resolve => approvals.push(resolve)) });
  f.document.fullscreenElement = f.document.documentElement;
  f.showScreen('game'); f.lockPointer();
  f.key('keydown', 'Escape'); f.lockPointer();
  f.calls.length = 0;
  approvals[0](); await Promise.resolve();
  approvals[1](); await Promise.resolve();
  expect(f.calls).not.toContain('keyboard.unlock');
  expect(f.document.pointerLockElement).toBe(f.canvas);
  expect(f.state.paused).toBe(false);
});

test('resuming keeps keyboard capture when its permission resolves before pointer capture', async () => {
  let resolvePointer!: () => void;
  const pointerPermission = new Promise<void>(resolve => { resolvePointer = resolve; });
  const f = fixture(); f.document.fullscreenElement = f.document.documentElement; f.showScreen('game'); f.setPaused(true);
  f.canvas.requestPointerLock = () => { f.calls.push('pointer.lock'); return pointerPermission; };
  f.calls.length = 0;
  f.lockPointer(); await Promise.resolve();
  expect(f.state.paused).toBe(true);
  expect(f.document.pointerLockElement).toBeNull();
  expect(f.calls).toContain('keyboard.lock');
  expect(f.calls).not.toContain('keyboard.unlock');
  f.document.pointerLockElement = f.canvas;
  emit(f.document, 'pointerlockchange');
  resolvePointer(); await Promise.resolve();
  expect(f.state.paused).toBe(false);
  expect(f.calls).not.toContain('keyboard.unlock');
  f.key('keydown', 'ControlLeft'); f.key('keydown', 'Tab', { ctrlKey: true });
  expect(f.state.keys.has('ControlLeft')).toBe(true);
  expect(f.element('score-screen').hidden).toBe(false);
});
