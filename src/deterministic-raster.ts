/**
 * @file
 *
 * The Chromium switches that make an owned desktop instance rasterize the same
 * frame to the same bytes every time it is captured.
 *
 * A sized capture pins the viewport with `Emulation.setDeviceMetricsOverride`
 * and clears the override afterwards, so every capture re-rasterizes the page
 * at the requested size. With GPU rasterization on, that re-raster is not
 * deterministic: the soft `box-shadow` of a modal and of a suggester come back
 * one value off in a single channel in a fraction of the captures, with nothing
 * visibly different. Measured on a 1200x800 frame with a modal and a suggester
 * open, 300 captures each:
 *
 * | Launch | Distinct frames |
 * | --- | --- |
 * | default | 3 (253 / 39 / 8) |
 * | `--disable-partial-raster` | 3 (201 / 83 / 16) |
 * | `--force-color-profile=srgb` | 3 (209 / 78 / 13) |
 * | no size override at all | 1 |
 * | `--disable-gpu-rasterization` | 1 |
 *
 * So the noise is the GPU rasterizer redoing the page after a resize, and the
 * resize cannot go, because a sized capture is the whole point of the size
 * options. Rasterizing on the CPU closes it while compositing stays on the GPU,
 * which is why this is `--disable-gpu-rasterization` and not `--disable-gpu`
 * (also stable, but it moves compositing to software as well). It cost no
 * capture time in the same measurement.
 */

/**
 * Chromium switches passed to every **owned** desktop instance so its captures
 * are byte-reproducible.
 *
 * Only an owned instance gets them: an attached Obsidian was launched by
 * somebody else, and its switches are not the harness's to choose.
 */
export const DETERMINISTIC_RASTER_LAUNCH_FLAGS: readonly string[] = [
  '--disable-gpu-rasterization'
];
