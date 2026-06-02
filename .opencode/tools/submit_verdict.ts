import { appendFileSync } from 'node:fs';
import { tool } from '@opencode-ai/plugin';

const bullet = tool.schema
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine((value) => !value.includes('\n') && !value.includes('\r'), 'Bullet must be one line');

const verdict = tool.schema
  .object({
    added: tool.schema.array(bullet).max(3),
    bump: tool.schema.enum(['patch', 'minor', 'major']),
    changed: tool.schema.array(bullet).max(3),
    fixed: tool.schema.array(bullet).max(3),
    removed: tool.schema.array(bullet).max(3),
  })
  .strict();

export default tool({
  args: { verdict },
  description:
    'Submit the final release verdict. This is your only tool. Call it exactly once with one to three total changelog bullets.',
  async execute(args, context) {
    const total =
      args.verdict.added.length +
      args.verdict.changed.length +
      args.verdict.fixed.length +
      args.verdict.removed.length;
    if (total < 1 || total > 3)
      throw new Error(`Verdict must contain one to three bullets total; got ${total}`);

    await context.ask({
      always: ['*'],
      metadata: {},
      patterns: ['*'],
      permission: 'submit_verdict',
    });

    const file = process.env.PARDES_VERDICT_FILE;
    if (!file) throw new Error('PARDES_VERDICT_FILE missing');
    appendFileSync(file, `${JSON.stringify({ agent: context.agent, verdict: args.verdict })}\n`);
    return 'Verdict submitted. End your response.';
  },
});
