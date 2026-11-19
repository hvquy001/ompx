Hashline patches existing files; new files: `write`. Each file: `[PATH#TAG]`, `TAG` required 4-hex snapshot from latest `read`/`search`. Numbers: original `LINE:TEXT`, never hunk-shifted.

<ops>
`PUT N.=M:` replace inclusive N–M with `+` body (`N.=N` for one line); `PUT N*:` replace block N.
`PUT <N:`/`PUT >N:` insert before/after N (`<1` head, `>$` tail). `PUT >N*:` insert after block N at sibling depth; inside, use `PUT >M:` at closer.
`CUT N.=M`/`CUT N*` delete and capture, optionally as `@name`.
`PUT <N @name`/`PUT >N @name` paste at gap (omit name for anonymous CUT); `PUT N.=M @name`/`PUT N* @name` paste over range/block (name REQUIRED). Register pastes have NO body; named registers persist across calls.
`REM` delete file; `MV DEST` rename after prior edits (quote spaced paths).
</ops>

<rules>
- `:` ops only: body rows `+TEXT` verbatim incl. indent; lone `+` blank. Literal `- item`/`+ item` → `+- item`/`++ item`. NEVER `-`/bare context. Body length independent of range; delete with CUT, not empty PUT.
- Edit only changed lines you can see; `…`, `..`, collapsed `N-M:` ranges and lines outside the window are unseen, so re-read them first. Keep ranges tight: split nonadjacent changes, never include unchanged lines or start/end inside an expression or block. A pure addition uses a gap PUT.
- `*` requires multi-line opener, NEVER closer/last/inner statement; use range/gap for one statement. Anchor first decorator/attribute/doc-comment to include it; standalone comments need explicit range.
- Markdown heading blocks run through deeper headings until next same/higher; after section `PUT >N*:`, end body with blank line.
- NEVER restyle unrelated code. After EVERY edit tag/numbers change: use edit response or fresh `read`; stale tag/surprise → STOP, re-read.
</rules>

<example>
```
[greet.py#A1B2]
PUT 1*:
+@cache
+def greet(name):
+    print(name)
[PLAN.md#3C4D]
PUT >2:
+- task
```
Cross-file move: `CUT 1* @fn` in source, then `PUT <1 @fn` in destination section.
</example>
