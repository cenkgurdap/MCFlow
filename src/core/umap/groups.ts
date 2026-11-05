/* ==========================================================================
   Which groups a set of loaded files has, and in what order they are coloured.

   The projection is coloured by group, and until 2026-08-19 the order those
   groups were coloured in was whatever order the files happened to be loaded
   in. That is invisible from the map and impossible to correct: a figure with
   *Control* in blue and *Treated* in orange could not be made to match the Compare
   chart of the same experiment, which colours by the arrangement of its own x
   axis. So the order is a stored arrangement here too, and the merge against
   what currently exists is the same function the chart uses — one convention,
   so a group renamed in one panel behaves the way it does in the other.

   Kept out of the store because it is arithmetic over a list, and because both
   the store (to move a group) and the view (to draw the key) need the same
   answer; two derivations of "which group is first" is exactly the bug this
   replaces.
   ========================================================================== */

import { orderCategories } from '../statisticsOrder';

/** What a dataset has to carry to be sorted into a group. */
export interface GroupedFile {
  /** The file's name, which is its category while it has no group. */
  name: string;
  group: string;
}

/**
 * The categories these files fall into, in the order they first appear.
 *
 * An ungrouped file is **its own category**, named after itself — the same rule
 * the Compare chart follows for an ungrouped sample. Pooling them into one
 * *Ungrouped* bucket would be a claim that those files are one condition, made
 * by the application rather than by the person who ran the experiment.
 */
export function groupLabels(files: readonly GroupedFile[]): string[] {
  return Array.from(new Set(files.map((d) => d.group.trim() || d.name)));
}

/**
 * The categories in the order they are drawn and coloured in.
 *
 * `stored` is the arrangement somebody made; anything in it that no longer
 * exists is dropped and anything new goes to the end, which is `orderCategories`
 * and is what stops a newly loaded file from silently renumbering the colours of
 * every group already arranged.
 */
export function orderedGroups(files: readonly GroupedFile[], stored: readonly string[]): string[] {
  return orderCategories(groupLabels(files), stored);
}
