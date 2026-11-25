#!/usr/bin/env python3
"""Copy two arms' answers to coded names so the judge does not know which is which.

usage: blind.py <out-dir> <blind-dir> <labelA> <labelB> [task-glob]
Writes <blind-dir>/<task>/{x,y}.md and <blind-dir>/.map.tsv (task, x-label, y-label).
The judge reads x/y only and opens .map.tsv after every score is recorded.
"""
import fnmatch, os, random, shutil, sys

out, blind, la, lb = sys.argv[1:5]
glob = sys.argv[5] if len(sys.argv) > 5 else "*"
rng = random.Random(os.urandom(16))
rows = []
for task in sorted(os.listdir(out)):
    d = os.path.join(out, task)
    if not os.path.isdir(d) or not fnmatch.fnmatch(task, glob):
        continue
    a, b = os.path.join(d, la + ".md"), os.path.join(d, lb + ".md")
    if not (os.path.exists(a) and os.path.exists(b)):
        print("missing", task, os.path.exists(a), os.path.exists(b))
        continue
    pair = [(la, a), (lb, b)]
    rng.shuffle(pair)
    os.makedirs(os.path.join(blind, task), exist_ok=True)
    shutil.copy(pair[0][1], os.path.join(blind, task, "x.md"))
    shutil.copy(pair[1][1], os.path.join(blind, task, "y.md"))
    rows.append((task, pair[0][0], pair[1][0]))
with open(os.path.join(blind, ".map.tsv"), "a") as f:
    for r in rows:
        f.write("\t".join(r) + "\n")
print(len(rows), "tasks blinded")
