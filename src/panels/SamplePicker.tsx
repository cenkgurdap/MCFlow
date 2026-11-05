import { useMemo } from 'react';
import { withBlock } from '@/core/rangeSelect';
import type { PopulationNode } from '@/core/export';
import { useStatisticsPrefs } from '@/state/statisticsPrefs';
import type { Sample } from '@/state/workspaceStore';
import { PopulationPicker } from './PopulationPicker';

/**
 * Which samples Statistics and Export are about — tick, untick, Shift for a
 * range.
 *
 * Both screens used every loaded sample, so leaving a failed tube out of a
 * comparison, or exporting three of twelve, meant removing files from the
 * workspace. This is the population picker over a flat list rather than a
 * second list control: the range, the keyboard and *Select all / none* are the
 * ones every other list here uses (`core/rangeSelect.ts`, `ui/useListKeys.ts`).
 *
 * It writes \`excludedSamples\` — one list for both screens, saved with the
 * workspace — and lists every experiment sample, chosen or not, so a sample left
 * out can be put back.
 */
export function SamplePicker({ samples, hint }: { samples: readonly Sample[]; hint: string }) {
  const excluded = useStatisticsPrefs((s) => s.excludedSamples);
  const setExcluded = useStatisticsPrefs((s) => s.setExcludedSamples);

  const rows = useMemo<PopulationNode[]>(() => samples.map((s) => ({
    path: s.id,
    name: s.name,
    depth: 0,
    parentPath: null,
    sampleCount: 1,
    eventCount: s.parsed.metadata.eventCount,
  })), [samples]);
  const chosen = useMemo(
    () => new Set(samples.filter((s) => !excluded.includes(s.id)).map((s) => s.id)),
    [samples, excluded],
  );
  // Written back as "everything not chosen", from the samples loaded now, so an
  // id left behind by a removed file does not linger in the list.
  const write = (on: ReadonlySet<string>) => setExcluded(samples.filter((s) => !on.has(s.id)).map((s) => s.id));

  return (
    <PopulationPicker
      kind="sample"
      label="Samples"
      tree={rows}
      selected={chosen}
      everything={chosen.size === samples.length}
      sampleCount={1}
      countLabel="events in the file"
      hint={hint}
      onToggle={(id) => {
        const next = new Set(chosen);
        if (next.has(id)) next.delete(id); else next.add(id);
        write(next);
      }}
      onSelectBlock={(ids, on) => write(new Set(withBlock([...chosen], ids, on)))}
      onAll={() => setExcluded([])}
      onNone={() => write(new Set())}
    />
  );
}
