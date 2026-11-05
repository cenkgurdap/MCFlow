import { describe, expect, it } from 'vitest';
import { requireMatrixExtension } from './unmixingIO';
import { modelFromPath, UnmixingFileError } from '@/core/unmixingFile';

/* ==========================================================================
   2026-08-11, Item 17 — the reader refuses what the dialog no longer offers.

   Checked here rather than only in the file filter, because a filter is a
   convenience: *All files* is one dropdown away and a path recorded in a saved
   workspace never passes through a dialog at all. A legacy file that loaded
   anyway would be an accidental compatibility promise, which is the state this
   item is explicitly removing.

   Widened on 2026-08-29 to `.compensation`, and the pair of claims below is the
   point: **two extensions, one guard.** They are the same format, so refusing
   one from the other panel would be a second and weaker gate in front of
   `checkDetectorCompatibility` — which is the check that actually decides
   whether a matrix may be applied, by detector name and order.
   ========================================================================== */

describe('requireMatrixExtension', () => {
  it('accepts a `.unmixing` file', () => {
    expect(() => requireMatrixExtension('D:/panels/First panel.unmixing')).not.toThrow();
    expect(() => requireMatrixExtension('/home/lab/panel.UNMIXING')).not.toThrow();
  });

  it('accepts a `.compensation` file', () => {
    expect(() => requireMatrixExtension('D:/panels/Second panel.compensation')).not.toThrow();
    expect(() => requireMatrixExtension('/home/lab/panel.COMPENSATION')).not.toThrow();
  });

  it('accepts the 2026-08-08 double form, because the shell reads the last segment', () => {
    // `Panel.mcflow.unmixing` and `Panel.unmixing` are the same file type to
    // Windows and to macOS. Refusing one would be inventing a distinction the
    // operating system does not make, about a file this build writes
    // byte-identically.
    expect(() => requireMatrixExtension('C:/lab/Panel.mcflow.unmixing')).not.toThrow();
  });

  it('refuses a `.fcunmix.json`, and says what to do about it', () => {
    let caught: unknown;
    try {
      requireMatrixExtension('C:/lab/General panel.fcunmix.json');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnmixingFileError);
    const err = caught as UnmixingFileError;
    // Names the file rather than the path, and the remedy rather than the rule.
    expect(err.message).toContain('General panel.fcunmix.json');
    expect(err.hint).toContain('.unmixing');
    expect(err.hint).toContain('.compensation');
  });

  it('refuses anything else', () => {
    for (const p of ['panel.json', 'panel.mcflow', 'panel', 'panel.unmixing.bak', 'panel.compensation.bak']) {
      expect(() => requireMatrixExtension(p)).toThrow(UnmixingFileError);
    }
  });
});

/* ==========================================================================
   The filename is the *last* answer about which model a matrix is, and only for
   a file written before `model` existed. Asserted so that the fallback stays a
   fallback: this project does not infer from filenames, and the exemption is
   narrow enough to be worth pinning down.
   ========================================================================== */

describe('modelFromPath', () => {
  it('reads `.compensation` as a compensation matrix', () => {
    expect(modelFromPath('D:/panels/Second.compensation')).toBe('compensation');
    expect(modelFromPath('/lab/DONOR.COMPENSATION')).toBe('compensation');
  });

  it('reads everything else as unmixing, including a name that merely says so', () => {
    expect(modelFromPath('D:/panels/First.unmixing')).toBe('unmixing');
    // The word in the *stem* decides nothing — only the extension does, and
    // this is the case that would tempt a substring test.
    expect(modelFromPath('D:/panels/compensation-beads.unmixing')).toBe('unmixing');
  });
});
