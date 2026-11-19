/**
 * Git Bash on Windows needs POSIX-style paths in scripts, env vars and argv:
 * `C:\Users\…\Temp\x` arrives as escapes, not a path. A no-op elsewhere.
 */
export const bashPath = (p: string): string =>
    process.platform === 'win32'
        ? p
              .replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`)
              .replace(/\\/g, '/')
        : p
