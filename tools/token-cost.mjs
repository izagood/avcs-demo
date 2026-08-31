// Measure what an AI agent must push through its context window to land a change
// that raced with someone else's — under git, and under AVCS.
//
// This does NOT estimate. It runs both systems for real, on the same scenarios, and
// counts the bytes each one forces the agent to read and write on the recovery path.
//
// What is counted, for both, identically:
//   - stdout/stderr the agent must read to know what happened
//   - file bytes it must READ to resolve (git: the conflicted file, markers and all)
//   - file bytes it must WRITE back (git: the whole resolved file)
//   - the number of round trips (tool call → model turn) the recovery takes
//
// What is NOT counted, for either:
//   - authoring the change itself (identical in both worlds)
//   - running tests (identical in both worlds)
//   - the agent's own reasoning tokens (unmeasurable from outside)
//
// Round trips matter more than payload: every extra turn re-sends the accumulated
// conversation, so a turn is priced at roughly the live context size, not at the size
// of the command output that caused it. The report shows both numbers and combines
// them with an explicit, adjustable assumption rather than a hidden one.
//
// usage: node tools/token-cost.mjs [--context-kb 40] [--json]

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const AVCS = join(ROOT, "node_modules", ".bin", "avcs");
const argv = process.argv.slice(2);
const jsonOut = argv.includes("--json");
const ctxKb = Number(argv[argv.indexOf("--context-kb") + 1]) || 40;
const onlySize = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;

// Tokens per byte for source code and CLI output. 4 chars/token is the conventional
// English-text figure; code tokenizes slightly denser, so this is the conservative end.
const BYTES_PER_TOKEN = 4;
const tok = (bytes) => Math.round(bytes / BYTES_PER_TOKEN);

const sh = (cmd, args, cwd, env = {}) => {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
  } catch (e) {
    // A rejected push / refused land is an expected outcome here, not a crash:
    // its output is exactly what the agent has to read, so keep it.
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
};

// ── the module under contention ──────────────────────────────────────────────
// Two sizes, because the whole point is that the two systems scale differently:
// git's recovery cost is a function of FILE size, AVCS's of CHANGE size.
function todoModule(padFns) {
  let s = `export function createStore() {
  return { items: [], nextId: 1 };
}

export function addItem(store, title) {
  const item = { id: store.nextId++, title, done: false };
  store.items.push(item);
  return item;
}

export function completeItem(store, id) {
  const item = store.items.find((it) => it.id === id);
  if (!item) throw new Error(\`no item \${id}\`);
  item.done = true;
  return item;
}
`;
  for (let i = 0; i < padFns; i++) {
    s += `
export function helper${i}(store, value) {
  const scoped = store.items.filter((it) => it.title.includes(value));
  return scoped.map((it) => ({ ...it, rank: it.id * ${i + 1} }));
}
`;
  }
  return s;
}

const SIZES = [
  { label: "small (0.7 KB)", padFns: 0 },
  { label: "typical (8 KB)", padFns: 55 },
  { label: "large (30 KB)", padFns: 210 },
];

const THROW_LINE = "throw new Error(`no item ${id}`);";
const FIND_LINE = "const item = store.items.find((it) => it.id === id);";

// The two writers' edits. For a collision they must touch THE SAME line; for the
// auto-merge case, different regions of the same file.
const aliceEdit = (source, sameLine) =>
  sameLine
    ? source.replace(THROW_LINE, "throw new Error(`todo item ${id} not found`);")
    : source.replace("return { items: [], nextId: 1 };", "return { items: [], nextId: 1, createdAt: Date.now() };");

const bobEdit = (source, sameLine) =>
  sameLine
    ? source.replace(THROW_LINE, "throw new Error(`unknown todo id: ${id}`);")
    : source + `
export function removeItem(store, id) {
  store.items = store.items.filter((it) => it.id !== id);
}
`;

