# Contributing

Install the locked dependencies with `npm ci`, then run `npm run setup:hooks` to install the existing pre-push committed-dist check.

Before submitting a change, run `npm test`, `npm run typecheck`, `npm run lint`, and `npm run verify:dist`. GitHub Actions execute the committed `dist/` bundle, so source changes that affect runtime behavior must include the matching generated `dist/` artifacts.
