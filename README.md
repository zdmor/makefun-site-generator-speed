# Fast makefun-site

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/zdmor/makefun-site-generator-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/zdmor/makefun-site-generator-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A dependency-free reimplementation of makefun-site 1.0.0 — the static site
generator from the make.fun `site-generator-speed-01` competition — written
for speed. `solve.js` exports `run(input)`, which builds a whole site (pages,
index and tag pages, `build-report.txt`, static files) and returns the output
tree. `main.ts` is the driver: it reads `/input/cases.json`, answers each case
with `run`, and writes `/output/answers.json`.

The output is byte-identical to makefun-site 1.0.0 for every input: the same
front-matter rules, the same template dialect, the same Markdown subset, the
same slug, sorting and report rules. The implementation was written from the
vendor's documented semantics, reimplemented from scratch.

## Layout

- `solve.js` — the whole generator, one ES module, no dependencies.
- `main.ts` — the driver (reads cases, writes answers).
- `package.json` — `{"type": "module"}`, so Node loads `solve.js` as ESM
  without a warning.
- `LICENSE` — MIT.

## How it is fast

**Templates are compiled, not interpreted.** Each template is parsed once per
case into a node tree, then compiled with `new Function` to a render function
that appends straight to an output array. There is no per-node dispatch at
render time.

**Paths are hoisted.** Every scope level resolves each distinct variable path
it references once, up front, into a local; every use then reads the local.
A path referenced five times is resolved once.

**Fragments are cached.** A template whose output can only depend on the
case-level constants (`site`, `tags`, `recent`) — navigation, headers,
footers, filler blocks — is rendered once per case and reused: the include
site compares the resolved references by identity, so a shadowed name simply
misses and renders normally. A depth bound guarantees the cache never changes
an include-depth cutoff. This removes most of the repeated work: those
fragments are rendered once instead of once per page.

**Scopes are flat.** A scope is one object with a single `PARENT` key instead
of a `{vars, parent}` pair, and a `for` loop only builds its `loop` object
when the body can see it (checked transitively through includes).

**Markdown is fused.** One pass renders the HTML, the table of contents and
the excerpt together. Blocks dispatch on the first character; inline markup
and HTML escaping share a single regex scan, so a paragraph is scanned once;
fence bodies are joined and escaped in one go. Word counting is a branchless
table scan (one 64 KiB lookup table over the JavaScript `\s` set).

**No repeated work.** Slugs are memoised (with an ASCII fast path); link
targets are resolved through a cache; front matter is parsed by slicing the
header region instead of re-scanning; per-post and per-tag link objects are
precomputed once and shared by every card and page.

## Verification

Correctness was checked against the vendor implementation with a differential
tester: the practice set, generated cases from the competition's own
generator (18 cases across 6 seeds), and 14 hand-made edge cases (Markdown
torture, front-matter refusals, slug and Unicode collisions, template parse
errors, include-depth boundaries, self-includes, link resolution, empty and
CRLF sites, fragment-cache shadowing and depth bounds). All pass.

Local timing (this machine, practice set, 3 cases): the warm `run()` median
is about 210 ms against about 780 ms for the house baseline — roughly 4x.
End to end (whole `main.ts` process, cold, net of the null-entry baseline)
the median is about 0.79 s against about 1.71 s for the baseline — roughly
2.2x.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
