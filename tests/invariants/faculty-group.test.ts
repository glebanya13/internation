import { describe, expect, it } from 'vitest';
import { facultyForGroup, formatGroupCode } from '../../src/domain/facultyGroup.js';

describe('факультет по номеру группы', () => {
  it('группы 1–3 → ИСИТ', () => {
    expect(facultyForGroup(1)).toBe('ИСИТ');
    expect(facultyForGroup(3)).toBe('ИСИТ');
  });

  it('группы 4–5 → ЦД', () => {
    expect(facultyForGroup(4)).toBe('ЦД');
    expect(facultyForGroup(5)).toBe('ЦД');
  });

  it('группы 6–10 → ПИ', () => {
    expect(facultyForGroup(6)).toBe('ПИ');
    expect(facultyForGroup(10)).toBe('ПИ');
  });

  it('номер группы без курса', () => {
    expect(formatGroupCode(2, 3)).toBe('3');
    expect(formatGroupCode(3, 4)).toBe('4');
  });
});
