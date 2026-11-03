#!/usr/bin/env node
/** `kantel`: runs the command line with this process's arguments and streams, and exits with its code. */
import { run } from "./commands.ts";

process.exitCode = await run(process.argv.slice(2));
