#!/usr/bin/env bun

import { runFeedbackCli } from '../extensions/pardes/feedback/index.ts';

process.exitCode = await runFeedbackCli(process.argv.slice(2));
