# ComfyUI NKD Preview Tools

Preview tools for [ComfyUI](https://github.com/comfyanonymous/ComfyUI):

- **NKD Popup Preview** — preview generated images in a persistent floating popup window, ideal for multi-monitor setups.


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

## 📝 Troubleshooting

- **Pop-up Blocker** (Popup Preview): Your web browser might block the window from opening the first time you use this node. If this happens, please check your browser's address bar and make sure to **allow pop-ups** for the URL or localhost where ComfyUI is running.
