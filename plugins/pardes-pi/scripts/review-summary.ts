import { closeSync, mkdtempSync, openSync, readSync, rmSync, statSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const diagnosticByteLimit = 8 * 1024;
const diagnosticLineLimit = 40;
const previewByteLimit = 8 * 1024;
const previewLineLimit = 6;
const previewLineCharacterLimit = 120;
const usage = 'usage: bun run review:summary -- --base <sha>';
// biome-ignore lint/suspicious/noControlCharactersInRegex: Review diagnostics intentionally replace unsafe control ranges.
const DIAGNOSTIC_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

type LoggedCommand = {
  readonly label: string;
  readonly logPath: string;
  readonly exitCode: number;
};

type ParsedArguments = { readonly kind: 'help' } | { readonly kind: 'run'; readonly base: string };

const parseArguments = (arguments_: ReadonlyArray<string>): ParsedArguments => {
  const normalizedArguments = arguments_[0] === '--' ? arguments_.slice(1) : arguments_;

  if (
    normalizedArguments.length === 1 &&
    (normalizedArguments[0] === '--help' || normalizedArguments[0] === '-h')
  ) {
    return { kind: 'help' };
  }

  if (normalizedArguments.length !== 2 || normalizedArguments[0] !== '--base') {
    console.error(usage);
    process.exit(2);
  }

  const base = normalizedArguments[1];
  if (base === undefined || !/^[0-9a-f]{7,64}$/i.test(base)) {
    console.error('review: --base must be an abbreviated or full hexadecimal commit SHA');
    console.error(usage);
    process.exit(2);
  }

  return { base, kind: 'run' };
};

const redactCredentials = (text: string): string =>
  text
    .replace(/\b(authorization\s*:\s*(?:bearer|basic)\s+)[^\s]+/gi, '$1[redacted]')
    .replace(
      /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[=:]\s*)[^\s]+/gi,
      '$1[redacted]',
    )
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[redacted]');

const sanitizeDiagnostic = (text: string): string =>
  redactCredentials(text).replace(DIAGNOSTIC_CONTROL_CHARACTERS, '?');

const readSlice = (path: string, start: number, byteLength: number): string => {
  if (byteLength === 0) return '';

  const fileDescriptor = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(byteLength);
    const bytesRead = readSync(fileDescriptor, buffer, 0, byteLength, start);
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    closeSync(fileDescriptor);
  }
};

const readDiagnosticTail = (path: string): string => {
  const size = statSync(path).size;
  const start = Math.max(0, size - diagnosticByteLimit);
  return sanitizeDiagnostic(readSlice(path, start, size - start))
    .split('\n')
    .slice(-diagnosticLineLimit)
    .join('\n')
    .trimEnd();
};

const readSmallOutput = (path: string): string | undefined => {
  const size = statSync(path).size;
  if (size > previewByteLimit) return undefined;
  return readSlice(path, 0, size).trim();
};

const summarizePathLog = (path: string): string => {
  const size = statSync(path).size;
  const bytesToRead = Math.min(size, previewByteLimit);
  let preview = readSlice(path, 0, bytesToRead);
  let wasTruncated = size > bytesToRead;

  if (wasTruncated) {
    const finalNewlineIndex = preview.lastIndexOf('\n');
    preview = finalNewlineIndex === -1 ? '' : preview.slice(0, finalNewlineIndex);
  }

  const lines = preview.split('\n').filter((line) => line.length > 0);
  if (lines.length > previewLineLimit) wasTruncated = true;

  const visibleLines = lines.slice(0, previewLineLimit).map((line) => {
    const sanitizedLine = sanitizeDiagnostic(line).replace(/\t+/g, ' ');
    return sanitizedLine.length <= previewLineCharacterLimit
      ? sanitizedLine
      : `${sanitizedLine.slice(0, previewLineCharacterLimit - 1)}…`;
  });

  if (visibleLines.length === 0) {
    return wasTruncated ? 'changed paths (bounded): … (more omitted)' : 'changed paths (0): (none)';
  }

  const count = wasTruncated ? 'bounded' : String(lines.length);
  const suffix = wasTruncated ? '; … (more omitted)' : '';
  return `changed paths (${count}): ${visibleLines.join('; ')}${suffix}`;
};

const summarizeDirtyWorktree = (path: string): string => {
  const size = statSync(path).size;
  const bytesToRead = Math.min(size, previewByteLimit);
  const preview = readSlice(path, 0, bytesToRead);
  const lineCount = preview.split('\n').filter((line) => line.length > 0).length;
  return size > bytesToRead
    ? `worktree dirty (at least ${lineCount} paths)`
    : `worktree dirty (${lineCount} paths)`;
};

