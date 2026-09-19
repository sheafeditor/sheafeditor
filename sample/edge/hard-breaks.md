# Hard line breaks

CommonMark has two ways to end a line without ending the paragraph: a backslash at the end of the line, or two or more spaces. Both render as a line break with the marker hidden. Sheaf's Shift+Enter writes the backslash form, so a document you type in Sheaf contains it. Each case below says what it should look like.

## Breaks that should render

Backslash form. Three lines, no backslash visible:

First line\
Second line\
Third line

Two trailing spaces. Three lines, and the spaces stay in the file:

First line  
Second line  
Third line

Five trailing spaces, still one break:

First line     
Second line

Both forms in one paragraph:

**When:** 09:00 station time\
**Where:** the galley  
**Who:** the whole crew

Inside emphasis: *first line\
second line, still italic*

> In a quote, first line\
> second line of the same quote.

- In a list item, first line\
  second line of the same item.
- A second item, first line  
  second line of the same item.

## Things that are not breaks

A plain paragraph for contrast. These two lines
join into one line when rendered.

A backslash at the very end of a paragraph is a literal backslash\

Trailing spaces at the very end of a paragraph are dropped, not a break  

### A heading that ends in a backslash stays one line\

`code with a trailing backslash\`

```text
Inside a fence, a backslash is just a character\
and so are trailing spaces  
```

One trailing space is not a break 
so these lines join.
