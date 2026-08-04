"""Sample first-turn English user prompts from WildChat-1M via datasets-server."""
import json
import random
import time
import urllib.request

TOTAL = 837_989
BATCH = 100
N_BATCHES = 60
OUT = "/private/tmp/claude-501/-Users-tylersolloway-Documents-Resondex/31011d25-22ff-456a-afe9-2bb72a192dd2/scratchpad/wildchat_prompts.jsonl"

random.seed(42)
offsets = sorted(random.sample(range(0, TOTAL - BATCH), N_BATCHES))

kept = 0
with open(OUT, "w") as f:
    for i, off in enumerate(offsets):
        url = (
            "https://datasets-server.huggingface.co/rows?dataset=allenai%2FWildChat-1M"
            f"&config=default&split=train&offset={off}&length={BATCH}"
        )
        for attempt in range(3):
            try:
                with urllib.request.urlopen(url, timeout=60) as r:
                    data = json.load(r)
                break
            except Exception as e:
                if attempt == 2:
                    print(f"batch {i} offset {off} failed: {e}")
                    data = None
                time.sleep(3)
        if data is None:
            continue
        for row in data["rows"]:
            r = row["row"]
            if r.get("language") != "English":
                continue
            conv = r.get("conversation") or []
            first = next((t for t in conv if t.get("role") == "user"), None)
            if not first or not first.get("content"):
                continue
            text = first["content"].strip()
            if not text or len(text) > 4000:
                continue
            f.write(json.dumps({"text": text, "country": r.get("country")}) + "\n")
            kept += 1
        if (i + 1) % 10 == 0:
            print(f"{i+1}/{N_BATCHES} batches, {kept} prompts")
        time.sleep(0.7)
print(f"done: {kept} English first-turn prompts -> {OUT}")
