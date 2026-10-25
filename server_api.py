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

    async def api_directory_info(request):
        import glob
        path = request.query.get("path", "")
        if not path or not os.path.isdir(path):
            raise web.HTTPBadRequest(reason=f"Directory not found: {path}")
        pattern = request.query.get("pattern", "*.png, *.jpg, *.jpeg, *.webp")
        exts = [p.strip() for p in pattern.split(",") if p.strip()]
        files = []
        for ext in exts:
            files.extend(glob.glob(os.path.join(path, ext)))
            files.extend(glob.glob(os.path.join(path, ext.upper())))
        files = sorted(list(set(files)))
        return web.json_response({"count": len(files), "files": [os.path.basename(f) for f in files]})

    routes.add_get("/rf_nodes/suggest", api_suggest)
    routes.add_get("/rf_nodes/series_characters", api_series_characters)
    routes.add_get("/rf_nodes/refresh_wildcards", api_refresh_wildcards)
    routes.add_get("/rf_nodes/directory_info", api_directory_info)