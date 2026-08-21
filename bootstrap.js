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

// Fuzzy score: every char of `q` must appear in `name` in order (both already
// normalized by norm()). Returns null for no match, else a number — LOWER is better:
// an earlier start, fewer gaps and a tighter span win, length breaks ties.
// ponytail: greedy leftmost match, not an optimal alignment. Swap in a real
// Smith-Waterman if the ranking ever feels wrong on long tags.
function score(q, name) {
	let i = 0, first = -1, prev = -1, gaps = 0;
	for (let j = 0; j < name.length && i < q.length; j++) {
		if (name[j] !== q[i]) continue;
		if (first < 0) first = j;
		else if (j !== prev + 1) gaps++;
		prev = j;
		i++;
	}
	if (i < q.length) return null;
	return first + 4 * gaps + (prev - first + 1 - q.length) + name.length / 100;
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
	const result = Cc["@mozilla.org/autocomplete/simple-result;1"]
		.createInstance(Ci.nsIAutoCompleteSimpleResult);
	result.setSearchString(searchString);
	this._result = result;
	this._results = [];
	this._listener = listener;
	this._cancelled = false;

	try {
		const params = JSON.parse(searchParams);
		const tags = await candidateTags(params);
		this.updateResults(rank(norm(searchString.trim()), tags), [], false);
	}
	catch (e) {
		Zotero.logError(e);
		this.updateResults(null, null, false, Ci.nsIAutoCompleteResult.RESULT_FAILURE);
	}
}

// --- tag selector pane -----------------------------------------------------

// The tag cloud in the bottom left does its own filtering, inside render():
// `normalizeForSearch(tag.tag).includes(normalizedSearchString)`. Filter
// fuzzily instead, then hide the query from the original render so it can't
// re-apply the substring test. Order is deliberately left alone — it's an
// alphabetical cloud with colored tags pinned first, not a ranked list.
// The search box keeps the typed text: it only re-reads the prop on change,
// and ours is a constant "".
function patchTagSelector() {
	const cls = typeof Zotero !== "undefined" && Zotero.TagSelector;
	if (!cls || cls.prototype.render.fuzzyOriginal) return;
	const orig = cls.prototype.render;
	const patched = function () {
		const q = norm((this.state.searchString || "").trim());
		if (!q) return orig.call(this);
		const state = this.state;
		this.state = Object.assign({}, state, {
			tags: state.tags.filter((t) => score(q, norm(t.tag)) !== null),
			searchString: "",
		});
		try { return orig.call(this); }
		finally { this.state = state; }
	};
	patched.fuzzyOriginal = orig;
	cls.prototype.render = patched;
}

// --- plugin lifecycle ------------------------------------------------------

let original = null; // pre-patch startSearch, restored on shutdown

function startup() {
	// Zotero.TagSelector is defined by a script in the main window, so it may not
	// exist yet at startup; onMainWindowLoad catches that (and later windows,
	// which each redefine the class).
	patchTagSelector();

	const { ZoteroAutoComplete } = ChromeUtils.importESModule(AC_MODULE);
	if (ZoteroAutoComplete.prototype.startSearch.fuzzyPatched) return;
	original = ZoteroAutoComplete.prototype.startSearch;

	const patched = function (searchString, searchParams, previousResult, listener) {
		let fieldName = "";
		try { fieldName = (JSON.parse(searchParams) || {}).fieldName || ""; }
		catch (e) { /* not ours; fall through to Zotero's own handling */ }
		const fn = fieldName.split("-")[0] === "tag" ? fuzzyStartSearch : original;
		return fn.call(this, searchString, searchParams, previousResult, listener);
	};
	patched.fuzzyPatched = true;
	ZoteroAutoComplete.prototype.startSearch = patched;
}

function onMainWindowLoad() {
	patchTagSelector();
}

function shutdown() {
	const cls = Zotero.TagSelector;
	if (cls && cls.prototype.render.fuzzyOriginal) {
		cls.prototype.render = cls.prototype.render.fuzzyOriginal;
	}
	if (!original) return;
	ChromeUtils.importESModule(AC_MODULE).ZoteroAutoComplete.prototype.startSearch = original;
	original = null;
}

function install() {}
function uninstall() {}

// node-only: lets test.js import the pure helpers; no-op inside Zotero.
if (typeof module !== "undefined") module.exports = { score, rank };
