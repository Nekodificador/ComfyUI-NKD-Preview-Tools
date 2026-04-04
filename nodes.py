from comfy_api.latest import ComfyExtension, io, ui
from typing_extensions import override


class NKD_PopupPreview(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="NKD_PopupPreview",
            display_name="NKD Popup Preview",
            category="NKD Nodes/Preview",
            description=(
                "Previsualiza una imagen en una ventana flotante sobre el navegador. "
                "La ventana puede abrirse en una pantalla secundaria a pantalla completa."
            ),
            inputs=[
                io.Image.Input("image"),
            ],
            outputs=[],
            is_output_node=True,
            not_idempotent=True,
            hidden=[io.Hidden.prompt, io.Hidden.extra_pnginfo],
        )

    @classmethod
    def execute(cls, image):
        return io.NodeOutput(ui=ui.PreviewImage(image, cls=cls))


class NKDExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [NKD_PopupPreview]


async def comfy_entrypoint() -> NKDExtension:
    return NKDExtension()