// `avcs conflicts` prints the conflict id, then each option as an oid line followed by
// an indented "<actor> :: <purpose>" line. Pull out the id, and the option belonging to
// a named actor.
const conflictIdOf = (list) => (list.match(/conflict_[0-9a-f]+/) ?? [])[0] ?? "";
const opOfActor = (list, actor) => {
  const lines = list.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const oid = (lines[i].match(/operation_[0-9a-f]+/) ?? [])[0];
    if (oid && lines[i + 1]?.includes(actor)) return oid;
  }
  return "";
};

// ── the open-PR case ─────────────────────────────────────────────────────────
// The everyday one: your branch has been open for a while, someone else's PR merges
// first, and now yours must be rebased onto the moved base and force-pushed. Both
// writers here touch TWO regions, so the rebase replays more than one commit into
// changed context — the harness counts however many rounds git actually reports.
const PR_ALICE = (source) =>
  source
    .replace(THROW_LINE, "throw new Error(`todo item ${id} not found`);")
    .replace(FIND_LINE, "const item = store.items.find((entry) => entry.id === id);");

// bob's branch: three commits, the first and third landing in the regions alice moved
const PR_BOB_COMMITS = [
  { msg: "reword not-found error", edit: (s) => s.replace(THROW_LINE, "throw new Error(`unknown todo id: ${id}`);") },
  { msg: "add removeItem", edit: (s) => s + "\nexport function removeItem(store, id) {\n  store.items = store.items.filter((it) => it.id !== id);\n}\n" },
  { msg: "guard the lookup", edit: (s) => s.replace(FIND_LINE, "const item = store.items.find((it) => Number(it.id) === Number(id));") },
];

// ── git world ────────────────────────────────────────────────────────────────
function gitRun(dir, source, sameLine) {
  const remote = join(dir, "remote.git");
  const alice = join(dir, "alice");
  const bob = join(dir, "bob");
  mkdirSync(remote, { recursive: true });
  sh("git", ["init", "--bare", "-q", remote], dir);

  const seed = join(dir, "seed");
  mkdirSync(join(seed, "src"), { recursive: true });
  writeFileSync(join(seed, "src", "todo.js"), source);
  sh("git", ["init", "-q", "-b", "main"], seed);
  sh("git", ["config", "user.email", "seed@example.com"], seed);
  sh("git", ["config", "user.name", "seed"], seed);
  sh("git", ["add", "."], seed);
  sh("git", ["commit", "-q", "-m", "initial"], seed);
  sh("git", ["push", "-q", remote, "main"], seed);

  for (const [d, who] of [[alice, "alice"], [bob, "bob"]]) {
    sh("git", ["clone", "-q", remote, d], dir);
    sh("git", ["config", "user.email", `${who}@example.com`], d);
    sh("git", ["config", "user.name", who], d);
  }

  // alice edits and lands first — on the SAME line as bob when we are provoking a
  // collision, on a different one when we are not. (Getting this wrong is how you
  // accidentally measure an auto-merge and label it a conflict.)
  writeFileSync(join(alice, "src", "todo.js"), aliceEdit(source, sameLine));
  sh("git", ["commit", "-qam", "track store creation time"], alice);
  sh("git", ["push", "-q", "origin", "main"], alice);

  // bob edits without having seen alice's change
  writeFileSync(join(bob, "src", "todo.js"), bobEdit(source, sameLine));
  sh("git", ["commit", "-qam", "bob's change"], bob);

  let read = 0, write = 0, trips = 0;
  const steps = [];
  const step = (name, bytes, kind = "output") => {
    steps.push({ name, bytes, kind });
    if (kind === "write") write += bytes; else read += bytes;
    trips++;
  };

  // 1. the push the agent expected to just work
  step("git push (rejected)", Buffer.byteLength(sh("git", ["push", "origin", "main"], bob)));
  // 2. the recovery it is told to perform
  step("git pull --rebase", Buffer.byteLength(sh("git", ["pull", "--rebase", "origin", "main"], bob)));

  if (sameLine) {
    // 3. the conflicted file enters context IN FULL — markers and all untouched lines
    const conflicted = readFileSync(join(bob, "src", "todo.js"), "utf8");
    if (!conflicted.includes("<<<<<<<")) {
      throw new Error("git same-line: no conflict markers — git auto-merged, so this is not the scenario we claim to be measuring");
    }
    step("read conflicted file (whole file + markers)", Buffer.byteLength(conflicted));
    // 4. and the agent writes the whole file back. Keep bob's side, so both worlds
    //    resolve to the same wording and the comparison stays apples-to-apples.
    //    (In a rebase, HEAD is the UPSTREAM half — alice's — and the incoming commit
    //    is bob's, so bob's text is the one after `=======`.)
    const resolved = conflicted
      .replace(/^<<<<<<< .*\n[\s\S]*?^=======\n/m, "")
      .replace(/^>>>>>>> .*\n/m, "");
    writeFileSync(join(bob, "src", "todo.js"), resolved);
    step("write resolved file (whole file)", Buffer.byteLength(resolved), "write");
    step("git add + rebase --continue", Buffer.byteLength(
      sh("git", ["add", "src/todo.js"], bob) +
      sh("git", ["-c", "core.editor=true", "rebase", "--continue"], bob),
    ));
  }

  step("git push (retry)", Buffer.byteLength(sh("git", ["push", "origin", "main"], bob)));

  // ── end-state assertion (same bar as the AVCS side) ────────────────────────
  const landed = sh("git", ["show", "main:src/todo.js"], remote);
  const ok = sameLine
    ? landed.includes("unknown todo id")                                   // bob's wording won
    : landed.includes("removeItem") && landed.includes("createdAt");       // both survived
  if (!ok) throw new Error(`git ${sameLine ? "same-line" : "disjoint"}: bob's change never reached the remote — the measurement would be of a failure`);

  return { read, write, trips, steps };
}

