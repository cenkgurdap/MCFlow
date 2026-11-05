/// <reference lib="webworker" />
import { UMAP } from 'umap-js';
import { seededRandom } from './random';

/**
 * UMAP, off the main thread.
 *
 * ## Why a worker and not a `setTimeout` loop
 *
 * Everything else expensive in this application is synchronous on the main
 * thread — parsing, unmixing, the mixture fit — and gets away with it because
 * each is seconds at worst and covered by a busy overlay. UMAP is not in that
 * class: 20 000 points for 300 epochs is tens of seconds of tight numeric work,
 * and the graph construction before it allocates heavily. Run inline, the window
 * stops responding to anything, including the button that would cancel it, and
 * on a large run the operating system offers to kill the app.
 *
 * Chunking it across timeouts would keep the window alive but makes every epoch
 * a scheduling decision and roughly doubles the wall time. A worker is the
 * mechanism that actually exists for this.
 *
 * ## The protocol
 *
 * One `run` message in, `progress` messages out, then `done` or `error`.
 * Cancellation is **termination** — `umap-js` has no abort and a cooperative
 * flag would only be read between epochs, which is exactly where the time is
 * not being spent. The store terminates the worker and makes a new one; a
 * worker holds no state worth preserving.
 *
 * The matrix arrives as `number[][]` because that is what `umap-js` consumes.
 * It is built once, in `buildMatrix`, and structured-cloned across — which is a
 * copy, and is the reason `maxPoints` exists.
 */

export interface UmapRunMessage {
  type: 'run';
  rows: number[][];
  nNeighbors: number;
  minDist: number;
  nEpochs: number;
  /** The random state. See `seededRandom` for what is stochastic and why. */
  seed: number;
}

export type UmapWorkerOut =
  | { type: 'progress'; epoch: number; total: number }
  | { type: 'done'; embedding: number[][] }
  | { type: 'error'; message: string };

const post = (m: UmapWorkerOut) => (self as unknown as Worker).postMessage(m);

self.onmessage = (event: MessageEvent<UmapRunMessage>) => {
  const msg = event.data;
  if (!msg || msg.type !== 'run') return;

  try {
    const { rows, nEpochs } = msg;
    if (rows.length === 0) { post({ type: 'done', embedding: [] }); return; }

    /*
       `nNeighbors` cannot exceed the number of points.

       umap-js builds a k-nearest-neighbour graph and asking for 15 neighbours
       among 8 points throws from inside the descent rather than returning
       something degenerate. Clamped here, where the real count is known, rather
       than in the panel where the preset is chosen — the preset is a preference
       and this is a fact about the data.
    */
    const nNeighbors = Math.max(2, Math.min(msg.nNeighbors, rows.length - 1));

    /*
       The seeded source, passed in rather than left to default.

       `umap-js` reaches for `Math.random` in three places — the projection
       forest, the initial layout and the negative sampling in every epoch — so
       supplying one function is what makes the whole run reproducible. Built
       here, inside the worker, so it starts from the same state on every run:
       one built in the store would carry whatever draws the previous projection
       had already taken out of it.
    */
    const umap = new UMAP({
      nNeighbors,
      minDist: msg.minDist,
      nComponents: 2,
      random: seededRandom(msg.seed),
    });
    umap.initializeFit(rows);

    const total = nEpochs;
    for (let epoch = 0; epoch < total; epoch++) {
      umap.step();
      // Every twentieth, not every one: a postMessage per epoch is 300 structured
      // clones and a re-render each, which is measurably slower than the work.
      if (epoch % 20 === 0) post({ type: 'progress', epoch, total });
    }

    post({ type: 'done', embedding: umap.getEmbedding() });
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
