# agent-session.md — the same work, driven by an agent over MCP

`demo.sh` plays both collaborators from the CLI. This document is what the **intended**
first user of AVCS looks like: an AI agent (here, Claude Code) connected to the repo
through the `avcs mcp` server. It is written as a session record — the tool calls an agent
actually makes, in order, with representative responses (oids shortened).

It follows the canonical 9-step loop from the
[agent quickstart](https://github.com/izagood/avcs/blob/main/docs/25-agent-quickstart.md).
The agent's very first call in an unfamiliar repo is always `avcs.guide`, which returns
this loop plus the rules — an agent that has never seen AVCS bootstraps from one tool call.

## Setup (once, by the human)

```bash
npm install -g @izagood/avcs
avcs mcp install                    # = `claude mcp add avcs -- avcs mcp`

cd todo-project
avcs init .
avcs import . -m "initial import"
avcs key provision human:dev        # the human's signing identity (decisions need it)
```

## Part 1 — a clean pass: reword the not-found error

> **User:** the error `completeItem` throws is unhelpful — reword it to name the id.

### 1–2. Open work against an intent

```jsonc
// the human (or an orchestrator) declares WHY before anyone writes anything
avcs.intent.create {
  title: "completeItem: not-found error should name the id",
  owner: "human:dev", kind: "refactor",
  allowedScopes: ["file:src/todo.js", "file:test/todo.test.js"]
}
→ "intent_a41f…"

avcs.session.start {
  intentOid: "intent_a41f…",
  actor: { id: "ai_agent:claude", kind: "ai_agent" }
}
→ "session_09be…"
```

### 3–4. Look before writing

```jsonc
avcs.context.build { intentOid: "intent_a41f…" }
→ { scopes: ["file:src/todo.js", "file:test/todo.test.js"],
    priorDecisions: [],            // nobody has ruled on this area before
    liveRisks: [] }

avcs.contention.check { keys: ["file:src/todo.js"], sessionOid: "session_09be…" }
→ []                               // nobody else is in this file right now

avcs.lease.request {
  intentOid: "intent_a41f…", sessionOid: "session_09be…",
  actor: { id: "ai_agent:claude", kind: "ai_agent" },
  writeScopes: [{ kind: "file", id: "src/todo.js" }]
}
→ { granted: true, leaseOid: "lease_31c8…" }
```

### 5. The change is an operation, not a file write

The agent never writes the final file itself — it submits the new content as a
*proposed operation*, with its effects declared honestly (the declaration is load-bearing):

```jsonc
avcs.operation.propose {
  sessionOid: "session_09be…", intentOid: "intent_a41f…",
  actor: { id: "ai_agent:claude", kind: "ai_agent" },
  path: "src/todo.js",
  content: "<full new file text — the throw line now reads: `unknown todo id: ${id}`>",
  declaredPurpose: "reword not-found error to name the id",
  effects: { changesBehavior: true, breaksPublicApi: false }
}
→ "operation_77c2…"
```

### 6–7. A behavior change needs evidence — or the reducer blocks it at L3

`changesBehavior: true` with no *trusted* evidence grades the operation **L3 — blocked**.
The validation run counts because the **ci actor** signs it, not the operation's author;
an author vouching for its own change does not.

```jsonc
avcs.validate.run {
  ops: ["operation_77c2…"],
  ciActor: { id: "ci_bot:runner", kind: "ci_bot" },
  checks: [{ kind: "test", command: "npm test" }]
}
→ ["evidence_5d10…"]               // signed, bound to the op's treeHash
```

### 8–9. Merge-check, then land in one call

```jsonc
avcs.view.materialize { view: "main" }
→ { conflicts: [], treeHash: "9f3a…" }

avcs.sync.land { by: "ai_agent:claude" }
→ { outcome: "landed", checkpoint: "checkpoint_c8e4…" }
```

`sync.land` never says "pull first". If the head moved while the agent worked, the hub
absorbs the stale head and re-reduces — the outcome is `landed`, or a conflict packet for
a human. There is no rebase-and-retry loop to burn agent turns on.

### What the human sees afterwards

```bash
avcs log                        # […] ai_agent:claude  edit_file file:src/todo.js — reword not-found error…
avcs blame file:src/todo.js    # who owns it, the why, the intent behind it
avcs conflicts                  # decisions a human still owes (empty on this pass)
```

The review surface is not a text diff: it is intent → operation → evidence → checkpoint,
each a signed object in history.

## Part 2 — the collision: what Act 3 of demo.sh looks like to an agent

Meanwhile another session (alice's) landed a *different* rewording of the same line.
This agent's `sync.land` does not merge silently and does not throw markers into the file:

```jsonc
avcs.sync.land { by: "ai_agent:claude" }
→ { outcome: "conflict",
    conflicts: [{
      id: "conflict_4d8f…", key: "file:src/todo.js", kind: "needs_human",
      reason: "concurrent edits to src/todo.js overlap on 1 line range(s) — a human/policy must choose",
      options: [
        { opOid: "operation_4472…", purpose: "clearer not-found message" },   // alice's
        { opOid: "operation_4498…", purpose: "reword not-found error" }        // ours
      ]
    }],
    nextActions: [
      "avcs.conflict.list",
      "present the options to a human, then avcs.decision.record",
      "avcs.sync.land (again, once the decision is recorded)"
    ] }
```

The rules `avcs.guide` returned earlier apply here: **on a conflict, produce options for a
human; do not silently overwrite.** So the agent summarizes both operations — authors,
declared purposes, the exact line each produces — and asks.

> **Agent:** two concurrent rewordings of the same line. alice's:
> ``todo item ${id} not found`` — ours: ``unknown todo id: ${id}``. Which should win?
>
> **User:** keep ours.

```jsonc
avcs.decision.record {
  conflictId: "conflict_4d8f…",
  chosenOps: ["operation_4498…"],
  rejectedOps: ["operation_4472…"],
  reason: "human:dev reviewed both wordings and kept the id-first phrasing",
  actor: { id: "human:dev", kind: "human" }
}
// the server now elicits confirmation from the HUMAN, then signs with the human's
// local key — a decision by an ai_agent actor is refused outright:
//   "avcs.decision.record requires a human actor; agents may not resolve their own conflicts"
→ "decision_5f4e…"

avcs.sync.land { by: "ai_agent:claude" }
→ { outcome: "landed", checkpoint: "checkpoint_d213…" }
```

Two properties worth noticing, because no git workflow has them:

- **The agent physically cannot resolve the conflict alone.** `avcs.decision.record`
  refuses non-human actors, requires the owner's confirmation via MCP elicitation, and the
  decision is signed with the owner's *local* private key — which the agent never holds.
- **The decision outlives the merge.** It is a content-addressed, signed object
  (`avcs show decision_5f4e…`), recallable the next time this area conflicts
  (`priorDecisions` in step 3), and it biases future auto-resolution.

## The rules the server itself tells agents

`avcs.guide` returns these with the loop; they are the contract, not etiquette:

1. Never write final files directly — submit `avcs.operation.propose`.
2. Declare effects (`changesBehavior` / `breaksPublicApi`) honestly.
3. A behavior change cannot be accepted without passing-test evidence.
4. On a conflict, produce options for a human; do not silently overwrite.
5. Stay inside the intent's allowed scopes; widen the intent instead of exceeding it.
6. Read a failure's `nextActions` and follow them; do not improvise recovery from the message text.
