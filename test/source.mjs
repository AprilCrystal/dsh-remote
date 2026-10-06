/**
 * Read one plugin source file for a source-level assertion, with line endings
 * normalized to LF.
 *
 * These suites match multi-line patterns with `\n`, and that is the right thing
 * for them to match — but a checkout with `core.autocrlf=true` writes CRLF, and
 * then seven multi-line assertions failed for a reason that had nothing to do
 * with the code under test. Normalizing here means these tests describe the code
 * rather than the checkout that produced it.
 *
 * `.gitattributes` pins the repository to LF as well, so this is the second of two
 * guards rather than the only one.
 */

import { readFileSync } from 'node:fs'

/** @param url - a file URL. @returns its text with CRLF collapsed to LF. */
export function readNormalized(url) {
  return readFileSync(url, 'utf8').replace(/\r\n/gu, '\n')
}