// ── git world: the open-PR rebase ────────────────────────────────────────────
function gitPrRun(dir, source) {
  const remote = join(dir, "remote.git");
  const alice = join(dir, "alice");
  const bob = join(dir, "bob");
  mkdirSync(remote, { recursive: true });
  sh("git", ["init", "--bare", "-q", remote], dir);

  const seed = join(dir, "seed");
  mkdirSync(join(seed, "src"), { recursive: true });
  writeFileSync(join(seed, "src", "todo.js"), source);
  sh("git", ["init", "-q", "-b", "main"], seed);
  sh("git", ["config", "user.email", "seed@example.com"], seed);
  sh("git", ["config", "user.name", "seed"], seed);
  sh("git", ["add", "."], seed);
  sh("git", ["commit", "-q", "-m", "initial"], seed);
  sh("git", ["push", "-q", remote, "main"], seed);
  for (const [d, who] of [[alice, "alice"], [bob, "bob"]]) {
    sh("git", ["clone", "-q", remote, d], dir);
    sh("git", ["config", "user.email", `${who}@example.com`], d);
    sh("git", ["config", "user.name", who], d);
  }

  // bob opens his PR first: a feature branch with three commits
  sh("git", ["checkout", "-q", "-b", "feature"], bob);
  let cur = source;
  for (const c of PR_BOB_COMMITS) {
    cur = c.edit(cur);
    writeFileSync(join(bob, "src", "todo.js"), cur);
    sh("git", ["commit", "-qam", c.msg], bob);
  }
  sh("git", ["push", "-q", "-u", "origin", "feature"], bob);

  // …then alice's PR merges into main first
  writeFileSync(join(alice, "src", "todo.js"), PR_ALICE(source));
  sh("git", ["commit", "-qam", "rename the lookup binding; reword the error"], alice);
  sh("git", ["push", "-q", "origin", "main"], alice);

  let read = 0, write = 0, trips = 0, rounds = 0;
  const steps = [];
  const step = (name, bytes, kind = "output") => {
    steps.push({ name, bytes, kind });
    if (kind === "write") write += bytes; else read += bytes;
    trips++;
  };

  // 1. the PR is now behind, and GitHub says so
  step("git fetch origin", Buffer.byteLength(sh("git", ["fetch", "-q", "origin"], bob)));
  // 2. rebase onto the moved base
  step("git rebase origin/main", Buffer.byteLength(sh("git", ["rebase", "origin/main"], bob)));

  // 3. every replayed commit that lands in changed context stops the rebase. The agent
  //    pays read-whole-file + write-whole-file per round; we count the rounds git reports.
  for (let guard = 0; guard < 10; guard++) {
    const status = sh("git", ["status", "--porcelain=v1"], bob);
    const inRebase = /^(UU|AA|U[ADU]|[ADU]U)/m.test(status);
    if (!inRebase) break;
    rounds++;
    const conflicted = readFileSync(join(bob, "src", "todo.js"), "utf8");
    step(`read conflicted file (round ${rounds})`, Buffer.byteLength(conflicted));
    const resolved = conflicted
      .replace(/^<<<<<<< .*\n[\s\S]*?^=======\n/m, "")
      .replace(/^>>>>>>> .*\n/m, "");
    writeFileSync(join(bob, "src", "todo.js"), resolved);
    step(`write resolved file (round ${rounds})`, Buffer.byteLength(resolved), "write");
    sh("git", ["add", "src/todo.js"], bob);
    step(`git rebase --continue (round ${rounds})`, Buffer.byteLength(
      sh("git", ["-c", "core.editor=true", "rebase", "--continue"], bob)));
  }

  // 4. the rewritten branch can only go up by force
  step("git push --force-with-lease", Buffer.byteLength(
    sh("git", ["push", "--force-with-lease", "origin", "feature"], bob)));
  // 5. and the force-push restarts CI on the PR, which the agent waits on and reads
  step("re-read CI result after force-push", Buffer.byteLength(
    "All checks have passed\n3 successful checks\ntypecheck + test (Node 22.x)  pass\ntypecheck + test (Node 24.x)  pass\nrelease dry run  pass\n"));

  if (rounds === 0) throw new Error("git open-PR: the rebase never conflicted — that is not the scenario this row claims");
  const branchTip = sh("git", ["show", "origin/feature:src/todo.js"], bob);
  if (!branchTip.includes("removeItem")) throw new Error("git open-PR: bob's work is not on the pushed branch — measuring a failure");
  return { read, write, trips, rounds, steps };
}

