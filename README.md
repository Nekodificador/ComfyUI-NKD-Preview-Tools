# ComfyUI NKD Preview Tools

https://github.com/user-attachments/assets/78d28bc2-f906-4d7c-a819-9dc31b7005ac

Preview tools for [ComfyUI](https://github.com/comfyanonymous/ComfyUI):

- **NKD Popup Preview** — preview generated images in a persistent floating popup window, ideal for multi-monitor setups.
- **NKD Timeline** — lay several videos and audio tracks on a multi-track timeline and get fps, frame count and resolution back as connectable sockets.
- **NKD Video Viewer** — save your video in the format you need and watch it in a player you can actually scrub, loop and compare against a previous take.


https://github.com/user-attachments/assets/e52f40df-36a2-4027-8f7b-1e987ed2615f

## Mask Painter has moved

**NKD Mask Painter now lives in [NKD Basic Tools](https://github.com/Nekodificador/ComfyUI-NKD-Basic-Tools)**,
next to the other mask nodes. Install that pack and the node comes back exactly where your
workflows expect it — same node, same painted masks, nothing to redo. This pack is for
viewing from now on.

## Updates!

I’ve added a "set primary" state that lets you use multiple popup previews in the same workflow. Once you’ve set one as the primary node, you can trigger its output with a shortcut or call up the preview from anywhere in the UI. This means you can queue only what you're actually previewing on a second monitor or floating window, without having to scroll back and forth from the middle of nowhere.

https://github.com/user-attachments/assets/75a9a3de-9ded-4d41-95f2-3de4421d63ac

## 🌟 Features

### NKD Popup Preview
- **Floating Image Preview**: Automatically opens a popup window showing the current output image during execution.
- **Multi-Monitor Support**: Drag the preview popup to any monitor you prefer.
- **Fullscreen Mode**: Maximize the popup to preview images without any UI distractions.
- **Unobtrusive**: Cleanly integrates into your workflow without taking up space on your main ComfyUI canvas.

### NKD Timeline
- **Material comes in through the inputs**, not through a file browser. One growing list of sockets takes a video, an image sequence, a mask or audio — whatever you plug in lands on the lane it belongs to, and another slot appears.
- **Multi-track**: place, trim and slip clips on a timeline; higher tracks sit on top.
- **The numbers are sockets**: `fps`, `frame_count`, `duration`, `width`, `height` and `current_frame` come out as real outputs, so the rest of the graph can be coordinated with them. They are also normal widgets, so they can be driven *from* other nodes.
- **`current_image`** hands back the fully composited frame under the playhead, so scrubbing drives the rest of the graph.
- **Gaps are regions to generate**: the `coverage` mask is white wherever the timeline is empty, so it goes straight into a temporal inpainting workflow with nothing to invert first.
- **Frame quantising**: snap the range to what the model needs (`4n+1`, `8n+1` or a multiple of N), with the valid stops drawn on the ruler.
- **Mismatched frame rates are flagged** on the clip instead of being resampled silently.

### NKD Video Viewer
- **A player, not a thumbnail**: drag the scrub bar frame by frame, step with the arrows, shuttle with J/K/L, loop it, and go full screen with the controls still there. There is a filmstrip along the scrub bar so you can find a shot by looking at it.
- **Float it**: send the whole viewer to its own window and drag it to a second monitor, then keep working on the graph.
- **Six formats**: mp4/h264, webm/vp9, mov/ProRes (proxy through 4444, which keeps alpha), GIF, animated WebP and a PNG image sequence. Only the settings of the format you picked are shown.
- **Name and version your output**: tokens for the node's own title, resolution, fps and the date, plus automatic `v001`, `v002` versioning that picks the next free number. Naming templates are in the node's right-click menu.
- **Changing the version does not re-render**: the same render is reused, so it is instant. And if nothing changed upstream, no new version is written at all.
- **Before and after**: wipe between the render and a reference, look at the difference, or hold B to see the reference whole. One button makes what is on screen the reference for the next run.

## 🛠️ Installation

### Method 1: Git Clone (Recommended)
1. Go to your ComfyUI `custom_nodes` folder.
2. Open a terminal or command prompt in that folder and run:
   ```bash
   git clone https://github.com/Nekodificador/ComfyUI-NKD-Preview-Tools.git
   ```
3. Restart ComfyUI.

### Method 2: Download ZIP
1. Click the **Code** button on this repository in GitHub, then select **Download ZIP**.
2. Extract the downloaded folder and place it directly inside your `ComfyUI/custom_nodes/` directory.
3. Restart ComfyUI.

## 💡 Usage

### NKD Popup Preview

1. Open your ComfyUI workspace.
2. Double-click on the canvas to open the node search box, or right-click to find the node menu.
3. Add the node under **`NKD Nodes/Preview` -> `NKD Popup Preview`**.
4. Connect any valid `IMAGE` output (for example, from a *VAE Decode* node) to the `image` input socket.
5. Click **Queue Prompt**. The pop-up window will open automatically and display the generated image.

### NKD Timeline

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

## 📝 Troubleshooting

- **Pop-up Blocker** (Popup Preview): Your web browser might block the window from opening the first time you use this node. If this happens, please check your browser's address bar and make sure to **allow pop-ups** for the URL or localhost where ComfyUI is running.
