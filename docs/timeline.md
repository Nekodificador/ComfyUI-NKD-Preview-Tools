# 😺NKD Timeline

- **Material comes in through the inputs**, not through a file browser. One growing list of sockets takes a video, an image sequence, a mask or audio — whatever you plug in lands on the lane it belongs to, and another slot appears.
- **Multi-track**: place, trim and slip clips on a timeline; higher tracks sit on top.
- **The numbers are sockets**: `fps`, `frame_count`, `duration`, `width`, `height` and `current_frame` come out as real outputs, so the rest of the graph can be coordinated with them. They are also normal widgets, so they can be driven *from* other nodes.
- **`current_image`** hands back the fully composited frame under the playhead, so scrubbing drives the rest of the graph.
- **Gaps are regions to generate**: the `coverage` mask is white wherever the timeline is empty, so it goes straight into a temporal inpainting workflow with nothing to invert first.
- **Frame quantising**: snap the range to what the model needs (`4n+1`, `8n+1` or a multiple of N), with the valid stops drawn on the ruler.
- **Mismatched frame rates are flagged** on the clip instead of being resampled silently.
- **Every clip carries its own sound**: a volume line you drag, and fade handles at either end to ease in and out of a hard cut — no separate audio lane needed.
- **Several timelines in one workflow** each keep their own cuts, playback and preview, so a reference cut and the shot it came from can live side by side.

## Using it

1. Add the node under **`😺NKD Nodes/Preview` -> `😺NKD Timeline`**.
2. Connect a stock **Load Video** to `media_0`. The clip lands on its own track and a `media_1` slot appears. Connect a second one and it stacks on top, ready to compare — switch `import_mode` to `append` if you would rather assemble a sequence. The same socket takes images, masks and audio.
3. Press **conform** to take fps and resolution from the first clip.
4. Drag clips to move them, drag their edges to trim, **Alt**-drag to slip the content inside a clip. **Ctrl**-drag is ten times finer, and **Ctrl**-click adds to the selection.
5. Click the ruler to scrub. Hold **Shift** while dragging to land only on frame counts the model accepts.
6. **Space** plays, **J K L** shuttle, **I** and **O** set the in and out points, **,** and **.** step a frame, **Delete** removes the selection, **Ctrl+Z** undoes.
7. **X** fits the in/out range to the clip itself, and **Q** and **E** bring its left or right edge to the playhead, so you never have to drag a three-minute clip's end back by hand. With nothing selected they cut everything under the playhead at once.
8. **Ctrl + wheel** zooms, the wheel or the middle button pans, **F** fits.
9. Right-click a clip to reinterpret it as a mask, or to set a track's blend mode — stack a before and an after on two tracks, set the top one to `difference`, and everything that matches goes black.
10. Changed a file upstream? A different file is picked up on its own; press **reload** if you overwrote one keeping its name.
11. Wire `images` onward, `coverage` into whatever consumes a mask if you are filling the gaps, and `current_image` if you want scrubbing to drive the rest of the graph.

---

[← All 😺NKD Preview Tools nodes](../README.md)
