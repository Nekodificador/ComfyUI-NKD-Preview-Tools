# 😺NKD Video Viewer

- **A player, not a thumbnail**: drag the scrub bar frame by frame, step with the arrows, shuttle with J/K/L, loop it, and go full screen with the controls still there. There is a filmstrip along the scrub bar so you can find a shot by looking at it.
- **Float it**: send the whole viewer to its own window and drag it to a second monitor, then keep working on the graph.
- **Six formats**: mp4/h264, webm/vp9, mov/ProRes (proxy through 4444), GIF, animated WebP and a PNG image sequence. Only the settings of the format you picked are shown.
- **Transparent clips play transparent**: RGBA frames show over a checkerboard, whatever format you save. ProRes 4444 and webm/vp9 keep the alpha in the file; mp4 can't, so the player gets a small transparent webm of its own in ComfyUI's temp folder. Only the render you asked for lands in output.
- **Name and version your output**: tokens for the node's own title, resolution, fps and the date, plus automatic `v001`, `v002` versioning that picks the next free number. Naming templates are in the node's right-click menu.
- **Changing the version does not re-render**: the same render is reused, so it is instant. And if nothing changed upstream, no new version is written at all.
- **Before and after**: wipe between the render and a reference, look at the difference, or hold B to see the reference whole. One button makes what is on screen the reference for the next run.

---

[← All 😺NKD Preview Tools nodes](../README.md)
