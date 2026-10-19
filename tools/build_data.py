"""ساخت data/history.js برای مدل پیش‌بینی.

نتایج، xG و ضرایب بسته‌شدن از football-data.co.uk گرفته می‌شود و با شناسهٔ تیم‌های
ESPN (که سایت برای دادهٔ زنده استفاده می‌کند) تطبیق داده می‌شود. فقط از کتابخانهٔ
استاندارد پایتون استفاده می‌کند تا در GitHub Actions بدون نصب وابستگی اجرا شود.

    python tools/build_data.py [--cache DIR] [--out data/history.js]

خروجی یک فایل JS است (window.BAAZIKHAN_HISTORY = {...}) تا سایت با باز کردن مستقیم
index.html (file://) هم کار کند؛ fetch روی file:// در مرورگرها مسدود است.
"""
import argparse
import csv
import datetime as dt
import difflib
import hashlib
import io
import json
import os
import re
import sys
import time
import unicodedata
import urllib.request

LEAGUES = {
    # ESPN slug: football-data division code
    "eng.1": "E0",
    "esp.1": "SP1",
    "ita.1": "I1",
    "ger.1": "D1",
    "fra.1": "F1",
}
SEASONS_BACK = 2  # فصل جاری + دو فصل قبل
ESPN = "https://site.api.espn.com/apis/site/v2/sports/soccer/{lg}/scoreboard?dates={ym}&limit=400"
FD_SEASON = "https://football-data.co.uk/mmz4281/{code}/{div}.csv"
FD_FIXTURES = "https://football-data.co.uk/fixtures.csv"

ALIASES = {
    "man": "manchester", "utd": "united", "nottm": "nottingham", "spurs": "tottenham",
    "wolves": "wolverhampton", "ein": "eintracht", "mgladbach": "monchengladbach",
    "gladbach": "monchengladbach", "koln": "cologne", "ath": "atletico", "sociedad": "real sociedad",
    "espanol": "espanyol", "vallecano": "rayo vallecano", "psg": "paris saint germain",
    "sg": "saint germain", "st": "saint", "inter": "internazionale", "milan": "milan",
    "sheffield": "sheffield", "qpr": "queens park rangers", "betis": "real betis",
    "celta": "celta vigo", "leverkusen": "bayer leverkusen", "fortuna": "fortuna",
    "verona": "hellas verona", "forest": "nottingham forest", "palace": "crystal palace",
}
STOP = {"fc", "cf", "ac", "as", "sc", "afc", "ssc", "us", "rc", "cd", "ud", "sd", "de", "the", "club",
        "calcio", "vfb", "vfl", "tsg", "sv", "1", "04", "05", "1899", "1846", "1910", "rcd", "ogc", "losc",
        "stade", "olympique", "fsv", "bc", "hsc"}


def fetch(url, cache, retries=3):
    path = os.path.join(cache, hashlib.sha1(url.encode()).hexdigest())
    # ماه‌های گذشته و فصل‌های تمام‌شده تغییر نمی‌کنند؛ بقیه هر بار تازه دریافت می‌شوند.
    if cache and os.path.exists(path) and not getattr(fetch, "fresh", lambda u: True)(url):
        with open(path, "rb") as f:
            return f.read()
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (baazikhan data builder)"})
            with urllib.request.urlopen(req, timeout=40) as r:
                body = r.read()
            if cache:
                with open(path, "wb") as f:
                    f.write(body)
            return body
        except Exception as e:  # noqa: BLE001
            if attempt == retries - 1:
                raise
            print(f"  retry {url}: {e}", file=sys.stderr)
            time.sleep(2 * (attempt + 1))


def norm_tokens(name):
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[^a-z0-9 ]", "", s.replace("-", " "))
    out = []
    for t in s.split():
        t = ALIASES.get(t, t)
        out.extend(x for x in t.split() if x not in STOP)
    return out


def similarity(a, b):
    ta, tb = norm_tokens(a), norm_tokens(b)
    if not ta or not tb:
        return 0.0
    sa, sb = set(ta), set(tb)
    jac = len(sa & sb) / len(sa | sb)
    contain = 1.0 if (sa <= sb or sb <= sa) else 0.0
    seq = difflib.SequenceMatcher(None, " ".join(ta), " ".join(tb)).ratio()
    return max(jac, 0.85 * contain, seq)


