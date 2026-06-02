import { describe, expect, test } from 'vitest';
import {
  CONTROL_PLANE_MAX_TEXT_LENGTH,
  completeOrOmittedText,
  structuralRows,
  structuralValue,
} from './core.ts';

describe('model-visible structural row budgeting', () => {
  test('reserves authored orientation, omission metadata, and retrieval hints without slicing an identifier row', () => {
    const identifier = `report-${'a'.repeat(CONTROL_PLANE_MAX_TEXT_LENGTH)}`;
    const text = structuralRows(
      {
        authoredLines: ['reports: bounded index'],
        itemLines: [`reportId:${identifier}`],
        retrievalHintLines: ['retrieve: report_get({ reportId })'],
      },
      1,
    );

    expect(text).toBe(
      ['reports: bounded index', '… 1 more row omitted', 'retrieve: report_get({ reportId })'].join(
        '\n',
      ),
    );
    expect(text).not.toContain(identifier.slice(0, 80));
    expect(text.length).toBeLessThanOrEqual(CONTROL_PLANE_MAX_TEXT_LENGTH);
  });

  test('admits or omits a logical multi-row record as one complete group', () => {
    const text = structuralRows(
      {
        authoredLines: ['reviews: 1 open'],
        itemLines: [['#42 [open]', '↳ #42 watcher diagnosis']],
        retrievalHintLines: ['bounds: first 12 reviews'],
      },
      3,
    );

    expect(text).toBe(
      ['reviews: 1 open', '… 2 more rows omitted', 'bounds: first 12 reviews'].join('\n'),
    );
    expect(text).not.toContain('#42');
  });

  test('renders structural values whole and replaces oversized diagnostics explicitly', () => {
    expect(structuralValue('refs/heads/worker-branch')).toBe('refs/heads/worker-branch');
    expect(structuralValue('src/line\nbreak.ts')).toBe('"src/line\\nbreak.ts"');
    expect(completeOrOmittedText(`failure ${'x'.repeat(80)}`, 32)).toBe(
      '<omitted oversized text: 88 chars>',
    );
  });
});
