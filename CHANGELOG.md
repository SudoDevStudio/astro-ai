# Changelog

Notable changes to `@sudodevstudio/astro-ai`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

Each release section is used verbatim as the body of its GitHub release, so
write entries for someone deciding whether to upgrade.

## [Unreleased]

## [1.3.0] - 2026-09-14

### Added

- Share preview: the green **SEO** button on a chat window's toolbar opens a
  full-screen reading of the current route's head metadata. Eight cards show what the page
  actually renders as on X, Facebook, LinkedIn, Instagram DMs, Discord, Slack,
  WhatsApp, and in a Google result — each reading the tag chain that network
  reads, truncated where that network truncates. Instagram is shown as a DM
  link card because it has no feed link previews.
- The preview's **Issues** tab reports what will be wrong for a reader: a
  relative `og:image` that no crawler can fetch, an image that loads at 64px
  despite declaring 1200×630, an `og:url` that disagrees with the canonical
  link, a title past the length Google reads. Each finding names the networks
  it affects, and **Fix with AI** hands it to the agent with the current tag
  values, through the same path the Vite error overlay already uses.
- The **Tags** tab lists every title, meta, link, and `lang` value the page
  rendered, including the duplicates crawlers ignore.
- Docked chat layout: the **Dock** button moves every chat window into a column on
  the right, where tabs switch between the same conversations. The page reflows
  into the remaining width rather than sitting behind the panel, so nothing is
  hidden. A tab marks a conversation with a run in flight, the dock's left edge
  resizes it, and collapsing it to a rail pauses selection mode the way
  collapsing every floating window does. **Float** undocks them again; the
  choice, the width, and the collapsed state are remembered for the session.
- `chatLayout` option: `'fixed'` opens the editor docked, `'floating'` in
  windows. It is a starting point rather than a lock — the moment someone
  switches layouts themselves their choice wins for the rest of the session, so
  changing the project default never overrides a user mid-session.
- `seo` option: `networks` picks which of the eight cards to render and in what
  order, and `seo: false` hides the share preview button. Nothing else is
  configurable, because everything a card shows is read from the page's own head
  each time the preview opens. An unknown network name is reported at startup
  rather than silently rendering one card fewer.
- The page selection now follows the conversation you are in. The page carries
  one selection while every chat keeps its own attachment, and the overlay
  broadcast the live selection to whichever window was focused — so switching
  tabs handed one conversation's element to another, and two tabs ended up
  claiming the same file. Focusing a conversation restores the element it owns,
  moving the outline, the action bar, and the arrow with it. Opening a new chat
  while something is selected inherits that selection rather than clearing it.
- Selection outlines, insertion controls, and the selection arrow re-measure
  when the dock takes or releases its column, is resized, or is collapsed.
  Reflowing the page fires no scroll or resize event, so they previously stayed
  pinned to where the page used to be.
- Controls no longer disappear off the edge of a chat panel. Each row is a grid
  item, and a grid item's default `min-width: auto` refuses to shrink below its
  content — it overflowed its track instead, and the panel's `overflow: hidden`
  clipped whatever sat at the end of the row, which at the default width was
  the layout toggle and the close button. Rows now shrink to the panel, and
  within them the window name, status text, and provider label give way before
  any control does. Below 400px the controls drop their words and keep their
  icons rather than being pushed out.
- The docked width is published as `--astro-ai-dock-width` on the root element.
  A root margin reflows normal flow but cannot move an app's own
  `position: fixed` elements, so an app that has them can offset them with this
  variable. Below 720px the dock becomes a bottom sheet and takes no column.

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
[Unreleased]: https://github.com/SudoDevStudio/astro-ai/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/SudoDevStudio/astro-ai/releases/tag/v1.3.0
[1.1.0]: https://github.com/SudoDevStudio/astro-ai/releases/tag/v1.1.0
[1.0.0]: https://github.com/SudoDevStudio/astro-ai/releases/tag/v1.0.0
