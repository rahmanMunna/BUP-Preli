import { describe, expect, it } from 'vitest';
import { JsonRepairError, parseJsonLoose } from './json-repair.js';

describe('parseJsonLoose', () => {
  it('parses clean JSON', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
  });

  it('unwraps markdown code fences', () => {
    const text = '```json\n{"interpretations":[]}\n```';
    expect(parseJsonLoose(text)).toEqual({ interpretations: [] });
  });

  it('ignores prose around the JSON body', () => {
    const text = 'Sure! Here is the result:\n{"note_index":0}\nLet me know.';
    expect(parseJsonLoose(text)).toEqual({ note_index: 0 });
  });

  it('removes trailing commas', () => {
    expect(parseJsonLoose('{"hours":[13,14,],"factor":0.2,}')).toEqual({
      hours: [13, 14],
      factor: 0.2,
    });
  });

  it('normalises Python literals', () => {
    expect(parseJsonLoose('{"applies":True,"extra":None}')).toEqual({
      applies: true,
      extra: null,
    });
  });

  it('keeps braces that live inside strings', () => {
    expect(parseJsonLoose('{"explanation":"use {curly} braces"}')).toEqual({
      explanation: 'use {curly} braces',
    });
  });

  it('throws a typed error when nothing is salvageable', () => {
    expect(() => parseJsonLoose('no json here at all')).toThrow(
      JsonRepairError,
    );
  });
});
