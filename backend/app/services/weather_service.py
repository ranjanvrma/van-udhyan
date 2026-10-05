"""
Weather Service — Open-Meteo proxy for Bavdhan Van Udyan.

Fetches current + past 7-day rainfall + 3-day forecast and caches the
result in-memory for 30 minutes so the frontend polling stays cheap and
we respect Open-Meteo's no-key fair-use.
"""
from __future__ import annotations

import time
from typing import Any, Dict
import urllib.request
import urllib.error
import json

BAVDHAN_LAT = 18.5195
BAVDHAN_LON = 73.7802

_CACHE: Dict[str, Any] = {"ts": 0.0, "payload": None}
_TTL_SECONDS = 60 * 30  # 30 min


def _fetch_openmeteo() -> Dict[str, Any]:
    url = (
        "https://api.open-meteo.com/v1/forecast"
        f"?latitude={BAVDHAN_LAT}&longitude={BAVDHAN_LON}"
        "&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m"
        "&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code"
        "&past_days=7&forecast_days=4"
        "&timezone=Asia%2FKolkata"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "VanUdyan/1.0"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode("utf-8"))


WMO_LABELS = {
    0: ("Clear", "☀️"), 1: ("Mostly clear", "🌤"), 2: ("Partly cloudy", "⛅"),
    3: ("Overcast", "☁️"), 45: ("Fog", "🌫"), 48: ("Rime fog", "🌫"),
    51: ("Light drizzle", "🌦"), 53: ("Drizzle", "🌦"), 55: ("Dense drizzle", "🌧"),
    61: ("Light rain", "🌦"), 63: ("Rain", "🌧"), 65: ("Heavy rain", "🌧"),
    71: ("Light snow", "🌨"), 73: ("Snow", "🌨"), 75: ("Heavy snow", "❄️"),
    80: ("Light showers", "🌦"), 81: ("Showers", "🌧"), 82: ("Violent showers", "⛈"),
    95: ("Thunderstorm", "⛈"), 96: ("T-storm w/ hail", "⛈"), 99: ("T-storm w/ heavy hail", "⛈"),
}


def _label(code: int) -> Dict[str, str]:
    name, icon = WMO_LABELS.get(int(code), ("Unknown", "🌡"))
    return {"name": name, "icon": icon, "code": int(code)}


def get_watering_weather() -> Dict[str, Any]:
    """Returns current + past rainfall + forecast tuned for the watering tab."""
    now = time.time()
    if _CACHE["payload"] and (now - _CACHE["ts"] < _TTL_SECONDS):
        return _CACHE["payload"]

    try:
        raw = _fetch_openmeteo()
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as e:
        return {"available": False, "error": f"Weather unavailable: {type(e).__name__}"}

    current = raw.get("current") or {}
    daily = raw.get("daily") or {}
    dates = daily.get("time") or []
    precip = daily.get("precipitation_sum") or []
    tmax = daily.get("temperature_2m_max") or []
    tmin = daily.get("temperature_2m_min") or []
    codes = daily.get("weather_code") or []

    past = []
    future = []
    today_idx = 7  # past_days=7 so index 7 = today
    for i, d in enumerate(dates):
        row = {
            "date": d,
            "rain_mm": round(float(precip[i] or 0), 1) if i < len(precip) else 0.0,
            "t_min": round(float(tmin[i]), 1) if i < len(tmin) else None,
            "t_max": round(float(tmax[i]), 1) if i < len(tmax) else None,
            "label": _label(codes[i]) if i < len(codes) else None,
        }
        if i < today_idx:
            past.append(row)
        else:
            future.append(row)

    rain_24h = past[-1]["rain_mm"] if past else 0.0
    rain_7d = round(sum((p["rain_mm"] or 0) for p in past), 1)
    auto_pause = rain_24h >= 5.0  # meaningful rainfall in last 24h

    payload = {
        "available": True,
        "location": "Bavdhan, Pune",
        "current": {
            "temp_c": current.get("temperature_2m"),
            "humidity_pct": current.get("relative_humidity_2m"),
            "wind_kph": current.get("wind_speed_10m"),
            "precip_mm": current.get("precipitation"),
            "label": _label(current.get("weather_code") or 0),
        },
        "past_7_days": past,
        "forecast": future,
        "rain_24h_mm": rain_24h,
        "rain_7d_mm": rain_7d,
        "auto_pause": auto_pause,
        "updated_at": raw.get("current", {}).get("time"),
    }
    _CACHE["payload"] = payload
    _CACHE["ts"] = now
    return payload
