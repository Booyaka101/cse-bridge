import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';

/**
 * A subcommand's options and paths, by node:util parseArgs in strict mode. A bad argument
 * comes back as `problem`, Node's description of it, for the command to print above its
 * usage.
 */
export function parseCommand<T extends ParseArgsOptionsConfig>(argv: string[], options: T) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (err) {
    if (!(err as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS_')) throw err;
    return { problem: (err as Error).message };
  }
}
