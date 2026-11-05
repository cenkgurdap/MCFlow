/**
 * Filename heuristics.
 *
 * `$PnS` is empty in every file in this project, so marker and fluorophore
 * identity exists only in filenames. Everything here is a *suggestion* the user
 * can override — no downstream code may assume these parsed correctly.
 */

/** Strip a leading acquisition-date prefix: "20250101-", "2025-07-28_", … */
export function stripDatePrefix(name: string): string {
  return name
    .replace(/^\d{8}[-_ ]+/, '')
    .replace(/^\d{4}-\d{2}-\d{2}[-_ ]+/, '')
    .trim();
}

/** Filename → display name: drop the extension and any date prefix. */
export function displayNameFromFile(filename: string): string {
  const noExt = filename.replace(/\.fcs$/i, '');
  const stripped = stripDatePrefix(noExt);
  // Never return empty — a name is used as a UI label and a map key.
  return stripped || noExt || filename;
}

/* -------------------------------------------------------------------------
   Grouping — inferred no longer
   -------------------------------------------------------------------------

   `suggestGroups` is deleted (2026-08-03). It clustered a set of display names
   by replicate suffix and then by longest shared separator-bounded prefix, and
   the clustering was good at what it did — which is the problem. A **name is
   not a claim about an experiment.** Two samples called `…-Probe-Control` and
   `…-Probe-TreatmentA` share a prefix, so they were merged into one comparison
   category of n=2, which is the exact opposite of the comparison the operator
   loaded them to make: the shared part of the two names is the part that is the
   *same about the samples*, and the differing part is the condition.

   The heuristic had already lost its only visible surface when the sample
   list's group headers went on 2026-07-30, so from then until now it was state
   the user could neither see nor correct, silently deciding what the comparison
   chart averaged together. Grouping is now **explicit and empty by default**:
   every sample is its own category in the Compare view until somebody says
   otherwise, and `moveSampleToGroup` is how they say it.
   ------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------
   Fluorophore / marker parsing
   ------------------------------------------------------------------------- */

/**
 * Known fluorophore names, longest first so "PerCP-Cy5.5" matches before
 * "PerCP" and "APC-Fire 810" before "APC". Not exhaustive — it only needs to
 * cover enough to make the reference-control panel mostly self-populating.
 */
const FLUOROPHORES: string[] = [
  'PerCP-eFluor 710', 'PerCP-Vio700', 'PerCP-Cy5.5', 'PerCP-Cy5',
  'APC-Fire 810', 'APC-Fire 750', 'APC-eFluor 780', 'APC-Vio770', 'APC-R700', 'APC-H7', 'APC-Cy7',
  'PE-Fire 810', 'PE-Fire 744', 'PE-Fire 640', 'PE-eFluor 610', 'PE-Vio770',
  'PE-Dazzle 594', 'PE-CF594', 'PE-Cy5.5', 'PE-Cy5', 'PE-Cy7', 'PE-Texas Red',
  'Alexa Fluor 350', 'Alexa Fluor 405', 'Alexa Fluor 488', 'Alexa Fluor 532',
  'Alexa Fluor 546', 'Alexa Fluor 555', 'Alexa Fluor 594', 'Alexa Fluor 610',
  'Alexa Fluor 633', 'Alexa Fluor 647', 'Alexa Fluor 680', 'Alexa Fluor 700', 'Alexa Fluor 750',
  'AF350', 'AF405', 'AF488', 'AF532', 'AF546', 'AF555', 'AF594', 'AF610',
  'AF633', 'AF647', 'AF680', 'AF700', 'AF750',
  'Spark Blue 550', 'Spark NIR 685', 'Spark Violet 538', 'Spark YG 570',
  'Super Bright 436', 'Super Bright 600', 'Super Bright 645', 'Super Bright 702', 'Super Bright 780',
  'eFluor 450', 'eFluor 506', 'eFluor 660', 'eFluor 780',
  'BUV395', 'BUV496', 'BUV563', 'BUV615', 'BUV661', 'BUV737', 'BUV805',
  'BV421', 'BV480', 'BV510', 'BV570', 'BV605', 'BV650', 'BV711', 'BV750', 'BV785', 'BV786',
  'BB515', 'BB630', 'BB660', 'BB700', 'BB755', 'BB790',
  'KIRAVIA Blue 520', 'Zombie NIR', 'Zombie Aqua', 'Zombie UV', 'Zombie Violet',
  'Pacific Blue', 'Pacific Orange', 'Brilliant Violet 421', 'Brilliant Violet 510',
  'Cy5.5', 'Cy5', 'Cy7', 'Cy3',
  'FITC', 'PerCP', 'APC', 'PE', 'PI', 'DAPI', 'GFP', 'RFP', 'mCherry', 'tdTomato',
  'Viakrome 808', 'Live/Dead', 'LIVE/DEAD', '7-AAD', 'DRAQ7', 'DRAQ5', 'Annexin V',
].sort((a, b) => b.length - a.length);