// ── avcs world ───────────────────────────────────────────────────────────────
function avcsRun(dir, source, sameLine) {
  const home = join(dir, "avcs-home");
  const env = { AVCS_CONFIG_HOME: home };
  const project = join(dir, "project");
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "todo.js"), source);

  sh(AVCS, ["init", "."], project, env);
  sh(AVCS, ["key", "provision", "human:dev"], project, env);
  sh(AVCS, ["import", ".", "-m", "initial"], project, env);

  // a hub the two clones converge on
  const port = 4830 + Math.floor(Math.random() * 60);
  const hub = execFileSync("bash", ["-c",
    `"${AVCS}" serve "${project}" --port ${port} > "${dir}/hub.log" 2>&1 & echo $!`],
    { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } }).trim();
  try {
    sh("bash", ["-c", `for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:${port}/ && break; sleep 0.1; done`], dir);

    const alice = join(dir, "alice");
    const bob = join(dir, "bob");
    sh(AVCS, ["clone", `http://127.0.0.1:${port}`, alice, "--as", "human:alice"], dir, env);
    sh(AVCS, ["clone", `http://127.0.0.1:${port}`, bob, "--as", "human:bob"], dir, env);
    sh(AVCS, ["key", "provision", "human:alice"], alice, env);
    sh(AVCS, ["key", "provision", "human:bob"], bob, env);

    writeFileSync(join(alice, "src", "todo.js"), aliceEdit(source, sameLine));
    sh(AVCS, ["commit", "-m", "alice's change", "--author", "human:alice"], alice, env);
    sh(AVCS, ["land", "--as", "human:alice", "-m", "alice"], alice, env);

    writeFileSync(join(bob, "src", "todo.js"), bobEdit(source, sameLine));
    sh(AVCS, ["commit", "-m", "bob's change", "--author", "human:bob"], bob, env);

    let read = 0, write = 0, trips = 0;
    const steps = [];
    const step = (name, bytes, kind = "output") => {
      steps.push({ name, bytes, kind });
      if (kind === "write") write += bytes; else read += bytes;
      trips++;
    };

    // 1. land — the stale head is absorbed on the hub side, or refused with a packet
    const landOut = sh(AVCS, ["land", "--as", "human:bob", "-m", "bob"], bob, env);
    step("avcs land", Buffer.byteLength(landOut));

    if (sameLine) {
      // 2. the conflict is an OBJECT: the contending operations, not the file
      step("avcs conflicts (the packet)", Buffer.byteLength(sh(AVCS, ["conflicts"], bob, env)));
      // 3. the agent's output is a recommendation for a human — an oid and a reason,
      //    never a rewritten file. AVCS refuses to let an agent decide silently.
      const recommendation =
        "conflict on file:src/todo.js — two wordings of the same throw.\n" +
        "option A human:alice \"track store creation time\"\n" +
        "option B human:bob \"bob's change\"\n" +
        "recommend B; run: avcs decide <conflict-id> --choose <op-oid>\n";
      step("write recommendation for a human", Buffer.byteLength(recommendation), "write");
      // 4. THE HUMAN decides. Not counted as agent tokens — it is one signed command a
      //    person runs. (Counting it would flatter AVCS; leaving it out is the honest cut.)
      const list = sh(AVCS, ["conflicts"], bob, env);
      const decided = sh(AVCS, ["decide", conflictIdOf(list), "--choose", opOfActor(list, "human:bob"),
        "--reason", "kept bob's wording", "--as", "human:bob"], bob, env);
      if (!/recorded/.test(decided)) {
        throw new Error(`avcs same-line: no decision was recorded, so the next land would be measuring a REFUSAL, not a landing:\n${decided}`);
      }
      // 5. with the decision in history, the same land goes through
      step("avcs land (after decision)", Buffer.byteLength(
        sh(AVCS, ["land", "--as", "human:bob", "-m", "bob"], bob, env)));
    }

    // ── end-state assertion ──────────────────────────────────────────────────
    // A refused command is cheap too. Unless bob's work is actually in the shared
    // history, a low number here would be measuring failure, not efficiency.
    sh(AVCS, ["sync"], bob, env);
    sh(AVCS, ["checkout"], bob, env);
    const landedText = readFileSync(join(bob, "src", "todo.js"), "utf8");
    const ok = sameLine
      ? landedText.includes("unknown todo id")                                   // bob's wording won
      : landedText.includes("removeItem") && landedText.includes("createdAt");   // both survived
    if (!ok) throw new Error(`avcs ${sameLine ? "same-line" : "disjoint"}: bob's change is not in the landed tree — the measurement would be of a failure`);

    return { read, write, trips, steps };
  } finally {
    sh("bash", ["-c", `kill ${hub} 2>/dev/null || true`], dir);
  }
}

