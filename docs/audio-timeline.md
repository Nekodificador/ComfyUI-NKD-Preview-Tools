# 😺NKD Audio Timeline

- **The same editor, without the picture**: drag, trim, blade, snap, undo, in/out points and the transport all work exactly as they do on video, in a node that stays small.
- **Drop a video in and it takes the sound**: the socket accepts audio *or* video, and a video is read for its audio track alone. Pulling a voice out of a long take is instant, with no extractor node in the graph.
- **A waveform you can actually work against**: peak and body, both channels side by side, and detail that follows the zoom right down to the individual sample. Switch to the dB scale and a quiet dialogue track becomes readable instead of a flat line.
- **Level and fades on every clip**: drag the volume line — **Shift** snaps it to 3 dB steps, **Ctrl** is ten times finer — and pull the handles at either end for the fades. Blade a stretch and mute or fade just that piece.
- **Lanes that stack**: `append` assembles a sequence, `stack` gives each source its own lane so two can overlap for a crossfade or a bed under dialogue.
- **The numbers are sockets**: `audio`, `duration`, `frame_count` and `fps`.

## Using it

1. Add the node under **`😺NKD Nodes/Preview` -> `😺NKD Audio Timeline`**.
2. Connect a **Load Audio** to `media_0` — or a **Load Video**, if the sound you want is inside a take. Either way only the audio is read, and a `media_1` slot appears.
3. Everything from the video timeline works the same: drag to move, drag the edges to trim, **Space** plays, **J K L** shuttle, **I** and **O** set the in and out points, **Ctrl+Z** undoes, **Ctrl + wheel** zooms and **F** fits.
4. **W** blades the clip at the playhead — that plus a mute or a fade is how you take a stretch out.
5. Drag the **volume line** across the clip up or down to set its level. **Shift** lands on 3 dB steps, **Ctrl** is ten times finer, and the dotted line marks 0 dB.
6. Drag the **round handles** at the top corners inwards for the fade in and the fade out. To place one exactly, park the playhead and pick *Fade in to playhead* from the clip's right-click menu.
7. Press the **wave button** in the bar to switch the waveform to a dB scale when a track is too quiet to read.
8. Set `import_mode` to `stack` if you want each new source on its own lane so two can overlap; a lane to drop onto appears while you drag.
9. Wire `audio` onward, and `frame_count` / `duration` / `fps` if the sound is what should decide how long the video is.

---

[← All 😺NKD Preview Tools nodes](../README.md)
