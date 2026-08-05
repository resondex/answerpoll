"""Clean vs messy battery: does surface messiness change the measurement?"""
import json
import math
import sys
from collections import Counter, defaultdict

DIR = "/private/tmp/claude-501/-Users-tylersolloway-Documents-Resondex/31011d25-22ff-456a-afe9-2bb72a192dd2/scratchpad"
stem = sys.argv[1] if len(sys.argv) > 1 else "exp_batteries"
rows = json.load(open(f"{DIR}/{stem}_extracted.json"))

conds = {"clean": [r for r in rows if r["cond"] == "clean"],
         "messy": [r for r in rows if r["cond"] == "messy"]}
n = {c: len(v) for c, v in conds.items()}
print(f"answers: clean={n['clean']}, messy={n['messy']}")

def rates(cond_rows):
    counts = Counter()
    for r in cond_rows:
        for m in r["mentions"]:
            counts[m["brand"].strip().lower()] += 1
    return counts

rc, rm = rates(conds["clean"]), rates(conds["messy"])
all_brands = set(rc) | set(rm)

def two_prop_z(k1, n1, k2, n2):
    p1, p2 = k1 / n1, k2 / n2
    p = (k1 + k2) / (n1 + n2)
    if p in (0, 1):
        return 0.0, 1.0
    z = (p1 - p2) / math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2))
    # two-sided p from normal approx
    pval = 2 * (1 - 0.5 * (1 + math.erf(abs(z) / math.sqrt(2))))
    return z, pval

# test the most-mentioned brands (union top 10 by combined count)
top = [b for b, _ in Counter({b: rc.get(b, 0) + rm.get(b, 0) for b in all_brands}).most_common(10)]
results = []
for b in top:
    k1, k2 = rc.get(b, 0), rm.get(b, 0)
    z, p = two_prop_z(k1, n["clean"], k2, n["messy"])
    results.append((b, k1 / n["clean"], k2 / n["messy"], z, p))

# Holm correction
by_p = sorted(results, key=lambda x: x[4])
m = len(by_p)
sig = {}
for i, (b, *_ , p) in enumerate(by_p):
    sig[b] = p < 0.05 / (m - i)
    if not sig[b]:
        for bb, *_r, _p in by_p[i:]:
            sig[bb] = False
        break

print(f"\n{'brand':<22} {'clean':>7} {'messy':>7} {'diff':>7} {'z':>6} {'p':>8} {'sig(Holm)'}")
any_sig = False
for b, r1, r2, z, p in sorted(results, key=lambda x: -max(x[1], x[2])):
    s = "YES" if sig.get(b) else ""
    if sig.get(b):
        any_sig = True
    print(f"{b:<22} {r1:>6.0%} {r2:>6.0%} {r2-r1:>+6.0%} {z:>6.2f} {p:>8.4f} {s:>6}")

# brand-set similarity and answer richness
set_c = {b for b in rc if rc[b] >= 3}
set_m = {b for b in rm if rm[b] >= 3}
jac = len(set_c & set_m) / max(1, len(set_c | set_m))
bpa_c = sum(len(r["mentions"]) for r in conds["clean"]) / n["clean"]
bpa_m = sum(len(r["mentions"]) for r in conds["messy"]) / n["messy"]
print(f"\nbrand-set Jaccard (brands with >=3 mentions): {jac:.2f}")
print(f"brands per answer: clean {bpa_c:.1f}, messy {bpa_m:.1f}")
print(f"distinct brands: clean {len(rc)}, messy {len(rm)}")

verdict = "MESSINESS MATTERS" if any_sig else "no significant differences — polish does not bias the measurement"
print(f"\nVERDICT: {verdict}")
