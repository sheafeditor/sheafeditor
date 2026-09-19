# Tables — every type and size

A gallery for Sheaf's table rendering and in-grid editing. Click any cell to edit; Tab/Enter to move; hover a table for **+ Row / + Col / − Row / − Col** and **</>** (edit raw source). Pipe tables and `csv` / `tsv` data blocks both render as grids.

---

## Pipe tables

### Smallest — 1 column, 1 row
| Item    |     |
| ------- | --- |
| Only    |     |
| Hello 2 |     |
| Hello   |     |
|         |     |
| Only    |     |
| Hello 2 |     |
| Hello   |     |
|         |     |

| Key | Value |
| --- | ----- |
| a   | 1     |

### Alignment (left / center / right)

| Left         | Center                         | Right                    |
| :----------- | :----------------------------: | -----------------------: |
| start        | *middle*                       | end                      |
| foo          | bar                            | baz                      |
| 1            | 22                             | 333                      |
| -----------  | ------------------------------ | ------------------------ |
| Bold         | **strong**                     | rendered on reveal       |
| Italic       | *emphasis*                     |                          |
| Code         | `inline()`                     | monospace                |
| Link         | [Sheaf](https://example.com)     | Cmd/Ctrl-click on reveal |
| Escaped pipe | a \\| b                        | literal pipe in a cell   |

### Wide — many columns

| # | Name    | Role      | Team     | City      | Start | Active | Score |
| - | ------- | --------- | -------- | --------- | ----- | ------ | ----- |
| 1 | Ada     | Eng       | Platform | London    | 2019  | yes    | 98    |
| 2 | Grace   | Eng       | Compiler | New York  | 2020  | yes    | 95    |
| 3 | Linus   | Eng       | Kernel   | Portland  | 2018  | no     | 91    |
| 4 | Margaret| PM        | Apollo   | Boston    | 2021  | yes    | 88    |

### Tall — many rows

| n  | square | cube |
| -- | ------ | ---- |
| 1  | 1      | 1    |
| 2  | 4      | 8    |
| 3  | 9      | 27   |
| 4  | 16     | 64   |
| 5  | 25     | 125  |
| 6  | 36     | 216  |
| 7  | 49     | 343  |
| 8  | 64     | 512  |
| 9  | 81     | 729  |
| 10 | 100    | 1000 |

### Ragged source (uneven spacing still parses)

| Product | Price | In stock |
|-|-|-|
| Widget | $9.99 | yes |
| Gadget | $19.99 | no |
| Gizmo | $4.50 | yes |

---

## CSV data blocks

### Small

```csv
Region,Q1,Q2,Q3,Q4
North,120,135,150,90
South,98,110,102,140
West,210,180,199,205
```

### Quoted fields (commas, quotes, and spaces)

```csv
Name,Title,Quote
Ada Lovelace,"Mathematician, Analyst","That brain of mine is ""more"" than merely mortal"
Grace Hopper,Rear Admiral,"Ships in port are safe, but that's not what ships are for"
Alan Turing,Logician,"We can only see a short distance ahead"
```

### Larger — 6 columns × 12 rows

```csv
id,first,last,department,country,salary
1,Ada,Lovelace,Engineering,UK,145000
2,Grace,Hopper,Engineering,US,152000
3,Linus,Torvalds,Kernel,US,161000
4,Margaret,Hamilton,Software,US,158000
5,Katherine,Johnson,Mathematics,US,139000
6,Dennis,Ritchie,Systems,US,164000
7,Barbara,Liskov,Research,US,171000
8,Donald,Knuth,Research,US,169000
9,Tim,Berners-Lee,Web,UK,155000
10,Vint,Cerf,Networking,US,166000
11,Radia,Perlman,Networking,US,157000
12,Leslie,Lamport,Distributed,US,172000
```

## TSV data block

```tsv
Month	Users	Revenue
Jan	1024	$4,300
Feb	1180	$5,120
Mar	1342	$6,780
```

---

## Edge cases

### Single-column CSV

```csv
color
red
green
blue
```

### Header-only pipe table (no body rows)

| Column A | Column B |
| -------- | -------- |

### Empty cells

| a | b | c |
| - | - | - |
| 1 |   | 3 |
|   | 2 |   |
