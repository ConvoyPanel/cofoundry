import { readFileSync } from 'node:fs'

/**
 * Read the entire piped registry document from fd 0. Drains the pipe.
 *
 * Note on piped-registry + interactive selection: a piped registry occupies
 * stdin, leaving clack no keyboard. That combination can't work, so main.ts
 * rejects it with guidance (use an inline-arg registry for interactive, or
 * --all/--select to stay piped). This read path is for the non-interactive
 * piped case.
 */
export const readStdinSync = (): string => readFileSync(0, 'utf8')
