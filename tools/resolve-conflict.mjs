// Resolve the first open conflict in an AVCS repo by recording a signed human decision.
//
// In AVCS a conflict is not a broken file full of <<<<<<< markers — it is a first-class
// object listing the contending operations. Resolving it means recording a *decision*:
// which operation wins, which loses, and why. The decision is ed25519-signed with the
// human's local key, so an agent cannot forge it, and the rationale stays in history.
//
// The MCP tool for this is `avcs.decision.record` (it additionally requires the owner to
// confirm via elicitation). A CLI verb now exists too —
//   avcs decide <conflict-id> --choose <op-oid> --reason "…"
// (izagood/avcs#129, merged) — but it is not in a published release yet, and this demo runs
// against the release on npm. Once it ships, this script collapses into that one command.
//
// usage: node tools/resolve-conflict.mjs <repo-dir> <human-actor-id> <substring-of-chosen-purpose>

import { Repo } from "@izagood/avcs";

const [repoDir, actorId, want] = process.argv.slice(2);
if (!repoDir || !actorId || !want) {
  console.error("usage: node tools/resolve-conflict.mjs <repo-dir> <human-actor-id> <substring-of-chosen-purpose>");
  process.exit(2);
}

const repo = await Repo.open(repoDir);
const { conflicts } = await repo.materialize("main");
if (!conflicts.length) {
  console.log("no open conflicts — nothing to decide");
  process.exit(0);
}

const conflict = conflicts[0];
console.log(`conflict ${conflict.id}  @ ${conflict.key}`);
console.log(`  ${conflict.reason}`);

const options = [];
for (const o of conflict.options) {
  const op = await repo.store.get(o.opOid);
  options.push({ oid: o.opOid, actor: op.actor?.id, purpose: op.declaredPurpose });
}
for (const o of options) console.log(`  option: ${o.oid.slice(0, 26)}…  by ${o.actor}  — "${o.purpose}"`);

const chosen = options.find((o) => o.purpose?.includes(want));
if (!chosen) {
  console.error(`no option's declaredPurpose contains "${want}"`);
  process.exit(2);
}
const rejected = options.filter((o) => o !== chosen);

// The decision must be signed with the deciding human's LOCAL private key —
// that signature is what makes the reducer trust it.
const privateKey = await repo.loadLocalKey(actorId);
if (!privateKey) {
  console.error(`no local signing key for ${actorId} — run: avcs key provision ${actorId}`);
  process.exit(2);
}

const oid = await repo.recordDecision({
  conflictId: conflict.id,
  chosenOps: [chosen.oid],
  rejectedOps: rejected.map((o) => o.oid),
  reason: `${actorId} reviewed both edits and kept ${chosen.actor}'s: "${chosen.purpose}"`,
  decidedBy: { kind: "human", id: actorId },
  signWith: { keyId: actorId, privateKey },
});

console.log(`decision recorded: ${oid}`);
console.log(`  chose  ${chosen.actor}: "${chosen.purpose}"`);
for (const r of rejected) console.log(`  reject ${r.actor}: "${r.purpose}"`);
