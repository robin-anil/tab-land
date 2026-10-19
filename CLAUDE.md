# Tab Land: notes for Claude

- Anything that touches Jev (src/lib/jev.js, src/bg/grouping.js, src/bg/ask.js, src/lib/tune.js): use the `typesafe-ai`
  skill and check the live docs at https://docs.typesafe.ai (llms.txt index; append `.md` to page paths)
  for current limits and primitive guidance before changing requests.
- Known Jev limits we rely on: 64k tokens per request / 32k per question, at most 255 Choice options,
  400 `max_tokens_exceeded` when over. See MAX_REQUEST_CHARS and MAX_CHOICE_OPTIONS in src/lib/jev.js.
- Privacy: never print or read tab titles, URLs or the API key. The tuner (`node scripts/tune.mjs`) runs
  on the owner's machine and prints numbers only; its files live in `.private/` (git-ignored).
- Checks: `npm test`, `npx eslint .`, `npx tsc -p jsconfig.json --noEmit`.
- Commits: new commits on top (no amending); end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  and no session links.
