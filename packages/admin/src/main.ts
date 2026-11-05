#!/usr/bin/env node
/** `kantel-admin`: runs the operator command line with this process's arguments, and exits with its code. */
import { runAdmin } from "./admin.ts";

process.exitCode = await runAdmin(process.argv.slice(2));
