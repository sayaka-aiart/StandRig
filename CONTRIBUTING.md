# Contributing

Read docs/ARCHITECTURE.md and AGENTS.md. Keep camera inference, OBS automation and proprietary SDK integrations in separate adapters. Do not make the modeling core depend on an AI vendor or UI framework.

Run `npm ci`, `npm run build` and `npm test`. Add focused regressions for reproducible behavioral bugs. Parser fixtures should use generated, nonpersonal data. For rendering/modeling changes, include actual before/after visual evidence and state what was not tested.

Describe the concrete problem, resulting behavior and validation in pull requests. Do not attach user PSDs, licensed artwork, API keys, camera recordings or private model files without rights to redistribute them. Contributions are under the project's Apache-2.0 license unless an explicit separate agreement applies.

When changing endpoints or action types, run `npm run docs` and include the generated changes. Ordinary source edits invalidate `DISTRIBUTION-MANIFEST.json`: `npm run verify` checks a packaged release, not arbitrary development edits. Maintainers regenerate the manifest when preparing a release; build/tests are the development CI gates.
