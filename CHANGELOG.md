# Changelog

Notable changes to `@sudodevstudio/astro-ai`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

Each release section is used verbatim as the body of its GitHub release, so
write entries for someone deciding whether to upgrade.

## [Unreleased]

## [1.1.0] - 2026-09-13

### Added

- `contentSources` option: declare the DOM attribute your CMS client renders,
  and a selected element resolves to the entry that owns its content. The entry
  URL is returned when `entryUrl` is configured and the raw id otherwise.
  Several sources can be declared, each with its own attribute, so one element
  can carry a CMS entry, a product id, and a translation key at once.
- Agent requests now state that a selection's text is fetched data, name the
  entry behind it, point at any configured `docs` and `mcp` server, and ask for
  a change to the entry or the template rather than content hardcoded into
  source.
- The selection bar shows a chip per resolved entry. Clicking opens the entry,
  or copies the id when the source has no `entryUrl`.
- The Source panel names each resolved entry's source, id, attribute, and URL
  in labelled rows, and gains an `Open <source> entry` or `Copy <source> id`
  action beside `Copy path`. The entry id is always shown, because a configured
  entry URL contains it only encoded inside a path.
- `Publish beta to npm` workflow, publishing a `-beta.N` prerelease under the
  `beta` dist-tag from any dispatched ref without tagging or releasing.

### Changed

- `SelectionContext` gained a `contentOrigins` array, empty when no content
  source matches. `AstroResolver#resolveSelection` takes the collected
  attributes as an optional third argument.

## [1.0.0] - 2026-09-07

First stable release, and the first to publish its sources alongside `dist`.

### Added

- Source-backed selection and inspection of Astro, JSX, and TSX elements, with
  multi-select by Shift-click or marquee.
- Direct editing of literal text and props, plus reorder, remove, insert, and
  move of compatible source nodes, applied as source transactions with undo,
  redo, and conflict recovery.
- Codex and Claude CLI agent bridge with independent multi-window chats, queued
  source-changing runs, and a locked edit scope.
- Attachments by picker, drag-and-drop, or clipboard paste, and **Fix with AI**
  for Vite errors and Astro audit findings.
- `visualComponents`, `skills`, `excludeDirectories`, `maxRecoveryFiles`, and
  `allowNetworkAgent` configuration.

### Security

- The agent bridge is disabled when Astro listens beyond loopback unless
  `allowNetworkAgent` is set. Provider credentials stay in the CLI credential
  store and never reach browser code.

## Earlier releases

`0.4.3` and earlier published only build output, so their changes are not
reconstructed here. See the [releases page][releases] for those tags.

[releases]: https://github.com/SudoDevStudio/astro-ai/releases
[Unreleased]: https://github.com/SudoDevStudio/astro-ai/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/SudoDevStudio/astro-ai/releases/tag/v1.1.0
[1.0.0]: https://github.com/SudoDevStudio/astro-ai/releases/tag/v1.0.0
