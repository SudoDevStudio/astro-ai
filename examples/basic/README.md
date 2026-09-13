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
