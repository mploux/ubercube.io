import { expect, test } from 'bun:test';
import { InputButton } from '../src/client/input-button';

test('a click shorter than one simulation tick preserves its press and release', () => {
  const button = new InputButton();
  button.set(true); button.set(false);
  expect([button.sample(), button.sample(), button.sample()]).toEqual([true, false, false]);
});

test('holding fires continuously and repeated DOM events do not create extra edges', () => {
  const button = new InputButton();
  button.set(true); button.set(true);
  expect([button.sample(), button.sample()]).toEqual([true, true]);
  button.set(false);
  expect(button.sample()).toBe(false);
});

test('consecutive quick clicks are distinct while focus loss cancels queued actions', () => {
  const button = new InputButton();
  button.set(true); button.set(false); button.set(true); button.set(false);
  expect([button.sample(), button.sample(), button.sample(), button.sample()]).toEqual([true, false, true, false]);
  button.set(true); button.set(false); button.clear();
  expect(button.sample()).toBe(false);
});
