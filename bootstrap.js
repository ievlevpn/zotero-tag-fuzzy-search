/* Tag Fuzzy Search — a tiny Zotero plugin (bootstrapped, Zotero 7+).
 *
 * Zotero's tag autocomplete matches by leading substring ("name LIKE 'q%'").
 * This swaps it for a fuzzy (subsequence) match, ranked best-first, in every
 * place tags are added: the item pane, note editor, the PDF reader's
 * annotation tag popup, and the advanced-search tag condition — they all
 * share one nsIAutoCompleteSearch implementation, so we patch that.
 *
 * No build step: this is a plain bootstrapped plugin. See README.md.
 */

const AC_MODULE = "chrome://zotero/content/zotero-autocomplete.mjs";
const LIMIT = 50; // same cap Zotero's own query uses

// Lowercase and fold accents exactly the way Zotero's own tag filter does.
function norm(s) {
	const f = typeof Zotero !== "undefined" && Zotero.Utilities.Internal.normalizeForSearch;
	return f ? f(s) : s.toLowerCase(); // plain lowercase under node (test.js)
}

// What counts as the start of a word inside a tag.
const SEP = /[\s\-_/.,:;&()]/;
const SEPS = new RegExp(SEP.source + "+");

// First letter of each word: "natural language processing" -> "nlp".
function initials(name) {
	return name.split(SEPS).filter(Boolean).map((w) => w[0]).join("");
}

// Fuzzy score for one word: every char of `w` must appear in `name` in order
// (both already normalized by norm()). Returns null for no match, else a number
// — LOWER is better. Jumping to the start of a word is nearly free, so "nlp" prefers
// "natural language processing" over "nonlinear programming"; jumping into the
// middle of one costs, and more so the further it skips. Starting at a word
// boundary is free too, so "learn" likes "machine learning". Length breaks ties.
// ponytail: greedy leftmost match, not an optimal alignment — it takes the first
// occurrence of each char, so a better-aligned match later in the tag still
// scores as the earlier sloppy one. Swap in Smith-Waterman if that ever shows.
function wordScore(w, name) {
	let i = 0, first = -1, prev = -1, cost = 0;
	for (let j = 0; j < name.length && i < w.length; j++) {
		if (name[j] !== w[i]) continue;
		if (first < 0) first = j;
		else if (j !== prev + 1) {
			cost += SEP.test(name[j - 1]) ? 1 : 4 + (j - prev - 1);
		}
		prev = j;
		i++;
	}
	if (i < w.length) return null;
	// first <= 0 also covers the empty query (first stays -1).
	const start = first <= 0 || SEP.test(name[first - 1]) ? 0 : first;
	const sub = start + cost + name.length / 100;
	// Acronyms, which the greedy scan above misses whenever an earlier word
	// contains the letter — it spends the "l" of "nlp" on "natura(l)" and never
	// reaches "language". Scored just below a real prefix match, far above any
	// gappy one. Single letters are left to the scan; every tag has initials.
	return w.length > 1 && initials(name).startsWith(w)
		? Math.min(sub, 0.5 + name.length / 100)
		: sub;
}

// Every word of the query has to match, but in any order, so "learn machine"
// finds "machine learning". Costs add, so the name that matches every word
// tightly wins. A one-word query is just wordScore().
// ponytail: two words can be satisfied by the same stretch of the name ("ml ml"
// matches "ml"). Nobody types that; dedupe the matched ranges if they ever do.
function score(q, name) {
	let sum = 0;
	for (const w of q.split(/\s+/)) {
		if (!w) continue;
		const s = wordScore(w, name);
		if (s === null) return null;
		sum += s;
	}
	return sum;
}

// `q` normalized by the caller; empty q keeps Zotero's plain alphabetical list.
function rank(q, names) {
	if (!q) return names.slice(0, LIMIT);
	return names
		.map((n) => [score(q, norm(n)), n])
		.filter(([s]) => s !== null)
		.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]))
		.slice(0, LIMIT)
		.map(([, n]) => n);
}

// Every candidate tag, minus trashed items and tags the item already has.
// Same scoping rules as Zotero's own tag query, just without the LIKE filter.
// ponytail: full scan per keystroke — a few ms for thousands of tags. Cache on
// Zotero.Notifier 'tag' events if someone shows up with a 100k-tag library.
async function candidateTags(params) {
	const libraryIDs = params.libraryIDs || (params.libraryID ? [params.libraryID] : []);
	const args = [];
	let sql = "SELECT DISTINCT name AS val FROM tags WHERE tagID IN ("
		+ "SELECT tagID FROM itemTags JOIN items USING (itemID) "
		+ "WHERE itemID NOT IN (SELECT itemID FROM deletedItems)";
	if (libraryIDs.length) {
		sql += ` AND libraryID IN (${libraryIDs.map(() => "?").join(", ")})`;
		args.push(...libraryIDs);
	}
	sql += ")";
	if (params.itemID) {
		sql += " AND name NOT IN (SELECT name FROM tags WHERE tagID IN ("
			+ "SELECT tagID FROM itemTags WHERE itemID = ?))";
		args.push(params.itemID);
	}
	sql += " ORDER BY val COLLATE locale";
	return (await Zotero.DB.columnQueryAsync(sql, args)) || [];
}

