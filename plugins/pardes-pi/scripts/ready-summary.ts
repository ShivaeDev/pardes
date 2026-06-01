import { closeSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tailByteLimit = 8 * 1024;
const tailLineLimit = 40;
const tempDirectory = mkdtempSync(join(tmpdir(), 'pardes-ready-'));
const logPath = join(tempDirectory, 'ready.log');
const logFileDescriptor = openSync(logPath, 'w');

let exitCode: number;
try {
  const ready = Bun.spawn(['bun', 'run', 'ready'], {
    stderr: logFileDescriptor,
    stdin: 'inherit',
    stdout: logFileDescriptor,
  });
  exitCode = await ready.exited;
} finally {
  closeSync(logFileDescriptor);
}

if (exitCode === 0) {
  rmSync(tempDirectory, { recursive: true });
  console.log('ready: passed');
} else {
  const log = Bun.file(logPath);
  const tailStart = Math.max(0, log.size - tailByteLimit);
  const tail = (await log.slice(tailStart).text())
    .split('\n')
    .slice(-tailLineLimit)
    .join('\n')
    .trimEnd();

  console.error(`ready: failed with exit code ${exitCode}; diagnostic tail:`);
  console.error(tail || '(no output)');
  console.error(`ready: full log: ${logPath}`);
  process.exit(exitCode);
}
