from comfy_api.latest import ComfyExtension, io, ui
from typing_extensions import override
import torch


class NKD_PopupPreview(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="NKD_PopupPreview",
            display_name="NKD Popup Preview",
            category="NKD Nodes/Preview",
            description=(
                "Preview an image in a floating popup window. "
                "Optionally connect a mask to visualize it as the alpha channel in the viewer."
            ),
            inputs=[
                io.Image.Input("image"),
                io.Mask.Input("mask", optional=True, tooltip="Optional mask to composite as alpha channel (RGBA) for mask visualization in the viewer."),
            ],
            outputs=[],
            is_output_node=True,
            not_idempotent=True,
            hidden=[io.Hidden.prompt, io.Hidden.extra_pnginfo],
        )

    @classmethod
    def execute(cls, image, mask=None):
        if mask is not None:
            # image: [B, H, W, 3]  mask: [B, H, W] or [1, H, W]
            # Broadcast mask to match image batch size
            b, h, w, c = image.shape
            if mask.ndim == 2:
                mask = mask.unsqueeze(0)  # [1, H, W]
            mask = mask[:b]              # trim to batch
            if mask.shape[0] < b:
                mask = mask.expand(b, -1, -1)
            # Clamp and unsqueeze to [B, H, W, 1]
            alpha = mask.clamp(0.0, 1.0).unsqueeze(-1)
            # Composite into RGBA
            image = torch.cat([image, alpha], dim=-1)

        return io.NodeOutput(ui=ui.PreviewImage(image, cls=cls))


class NKDExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [NKD_PopupPreview]


async def comfy_entrypoint() -> NKDExtension:
    return NKDExtension()
