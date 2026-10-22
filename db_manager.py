import os
import sqlite3
import urllib.request
import shutil

DB_URL = "https://huggingface.co/rufflet17/temp/resolve/main/files_db_smart_unified.db"
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(CURRENT_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "smart_unified.db")

def ensure_db():
    if os.path.exists(DB_PATH) and os.path.getsize(DB_PATH) > 0:
        return DB_PATH
    os.makedirs(DATA_DIR, exist_ok=True)
    temp_path = DB_PATH + ".tmp"
    try:
        req = urllib.request.Request(DB_URL, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req) as resp, open(temp_path, "wb") as f:
            shutil.copyfileobj(resp, f)
        os.replace(temp_path, DB_PATH)
    except Exception as e:
        if os.path.exists(temp_path):
            os.remove(temp_path)
        raise RuntimeError(f"Failed to download smart_unified.db: {e}")
    return DB_PATH

_MEM_CONN = None

def get_connection():
    global _MEM_CONN
    if _MEM_CONN is not None:
        return _MEM_CONN
    path = ensure_db()
    disk_conn = sqlite3.connect(path)
    mem_conn = sqlite3.connect(":memory:", check_same_thread=False)
    mem_conn.row_factory = sqlite3.Row
    disk_conn.backup(mem_conn)
    disk_conn.close()
    _MEM_CONN = mem_conn
    return _MEM_CONN

def _escape_like(s: str) -> str:
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")

def _clean(s):
    return s.replace("_", " ") if s else s

def suggest_names(category: str, query: str, limit: int = 20):
    query = (query or "").strip()
    if not query:
        return []
    conn = get_connection()
    cursor = conn.cursor()
    q = _escape_like(query.replace(" ", "_")) + "%"
    try:
        if category == "characters":
            sql_with_series = r"""
                SELECT n.name AS name,
                       (SELECT sn.name
                          FROM character_top_series c2
                          JOIN series_names sn ON sn.id = c2.series_id
                         WHERE c2.character_id = n.id
                         ORDER BY c2.appearance_count DESC
                         LIMIT 1) AS series
                FROM character_names n
                JOIN character_top_series cts ON n.id = cts.character_id
                WHERE n.name LIKE ? ESCAPE '\'
                GROUP BY n.id
                ORDER BY SUM(cts.appearance_count) DESC
                LIMIT ?
            """
            sql_plain = r"""
                SELECT n.name AS name, NULL AS series
                FROM character_names n
                JOIN character_top_series cts ON n.id = cts.character_id
                WHERE n.name LIKE ? ESCAPE '\'
                GROUP BY n.id
                ORDER BY SUM(cts.appearance_count) DESC
                LIMIT ?
            """
            try:
                cursor.execute(sql_with_series, (q, limit))
            except sqlite3.OperationalError as e:
                print(f"[RFNodes] series lookup failed, fallback: {e}")
                cursor.execute(sql_plain, (q, limit))
        elif category == "series":
            cursor.execute(r"""
                SELECT n.name AS name, NULL AS series
                FROM series_names n
                JOIN series_totals s ON n.id = s.series_id
                WHERE n.name LIKE ? ESCAPE '\'
                ORDER BY s.total_hits DESC
                LIMIT ?
            """, (q, limit))
        elif category == "artists":
            cursor.execute(r"""
                SELECT n.name AS name, NULL AS series
                FROM artist_names n
                JOIN artists a ON n.id = a.artist_id
                WHERE n.name LIKE ? ESCAPE '\'
                ORDER BY a.image_count DESC
                LIMIT ?
            """, (q, limit))
        else:
            return []

        results = []
        for r in cursor.fetchall():
            name = _clean(r["name"])
            series = _clean(r["series"])
            if category == "characters":
                parts = ["1girl", name] + ([series] if series else [])
                prompt = ", ".join(parts)
            else:
                prompt = name
            results.append({"name": name, "series": series, "prompt": prompt})
        return results
    finally:
        cursor.close()

def get_characters_for_series(series_name: str, limit: int = 50):
    if not series_name:
        return []
    conn = get_connection()
    cursor = conn.cursor()
    clean_series = series_name.strip().replace(" ", "_")
    try:
        sql = """
            SELECT cn.name
            FROM series_top_characters stc
            JOIN character_names cn ON stc.character_id = cn.id
            WHERE stc.series_id = (SELECT id FROM series_names WHERE name = ? LIMIT 1)
            ORDER BY stc.rank ASC
            LIMIT ?
        """
        cursor.execute(sql, (clean_series, limit))
        rows = cursor.fetchall()
        return [r["name"].replace("_", " ") for r in rows]
    finally:
        cursor.close()