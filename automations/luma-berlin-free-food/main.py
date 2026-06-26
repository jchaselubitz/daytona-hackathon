"""
Demo automation: find today's Luma events in a city (default Berlin) that
advertise free food/drinks.

Best-effort web scraping of public lu.ma pages (contract: AGENTS.md "treat
network calls as best-effort"). No login or private API access is used.

Inputs (env, per AGENTS.md convention):
  INPUT_CITY - Luma city slug, e.g. "berlin" (default: berlin)

Output: $RUN_ARTIFACTS_DIR/free_food_events.json and .md summary.
"""
import json
import os
import re
import sys
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import requests
from bs4 import BeautifulSoup

UA = (
    "Mozilla/5.0 (compatible; demo-automation/1.0; "
    "+https://github.com/) luma-free-food-finder"
)
HEADERS = {"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"}
TIMEOUT = 15
MAX_EVENTS = 25
REQUEST_DELAY_SECONDS = 0.4

# Luma events are free to attend, so any mention of food/drink in the
# description is almost always something served at the event, not a sales
# pitch. Real listings rarely spell out "free food provided" explicitly
# (e.g. "Vegetarian & Vegan BBQ", "Cold drinks and DJ") so we match on plain
# food/drink nouns rather than requiring an explicit "free"/"provided" qualifier.
FREE_FOOD_PATTERNS = [
    r"\bfree\s+(food|pizza|lunch|dinner|breakfast|snacks?|drinks?|beer|wine)\b",
    r"\b(food|drinks?|snacks?|catering|refreshments?)\b\s*(and\s+drinks?\s+)?(will be\s+|are\s+|is\s+)?(provided|included)\b",
    r"\bcomplimentary\s+(food|drinks?|snacks?|breakfast|lunch|dinner|catering)\b",
    r"\b(bbq|barbecue|pizza|snacks?|appetizers?|finger\s*food|refreshments?|catering)\b",
    r"\b(lunch|dinner|breakfast|brunch)\s+(provided|included|served)?\b",
    r"\b(beer|wine|cocktails?|cold\s+drinks?)\b",
    r"\bfood\s*(&|and)\s*drinks?\b",
]
FOOD_REGEX = re.compile("|".join(f"(?:{p})" for p in FREE_FOOD_PATTERNS), re.IGNORECASE)


def artifacts_dir() -> str:
    d = os.environ.get("RUN_ARTIFACTS_DIR", ".")
    os.makedirs(d, exist_ok=True)
    return d


def fetch(url: str) -> requests.Response:
    resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
    resp.raise_for_status()
    return resp


def walk_json_for_events(node, found, seen_urls):
    """Recursively collect dict nodes that look like Luma event records.

    Luma's embedded __NEXT_DATA__ shape isn't publicly documented and can
    change, so we detect event-shaped dicts generically instead of indexing
    fixed keys.
    """
    if isinstance(node, dict):
        name = node.get("name")
        url = node.get("url")
        start_at = node.get("start_at") or node.get("startAt")
        if isinstance(name, str) and isinstance(url, str) and (
            "api_id" in node or "event" in node.get("url", "") or start_at
        ):
            full_url = url if url.startswith("http") else f"https://lu.ma/{url.lstrip('/')}"
            if full_url not in seen_urls:
                seen_urls.add(full_url)
                found.append({"name": name, "url": full_url, "start_at": start_at})
        for v in node.values():
            walk_json_for_events(v, found, seen_urls)
    elif isinstance(node, list):
        for item in node:
            walk_json_for_events(item, found, seen_urls)


def extract_events_from_listing(html: str):
    soup = BeautifulSoup(html, "html.parser")
    script = soup.find("script", id="__NEXT_DATA__")
    events = []
    if script and script.string:
        try:
            data = json.loads(script.string)
            walk_json_for_events(data, events, set())
        except (json.JSONDecodeError, TypeError):
            pass
    return events


def is_today_berlin(start_at: str | None) -> bool:
    if not start_at:
        # No date info available; keep it so the agent doesn't silently
        # drop events rather than risk false negatives.
        return True
    try:
        dt = datetime.fromisoformat(start_at.replace("Z", "+00:00"))
    except ValueError:
        return True
    berlin_today = datetime.now(ZoneInfo("Europe/Berlin")).date()
    return dt.astimezone(ZoneInfo("Europe/Berlin")).date() == berlin_today


def find_food_mentions(event_html: str) -> list[str]:
    text = BeautifulSoup(event_html, "html.parser").get_text(" ", strip=True)
    return sorted({m.group(0).strip() for m in FOOD_REGEX.finditer(text)})


def main() -> int:
    city = (os.environ.get("INPUT_CITY") or "berlin").strip().lower() or "berlin"
    listing_url = f"https://lu.ma/{city}"

    try:
        listing_html = fetch(listing_url).text
    except requests.RequestException as exc:
        print(f"ERROR: could not fetch {listing_url}: {exc}", file=sys.stderr)
        return 1

    candidates = extract_events_from_listing(listing_html)
    todays_events = [e for e in candidates if is_today_berlin(e.get("start_at"))][:MAX_EVENTS]

    print(f"Found {len(candidates)} event(s) on {listing_url}, "
          f"{len(todays_events)} matching today (Europe/Berlin).")

    results = []
    for event in todays_events:
        try:
            event_html = fetch(event["url"]).text
        except requests.RequestException as exc:
            print(f"WARN: skipping {event['url']}: {exc}", file=sys.stderr)
            continue
        time.sleep(REQUEST_DELAY_SECONDS)

        matches = find_food_mentions(event_html)
        if matches:
            results.append(
                {
                    "name": event["name"],
                    "url": event["url"],
                    "start_at": event.get("start_at"),
                    "matched_phrases": matches,
                }
            )

    out_dir = artifacts_dir()

    json_path = os.path.join(out_dir, "free_food_events.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(
            {
                "city": city,
                "checked_at": datetime.now(ZoneInfo("Europe/Berlin")).isoformat(),
                "events_checked": len(todays_events),
                "free_food_events": results,
            },
            f,
            indent=2,
        )

    md_path = os.path.join(out_dir, "free_food_events.md")
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(f"# Free food events in {city.title()} today\n\n")
        if not results:
            f.write("No events with free food/drinks mentions found today.\n")
        for e in results:
            f.write(f"- **[{e['name']}]({e['url']})** — {', '.join(e['matched_phrases'])}\n")

    print(f"Wrote {len(results)} free-food event(s) to {json_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