const UNSTAINED = /\bun[-\s]?stain(ed)?d?\b|\bunstd\b|\bblank\b|\bneg(ative)?\s*control\b|\bNC\b/i;

export interface ControlIdentity {
  /** True when the name looks like an unstained / autofluorescence control. */
  isUnstained: boolean;
  /** Surface marker, e.g. "CD3". Null when not recognisable. */
  marker: string | null;
  /** Fluorophore, e.g. "PerCP-Cy5.5". Null when not recognisable. */
  fluorophore: string | null;
  /** Best single label for the reference control, e.g. "CD3 PerCP-Cy5.5". */
  label: string;
  /** How confident the parse is — drives whether the UI pre-selects it. */
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Parse a single-stain control filename into marker + fluorophore.
 *
 * Handles the project's convention
 * `…-Beads-<MARKER> <FLUOROPHORE>.fcs`
 * and degrades gracefully for anything else.
 */
export function parseControlIdentity(filenameOrDisplay: string): ControlIdentity {
  const display = displayNameFromFile(filenameOrDisplay);

  if (UNSTAINED.test(display)) {
    return { isUnstained: true, marker: null, fluorophore: null, label: 'Unstained', confidence: 'high' };
  }

  // Locate the fluorophore in the FULL name rather than in a hyphen-split tail:
  // half the names in use ("APC-R700", "PerCP-Cy5.5", "PE-Fire 744") contain a
  // hyphen themselves, so splitting on the last one severs them.
  const lower = display.toLowerCase();
  let fluorophore: string | null = null;
  let fluorIndex = -1;
  for (const f of FLUOROPHORES) {
    const needle = f.toLowerCase();
    let from = 0;
    for (;;) {
      const i = lower.indexOf(needle, from);
      if (i < 0) break;
      // Require token boundaries so "PE" cannot match inside a longer word.
      const before = i === 0 ? '' : lower[i - 1]!;
      const after = lower[i + needle.length] ?? '';
      if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) {
        fluorophore = display.slice(i, i + f.length);
        fluorIndex = i;
        break;
      }
      from = i + 1;
    }
    if (fluorophore) break;
  }

  // The marker is the token immediately preceding the fluorophore; when no
  // fluorophore was recognised, it is the segment after the last separator.
  let marker: string | null = null;
  const head = fluorIndex > 0 ? display.slice(0, fluorIndex) : fluorIndex === 0 ? '' : display;
  const tokens = head.split(/[\s\-_]+/).filter(Boolean);
  if (tokens.length) marker = tokens[tokens.length - 1]!;

  const label = [marker, fluorophore].filter(Boolean).join(' ') || display;
  const confidence: ControlIdentity['confidence'] =
    marker && fluorophore ? 'high' : fluorophore ? 'medium' : 'low';

  return { isUnstained: false, marker, fluorophore, label, confidence };
}

/**
 * Drop a redundant group prefix from a sample name for display.
 *
 * Rows sit under a group header that already states the shared stem, so
 * repeating it wastes the width that distinguishes the samples — nine controls
 * all rendering as "Beads-CD…" are indistinguishable, while
 * "CD3 PerCP-Cy5.5" is immediately readable.
 */
export function stripGroupPrefix(name: string, groupName: string): string {
  if (!groupName || groupName === 'Ungrouped' || !name.startsWith(groupName)) return name;
  const rest = name.slice(groupName.length).replace(/^[-_\s]+/, '').trim();
  // Keep the full name when little would remain: "Experiment condition B Probe1" reduced to
  // "1" is more cryptic than the repetition it avoids. The case worth fixing is
  // the long one, where the distinguishing text would otherwise be truncated.
  return rest.length >= 3 ? rest : name;
}

/** Registered fluorophore names, for autocomplete in the reference-control UI. */
export function knownFluorophores(): readonly string[] {
  return FLUOROPHORES;
}
