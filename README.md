# Tag Fuzzy Search (Zotero plugin)

Zotero's tag autocomplete only matches the **start** of a tag: typing `learn`
never suggests `machine learning`. This plugin makes it fuzzy — every character
you type just has to appear in order — and sorts the suggestions best-first
(tight, early matches on short tags win).

It works everywhere tags are added, because they all share one autocomplete
implementation:

- the item pane's **Tags** section,
- the **note editor**,
- the PDF reader's **annotation tag popup** (highlights, notes, images),
- the tag condition in **advanced search**,
- the **tag selector** filter box in the bottom-left pane.

Nothing else changes: same tag list, same scoping (no trashed items, no tags the
item already has), same 50-result cap. The tag selector is only *filtered*
fuzzily, not reordered — it stays alphabetical with colored tags pinned first.

## Install

```sh
zip -r tag-fuzzy-search.xpi manifest.json bootstrap.js
```

Then in Zotero: **Tools → Plugins → gear icon → Install Plugin From File…**

For live development, point Zotero at the folder instead of zipping: create a
file named `tag-fuzzy-search@local` (the id from `manifest.json`) inside your
Zotero profile's `extensions/` directory whose contents are the absolute path to
this folder, then restart Zotero.

## How it works

`Zotero.AutoComplete`'s `tag` branch runs `SELECT name FROM tags WHERE name LIKE
'q%'`. The plugin patches `ZoteroAutoComplete.prototype.startSearch` (from
`chrome://zotero/content/zotero-autocomplete.mjs`): for `tag` searches it runs
the same query without the `LIKE` filter and ranks the candidates in JS;
everything else falls through to the original untouched.

The tag selector pane filters separately, inside `Zotero.TagSelector`'s
`render()` (`normalizeForSearch(tag).includes(query)`). The plugin wraps that
method: it filters the tags fuzzily and hands the original an empty query so it
can't re-apply the substring test.

Both patches are undone on shutdown.

- `node test.js` runs the self-check for the matching and ranking logic.
- Ranking lives in `score()` in `bootstrap.js` — one small function, tweak away.

## Caveats

- Patching a Zotero-internal prototype is not a documented API — a major Zotero
  release could rename it. The tag branch is a single function, so a fix is small.
- Every keystroke re-reads all candidate tags (no LIKE prefilter). That's a few
  milliseconds for a normal library; a huge one may want a cache.
- Matching is a subsequence over Zotero's own `normalizeForSearch` (so it is
  case- and accent-insensitive), but there is no transliteration or typo
  tolerance: the characters have to be there, in order.
