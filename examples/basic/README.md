# Basic example

A minimal Astro app wired to `@sudodevstudio/astro-ai` from this repository, not
from npm. It is the fastest way to see a change running in a real app.

```sh
npm install              # at the repository root, once
cd examples/basic
npm install
npm run dev
```

`npm run dev` builds the package first, so a source change in `../../src` is
picked up by restarting the dev server. That build needs the root dependencies,
which is why the root install comes first. The dependency here is `file:../..`,
which npm installs as a link to the repository root rather than a copy from
npm.

Open the dev toolbar, choose the star app, and click anything on the page.

## Pages

Navigation uses `<ClientRouter />`, so moving between pages also exercises the
path where the editor re-establishes itself against a swapped page.

| Page | What it shows |
| --- | --- |
| `/` | Literal text and prop editing, sibling reordering, a repeated list. |
| `/content/` | Content sources, including an element that belongs to no entry. |
| `/components/` | Registered components and their typed props. |
| `/catalog/` | One template in a loop where every card resolves its own entry. |
| `/island/` | A React island: editable props, a repeated `.map()`, entries per row. |
| `/seo/` | Share preview fixtures, one page per failure mode. |

### React island

`/island/` renders two React components so island editing can be exercised in
the same app as everything else. Selecting inside `ProductPicker` resolves to
`ProductPicker.jsx`, not to the page that renders it, and literal text, props,
reordering and removal all work there.

Three things meet on that page:

- **Props** are declared for `ProductPicker` in `astro.config.mjs`, so `heading`,
  `cta` and `tone` are editable from the action bar. They are registered where
  the island is *used*, in the Astro page, so the editor never has to read the
  framework's own prop types.
- **A repeated template**: the three rows come from one `.map()`, so they share
  one source node and one edit rewrites all of them.
- **Content sources inside JSX**: each row carries `data-entry-id` and
  `data-sku`, and the entry is read from the row you clicked. Attributes are read
  from the DOM, so this works the same in an island as in a template.

A second island, `BuildStatus`, is hydrated with `client:visible` rather than
`client:load`, because instrumentation and hydration are independent and it is
worth having a fixture that proves it.

### Share preview

`astro.config.mjs` sets `chatLayout: 'fixed'`, so the chat opens docked in a
column with tabs and the page reflows beside it — press **Float** to undock the
windows instead.

The preview itself is configured with nothing at all. It reads the head of
whatever page you are on, every time you open it, so these fixtures need only
differ in their tags.

`/seo/` holds four pages with deliberately different head metadata. Open a chat
window, press the green **SEO** button, and walk them:

| Page | Reports | Why |
| --- | --- | --- |
| `/seo/` | 1 warning | `og:image` is 800×418: kept by every network, too small for the wide card. |
| `/seo/clean/` | nothing | Every tag present and inside the limits each network truncates at. |
| `/seo/broken/` | 3 errors, 4 warnings, 5 notes | Relative and 64×64 `og:image`, invalid `twitter:card`, `og:url` disagreeing with the canonical link, overlong title and description, `noindex`. |
| `/seo/minimal/` | 3 errors, 4 warnings, 3 notes | A `<title>` and nothing else, so every card shows its fallback. |

The head tags come from `src/components/Seo.astro`, driven by the `seo` prop each
page passes to the layout. `seo={false}` emits nothing but a `<title>`, and
`htmlLang={false}` drops the `lang` attribute — both only exist so the bare
fixture can be bare.

`Seo.astro` builds absolute URLs from `Astro.site ?? Astro.url.origin`. This
example deliberately leaves `site` unset, so they resolve against the dev server
and the images load while you look at the preview. A real site sets `site` and
these become its public URLs.

### Content sources

Two sources are declared, with deliberately different shapes:

| Source | Attribute | Resolves to |
| --- | --- | --- |
| `demo-cms` | `data-entry-id` | `https://cms.example/entries/demo-entry-7f3a` |
| `catalog` | `data-sku` | `SKU-2201` |

The first has an `entryUrl`, so its chip opens the entry and the Source panel
offers **Open demo-cms entry**. The second has none, so it hands back the id
and offers **Copy catalog id**. Both reach the agent, which is told the text is
fetched data and asked to change the entry rather than the template.

`/catalog/` is the case worth understanding. All three cards come from one
template, so they share a single source node and one edit changes all of them,
but the entry id is read from the card you actually clicked. The source
location stays put while the resolved entry changes.

## Notes

The `agent: 'codex'` line needs the Codex CLI installed and authenticated. Set
it to `'claude'`, or remove it, if you only want the non-AI editing. Everything
except the chat works without an agent.

Attribute names are entirely yours to choose; `data-entry-id` and `data-sku`
here are just what this example's config declares. A non-`data-` name such as
`sku` works too, but Astro's types reject a bare unknown attribute in a
template, so it has to go through a spread:

```astro
<section {...{ sku: entry.sku }}>
```

That is a template typing rule, not a limit of the integration.
