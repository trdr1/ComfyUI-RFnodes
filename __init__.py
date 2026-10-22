from .nodes import RFEntitySearchNode, RFSeriesCharacterListNode
from .wildcard import RFWildcardProcessorNode
from .inpaint import RFInpaintCanvasNode
from .db_manager import ensure_db
from .server_api import setup_routes

ensure_db()
setup_routes()

WEB_DIRECTORY = "./web"

NODE_CLASS_MAPPINGS = {
    "RFEntitySearchNode": RFEntitySearchNode,
    "RFSeriesCharacterListNode": RFSeriesCharacterListNode,
    "RFWildcardProcessorNode": RFWildcardProcessorNode,
    "RFInpaintCanvasNode": RFInpaintCanvasNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "RFEntitySearchNode": "RF Entity Search (Char/Series/Artist)",
    "RFSeriesCharacterListNode": "RF Series Characters to Prompt",
    "RFWildcardProcessorNode": "RF Wildcard Processor",
    "RFInpaintCanvasNode": "RF Inpaint Canvas (Inline Paint)",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]