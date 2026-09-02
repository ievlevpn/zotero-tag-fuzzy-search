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
assert.strictEqual(score("", "anything"), 0, "empty query matches at no cost");

// --- ranking: exact/prefix beats scattered; fewer gaps beats more ---
assert.ok(score("ml", "ml") < score("ml", "machine learning"), "tight beats scattered");
assert.ok(score("mos", "morse theory") < score("mos", "meta-topos"), "earlier start wins");
assert.deepStrictEqual(r("ml"), ["ml", "ML ops", "meta-learning", "machine learning"]);
assert.deepStrictEqual(r("learn"), ["meta-learning", "machine learning"]);
assert.deepStrictEqual(r("top"), ["topology"]);
assert.deepStrictEqual(r("zzz"), []);

// --- word starts: acronyms beat tighter mid-word matches ---
const ACRO = ["nonlinear programming", "natural language processing"];
assert.deepStrictEqual(rank("nlp", ACRO), ["natural language processing", "nonlinear programming"]);
assert.ok(score("nlp", "natural language processing") < score("nlp", "nonlinear programming"),
	"every char at a word start beats a shorter but mid-word match");

// --- starting at a word boundary is free; starting mid-word is not ---
assert.ok(score("learn", "machine learning") < score("learn", "unlearning"), "word-start beats mid-word start");
assert.strictEqual(score("ml", "ml"), 0.02, "exact match costs only its length");

// --- case-insensitive (caller lowercases the query) ---
assert.deepStrictEqual(r("mlops"), ["ML ops"]);

// --- multi-word: every word must match, in any order ---
assert.ok(score("learn machine", "machine learning") !== null, "words out of order still match");
assert.strictEqual(score("learn machine", "machine learning"), score("machine learn", "machine learning"),
	"word order does not change the score");
assert.strictEqual(score("learn topology", "machine learning"), null, "every word must match");
assert.deepStrictEqual(r("learn ml"), ["meta-learning", "machine learning"]);
assert.ok(score("mach lear", "machine learning") < score("mach lear", "machine relearning"),
	"per-word matching stops charging for the jump between words");
assert.strictEqual(score(" ml ", "ml"), score("ml", "ml"), "stray whitespace is ignored");

// --- norm() is memoized: repeated queries must not drift ---
assert.deepStrictEqual(r("ml"), r("ml"), "same query, same answer");
assert.deepStrictEqual(rank("morse", ["Morse theory"]), ["Morse theory"], "cached normalization still folds case");

// --- empty query: alphabetical passthrough, capped ---
assert.deepStrictEqual(rank("", TAGS), TAGS);
assert.strictEqual(rank("", Array.from({ length: 200 }, (_, i) => "t" + i)).length, 50);

console.log("ok");
