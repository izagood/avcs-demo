#!/usr/bin/env bash
# avcs-demo — what happens when two agents edit the same file at the same time?
#
# Runs end to end against the published @izagood/avcs release, entirely inside
# ./sandbox (wiped on every run). Your real ~/.avcs keystore is never touched:
# the demo points AVCS_CONFIG_HOME at the sandbox.
#
# Three acts:
#   1. solo basics        — init → import → edit → commit → log/blame
#   2. concurrent, apart  — two clones edit DISJOINT regions of one file → auto-merge
#   3. concurrent, collide— two clones edit the SAME line → a first-class conflict,
#                           resolved by a signed human decision, then landed
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SANDBOX="$ROOT/sandbox"
export AVCS_CONFIG_HOME="$SANDBOX/avcs-home"   # keystore isolation: nothing leaks into ~/.avcs

# ── helpers ──────────────────────────────────────────────────────────────────
say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  \033[2m%s\033[0m\n' "$*"; }
avcs() { printf '  \033[36m$ avcs %s\033[0m\n' "$*"; "$AVCS" "$@"; }

# replace an exact string in a file, failing loudly if it is not there
edit_replace() {
  node -e '
    const fs = require("fs");
    const [f, from, to] = process.argv.slice(1);
    const s = fs.readFileSync(f, "utf8");
    if (!s.includes(from)) { console.error("edit failed: pattern not found in " + f); process.exit(1); }
    fs.writeFileSync(f, s.replace(from, to));
  ' "$1" "$2" "$3"
}

# ── setup ────────────────────────────────────────────────────────────────────
say "== setup: installing @izagood/avcs from npm (local to this repo) =="
cd "$ROOT"
[ -x "$ROOT/node_modules/.bin/avcs" ] || npm install --no-audit --no-fund
AVCS="$ROOT/node_modules/.bin/avcs"
"$AVCS" version

rm -rf "$SANDBOX"
mkdir -p "$SANDBOX/project"
cp -R "$ROOT/src" "$ROOT/test" "$SANDBOX/project/"
cat > "$SANDBOX/project/package.json" <<'EOF'
{ "name": "todo-example", "private": true, "type": "module",
  "scripts": { "test": "node --test test/*.test.js" } }
EOF

# ── act 1: solo basics ───────────────────────────────────────────────────────
say "== act 1: a repo on your disk is a complete VCS (no server, no git) =="
cd "$SANDBOX/project"
# --no-hooks matters here: the sandbox sits inside THIS git repo, and installing the
# git-bridge hooks would put them on the enclosing repo — every later `git commit` in
# your clone would then look for an AVCS repo that lives one directory down.
avcs init . --no-hooks
avcs key provision human:dev
avcs import . -m "initial import"

note "edit a file the ordinary way, then record the change as *operations* (not a git commit):"
cat >> src/todo.js <<'EOF'

export function clearCompleted(store) {
  store.items = store.items.filter((it) => !it.done);
}
EOF
avcs commit -m "add clearCompleted()" --author human:dev

avcs log
avcs blame file:src/todo.js
note "blame answers who owns this file and WHY — the purpose travels with the operation."

# ── act 2: two agents, disjoint edits → auto-merge ───────────────────────────
say "== act 2: alice and bob edit the SAME file, in DIFFERENT places =="
note "starting a hub over the project so two clones can collaborate…"
PORT="${AVCS_DEMO_PORT:-0}"
if [ "$PORT" = 0 ]; then
  for p in 4816 4817 4818 4819 4820; do
    if ! (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then PORT=$p; break; fi
  done
fi
"$AVCS" serve "$SANDBOX/project" --port "$PORT" > "$SANDBOX/hub.log" 2>&1 &
HUB_PID=$!
trap 'kill "$HUB_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break
  sleep 0.1
done
note "hub is up at http://127.0.0.1:$PORT"

cd "$SANDBOX"
avcs clone "http://127.0.0.1:$PORT" alice --as human:alice
avcs clone "http://127.0.0.1:$PORT" bob   --as human:bob
(cd alice && "$AVCS" key provision human:alice)
(cd bob   && "$AVCS" key provision human:bob)

note "alice touches the TOP of src/todo.js (createStore)…"
edit_replace alice/src/todo.js \
  "return { items: [], nextId: 1 };" \
  "return { items: [], nextId: 1, createdAt: Date.now() };"

note "…while bob, who has NOT seen alice's edit, appends at the BOTTOM:"
cat >> bob/src/todo.js <<'EOF'

export function removeItem(store, id) {
  store.items = store.items.filter((it) => it.id !== id);
}
EOF

(cd alice && avcs commit -m "track store creation time" --author human:alice \
          && avcs land --as human:alice -m "alice: createdAt")
note "bob's head is now STALE — in git this push would be rejected ('fetch first')."
note "avcs land absorbs the stale head on the hub side instead:"
(cd bob   && avcs commit -m "add removeItem()" --author human:bob \
          && avcs land --as human:bob -m "bob: removeItem")

note "both edits are in — disjoint line regions auto-merge (L0/L1), no markers, no rebase:"
(cd bob && avcs sync && avcs checkout && grep -n "createdAt\|removeItem" src/todo.js)
(cd bob && avcs log)
note "the last two entries share one sequence number: concurrent sibling operations"
note "in the DAG — neither was rebased onto the other."

# ── act 3: two agents, the same line → a decision, not conflict markers ─────
say "== act 3: alice and bob now edit the SAME LINE differently =="
(cd alice && avcs sync && avcs checkout)

edit_replace alice/src/todo.js \
  'throw new Error(`no item ${id}`);' \
  'throw new Error(`todo item ${id} not found`);'
edit_replace bob/src/todo.js \
  'throw new Error(`no item ${id}`);' \
  'throw new Error(`unknown todo id: ${id}`);'

(cd alice && avcs commit -m "clearer not-found message" --author human:alice \
          && avcs land --as human:alice -m "alice: not-found message")

note "bob lands the overlapping edit — this cannot auto-merge (L2):"
(cd bob && avcs commit -m "reword not-found error" --author human:bob) || true
(cd bob && avcs land --as human:bob -m "bob: not-found message") || true
note "in git this moment is <<<<<<< markers inside your file. Here the file stays"
note "clean; the conflict is an OBJECT that lists both operations and waits for a decision:"
(cd bob && avcs conflicts)

note "a human resolves it by recording a SIGNED decision (chosen op + rationale)."
note "(agents use the MCP tool avcs.decision.record; humans use this verb)"
CONFLICT_ID="$( (cd bob && "$AVCS" conflicts) | grep -o 'conflict_[a-f0-9]*' | head -1)"
BOB_OP="$( (cd bob && "$AVCS" conflicts) | grep -B1 'human:bob' | grep -o 'operation_[a-f0-9]*' | head -1)"
DECISION_OUT="$( (cd bob && avcs decide "$CONFLICT_ID" --choose "$BOB_OP" \
                    --reason "bob reviewed both wordings and kept his" --as human:bob) )"
DECISION_OID="$(printf '%s' "$DECISION_OUT" | grep -o 'decision_[a-f0-9]*' | head -1)"

note "with the decision in history, the same land now goes through:"
(cd bob && avcs land --as human:bob -m "bob: not-found message (after decision)")

say "== what history remembers =="
(cd bob && avcs checkout && grep -n "throw new Error" src/todo.js)
(cd bob && avcs blame file:src/todo.js)
note "the decision itself is a signed, recallable object — the rationale outlives the merge:"
(cd bob && avcs show "$DECISION_OID")
(cd bob && avcs status)

say "== done =="
note "sandbox left in ./sandbox for inspection (wiped on the next run)."
note "next: read agent-session.md — the same workflow driven by an AI agent over MCP."