// Drop-in replacement for ZoteroAutoComplete.prototype.startSearch, tag case
// only. Sets up the same instance state the module's updateResults() expects.
async function fuzzyStartSearch(searchString, searchParams, previousResult, listener) {
	const { classes: Cc, interfaces: Ci } = Components;
	let result;
	try {
		result = Cc["@mozilla.org/autocomplete/simple-result;1"]
			.createInstance(Ci.nsIAutoCompleteSimpleResult);
		result.setSearchString(searchString);
		this._result = result;
		this._results = [];
		this._listener = listener;
		this._cancelled = false;

		const params = JSON.parse(searchParams);
		const tags = await candidateTags(params);
		// One search object serves every tag field, so a fast typist can start a
		// newer search while this query is still running. Its startSearch has
		// already swapped in a fresh _result — bail rather than fill that one
		// with our stale suggestions. stopSearch() sets _cancelled the same way
		// when the popup is dismissed mid-query.
		if (this._result !== result || this._cancelled) return;
		this.updateResults(rank(norm(searchString.trim()), tags), [], false);
	}
	catch (e) {
		Zotero.logError(e);
		// Only report failure while our own result object is the live one —
		// without it updateResults has nothing to append to.
		if (result && this._result === result) {
			this.updateResults(null, null, false, Ci.nsIAutoCompleteResult.RESULT_FAILURE);
		}
	}
}

// --- tag selector pane -----------------------------------------------------

// Every main window runs the container script again and overwrites
// Zotero.TagSelector with a fresh class, so there can be one patched class per
// open window and shutdown has to undo all of them, not just the newest.
const patchedSelectors = new Set();

// The tag cloud in the bottom left does its own filtering, inside render():
// `normalizeForSearch(tag.tag).includes(normalizedSearchString)`. Filter
// fuzzily instead, then hide the query from the original render so it can't
// re-apply the substring test. Order is deliberately left alone — it's an
// alphabetical cloud with colored tags pinned first, not a ranked list.
// The search box keeps the typed text: it only re-reads the prop on change,
// and ours is a constant "".
function patchTagSelector() {
	const cls = typeof Zotero !== "undefined" && Zotero.TagSelector;
	if (!cls || patchedSelectors.has(cls)) return;
	let orig = cls.prototype.render;
	// A previous instance of the plugin may still be installed if its shutdown
	// was interrupted. Unwrap it instead of stacking on top.
	if (orig.fuzzyOriginal) orig = orig.fuzzyOriginal;
	const patched = function () {
		const q = norm((this.state.searchString || "").trim());
		if (!q) return orig.call(this);
		const matches = (name) => score(q, norm(name)) !== null;
		const state = this.state;
		this.state = Object.assign({}, state, {
			tags: state.tags.filter((t) => matches(t.tag)),
			// Colored tags missing from state.tags are injected straight from
			// this map *after* our filter, so they have to be filtered here or
			// they would survive every query.
			tagColors: new Map([...state.tagColors].filter(([name]) => matches(name))),
			searchString: "",
		});
		try { return orig.call(this); }
		finally { this.state = state; }
	};
	patched.fuzzyOriginal = orig;
	cls.prototype.render = patched;
	patchedSelectors.add(cls);
}

function unpatchTagSelectors() {
	for (const cls of patchedSelectors) {
		try {
			const render = cls.prototype.render;
			if (render.fuzzyOriginal) cls.prototype.render = render.fuzzyOriginal;
		}
		catch (e) { /* that window is gone and its class died with it */ }
	}
	patchedSelectors.clear();
}

// --- plugin lifecycle ------------------------------------------------------

let original = null; // pre-patch startSearch, restored on shutdown

function startup() {
	// Zotero.TagSelector is defined by a script in the main window, so it may not
	// exist yet at startup; onMainWindowLoad catches that (and later windows,
	// which each redefine the class).
	patchTagSelector();

	const { ZoteroAutoComplete } = ChromeUtils.importESModule(AC_MODULE);
	// Same as above: unwrap a patch left behind by an interrupted shutdown, so
	// an upgrade replaces the old version instead of silently keeping it.
	const prev = ZoteroAutoComplete.prototype.startSearch;
	const base = prev.fuzzyOriginal || prev;
	original = base;

	// Closes over `base`, not `original`, so an installed patch keeps working
	// even after shutdown clears the module-level reference.
	const patched = function (searchString, searchParams, previousResult, listener) {
		let fieldName = "";
		try { fieldName = (JSON.parse(searchParams) || {}).fieldName || ""; }
		catch (e) { /* not ours; fall through to Zotero's own handling */ }
		const fn = fieldName.split("-")[0] === "tag" ? fuzzyStartSearch : base;
		return fn.call(this, searchString, searchParams, previousResult, listener);
	};
	patched.fuzzyOriginal = base;
	ZoteroAutoComplete.prototype.startSearch = patched;
}

function onMainWindowLoad() {
	patchTagSelector();
}

function shutdown() {
	// Autocomplete first: it is the patch that matters, and the tag selector
	// classes below belong to windows that may already be gone, so touching one
	// can throw ("can't access dead object") and strand this half undone.
	if (original) {
		ChromeUtils.importESModule(AC_MODULE).ZoteroAutoComplete.prototype.startSearch = original;
		original = null;
	}
	unpatchTagSelectors();
}

function install() {}
function uninstall() {}

// node-only: lets test.js import the pure helpers; no-op inside Zotero.
if (typeof module !== "undefined") module.exports = { score, rank };