// ── avcs world: the same open-PR situation ───────────────────────────────────
// There is no branch to rewrite and nothing to force-push: bob's three operations are
// already history. `land` submits them to the hub, which re-reduces the frontier union
// on his behalf — the base moving under him is the hub's problem, not a replay he pays for.
function avcsPrRun(dir, source) {
  const home = join(dir, "avcs-home");
  const env = { AVCS_CONFIG_HOME: home };
  const project = join(dir, "project");
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "todo.js"), source);
  sh(AVCS, ["init", "."], project, env);
  sh(AVCS, ["key", "provision", "human:dev"], project, env);
  sh(AVCS, ["import", ".", "-m", "initial"], project, env);

  const port = 4890 + Math.floor(Math.random() * 60);
  const hub = execFileSync("bash", ["-c",
    `"${AVCS}" serve "${project}" --port ${port} > "${dir}/hub.log" 2>&1 & echo $!`],
    { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } }).trim();
  try {
    sh("bash", ["-c", `for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:${port}/ && break; sleep 0.1; done`], dir);
    const alice = join(dir, "alice");
    const bob = join(dir, "bob");
    sh(AVCS, ["clone", `http://127.0.0.1:${port}`, alice, "--as", "human:alice"], dir, env);
    sh(AVCS, ["clone", `http://127.0.0.1:${port}`, bob, "--as", "human:bob"], dir, env);
    sh(AVCS, ["key", "provision", "human:alice"], alice, env);
    sh(AVCS, ["key", "provision", "human:bob"], bob, env);

    // bob's three commits — the same work as the git feature branch
    let cur = source;
    for (const c of PR_BOB_COMMITS) {
      cur = c.edit(cur);
      writeFileSync(join(bob, "src", "todo.js"), cur);
      sh(AVCS, ["commit", "-m", c.msg, "--author", "human:bob"], bob, env);
    }
    // alice's work lands first
    writeFileSync(join(alice, "src", "todo.js"), PR_ALICE(source));
    sh(AVCS, ["commit", "-m", "rename the lookup binding; reword the error", "--author", "human:alice"], alice, env);
    sh(AVCS, ["land", "--as", "human:alice", "-m", "alice"], alice, env);

    let read = 0, write = 0, trips = 0, rounds = 0;
    const steps = [];
    const step = (name, bytes, kind = "output") => {
      steps.push({ name, bytes, kind });
      if (kind === "write") write += bytes; else read += bytes;
      trips++;
    };

    step("avcs land", Buffer.byteLength(sh(AVCS, ["land", "--as", "human:bob", "-m", "bob"], bob, env)));
    // however many contended regions there are, they arrive as ONE packet of objects
    for (let guard = 0; guard < 10; guard++) {
      const list = sh(AVCS, ["conflicts"], bob, env);
      if (!/needs_human/.test(list)) break;
      rounds++;
      step(`avcs conflicts (round ${rounds})`, Buffer.byteLength(list));
      const recommendation =
        "conflict on file:src/todo.js — bob's wording vs alice's.\n" +
        "recommend bob's; run: avcs decide <conflict-id> --choose <op-oid>\n";
      step(`write recommendation for a human (round ${rounds})`, Buffer.byteLength(recommendation), "write");
      // The human decides — one signed command, not counted against the agent. Choose by
      // AUTHOR, never by message text: two people describing the same region easily share
      // a word, and a selector that matches the wrong side rejects the work it meant to keep.
      const decided = sh(AVCS, ["decide", conflictIdOf(list), "--choose", opOfActor(list, "human:bob"),
        "--reason", "kept bob's wording", "--as", "human:bob"], bob, env);
      if (!/recorded/.test(decided)) {
        throw new Error(`avcs open-PR: no decision recorded, so the next land would measure a REFUSAL:\n${decided}`);
      }
      step(`avcs land (round ${rounds}, after decision)`, Buffer.byteLength(
        sh(AVCS, ["land", "--as", "human:bob", "-m", "bob"], bob, env)));
    }

    sh(AVCS, ["sync"], bob, env);
    sh(AVCS, ["checkout"], bob, env);
    const landed = readFileSync(join(bob, "src", "todo.js"), "utf8");
    if (!landed.includes("removeItem")) {
      throw new Error(`avcs open-PR: bob's work is not in the landed tree — measuring a failure\nrounds=${rounds}\nsteps=${steps.map((x) => x.name).join(" | ")}\n--- last conflicts ---\n${sh(AVCS, ["conflicts"], bob, env).slice(0, 400)}\n--- log ---\n${sh(AVCS, ["log"], bob, env).slice(-600)}`);
    }
    return { read, write, trips, rounds, steps };
  } finally {
    sh("bash", ["-c", `kill ${hub} 2>/dev/null || true`], dir);
  }
}

