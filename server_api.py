from aiohttp import web
from server import PromptServer
from .db_manager import suggest_names, get_characters_for_series
from .wildcard import refresh_wildcards

def setup_routes():
    server = PromptServer.instance
    routes = server.app.router

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

    routes.add_get("/rf_nodes/suggest", api_suggest)
    routes.add_get("/rf_nodes/series_characters", api_series_characters)
    routes.add_get("/rf_nodes/refresh_wildcards", api_refresh_wildcards)