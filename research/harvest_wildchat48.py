"""Harvest commercial-candidate first-turn prompts from WildChat-4.8M via
datasets-server full-text search. Broad phrase battery, paged, deduped."""
import json
import time
import urllib.parse
import urllib.request

OUT = "/private/tmp/claude-501/-Users-tylersolloway-Documents-Resondex/31011d25-22ff-456a-afe9-2bb72a192dd2/scratchpad/wc48_candidates.jsonl"
MAX_PAGES_PER_QUERY = 15  # 1,500 rows per query max
BATCH = 100

QUERIES = [
    # discovery
    "best app for", "best software for", "best tool for", "best website to buy",
    "best brand of", "best laptop for", "best phone for", "what is the best app",
    "top rated", "most reliable brand",
    # recommendation
    "can you recommend a", "recommend me a", "what should i buy",
    "which should i buy", "which one should i choose", "suggest a good",
    "looking to buy a", "i want to buy a", "help me choose",
    "what would you recommend for",
    # worth / evaluation
    "is it worth buying", "worth the money", "should i upgrade to",
    "is it a good laptop", "any good apps",
    # comparison
    "which is better for", "or should i get", "compare these two",
    "difference between iphone", "vs which is better",
    # budget / alternatives
    "on a budget which", "cheapest way to get", "best budget",
    "free alternative to", "cheaper alternative to", "best free app",
    # services
    "best place to buy", "best company for", "which bank is best",
    "best insurance for",
]

def fetch(url, tries=4):
    for a in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=90) as r:
                return json.load(r)
        except Exception as e:
            wait = 5 * (a + 1)
            if "429" in str(e):
                wait = 20 * (a + 1)
            time.sleep(wait)
    return None

seen_hash = set()
seen_text = set()
kept = 0
stats = {}
with open(OUT, "w") as f:
    for qi, q in enumerate(QUERIES):
        qenc = urllib.parse.quote(q)
        got_q = 0
        total_hits = None
        for page in range(MAX_PAGES_PER_QUERY):
            url = (
                "https://datasets-server.huggingface.co/search?dataset=allenai%2FWildChat-4.8M"
                f"&config=default&split=train&query={qenc}&offset={page*BATCH}&length={BATCH}"
            )
            data = fetch(url)
            if data is None or not data.get("rows"):
                break
            if total_hits is None:
                total_hits = data.get("num_rows_total")
            for row in data["rows"]:
                r = row["row"]
                if r.get("language") != "English":
                    continue
                h = r.get("conversation_hash")
                if h in seen_hash:
                    continue
                conv = r.get("conversation") or []
                first = next((t for t in conv if t.get("role") == "user"), None)
                if not first or not first.get("content"):
                    continue
                text = first["content"].strip()
                if not text or len(text) > 3000:
                    continue
                key = text[:300].lower()
                if key in seen_text:
                    continue
                seen_hash.add(h)
                seen_text.add(key)
                f.write(json.dumps({"text": text, "q": q}) + "\n")
                kept += 1
                got_q += 1
            if len(data["rows"]) < BATCH:
                break
            time.sleep(1.2)
        stats[q] = {"hits": total_hits, "kept": got_q}
        print(f"[{qi+1}/{len(QUERIES)}] '{q}': index hits={total_hits}, kept={got_q}, total={kept}", flush=True)
        time.sleep(2)

print(f"\nDONE: {kept} unique English first-turn candidates -> {OUT}")
with open(OUT + ".stats.json", "w") as f:
    json.dump(stats, f, indent=2)