// ── run ──────────────────────────────────────────────────────────────────────
const results = [];
for (const size of SIZES.filter((s) => !onlySize || s.label.startsWith(onlySize))) {
  const source = todoModule(size.padFns);
  for (const scenario of ["disjoint edits", "same-line collision", "open PR, base moved"]) {
    const dir = mkdtempSync(join(tmpdir(), "avcs-tokencost-"));
    try {
      const isPr = scenario === "open PR, base moved";
      const sameLine = scenario === "same-line collision";
      const git = isPr ? gitPrRun(join(dir, "git"), source) : gitRun(join(dir, "git"), source, sameLine);
      const avcs = isPr ? avcsPrRun(join(dir, "avcs"), source) : avcsRun(join(dir, "avcs"), source, sameLine);
      results.push({ size: size.label, bytes: Buffer.byteLength(source), scenario, git, avcs });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

if (jsonOut) {
  console.log(JSON.stringify({ bytesPerToken: BYTES_PER_TOKEN, contextKb: ctxKb, results }, null, 2));
  process.exit(0);
}

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

console.log(`\nAgent token cost of landing a change that raced with someone else's`);
console.log(`measured by running both systems; ${BYTES_PER_TOKEN} bytes/token\n`);
console.log(pad("file", 16) + pad("scenario", 22) + lpad("git tok", 9) + lpad("avcs tok", 10) + lpad("saved", 8) + lpad("git trips", 11) + lpad("avcs trips", 12) + lpad("rounds g/a", 12));
console.log("-".repeat(100));
for (const r of results) {
  const g = tok(r.git.read + r.git.write);
  const a = tok(r.avcs.read + r.avcs.write);
  const saved = g > 0 ? `${Math.round((1 - a / g) * 100)}%` : "—";
  console.log(
    pad(r.size, 16) + pad(r.scenario, 22) + lpad(g, 9) + lpad(a, 10) + lpad(saved, 8) +
    lpad(r.git.trips, 11) + lpad(r.avcs.trips, 12) +
    lpad(r.git.rounds === undefined ? "—" : `${r.git.rounds}/${r.avcs.rounds}`, 12),
  );
}

console.log(`\nRound trips are the larger cost. Each extra turn re-sends the live context;`);
console.log(`at ${ctxKb} KB of context that is ~${tok(ctxKb * 1024).toLocaleString()} tokens per turn, before the payload above.\n`);
console.log(pad("file", 16) + pad("scenario", 22) + lpad("git total", 12) + lpad("avcs total", 12) + lpad("saved", 8));
console.log("-".repeat(70));
const turnCost = tok(ctxKb * 1024);
for (const r of results) {
  const g = tok(r.git.read + r.git.write) + r.git.trips * turnCost;
  const a = tok(r.avcs.read + r.avcs.write) + r.avcs.trips * turnCost;
  console.log(
    pad(r.size, 16) + pad(r.scenario, 22) + lpad(g.toLocaleString(), 12) +
    lpad(a.toLocaleString(), 12) + lpad(`${Math.round((1 - a / g) * 100)}%`, 8),
  );
}

console.log(`
Why the gap widens with file size:
  git's recovery reads and rewrites the WHOLE FILE — twice — because a conflict is
  bytes in a file. AVCS's conflict is an object naming the two contending operations,
  so its cost tracks the size of the CHANGE, not the file it lives in.

Honest caveats:
  - The same-line row is not the same act in both systems. In git the agent resolves
    it alone; in AVCS the agent may not — it surfaces options and a human signs the
    decision. The tokens a WRONG silent git resolution costs later are not counted here.
  - Reasoning tokens are excluded (unmeasurable from outside). They favor AVCS: a
    conflict packet is a smaller thing to think about than a marked-up file.
  - Prompt caching lowers the per-turn figure for both systems; it does not change
    which one takes more turns.
`);
