# MCFlow

Desktop software for analysing conventional and spectral flow cytometry data, with biophysical readouts such as membrane order computed from ratiometric probes.

For tutorial:
https://www.youtube.com/watch?v=rL3dO8vWtso

## Features

- Reads FCS files from spectral and conventional cytometers.
- Hierarchical gating on dot, density, contour and histogram plots, with live counts and frequencies.
- Spectral unmixing and conventional compensation built from single-stain controls; matrices can be saved and reused.
- Derived parameters (for example membrane order from a two-band ratio) and a guided workflow that fits and gates populations on them.
- Statistics on full event data, with group comparisons corrected for multiple testing.
- Export of populations to CSV or XLSX, and of figures to PDF, SVG, PNG or TIFF at 300–900 dpi.

## Installation

Download the installer for your platform from [Releases](../../releases).

- **macOS:** `MCFlow-<version>-arm64.dmg` (Apple Silicon) or `MCFlow-<version>-x64.dmg` (Intel). Open it and drag MCFlow to Applications.
- **Windows:** `MCFlow-Setup-<version>.exe`, or `MCFlow-<version>-portable.exe` to run without installing.

### First launch on macOS

MCFlow is not notarized by Apple, so macOS may report that it "is damaged and can't be opened". The app is not damaged. These steps are needed once per downloaded copy, on each Mac.

1. Open MCFlow from Applications once. A warning is expected.
2. Open **System Settings → Privacy & Security**, scroll to **Security**, click **Open Anyway** next to the MCFlow message and authenticate.
3. If there is no such option, run this in Terminal (no output means it worked):
   ```
   xattr -cr /Applications/MCFlow.app
   ```
   If the app is elsewhere, type `xattr -cr ` (with a trailing space) and drag the app into the Terminal window to fill in the path.
4. Open MCFlow normally.

## Quick start

1. **Import:** drag `.fcs` files onto the sidebar, or press Ctrl+O (Cmd+O on macOS).
2. **Plot:** the first plot opens on FSC-A × SSC-A. Click an axis label to change its parameter.
3. **Gate:** choose a gate shape in the Gating panel and drag on the plot. Open a plot inside a population to build the hierarchy.
4. **Analyse (optional):** build or load a matrix in **Unmixing** or **Compensation**, compare groups in **Statistics**, or run a **Biophysics** analysis.
5. **Export:** click the image icon in a plot's toolbar to save it as PDF, SVG, PNG or TIFF. The **Export** view writes population data to CSV or XLSX.

## Citation

If you use MCFlow in published work, please cite:

> REFERENCE TO BE PROVIDED

Citation metadata is in [`CITATION.cff`](CITATION.cff).
