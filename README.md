# ComfyUI NKD Preview Tools

https://github.com/user-attachments/assets/78d28bc2-f906-4d7c-a819-9dc31b7005ac

Preview tools for [ComfyUI](https://github.com/comfyanonymous/ComfyUI):

- **NKD Popup Preview** — preview generated images in a persistent floating popup window, ideal for multi-monitor setups.
- **NKD Timeline** — lay several videos and audio tracks on a multi-track timeline and get fps, frame count and resolution back as connectable sockets.
- **NKD Audio Timeline** — the same editor without the picture: cut and arrange sound, set a level and drag fades into the joins.
- **NKD Video Viewer** — save your video in the format you need and watch it in a player you can actually scrub, loop and compare against a previous take.
- **NKD Freeze Frames** — pull individual frames out of a batch as stills, one per socket.
- **NKD Reference** — set the image, mask or video the other nodes compare against.


https://github.com/user-attachments/assets/e52f40df-36a2-4027-8f7b-1e987ed2615f

## Mask Painter has moved

**NKD Mask Painter now lives in [NKD Basic Tools](https://github.com/Nekodificador/ComfyUI-NKD-Basic-Tools)**,
next to the other mask nodes. Install that pack and the node comes back exactly where your
workflows expect it — same node, same painted masks, nothing to redo. This pack is for
viewing from now on.

---

## The nodes

| Node | What it does |
|---|---|
| [😺NKD Popup Preview](docs/popup-preview.md) | Preview images in a floating window that stays put, made for multi-monitor setups. |
| [😺NKD Timeline](docs/timeline.md) | Lay videos and audio on a multi-track timeline and get fps, frame count and resolution back as sockets. |
| [😺NKD Audio Timeline](docs/audio-timeline.md) | The same editor without the picture: cut and arrange sound, set a level, drag fades into the joins. |
| [😺NKD Video Viewer](docs/video-viewer.md) | Save your video in the format you need and watch it in a player you can scrub, loop and compare. |
| [😺NKD Freeze Frames](docs/freeze-frames.md) | Pull individual frames out of a batch as stills, one per socket. |
| [😺NKD Reference](docs/reference.md) | Sets the image, mask or video that the other nodes compare against. |

---

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

---

## 📝 Troubleshooting

- **Pop-up Blocker** (Popup Preview): Your web browser might block the window from opening the first time you use this node. If this happens, please check your browser's address bar and make sure to **allow pop-ups** for the URL or localhost where ComfyUI is running.

[Changelog](docs/changelog.md)