const arguments_ = parseArguments(process.argv.slice(2));
if (arguments_.kind === 'help') {
  console.log(usage);
} else {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'pardes-review-'));

  const runLogged = async (
    label: string,
    command: ReadonlyArray<string>,
  ): Promise<LoggedCommand> => {
    const logPath = join(tempDirectory, `${label}.log`);
    const logFileDescriptor = openSync(logPath, 'w');

    try {
      try {
        const child = Bun.spawn([...command], {
          stderr: logFileDescriptor,
          stdin: 'ignore',
          stdout: logFileDescriptor,
        });
        return { exitCode: await child.exited, label, logPath };
      } catch (error) {
        writeSync(
          logFileDescriptor,
          `unable to spawn ${command[0] ?? 'process'}: ${String(error)}\n`,
        );
        return { exitCode: 1, label, logPath };
      }
    } finally {
      closeSync(logFileDescriptor);
    }
  };

  const printDiagnostic = (command: LoggedCommand): void => {
    console.error(`${command.label}: failed with exit code ${command.exitCode}; diagnostic tail:`);
    console.error(readDiagnosticTail(command.logPath) || '(no output)');
    console.error(`${command.label}: full log: ${command.logPath}`);
  };

  const resolveCommit = async (
    label: string,
    revision: string,
  ): Promise<string | LoggedCommand> => {
    const command = await runLogged(label, [
      'git',
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${revision}^{commit}`,
    ]);
    if (command.exitCode !== 0) return command;

    const output = readSmallOutput(command.logPath);
    return output !== undefined && /^[0-9a-f]{40,64}$/i.test(output)
      ? output
      : { ...command, exitCode: 1 };
  };

  const failResolution = (command: LoggedCommand): void => {
    console.error(`review: unable to resolve ${command.label}`);
    printDiagnostic(command);
    console.error(`review: retained logs: ${tempDirectory}`);
    process.exitCode = command.exitCode;
  };

  const base = await resolveCommit('base', arguments_.base);
  if (typeof base !== 'string') {
    failResolution(base);
  } else {
    const head = await resolveCommit('HEAD', 'HEAD');
    if (typeof head !== 'string') {
      failResolution(head);
    } else {
      const range = `${base}...${head}`;
      const ready = await runLogged('ready', ['bun', 'run', 'ready']);
      const diffCheck = await runLogged('diff-check', [
        'git',
        'diff',
        '--check',
        '--no-ext-diff',
        range,
        '--',
      ]);
      const worktree = await runLogged('worktree', [
        'git',
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
      ]);
      const changedPaths = await runLogged('changed-paths', [
        'git',
        'diff',
        '--name-status',
        '--find-renames',
        '--no-ext-diff',
        range,
        '--',
      ]);
      const worktreeIsDirty = worktree.exitCode === 0 && statSync(worktree.logPath).size > 0;
      const checkSummary = [
        ready.exitCode === 0 ? 'ready passed' : `ready failed (exit ${ready.exitCode})`,
        diffCheck.exitCode === 0
          ? 'diff-check passed'
          : `diff-check failed (exit ${diffCheck.exitCode})`,
        worktree.exitCode !== 0
          ? `worktree check failed (exit ${worktree.exitCode})`
          : worktreeIsDirty
            ? summarizeDirtyWorktree(worktree.logPath)
            : 'worktree clean',
      ];

      if (changedPaths.exitCode !== 0)
        checkSummary.push(`changed-path check failed (exit ${changedPaths.exitCode})`);

      console.log(`review: HEAD ${head}; base ${base}`);
      console.log(`checks: ${checkSummary.join('; ')}`);
      console.log(
        changedPaths.exitCode === 0
          ? summarizePathLog(changedPaths.logPath)
          : 'changed paths: unavailable',
      );

      const failedCommands = [ready, diffCheck, worktree, changedPaths].filter(
        (command) => command.exitCode !== 0,
      );
      const exitCode = failedCommands[0]?.exitCode ?? (worktreeIsDirty ? 1 : 0);

      if (exitCode === 0) {
        rmSync(tempDirectory, { recursive: true });
      } else {
        for (const command of failedCommands) printDiagnostic(command);
        if (worktreeIsDirty) {
          console.error('worktree: diagnostic tail:');
          console.error(readDiagnosticTail(worktree.logPath) || '(no output)');
          console.error(`worktree: full log: ${worktree.logPath}`);
        }
        console.error(`review: retained logs: ${tempDirectory}`);
        process.exitCode = exitCode;
      }
    }
  }
}
