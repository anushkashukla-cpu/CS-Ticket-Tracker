#!/usr/bin/env python3
"""
Fill L1 (Category) and L2 (Subcategory) in the CS ticket tracker straight from Freshchat.

For every chat in your Freshchat transcript CSV, this asks Freshchat for its tags and
writes them onto that chat's row in the tracker. The tracker updates live, with no import step.

HomeRun's Freshchat fields:
  L1 = cf_issue_subcategory  (Freshchat label "Category")
  L2 = cf_root_cause         (Freshchat label "Subcategory")

Run it inside the Cs_tracker folder (it reads the Firebase settings from config.js):

  export FRESHCHAT_API_KEY="your-freshchat-key"
  export TRACKER_KEY="your-tracker-access-key"
  python3 fetch_freshchat_categories.py freshchat_transcripts_2026-10-19_to_2026-10-23.csv

Neither key is saved anywhere. Without TRACKER_KEY it only writes freshchat_categories.csv,
which you can import by hand.
"""
import csv, json, os, re, sys, time, urllib.request, urllib.error, urllib.parse
from concurrent.futures import ThreadPoolExecutor

FRESHCHAT = os.environ.get("FRESHCHAT_BASE", "https://homerun-team-d09d641d432c3b917703943.freshchat.com/v2")
FC_KEY = os.environ.get("FRESHCHAT_API_KEY", "").strip()
TRACKER_KEY = os.environ.get("TRACKER_KEY", "").strip()
L1_FIELD = os.environ.get("L1_FIELD", "cf_issue_subcategory")
L2_FIELD = os.environ.get("L2_FIELD", "cf_root_cause")
OUT = "freshchat_categories.csv"
WORKERS = 4


def http(method, url, headers=None, body=None, tries=6):
    data = json.dumps(body).encode() if body is not None else None
    h = {"Accept": "application/json", **(headers or {})}
    if data: h["Content-Type"] = "application/json"
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers=h, method=method)
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, json.loads(r.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as e:
            if e.code == 429 or e.code >= 500:
                time.sleep(min(int(e.headers.get("Retry-After") or 0) or 2 ** attempt, 30)); continue
            try: return e.code, json.loads(e.read().decode("utf-8") or "{}")
            except Exception: return e.code, {}
        except (urllib.error.URLError, TimeoutError):
            time.sleep(2 ** attempt)
    return 0, {}


def firebase_config():
    try: txt = open("config.js", encoding="utf-8").read()
    except OSError: sys.exit("Run this inside the Cs_tracker folder (config.js not found).")
    get = lambda k: (re.search(k + r'\s*:\s*"([^"]+)"', txt) or [None, None])[1]
    api, proj = get("apiKey"), get("projectId")
    if not api or not proj or "YOUR_" in api: sys.exit("config.js doesn't have your Firebase details yet.")
    return api, proj


def clean(v):
    v = "" if v is None else str(v).strip()
    return "" if v.lower() in ("", "none", "null", "(blank)") else v


def conversation_ids(path):
    ids, seen = [], set()
    with open(path, newline="", encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            cid = (r.get("conversation_id") or "").strip()
            if cid and cid not in seen: seen.add(cid); ids.append(cid)
    return ids


def doc_id(cid):  # same id the tracker uses
    return "c_" + re.sub(r"[^A-Za-z0-9_\-~:@+]", "_", cid)[:150]


def main():
    if not FC_KEY: sys.exit('Set your Freshchat key first:  export FRESHCHAT_API_KEY="..."')
    if len(sys.argv) < 2: sys.exit("Give the Freshchat transcript CSV:  python3 %s chats.csv" % sys.argv[0])
    ids = conversation_ids(sys.argv[1])
    if not ids: sys.exit("No conversation_id column found in that CSV.")

    fs_base = fs_key = None
    if TRACKER_KEY:
        fs_key, proj = firebase_config()
        fs_base = ("https://firestore.googleapis.com/v1/projects/%s/databases/(default)/documents/workspaces/%s/tickets/"
                   % (proj, urllib.parse.quote(TRACKER_KEY, safe="")))
        code, _ = http("GET", fs_base + "__check__?key=" + fs_key)
        if code == 403: sys.exit("The tracker refused TRACKER_KEY. Use the same access key as in the tracker link.")

    stats = {"done": 0, "tagged": 0, "written": 0, "manual": 0, "not_in_tracker": 0, "fc_missing": 0}

    def work(cid):
        code, conv = http("GET", FRESHCHAT + "/conversations/" + cid, {"Authorization": "Bearer " + FC_KEY})
        if code in (401, 403):
            print("\nFreshchat refused the API key (HTTP %d). Check FRESHCHAT_API_KEY." % code); os._exit(1)
        props = ((conv or {}).get("properties") or {}) if code == 200 else {}
        if code != 200: stats["fc_missing"] += 1
        l1, l2 = clean(props.get(L1_FIELD)), clean(props.get(L2_FIELD))
        if fs_base and (l1 or l2):
            url = fs_base + doc_id(cid)
            c, doc = http("GET", url + "?key=" + fs_key)
            if c == 404: stats["not_in_tracker"] += 1
            elif c == 200 and ((doc.get("fields") or {}).get("tagManual") or {}).get("booleanValue"):
                stats["manual"] += 1
            elif c == 200:
                fields, mask = {}, []
                if l1: fields["l1"] = {"stringValue": l1}; mask.append("l1")
                if l2: fields["l2"] = {"stringValue": l2}; mask.append("l2")
                q = "&".join("updateMask.fieldPaths=" + m for m in mask)
                c2, _ = http("PATCH", url + "?key=" + fs_key + "&currentDocument.exists=true&" + q, body={"fields": fields})
                if c2 == 200: stats["written"] += 1
        return cid, l1, l2

    print("Checking %d chats in Freshchat%s…" % (len(ids), " and updating the tracker" if fs_base else ""))
    rows = []
    with ThreadPoolExecutor(WORKERS) as pool:
        for cid, l1, l2 in pool.map(work, ids):
            rows.append((cid, l1, l2)); stats["done"] += 1
            if l1 or l2: stats["tagged"] += 1
            if stats["done"] % 100 == 0 or stats["done"] == len(ids):
                print("  %d / %d checked, %d tagged in Freshchat%s" % (stats["done"], len(ids), stats["tagged"],
                      (", %d updated in tracker" % stats["written"]) if fs_base else ""))

    with open(OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f); w.writerow(["conversation_id", "L1", "L2"]); w.writerows(rows)

    print("\nDone. %d of %d chats have a category in Freshchat." % (stats["tagged"], len(ids)))
    if fs_base:
        print("Tracker rows updated: %d. Kept hand-set tags: %d. Not in the tracker yet: %d."
              % (stats["written"], stats["manual"], stats["not_in_tracker"]))
        if stats["not_in_tracker"]: print("Import the transcript CSV in the tracker first, then run this again.")
    else:
        print("Saved %s. Import it in the tracker, or set TRACKER_KEY to update the tracker directly." % OUT)
    if stats["fc_missing"]: print("%d chats couldn't be fetched from Freshchat." % stats["fc_missing"])


if __name__ == "__main__":
    main()