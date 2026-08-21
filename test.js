// Self-check: node test.js  (exits non-zero on failure)
const assert = require("assert");
const { score, rank } = require("./bootstrap.js");

const TAGS = ["ml", "machine learning", "meta-learning", "topology", "Morse theory", "ML ops"];
const r = (q) => rank(q, TAGS);

// --- subsequence matching, not prefix ---
assert.ok(score("lear", "machine learning") !== null, "matches mid-string");
assert.ok(score("mchlrn", "machine learning") !== null, "matches scattered chars");
assert.strictEqual(score("xyz", "machine learning"), null, "no match");
assert.strictEqual(score("nam", "machine"), null, "order matters");
assert.strictEqual(score("", "anything"), 0.08, "empty query matches at cost 0");

// --- ranking: exact/prefix beats scattered; fewer gaps beats more ---
assert.ok(score("ml", "ml") < score("ml", "machine learning"), "tight beats scattered");
assert.ok(score("mos", "morse theory") < score("mos", "meta-topos"), "earlier start wins");
assert.deepStrictEqual(r("ml"), ["ml", "ML ops", "meta-learning", "machine learning"]);
assert.deepStrictEqual(r("learn"), ["meta-learning", "machine learning"]);
assert.deepStrictEqual(r("top"), ["topology"]);
assert.deepStrictEqual(r("zzz"), []);

// --- case-insensitive (caller lowercases the query) ---
assert.deepStrictEqual(r("mlops"), ["ML ops"]);

// --- empty query: alphabetical passthrough, capped ---
assert.deepStrictEqual(rank("", TAGS), TAGS);
assert.strictEqual(rank("", Array.from({ length: 200 }, (_, i) => "t" + i)).length, 50);

console.log("ok");
