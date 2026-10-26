from aiohttp import web
from server import PromptServer
from .db_manager import suggest_names, get_characters_for_series
from .wildcard import refresh_wildcards
from .inpaint.region_swapper_node import get_latest_sessions, compose_and_save

def setup_routes():
    server = PromptServer.instance
    routes = server.app.router

    async def api_latest_inpaint_sessions(request):
        folder = request.query.get("folder", "inpaint_results")
        limit = int(request.query.get("limit", 25))
        sessions = get_latest_sessions(folder=folder, limit=limit)
        return web.json_response({"sessions": sessions})

    async def api_save_composed_image(request):
        data = await request.json()
        mask_path = data.get("mask_path") or data.get("session_path")
        assignments = data.get("assignments")
        if not mask_path or assignments is None:
            return web.Response(status=400, text="mask_path and assignments are required.")
        result = compose_and_save(mask_path, assignments)
        return web.json_response({"success": True, "result": result})

    async def api_suggest(request):
        category = request.query.get("category", "characters")
        query = request.query.get("query", "")
        limit = int(request.query.get("limit", 20))
        results = suggest_names(category, query, limit)
        return web.json_response({"results": results})

    async def api_series_characters(request):
        series_name = request.query.get("series", "")
        limit = int(request.query.get("limit", 50))
        characters = get_characters_for_series(series_name, limit)
        return web.json_response({"characters": characters})

    async def api_refresh_wildcards(request):
        keys = refresh_wildcards()
        return web.json_response({"wildcards": keys})

    routes.add_get("/rf_nodes/latest_inpaint_sessions", api_latest_inpaint_sessions)
    routes.add_post("/rf_nodes/save_composed_image", api_save_composed_image)
    routes.add_get("/rf_nodes/suggest", api_suggest)
    routes.add_get("/rf_nodes/series_characters", api_series_characters)
    routes.add_get("/rf_nodes/refresh_wildcards", api_refresh_wildcards)