def season_codes(today):
    start_year = today.year if today.month >= 7 else today.year - 1
    years = [start_year - k for k in range(SEASONS_BACK, -1, -1)]
    return [(y, f"{y % 100:02d}{(y + 1) % 100:02d}") for y in years]


def months_between(a, b):
    y, m = a.year, a.month
    while (y, m) <= (b.year, b.month):
        yield f"{y}{m:02d}"
        m += 1
        if m == 13:
            y, m = y + 1, 1


def fnum(row, *keys):
    for k in keys:
        v = row.get(k)
        if v not in (None, ""):
            try:
                x = float(v)
                if x > 1.0:
                    return x
            except ValueError:
                pass
    return None


def fxg(v):
    try:
        return round(float(v), 2) if v not in (None, "") else None
    except ValueError:
        return None


def parse_fd_date(s):
    for fmt in ("%d/%m/%Y", "%d/%m/%y"):
        try:
            return dt.datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    return None


def load_espn(lg, months, cache):
    teams, events = {}, []
    for ym in months:
        data = json.loads(fetch(ESPN.format(lg=lg, ym=ym), cache))
        for e in data.get("events", []):
            c = e["competitions"][0]
            side = {}
            for t in c["competitors"]:
                tm = t["team"]
                teams[tm["id"]] = {
                    "name": tm.get("displayName"), "short": tm.get("shortDisplayName"),
                    "abbr": tm.get("abbreviation"), "color": tm.get("color"), "logo": tm.get("logo"),
                }
                side[t["homeAway"]] = (tm["id"], t.get("score"))
            st = e["status"]["type"]
            events.append({
                "id": e["id"], "date": dt.date.fromisoformat(e["date"][:10]), "home": side["home"][0],
                "away": side["away"][0], "done": st.get("completed") and st.get("state") == "post",
                "hg": side["home"][1], "ag": side["away"][1],
            })
    uniq = {e["id"]: e for e in events}
    return teams, list(uniq.values())


def team_score(fd_name, espn_team):
    return max(similarity(fd_name, espn_team["name"] or ""), similarity(fd_name, espn_team["short"] or ""))


