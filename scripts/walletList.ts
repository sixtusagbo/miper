import { readFileSync } from 'fs';

// Read an address/mint list file: one entry per line. Ignores blank lines,
// full-line comments (`# ...`) AND inline comments (`<entry>  # note`). The
// research files annotate addresses ("# early in N tokens"), so inline
// stripping is required or every annotated line fails to parse as base58.
export function readWalletList(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.split('#')[0].trim())
    .filter((l) => l.length > 0);
}
