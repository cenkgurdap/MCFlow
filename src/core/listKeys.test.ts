import { describe, expect, it } from 'vitest';
import { isActivateKey, nextFocus, typingIn } from './listKeys';

const rows = ['a', 'b', 'c', 'd'];

describe('nextFocus', () => {
  it('steps down and up', () => {
    expect(nextFocus('ArrowDown', rows, 'b')).toBe('c');
    expect(nextFocus('ArrowUp', rows, 'b')).toBe('a');
  });

  it('clamps at both ends rather than wrapping', () => {
    // Wrapping would silently drag a Shift-range across the whole list at the
    // moment the key stopped doing what it had been doing.
    expect(nextFocus('ArrowDown', rows, 'd')).toBe('d');
    expect(nextFocus('ArrowUp', rows, 'a')).toBe('a');
  });

  it('lands on an end when there is no cursor yet', () => {
    expect(nextFocus('ArrowDown', rows, null)).toBe('a');
    expect(nextFocus('ArrowUp', rows, null)).toBe('d');
  });

  it('treats a cursor that has been filtered away as no cursor', () => {
    expect(nextFocus('ArrowDown', ['c', 'd'], 'a')).toBe('c');
  });

  it('takes Home and End', () => {
    expect(nextFocus('Home', rows, 'c')).toBe('a');
    expect(nextFocus('End', rows, 'b')).toBe('d');
  });

  it('is null for a key the list does not handle', () => {
    expect(nextFocus('ArrowLeft', rows, 'b')).toBeNull();
    expect(nextFocus('a', rows, 'b')).toBeNull();
  });

  it('has nowhere to go in an empty list', () => {
    expect(nextFocus('ArrowDown', [], null)).toBeNull();
    expect(nextFocus('Home', [], null)).toBeNull();
  });
});

describe('isActivateKey', () => {
  it('is Space and Enter, and nothing else', () => {
    expect(isActivateKey(' ')).toBe(true);
    expect(isActivateKey('Enter')).toBe(true);
    expect(isActivateKey('ArrowDown')).toBe(false);
  });
});

describe('typingIn', () => {
  const el = (tag: string, editable = false) => ({
    tagName: tag, isContentEditable: editable,
  }) as unknown as EventTarget;

  it('is true for the fields a row can contain', () => {
    expect(typingIn(el('INPUT'))).toBe(true);
    expect(typingIn(el('TEXTAREA'))).toBe(true);
    expect(typingIn(el('DIV', true))).toBe(true);
  });

  it('and false for the row itself', () => {
    expect(typingIn(el('DIV'))).toBe(false);
    expect(typingIn(null)).toBe(false);
  });
});