def match_rows(fd_rows, espn_events, teams):
    """هر سطر football-data را با رویداد ESPN هم‌تاریخ (±۱ روز) و بیشترین شباهت نام جفت می‌کند."""
    by_date = {}
    for e in espn_events:
        by_date.setdefault(e["date"], []).append(e)
    name_map, used, pairs = {}, set(), []
    cache_sim = {}

    def sim(n, tid):
        k = (n, tid)
        if k not in cache_sim:
            cache_sim[k] = team_score(n, teams[tid])
        return cache_sim[k]

    for r in fd_rows:
        best, best_s = None, 0.0
        for d in (r["date"], r["date"] - dt.timedelta(days=1), r["date"] + dt.timedelta(days=1)):
            for e in by_date.get(d, []):
                if e["id"] in used:
                    continue
                s = sim(r["home"], e["home"]) + sim(r["away"], e["away"])
                if s > best_s:
                    best, best_s = e, s
        if best and best_s >= 1.0:
            used.add(best["id"])
            pairs.append((r, best))
            for n, tid in ((r["home"], best["home"]), (r["away"], best["away"])):
                name_map.setdefault(n, {}).setdefault(tid, 0)
                name_map[n][tid] += 1
        else:
            print(f"  ! unmatched FD row {r['date']} {r['home']} - {r['away']}", file=sys.stderr)
    resolved = {n: max(c, key=c.get) for n, c in name_map.items()}
    return pairs, resolved, used


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=os.path.join(os.path.dirname(__file__), ".cache"))
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "data", "history.js"))
    args = ap.parse_args()
    os.makedirs(args.cache, exist_ok=True)
    today = dt.date.today()
    this_month = f"{today.year}{today.month:02d}"
    current_season = season_codes(today)[-1][1]
    fetch.fresh = lambda u: (this_month in u) or (f"/{current_season}/" in u) or u == FD_FIXTURES \
        or any(f"dates={m}" in u for m in months_between(today, today + dt.timedelta(days=40)))

    seasons = season_codes(today)
    espn_from = dt.date(seasons[0][0], 7, 1)
    espn_to = today + dt.timedelta(days=21)
    months = list(months_between(espn_from, espn_to))

    fixtures_csv = fetch(FD_FIXTURES, args.cache).decode("utf-8-sig", "replace")
    fixtures = list(csv.DictReader(io.StringIO(fixtures_csv)))

    out = {"generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
           "source": "football-data.co.uk + ESPN", "leagues": {}}
    for lg, div in LEAGUES.items():
        print(f"{lg}: ESPN {len(months)} months …", file=sys.stderr)
        teams, events = load_espn(lg, months, args.cache)
        fd_rows = []
        for _, code in seasons:
            try:
                text = fetch(FD_SEASON.format(code=code, div=div), args.cache).decode("utf-8-sig", "replace")
            except Exception as e:  # noqa: BLE001
                print(f"  ! {code}/{div}: {e}", file=sys.stderr)
                continue
            for row in csv.DictReader(io.StringIO(text)):
                d = parse_fd_date(row.get("Date", ""))
                if not d or row.get("FTHG", "") == "":
                    continue
                fd_rows.append({
                    "date": d, "home": row["HomeTeam"], "away": row["AwayTeam"],
                    "hg": int(row["FTHG"]), "ag": int(row["FTAG"]),
                    "hxg": fxg(row.get("HxG")), "axg": fxg(row.get("AxG")),
                    "oh": fnum(row, "PSCH", "BFECH", "AvgCH", "B365CH"),
                    "od": fnum(row, "PSCD", "BFECD", "AvgCD", "B365CD"),
                    "oa": fnum(row, "PSCA", "BFECA", "AvgCA", "B365CA"),
                    "oo": fnum(row, "PC>2.5", "BFEC>2.5", "AvgC>2.5", "B365C>2.5"),
                    "ou": fnum(row, "PC<2.5", "BFEC<2.5", "AvgC<2.5", "B365C<2.5"),
                })
        pairs, name_map, used = match_rows(fd_rows, events, teams)
        rows = []
        for r, e in pairs:
            rows.append([e["date"].isoformat(), e["home"], e["away"], r["hg"], r["ag"],
                         r["hxg"], r["axg"], r["oh"], r["od"], r["oa"], r["oo"], r["ou"]])
        # بازی‌های تمام‌شدهٔ ESPN که هنوز در football-data نیامده‌اند (فقط گل)
        for e in events:
            if e["done"] and e["id"] not in used and e["date"] >= espn_from and e["hg"] not in (None, ""):
                rows.append([e["date"].isoformat(), e["home"], e["away"], int(e["hg"]), int(e["ag"]),
                             None, None, None, None, None, None, None])
        rows.sort(key=lambda x: x[0])

        upcoming = []
        for row in fixtures:
            if row.get("Div") != div:
                continue
            h, a = name_map.get(row["HomeTeam"]), name_map.get(row["AwayTeam"])
            d = parse_fd_date(row.get("Date", ""))
            if not (h and a and d) or d < today - dt.timedelta(days=1):
                continue
            upcoming.append([d.isoformat(), h, a, fnum(row, "PSH", "BFEH", "AvgH", "B365H"),
                             fnum(row, "PSD", "BFED", "AvgD", "B365D"), fnum(row, "PSA", "BFEA", "AvgA", "B365A"),
                             fnum(row, "P>2.5", "BFE>2.5", "Avg>2.5", "B365>2.5"),
                             fnum(row, "P<2.5", "BFE<2.5", "Avg<2.5", "B365<2.5")])
        out["leagues"][lg] = {"teams": teams, "matches": rows, "upcoming": upcoming}
        n_odds = sum(1 for x in rows if x[7])
        n_xg = sum(1 for x in rows if x[5] is not None)
        print(f"  {len(rows)} matches ({n_odds} with odds, {n_xg} with xG), {len(upcoming)} upcoming odds, "
              f"{len(fd_rows) - len(pairs)} unmatched", file=sys.stderr)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write("window.BAAZIKHAN_HISTORY=")
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    print(f"wrote {args.out} ({os.path.getsize(args.out) // 1024} KB)", file=sys.stderr)


if __name__ == "__main__":
    main()
