# Emoji, flags and joined sequences

Characters outside the Basic Multilingual Plane take two UTF-16 code units, and many emoji are several characters joined together. Rendering them is easy. The hard case is replacing one with another: 😀 and 😃 share their first code unit, so an edit trimmed by code unit can cut a pair in half. To test it, select any emoji below, type a different one, and check that the file holds exactly the new emoji.

## In prose

The deploy passed 😀 and then failed 😃, so we rolled back 🙃 and went for coffee ☕. Ship it 🚀, or do not 🛑.

Flags sit next to each other: 🇫🇷 🇫🇮 🇩🇪 🇯🇵 🇧🇷 🇨🇦 🇺🇸 🇬🇧. Regional indicators pair up from the left, so deleting one letter of 🇫🇷 changes what the next flag reads as.

Families and professions are joined with U+200D: 👨‍👩‍👧 👨‍👩‍👦 👩‍👩‍👧‍👦 🧑‍🚀 👩‍🔬 🏳️‍🌈 🏴‍☠️ 🐈‍⬛.

Skin tones modify the character before them: 👋 👋🏻 👋🏽 👋🏿, and 🧑🏾‍💻 carries a tone inside a joined sequence.

Keycaps and variation selectors: 1️⃣ 2️⃣ #️⃣, ❤️ against ❤ (text style), ✔️ against ✔.

Mathematical letters are astral too, and are not emoji: 𝐀𝐁𝐂 𝔄𝔅 𝕏. So are some CJK ideographs: 𠀋 𡈽.

## In a table

| Status | Owner | Region | Note |
| :---: | :--- | :---: | :--- |
| ✅ | 🧑‍🚀 Quill | 🇫🇷 | Shipped 🚀 |
| ⬜ | 👩‍🔬 Bray | 🇫🇮 | Waiting 😴 |
| ❌ | 🐈‍⬛ Fresnel | 🇯🇵 | Knocked it over 😼 |
| 🟡 | 👨‍👩‍👧 Everyone | 🏳️‍🌈 | Reviewing 👀 |

## In a list and a heading

- 😀 at the start of an item
- An item ending in a flag 🇩🇪
- [x] A done task 👍🏽
- [ ] A task with a family 👩‍👩‍👧‍👦

### A heading with a rocket 🚀

> A quote that ends in a joined emoji 🏴‍☠️

`Inline code keeps 😀 as text`
