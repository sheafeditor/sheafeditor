# Unicode, Scripts, and Widths

Text that is not plain ASCII. Cursor movement, column alignment, and hidden-syntax measurement all get harder here.

## Scripts

| Script | Sample | Direction |
| :--- | :--- | :--- |
| Latin | The quick brown fox jumps over the lazy dog | LTR |
| Greek | Ξεσκεπάζω την ψυχοφθόρα βδελυγμία | LTR |
| Cyrillic | Съешь же ещё этих мягких французских булок | LTR |
| Hebrew | דג סקרן שט בים מאוכזב ולפתע מצא חברה | RTL |
| Arabic | نص حكيم له سر قاطع وذو شأن عظيم مكتوب | RTL |
| Devanagari | ऋषियों को सताने वाले दुष्ट राक्षसों के राजा | LTR |
| Thai | เป็นมนุษย์สุดประเสริฐเลิศคุณค่า | LTR |
| Japanese | いろはにほへと ちりぬるを 色は匂へど 散りぬるを | LTR |
| Korean | 키스의 고유조건은 입술끼리 만나야 하고 | LTR |
| Chinese | 天地玄黃，宇宙洪荒。日月盈昃，辰宿列張。 | LTR |
| Georgian | ვეპხის ტყაოსანი შოთა რუსთაველი | LTR |
| Armenian | Բարեւ Ձեզ, ինչպէ՞ս էք | LTR |

## Bidirectional text

A sentence in English containing עברית in the middle, then back to English.

The file is named `تقرير.md` and lives in `/data/2044/`.

Mixed numerals in RTL: الطلب رقم 12345 بتاريخ 2044-05-14.

> RTL inside a blockquote: הציטוט הזה נמצא בתוך בלוק ציטוט ומכיל **הדגשה** וגם `קוד`.

## Full-width and CJK in tables

Column alignment is measured in characters, but these render two cells wide.

| 名前 | 部署 | 状態 | 備考 |
| :--- | :--- | :---: | :--- |
| 田中 | 運行管理 | 稼働 | 通常運転 |
| 山本 | 整備 | 停止 | 定期点検中 |
| キム | 港湾 | 稼働 | — |
| 王 | 予約 | 稼働 | 繁忙期対応 |

| 항목 | 값 | 단위 |
| :--- | ---: | :--- |
| 승객 수 | 10,480 | 명 |
| 차량 수 | 2,110 | 대 |
| 적재율 | 90 | % |

Full-width punctuation and forms: ＡＢＣ１２３ ！？（）［］　←that was an ideographic space.

## Combining marks and normalisation

- Precomposed: café (U+00E9)
- Decomposed: café (e + U+0301)
- Stacked marks: e̸̢̛͈̙̠͐̈́ (deliberately over-combined)
- Vietnamese: Tiếng Việt có dấu — nghiêng, đậm, gạch
- Thai above and below: กำ กิ กี กึ กื กุ กู เก แก โก

## Emoji

Plain: 🚢 ⚓️ 🌊 🧭 📦 ⛴️

Skin tones: 👋 👋🏻 👋🏼 👋🏽 👋🏾 👋🏿

ZWJ sequences: 👨‍👩‍👧‍👦 👩🏽‍✈️ 🧑‍🔧 🏴󠁧󠁢󠁳󠁣󠁴󠁿 👨‍❤️‍💋‍👨

Flags: 🇳🇴 🇯🇵 🇪🇬 🇮🇱 🇮🇳 🇺🇳

Keycaps: 1️⃣ 2️⃣ 3️⃣ #️⃣ *️⃣

Emoji inside **bold 🚢 text**, inside `code 🚢 span`, and inside a [link 🚢](https://example.com).

| Emoji | Name | Bytes |
| :---: | :--- | ---: |
| 🚢 | ship | 4 |
| 👋🏾 | waving hand, medium-dark | 8 |
| 👨‍👩‍👧‍👦 | family | 25 |
| 🏴󠁧󠁢󠁳󠁣󠁴󠁿 | flag: Scotland | 28 |

## Invisible and lookalike characters

- Non-breaking space between these two → words
- Zero-width space between these→​←arrows
- Soft hyphen inside a long word: extra​ordinarily
- Word joiner, zero-width non-joiner, and a BOM sit on the next line:
- ⁠‌﻿
- Cyrillic lookalikes: аеорсху (these are not Latin letters)
- Right-to-left mark and left-to-right mark: ‏‎ (between these parens: ‏‎)

## Typographic punctuation

“Curly quotes,” ‘single curly,’ em—dash, en–dash, ellipsis…, non-breaking hyphen‑here, prime ′ and double prime ″, ¼ ½ ¾ ⅓ ⅔ ⅛, №, §, ¶, †, ‡, •, ‰, µ, Ω, Å, ℮.

Maths symbols in running text: ∀x ∈ ℝ, x² ≥ 0, and ∑ᵢ aᵢ ≤ ∏ᵢ bᵢ when a ≪ b.

Currency: $ € £ ¥ ₹ ₽ ₩ ₪ ₦ ₫ ₴ ₺ ₡ ₱.

## Long unbroken strings

A very long word with no break opportunities:

Pneumonoultramicroscopicsilicovolcanoconiosisantidisestablishmentarianismfloccinaucinihilipilification

A long URL that should wrap or scroll but not break the layout:

https://example.com/a/very/long/path/that/keeps/going/and/going/segment/after/segment?query=parameter&another=value&third=yet-another-value#and-a-fragment-too

A long inline code span: `const configurationForTheExtremelyVerboselyNamedSubsystemComponent = createDefaultConfiguration();`
