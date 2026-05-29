// investigate — answer a research/architecture question read-only: fan out
// reader agents over different angles, synthesize, then run a completeness
// critic that flags fabricated citations, unread surfaces, and missing angles.
// Bounded one extra round if the critic finds real gaps.
//
// Every agent here is READ-ONLY, so this is safe to run anywhere — no isolation
// needed and nothing is written except the final report file.
//
// Lean-context discipline: readers distill, the synthesis writes the full report
// to a file, and only a tight briefing + the file path come back. Big artifacts
// stay on disk, out of the caller's context.
//
// args: a question string, or { question, angles?, roots?, reportPath? }.
//   - question   (required) the research question, in generic terms.
//   - angles     (optional) explicit angles to fan over; otherwise derived from
//                the question.
//   - roots      (optional) paths/areas to scope the readers to.
//   - reportPath (optional) where to write the full report; default below.

export const meta = {
  description:
    'Read-only investigation: fan out reader agents over several angles, synthesize, then run a completeness critic that flags fabricated citations and unread surfaces (bounded re-fan). Writes a full report to a file and returns only a tight briefing + the path.',
  name: 'investigate',
  phases: [
    { detail: 'Parallel read-only readers cover distinct angles.', title: 'Fan-out read' },
    { detail: 'Merge findings and write the full report to a file.', title: 'Synthesize' },
    { detail: 'A completeness critic flags gaps and suspect citations.', title: 'Critique' },
  ],
  whenToUse:
    'Use to answer a research or architecture question over a codebase or doc set without writing anything — and to get an honest read on how complete the answer is.',
};

const question = typeof args === 'string' ? args : args?.question;
const explicitAngles = (typeof args === 'object' && args?.angles) || null;
const roots = (typeof args === 'object' && args?.roots) || [];
const reportPath = (typeof args === 'object' && args?.reportPath) || 'investigation-report.md';

if (!question) {
  log('No question provided. Pass a question string or { question, ... }.');
  return { error: 'missing-question' };
}

const scope = roots.length
  ? `Scope your reading to: ${roots.join(', ')}.`
  : 'Find the relevant surfaces yourself.';

// Pick fan-out angles: caller-supplied, else a small generic spread.
const angles = explicitAngles || [
  'Where this lives and how it is structured (entry points, key files).',
  'How it actually behaves at runtime (data flow, edge cases, failure modes).',
  'Its contracts and dependents — who relies on it and what would break.',
  'History, docs, and tests — what is documented vs. what the code really does.',
];

const completenessSchema = {
  additionalProperties: false,
  properties: {
    confidence: { enum: ['high', 'medium', 'low'] },
    missingAngles: { items: { type: 'string' }, type: 'array' },
    suspectCitations: { items: { type: 'string' }, type: 'array' },
    unreadSurfaces: { items: { type: 'string' }, type: 'array' },
  },
  required: ['confidence', 'unreadSurfaces', 'suspectCitations', 'missingAngles'],
  type: 'object',
};

phase('Fan-out read');
// parallel() takes an array of thunks (() => agent(...)), not bare promises.
let readings = await parallel(
  angles.map(
    (angle, i) => () =>
      agent(
        `READ-ONLY. Investigate one angle of the question below. ${scope}\n` +
          `Cite exact file paths and line ranges for every claim — never invent a citation.\n` +
          `Return a distilled findings list, not raw file dumps.\n\n` +
          `QUESTION: ${question}\n\nANGLE: ${angle}`,
        { label: `reader-${i + 1}`, phase: 'Fan-out read' },
      ),
  ),
);

async function synthesize(extraGaps) {
  phase('Synthesize');
  return await agent(
    `Synthesize the reader findings into one coherent answer to the question, then\n` +
      `WRITE the full report (with citations) to the file "${reportPath}". Keep only a\n` +
      `tight 8–15 line briefing in your reply; the long form lives in the file.\n` +
      (extraGaps
        ? `Close these previously-missed gaps too:\n${JSON.stringify(extraGaps, null, 2)}\n`
        : '') +
      `\nQUESTION: ${question}\n\nREADER FINDINGS:\n${JSON.stringify(readings, null, 2)}`,
    { label: 'synthesis', phase: 'Synthesize' },
  );
}

let briefing = await synthesize(null);

phase('Critique');
const completeness = await agent(
  `Adversarially judge whether the report at "${reportPath}" actually reads its sources.\n` +
    `READ-ONLY. Flag fabricated/unverifiable citations, surfaces that should have been read\n` +
    `but were not, and angles of the question left unaddressed. Be specific.\n\n` +
    `QUESTION: ${question}\n\nBRIEFING:\n${briefing}`,
  { label: 'completeness-critic', phase: 'Critique', schema: completenessSchema },
);

// One bounded extra round if the critic found real, closeable gaps.
const gaps = [...(completeness.unreadSurfaces || []), ...(completeness.missingAngles || [])];
if (gaps.length && completeness.confidence !== 'high') {
  phase('Fan-out read (gap round)');
  readings = await parallel(
    gaps.slice(0, 4).map(
      (gap, i) => () =>
        agent(
          `READ-ONLY. Close this specific gap from a completeness review of the question.\n` +
            `Cite exact paths/lines. Distill.\n\nQUESTION: ${question}\n\nGAP: ${gap}`,
          { label: `gap-reader-${i + 1}`, phase: 'Fan-out read' },
        ),
    ),
  );
  briefing = await synthesize(gaps);
}

return { briefing, completeness, reportPath };
