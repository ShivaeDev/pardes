import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Key } from '@earendil-works/pi-tui';
import { Effect } from 'effect';
import {
  formatPardesError,
  ManagerController,
  managerGuidanceReasonForSessionStart,
  queueManagerGuidance,
  registerManagerCompactionStrategy,
} from './manager/index.ts';
import { registerManagerPresentation } from './presentation/index.ts';
import {
  registerAgentTools,
  registerQuestionTool,
  registerWorkstreamTools,
} from './tools/index.ts';

export function isNormalUserInputSource(source: 'interactive' | 'rpc' | 'extension'): boolean {
  return source !== 'extension';
}

async function runCommand<A>(
  ctx: ExtensionContext,
  effect: Effect.Effect<A, unknown>,
): Promise<A | undefined> {
  try {
    return await Effect.runPromise(effect);
  } catch (error) {
    ctx.ui.notify(formatPardesError(error), 'error');
    return undefined;
  }
}

export default function pardes(pi: ExtensionAPI): void {
  const presentation = registerManagerPresentation(pi);
  const manager = new ManagerController(pi, { presentation });
  registerQuestionTool(pi);
  registerWorkstreamTools(pi, manager);
  registerAgentTools(pi, manager);

  pi.registerCommand('pardes', {
    description:
      'Open the Pardes dashboard, or use /pardes start, /pardes stop, and /pardes monitor',
    handler: async (args, ctx) => {
      const [action] = args.trim().split(/\s+/, 1);
      if (action === 'start') {
        const state = await runCommand(ctx, manager.activate(ctx));
        if (state) {
          queueManagerGuidance(pi, state, manager.runtimeSnapshots(), 'activated');
          ctx.ui.notify(`Pardes manager activated: ${state.managerId}`, 'info');
        }
        return;
      }
      if (action === 'stop') {
        const state = manager.snapshot();
        const stopped = await runCommand(ctx, manager.deactivate(ctx));
        if (stopped !== undefined || state)
          ctx.ui.notify(`Pardes manager stopped${state ? `: ${state.managerId}` : ''}`, 'info');
        return;
      }
      if (action === 'monitor') {
        const result = presentation.toggleBridgeMonitor(
          ctx,
          manager.snapshot(),
          manager.runtimeSnapshots(),
        );
        ctx.ui.notify(
          result === 'unavailable'
            ? 'Pardes bridge monitor is unavailable without an attached worker.'
            : `Pardes bridge monitor ${result}.`,
          result === 'unavailable' ? 'warning' : 'info',
        );
        return;
      }
      if (action) {
        ctx.ui.notify('Usage: /pardes, /pardes start, /pardes stop, or /pardes monitor', 'warning');
        return;
      }
      await presentation.showDashboardOverlay(ctx, manager.snapshot(), manager.runtimeSnapshots());
    },
  });

  pi.registerShortcut(Key.ctrlAlt('d'), {
    description: 'Open Pardes dashboard',
    handler: async (ctx) =>
      presentation.showDashboardOverlay(ctx, manager.snapshot(), manager.runtimeSnapshots()),
  });

  pi.on('session_start', async (event, ctx) => {
    const state = await runCommand(ctx, manager.restore(ctx));
    if (state) {
      queueManagerGuidance(
        pi,
        state,
        manager.runtimeSnapshots(),
        managerGuidanceReasonForSessionStart(event.reason),
      );
      // Loaded/rebound session_start remains a lifecycle retry edge. Durable
      // inbox state, not a former transient hold, decides whether one
      // presentation cursor is still due.
      manager.scheduleInboxWakeAfterIdle(ctx);
    }
  });

  pi.on('agent_end', (_event, ctx) => {
    manager.scheduleInboxWakeAfterIdle(ctx);
  });

  // Pi 0.75.5 exposes the supported raw `input` event before normal agent
  // processing. Extension-injected prompts are excluded: only the next normal
  // interactive/RPC user message after an explicitly surfaced handoff resolves
  // that one presented cursor.
  pi.on('input', async (event, ctx) => {
    if (!isNormalUserInputSource(event.source) || !manager.isActive())
      return { action: 'continue' };
    await runCommand(ctx, manager.acknowledgeInboxAfterHandoff(ctx));
    return { action: 'continue' };
  });

  registerManagerCompactionStrategy(pi, manager);

  pi.on('session_compact', (_event, ctx) => {
    manager.observeCompactionSuccess(ctx);
    // Pi 0.75.5 has no extension-facing compaction_end hook. The controller
    // schedules its generation-checked success settlement attempt for the next
    // macrotask; keep this bounded next-turn reminder separate from wake retry.
    queueManagerGuidance(pi, manager.snapshot(), manager.runtimeSnapshots(), 'compacted');
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    await runCommand(ctx, manager.shutdown(ctx));
    presentation.clearDashboard(ctx);
  });
}
