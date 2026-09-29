/**
 * Timing ceilings of the corpus gates. The full analysis of the largest game file with the script
 * properties must stay under `fileCeilingMs`: 200 ms, unless `X4_FILE_CEILING_MS` allows more on a
 * slower or busy machine, so that a check is kept at the cost of speed rather than dropped. A patch
 * document, whose analysis includes the file it changes, gets twice the ceiling.
 */
const configured = Number(process.env.X4_FILE_CEILING_MS);

export const fileCeilingMs = Number.isFinite(configured) && configured > 0 ? configured : 200;

export const patchCeilingMs = 2 * fileCeilingMs;

/** The best time of some runs, in ms: the others share the machine with the other test files. */
export function bestOf(rounds: number, run: () => void): number {
  let best = Infinity;
  for (let round = 0; round < rounds; round++) {
    const started = performance.now();
    run();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}
