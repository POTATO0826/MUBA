# Conventions

Durable rules for anyone — human or agent — writing code or docs in this repo.
Unlike `docs/reality-check.md` (a dated audit of one pass against one HEAD) or
`docs/HANDOFF.md` (session-to-session status), this file is not scoped to a
moment: nothing here should need a date to be true.

## Cross-file references: cite symbols, not line numbers

**Address a constant, function or type by name — `MIN_STAKE` in
`DuelEscrow.sol`, `SIGNING_CHAIN_ID` in `src/data/wallet.ts` — never by
`file:line`.** A line number is accurate exactly until the next unrelated edit
to that file, and then it is silently wrong: `grep` still returns a hit, the
citation still *looks* like it points somewhere real, and nothing about
reading it tells you it moved. A wrong line number is a citation that still
looks right — the same failure mode as a mislabelled chain id, just quieter,
because nobody double-checks a footnote the way they double-check a number on
screen.

This is not hypothetical. On 2026-09-05, a comment written to *explain*
`MIN_STAKE` shifted the line it sits on, which broke `file:line` citations to
it in `contracts/deploy.ts`, `contracts/README.md`, and four places in
`src/desk/escrow.ts` — every one of them accurate when written, all wrong
within the hour. Documentation that explains a constant is precisely the kind
of edit that moves it. All four now cite `MIN_STAKE` by name and survive the
next comment written near it. The same thing happened again, independently,
while this file was being written: a `.env.example` edit to disambiguate a
chain name shifted `THETADUEL_ESCROW` from line 54 to line 56, breaking a
citation in `contracts/deploy.ts` that named the line rather than the
variable. Two unrelated edits, same failure, same fix.

**The one legitimate exception: a line number pinned inside a test that fails
if the line moves.** `test/attest.test.ts` asserting
`expect(SIGNING_CHAIN_ID).toBe(84532)`, or a determinism scan that greps a
specific construct, is a citation that maintains itself — if the referenced
line ever moves or changes meaning, the suite goes red before anyone ships on
the stale assumption. That self-checking property is what a prose citation in
a comment or a README can never have, which is exactly why prose should not
use line numbers at all.
