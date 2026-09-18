import { beforeEach, describe, expect, it } from 'vitest';
import { DirectiveValidatorService } from './directive.validator.js';

const context = {
  horizonHours: Array.from({ length: 24 }, (_, hour) => hour),
  batteryCapacityKwh: 100,
};

describe('DirectiveValidatorService', () => {
  let validator: DirectiveValidatorService;

  beforeEach(() => {
    validator = new DirectiveValidatorService();
  });

  it('accepts a well formed solar_reduction directive', () => {
    const outcome = validator.validate(
      [
        {
          note_index: 0,
          applies: true,
          directive_type: 'solar_reduction',
          structured_adjustment: { hours: [13, 14], factor: 0.2 },
          explanation: 'Panels cleaned at 1pm and 2pm.',
        },
      ],
      ['Panel cleaning 1pm-3pm, expect 20% less output'],
      context,
    );

    expect(outcome.interpretations).toHaveLength(1);
    expect(outcome.directives).toHaveLength(1);
    expect(outcome.directives[0].structured_adjustment).toEqual({
      hours: [13, 14],
      factor: 0.2,
    });
  });

  it('returns exactly one interpretation per note, never skipping one', () => {
    const outcome = validator.validate(
      [{ note_index: 2, directive_type: 'no_op', structured_adjustment: {} }],
      ['first note', 'second note', 'third note'],
      context,
    );

    expect(outcome.interpretations.map((item) => item.note_index)).toEqual([
      0, 1, 2,
    ]);
    expect(outcome.missingNoteIndexes).toEqual([0, 1]);
    expect(outcome.interpretations[0].directive_type).toBe('no_op');
  });

  it('rejects an unsupported directive type and downgrades it to no_op', () => {
    const outcome = validator.validate(
      [
        {
          note_index: 0,
          applies: true,
          directive_type: 'shutdown_campus',
          structured_adjustment: { hours: [1] },
          explanation: 'invented directive',
        },
      ],
      ['do something creative'],
      context,
    );

    expect(outcome.interpretations[0].directive_type).toBe('no_op');
    expect(outcome.directives).toHaveLength(0);
    expect(outcome.rejectedNoteIndexes).toEqual([0]);
  });

  it('repairs duplicate and unsorted hours', () => {
    const outcome = validator.validate(
      [
        {
          note_index: 0,
          applies: true,
          directive_type: 'no_charge_window',
          structured_adjustment: { hours: [20, 18, 18, 19] },
          explanation: 'no charging in the evening peak',
        },
      ],
      ['do not charge during the evening peak'],
      context,
    );

    expect(outcome.directives[0].structured_adjustment).toEqual({
      hours: [18, 19, 20],
    });
    expect(outcome.issues.map((issue) => issue.severity)).toContain('warning');
  });

  it('rejects hours outside 0-23', () => {
    const outcome = validator.validate(
      [
        {
          note_index: 0,
          applies: true,
          directive_type: 'no_discharge_window',
          structured_adjustment: { hours: [24, 25] },
          explanation: 'bad hours',
        },
      ],
      ['some note'],
      context,
    );

    expect(outcome.directives).toHaveLength(0);
    expect(outcome.interpretations[0].applies).toBe(false);
  });

  it('rejects a non-numeric max_grid_window cap', () => {
    const outcome = validator.validate(
      [
        {
          note_index: 0,
          applies: true,
          directive_type: 'max_grid_window',
          structured_adjustment: { hours: [10], max_kwh: 'as low as possible' },
          explanation: 'cap the grid',
        },
      ],
      ['keep grid draw low at 10am'],
      context,
    );

    expect(outcome.directives).toHaveLength(0);
    expect(outcome.rejectedNoteIndexes).toEqual([0]);
  });

  it('converts a percentage reserve into kWh and clamps to capacity', () => {
    const outcome = validator.validate(
      [
        {
          note_index: 0,
          applies: true,
          directive_type: 'minimum_battery_reserve',
          structured_adjustment: { reserve_percent: 30 },
          explanation: 'keep 30% for the labs',
        },
      ],
      ['keep at least 30% of the battery for the labs'],
      context,
    );

    expect(outcome.directives[0].structured_adjustment).toEqual({
      reserve_kwh: 30,
    });
  });

  it('accepts a percentage written as 20 for a solar factor', () => {
    const outcome = validator.validate(
      [
        {
          note_index: 0,
          applies: true,
          directive_type: 'solar_reduction',
          structured_adjustment: { hours: [12], factor: 20 },
          explanation: '20 percent less solar',
        },
      ],
      ['expect 20% less solar at noon'],
      context,
    );

    expect(outcome.directives[0].structured_adjustment).toEqual({
      hours: [12],
      factor: 0.2,
    });
  });
});
