---
title: Templating syntax
layout: docs
permalink: /edge/templating/
---

# Templating syntax

Repository docs are often the source for a static site, so the Markdown carries the site generator's template tags. None of this is Markdown. All of it has to survive a round trip through the editor byte for byte. Ideally each tag reads as a quiet, inert token.

## Liquid (Jekyll, GitHub docs)

The product is called {{ site.product_name }} and this page was built on {{ page.date | date: "%B %-d, %Y" }}.

{% data reusables.scheduler.lease-intro %}

{% if page.version == "cloud" %}
Leases renew automatically on the hosted plan.
{% else %}
Self-hosted installs renew leases with a cron job.
{% endif %}

{% raw %}
Text between raw tags keeps its {{ braces }} literally.
{% endraw %}

{% include callout.html type="warning" content="Rotate the key first." %}

## Hugo shortcodes

{{< note >}}
A paired shortcode whose inner text Hugo does not render as Markdown.
{{< /note >}}

{{% warning %}}
A paired shortcode whose inner text Hugo *does* render as Markdown.
{{% /warning %}}

{{< figure src="/images/rye-loaf.png" caption="A self-closing shortcode" >}}

## {{% heading "whatsnext" %}}

## mdBook

```rust
{{#include ../listings/ch04/src/main.rs:here}}
```

{{#rustdoc_include ../listings/ch04/src/lib.rs}}

```rust,ignore,does_not_compile
let s: String = 5;
```

## MDX (Docusaurus, Storybook, Next.js)

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';
export const version = '2.4.0';

<Tabs>
  <TabItem value="npm" label="npm">

```bash
npm install ledger-client
```

  </TabItem>
  <TabItem value="yarn" label="Yarn">

```bash
yarn add ledger-client
```

  </TabItem>
</Tabs>

The current version is {version}. An expression with an object: {{ color: 'red' }}.

<Callout type="info" title="Self-closing component with props" />

{/* An MDX comment. */}

## Container directives

:::note
A Docusaurus or VitePress admonition.
:::

:::tip[Custom title]
With a title in brackets.
:::

::: warning Legacy spacing
A VitePress container with a space after the colons.
:::

::::info Outer
:::danger Inner
Directives nest by adding colons.
:::
::::

## MyST and R Markdown

```{note}
A MyST directive, written as a fenced block with a braced language.
```

```{code-block} python
:linenos:
:emphasize-lines: 2
def renew(lease):
    return lease.extend(30)
```

```{r setup, echo=FALSE}
library(ledger)
```

{ref}`see-leases` is a MyST role. So is {math}`e^{i\pi}`.

## Pandoc fenced divs and attributes

::: {.callout-note #leases}
A fenced div with a class and an ID.
:::

A [span with attributes]{.highlight data-id="42"} and an image with a width: ![Rye](../assets/rye-loaf.png){width=50%}.

```{.python .numberLines startFrom="10"}
print("attribute-style fence info")
```

## Jinja and Handlebars

{% for lease in leases %}
- {{ lease.id }} expires {{ lease.expiry }}
{% endfor %}

{{#each replicas}}
- {{name}}: {{status}}
{{/each}}

{{! A Handlebars comment }}

## MDN KumaScript

The {{cssxref("grid-template-columns")}} property and the {{HTMLElement("table")}} element.

{{EmbedLiveSample("Basic_example", "100%", 200)}}

{{Specifications}}

{{Compat}}
