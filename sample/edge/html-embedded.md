# HTML Inside Markdown

Markdown's escape hatch. All of this is valid Markdown, and all of it must survive a round trip through Sheaf byte-for-byte.

## Inline elements

Text with <em>emphasis</em>, <strong>strength</strong>, <code>code</code>, <s>strikethrough</s>, <u>underline</u>, and <small>small print</small>.

Scientific notation: 6.022 × 10<sup>23</sup> and H<sub>2</sub>SO<sub>4</sub>.

Keyboard: press <kbd>⌘</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd> to open the command palette.

<mark>Highlighted text</mark> and an <abbr title="Recommendation, Request for Comments — depends who you ask">RFC</abbr> with a tooltip.

A <span style="color: #b4532a">coloured span</span> and a <span title="hover text">span with a title</span>.

Inline <a href="https://example.com" title="An HTML link">anchor</a> next to a [Markdown link](https://example.com).

Line one<br>line two, forced with a `<br>`.

<time datetime="2044-05-14">14 May 2044</time> · <var>x</var> = <samp>42</samp>

## Block elements

<div align="center">
  <strong>A centred block</strong><br>
  with two lines.
</div>

<blockquote>
  An HTML blockquote, which is not the same node as a Markdown one.
</blockquote>

<hr>

<p>An explicit paragraph element. <em>Inline Markdown inside a block element is not parsed:</em> **these asterisks stay literal**.</p>

## Collapsible sections

<details>
<summary>Click to expand — the summary is the visible part</summary>

The content is Markdown again, because of the blank line above:

- a list
- with **bold**

```js
const inside = 'a details element';
```

</details>

<details open>
<summary>Open by default</summary>

This one starts expanded.

</details>

<details>
<summary>Nested details</summary>

<details>
<summary>An inner one</summary>

Two levels deep.

</details>

</details>

## HTML tables

The thing Markdown tables cannot do: merged cells.

<table>
  <thead>
    <tr>
      <th rowspan="2">Route</th>
      <th colspan="2">Weekday</th>
      <th colspan="2">Weekend</th>
    </tr>
    <tr>
      <th>Sailings</th>
      <th>OTP</th>
      <th>Sailings</th>
      <th>OTP</th>
    </tr>
  </thead>
  <tbody>
    <tr><td>NW-14</td><td align="right">120</td><td align="right">92.9%</td><td align="right">48</td><td align="right">88.1%</td></tr>
    <tr><td>NW-22</td><td align="right">100</td><td align="right">88.6%</td><td align="right">40</td><td align="right">85.0%</td></tr>
    <tr><td>SE-03</td><td align="right">70</td><td align="right">93.9%</td><td align="right">28</td><td align="right">91.2%</td></tr>
  </tbody>
  <tfoot>
    <tr><td><strong>Total</strong></td><td align="right">290</td><td align="right">91.6%</td><td align="right">116</td><td align="right">87.9%</td></tr>
  </tfoot>
</table>

## Definition lists

<dl>
  <dt>Headway</dt>
  <dd>The scheduled gap between consecutive sailings on a route.</dd>
  <dt>Turnaround</dt>
  <dd>Minimum time a vessel needs alongside between an arrival and the next departure.</dd>
  <dt>Contention</dt>
  <dd>Two sailings wanting one berth at overlapping times.</dd>
</dl>

## Media and embeds

<picture>
  <source srcset="../assets/wide-diagram.png" media="(min-width: 900px)">
  <img src="../assets/terminal-dawn.png" alt="Responsive image" width="480">
</picture>

<audio controls src="../assets/does-not-exist.mp3">Your reader does not support audio.</audio>

<video controls width="320" poster="../assets/terminal-dawn.png">
  <source src="../assets/does-not-exist.mp4" type="video/mp4">
  Your reader does not support video.
</video>

<iframe src="https://example.invalid/embed" width="320" height="180" title="An embedded frame"></iframe>

## Comments and processing instructions

<!-- A single-line comment. Must not render. -->

<!--
  A multi-line comment.
  Also must not render.
-->

Text with an <!-- inline comment --> inside it.

## Raw entities

&amp; &lt; &gt; &quot; &apos; &nbsp; &copy; &reg; &trade; &hellip; &mdash; &ndash; &larr; &rarr; &harr; &deg; &plusmn; &frac12; &euro; &#8364; &#x20AC; &#128642;

An ampersand that is not an entity: AT&T, R&D, this & that.

## Scripts and styles

These should be inert in the preview — visible as source, never executed:

<script>
  console.log('this must not run');
</script>

<style>
  .sample-only { color: rebeccapurple; }
</style>

<p class="sample-only">If styles were applied, this would be purple.</p>
