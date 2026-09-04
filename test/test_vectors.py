#!/usr/bin/env python3
"""Vector conformance: replay proto/vectors/*.jsonl against the real engine.
handshake/errors: byte-exact e2c match (deterministic by construction).
gameplay: ordered-subsequence match (snapshot/delta cells elided in file,
matched by method+full flag only).
Usage: test_vectors.py <repo-root> ; engine = <root>/upstream/playground.
Exits nonzero with a diff summary on mismatch.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..")
VEC = os.path.join(ROOT, "proto", "vectors")
PG_SRC = os.path.join(ROOT, "upstream", "playground")
SEED_NOTE = "gameplay vectors were captured with seed 4242; the file carries its own new_game line"

failures = []


def fresh_pg():
    d = tempfile.mkdtemp(prefix="nhvec-")
    dst = os.path.join(d, "pg")
    shutil.copytree(PG_SRC, dst, ignore=shutil.ignore_patterns("save"))
    os.makedirs(os.path.join(dst, "save"), exist_ok=True)
    return dst


def run_file(path):
    pairs = [json.loads(l) for l in open(path) if l.strip()]
    pg = fresh_pg()
    env = dict(os.environ, NETHACKDIR=pg, NETHACKOPTIONS="!tutorial")
    p = subprocess.Popen(
        ["./nethack"], cwd=pg, stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True, bufsize=1, env=env)
    actual = []

    def feed(line):
        p.stdin.write(line + "\n")
        p.stdin.flush()

    for pair in pairs:
        if pair["dir"] == "c2e":
            feed(json.dumps(pair["line"]))
        elif pair["dir"] == "c2e-raw":
            p.stdin.write(pair["line"].get("_raw", "") + "\n")
            p.stdin.flush()
    p.stdin.close()
    try:
        out, _ = p.communicate(timeout=30)
        actual = [l for l in out.splitlines() if l.strip()]
    except subprocess.TimeoutExpired:
        p.kill()
        actual = (p.communicate()[0] or "").splitlines()
    return pairs, actual


def match_line(expected, actual_line, path, idx):
    """True if actual engine line satisfies the recorded expectation."""
    try:
        got = json.loads(actual_line)
    except json.JSONDecodeError:
        return False, f"{path}:{idx}: non-JSON engine output: {actual_line[:100]}"
    exp = expected["line"]
    if not isinstance(exp, dict) or exp.get("method") != got.get("method"):
        return False, f"{path}:{idx}: method/order mismatch:\n  want {str(exp)[:140]}\n  got  {actual_line[:140]}"
    if exp.get("method") in ("snapshot", "map_delta") and "_cells_elided" in exp.get("params", {}):
        if exp["params"].get("full", None) != got.get("params", {}).get("full", None) \
                and exp["method"] == "snapshot":
            return False, f"{path}:{idx}: snapshot full flag differs"
        return True, ""
    if exp != got:
        return False, f"{path}:{idx}:\n  want {str(exp)[:200]}\n  got  {actual_line[:200]}"
    return True, ""


def check_exact(name):
    pairs, actual = run_file(os.path.join(VEC, name))
    want = [p for p in pairs if p["dir"] == "e2c"]
    ok = True
    if len(want) > len(actual):
        failures.append(f"{name}: engine emitted {len(actual)} lines, want {len(want)}")
        return
    for i, w in enumerate(want):
        good, msg = match_line(w, actual[i], name, i + 1)
        if not good:
            failures.append(msg)
            ok = False
    print(f"{name}: {'OK' if ok and not failures else 'checked'} "
          f"({len(want)} lines)")


def check_gameplay():
    name = "gameplay.jsonl"
    pairs, actual = run_file(os.path.join(VEC, name))
    want = [p for p in pairs if p["dir"] == "e2c"]
    ai = 0
    ok = True
    for i, w in enumerate(want):
        found = -1
        for j in range(ai, len(actual)):
            good, _ = match_line(w, actual[j], name, i + 1)
            if good:
                found = j
                break
        if found < 0:
            failures.append(f"{name}:{i + 1}: expected line not found in order: "
                            f"{str(w['line'])[:160]}")
            ok = False
        else:
            ai = found + 1
    print(f"{name}: {'OK' if ok else 'MISMATCH'} "
          f"({len(want)} expected, {len(actual)} actual)")


check_exact("handshake.jsonl")
check_exact("errors.jsonl")
check_gameplay()
if failures:
    print(f"\n{len(failures)} FAILURES:")
    for f in failures[:10]:
        print("-", f)
    sys.exit(1)
print("\nALL VECTORS CONFORM")
