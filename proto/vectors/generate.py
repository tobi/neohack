#!/usr/bin/env python3
"""Regenerate golden vectors from the real headless engine.
Usage: generate.py <playground-dir> <out-dir> <seed>
Runs three scripted sessions and writes handshake/errors/gameplay jsonl
in {dir, line} format (dir = c2e client->engine, e2c engine->client).
All bytes after "E>" / "C>" markers are verbatim engine/client lines.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

pg_src, out_dir, seed = sys.argv[1], sys.argv[2], int(sys.argv[3])
os.makedirs(out_dir, exist_ok=True)


def run(lines, cwd):
    import os as _os
    env = dict(_os.environ, NETHACKDIR=cwd, NETHACKOPTIONS="!tutorial")
    p = subprocess.Popen(
        ["./nethack"], cwd=cwd, stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True, bufsize=1, env=env)
    out = []
    for ln in lines:
        p.stdin.write(ln + "\n")
    p.stdin.flush()
    # read until the engine blocks (no more output within budget) — we
    # feed inputs lazily via answer(); simpler: close after handshake
    # lines and drain with timeout.
    import select
    p.stdin.close()
    try:
        rest, _ = p.communicate(timeout=10)
        out = rest.splitlines()
    except subprocess.TimeoutExpired:
        p.kill()
        rest, _ = p.communicate()
        out = rest.splitlines()
    return out


def emit(path, pairs):
    with open(path, "w") as f:
        for direction, line in pairs:
            try:
                body = json.loads(line)
            except json.JSONDecodeError:
                body = {"_raw": line}
            f.write(json.dumps({"dir": direction, "line": body}) + "\n")


def fresh_pg():
    d = tempfile.mkdtemp(prefix="nhvec-")
    shutil.copytree(pg_src, os.path.join(d, "pg"),
                    ignore=shutil.ignore_patterns("save"))
    os.makedirs(os.path.join(d, "pg", "save"), exist_ok=True)
    return os.path.join(d, "pg")


# 1. handshake: good init, out-of-order method, garbage, bad version, re-init, new_game
pg = fresh_pg()
hs_in = [
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"0.1"}}',
    '{"jsonrpc":"2.0","id":2,"method":"bogus","params":{}}',
    'not json at all',
    '{"jsonrpc":"2.0","id":3,"method":"initialize","params":{"protocolVersion":"9.9"}}',
    '{"jsonrpc":"2.0","id":4,"method":"initialize","params":{"protocolVersion":"0.1"}}',
    json.dumps({"jsonrpc": "2.0", "id": 5, "method": "new_game",
                "params": {"seed": seed, "name": "vector", "role": 1,
                           "race": 0, "gender": 0, "align": 1}}),
]
hs_out = run(hs_in, pg)
pairs = [("c2e", ln) for ln in hs_in[:2]] + [("c2e-raw", "not json at all")] + \
        [("c2e", ln) for ln in hs_in[3:]]
for ln in hs_out[:6]:
    pairs.append(("e2c", ln))
emit(os.path.join(out_dir, "handshake.jsonl"), pairs)

# 2. errors: version mismatch then clean handshake
pg = fresh_pg()
er_in = [
    '{"jsonrpc":"2.0","id":11,"method":"initialize","params":{"protocolVersion":"9.9"}}',
    '{"jsonrpc":"2.0","id":12,"method":"initialize","params":{"protocolVersion":"0.1"}}',
    '{"jsonrpc":"2.0","id":13,"method":"new_game","params":{"seed":1}}',
]
er_out = run(er_in, pg)
pairs = [("c2e", ln) for ln in er_in]
for ln in er_out[:3]:
    pairs.append(("e2c", ln))
emit(os.path.join(out_dir, "errors.jsonl"), pairs)

# 3. gameplay: handshake + first input exchange + one move + delta sample.
# Answers: ack/menu/yn/getlin/msgmenu/extcmd canned, first poskey = 'j'.
pg = fresh_pg()
import os as _os2
genv = dict(_os2.environ, NETHACKDIR=pg, NETHACKOPTIONS="!tutorial")
p = subprocess.Popen(
    ["./nethack"], cwd=pg, stdin=subprocess.PIPE,
    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    text=True, bufsize=1, env=genv)
gpairs = []


def gsay(obj):
    line = json.dumps(obj)
    gpairs.append(("c2e", line))
    p.stdin.write(line + "\n")
    p.stdin.flush()


gsay({"jsonrpc": "2.0", "id": 1, "method": "initialize",
      "params": {"protocolVersion": "0.1"}})
gsay({"jsonrpc": "2.0", "id": 2, "method": "new_game",
      "params": {"seed": seed, "name": "vector", "role": 1, "race": 0,
                 "gender": 0, "align": 1}})
got_snapshot = False
moves_done = 0
want_delta = False
while True:
    line = p.stdout.readline()
    if not line:
        break
    gpairs.append(("e2c", line.rstrip("\n")))
    try:
        msg = json.loads(line)
    except json.JSONDecodeError:
        continue
    if msg.get("method") == "snapshot":
        got_snapshot = True
    if msg.get("method") == "input":
        kind = msg["params"]["kind"]
        rid = msg["id"]
        if kind == "menu":
            gsay({"jsonrpc": "2.0", "id": rid,
                  "result": {"picks": [1], "counts": []}})
        elif kind in ("poskey", "key"):
            if moves_done < 1:
                moves_done += 1
                gsay({"jsonrpc": "2.0", "id": rid,
                      "result": {"x": 0, "y": 0, "mod": 0, "key": 106}})
            else:
                break
        elif kind == "yn":
            gsay({"jsonrpc": "2.0", "id": rid, "result": {"answer": "n"}})
        elif kind == "getlin":
            gsay({"jsonrpc": "2.0", "id": rid, "result": {"line": ""}})
        elif kind == "msgmenu":
            gsay({"jsonrpc": "2.0", "id": rid, "result": {"answer": "\r"}})
        elif kind == "extcmd":
            gsay({"jsonrpc": "2.0", "id": rid, "result": {"index": -1}})
        else:
            gsay({"jsonrpc": "2.0", "id": rid, "result": {}})
    if moves_done >= 1 and want_delta:
        break
    if moves_done >= 1 and msg.get("method") == "map_delta":
        want_delta = True
p.stdin.close()
p.wait(timeout=20)
# trim to a readable golden sample: handshake replies + first input
# exchange + snapshot header note + the move + one delta (cells elided
# to the first 3 so the file stays reviewable).
trimmed = []
for direction, line in gpairs:
    try:
        body = json.loads(line)
    except json.JSONDecodeError:
        body = {"_raw": line}
    if isinstance(body, dict) and body.get("method") in ("snapshot", "map_delta"):
        cells = body["params"]["cells"]
        body = dict(body)
        body["params"] = dict(body["params"])
        body["params"]["cells"] = cells[:3]
        body["params"]["_cells_elided"] = len(cells) - 3
        line = json.dumps(body)
    trimmed.append((direction, line))
emit(os.path.join(out_dir, "gameplay.jsonl"), trimmed)
print("vectors written to", out_dir)
