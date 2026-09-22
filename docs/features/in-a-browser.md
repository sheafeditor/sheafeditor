---
title: In a browser
summary: Serve a folder on your own machine and edit its Markdown in a browser tab, for apps that cannot load an editor of their own.
order: 50
---

# In a browser

Documentation that lives beside the code is only worth keeping there if you can read it where you are working. Plenty of applications show you a Markdown file and give you no way to edit it properly: a chat window, a file pane, anything without a way to load an extension.

Sheaf can serve a folder from your own machine and open its documents in a browser tab. It is the same editor, running the same code as the one in your editor window. Anything that can open a link can open your documents in it.

Nothing leaves your machine. The address works on this computer and nowhere else.

## Starting it

From your editor, run **Sheaf: Open This Folder in a Browser** in the Command Palette. Sheaf serves the folder you have open and offers you the address, with a button to open it and a button to copy it.

From a terminal, in the folder you want to serve:

```
sheaf
```

It prints one address and opens it in your browser. Some options:

```
sheaf ~/project        the folder to serve, instead of this one
sheaf --port 8080      a particular port
sheaf --no-open        print the address without opening a browser
```

Stop it with **Sheaf: Stop Serving to the Browser**, or with Control-C in the terminal. It stops on its own when you close your editor window.

## What you get

The address opens a list of every Markdown file in the folder. Pick one and it opens in Sheaf.

Everything works as it does in your editor: the toolbar, the slash menu, the right-click menu, tables as a grid, callouts, typeset maths, the table of contents. Links between documents open the document they point at, and a link to a heading scrolls to it.

Typing writes to the file. There is no save button and nothing to press, in the same way there is nothing to press in your editor.

Images pasted or dropped into a document are written into an `assets` folder beside it and linked from there, which is where they go in your editor too.

The folder's settings are read from the project, so a document looks the same in a tab as it does in your editor window. The one setting that behaves differently is the table of contents: the toolbar button turns it on for that tab only, rather than writing a setting into the project you have checked in.

## Two places at once

You can have the same file open in a browser tab and in your editor at the same time. A change in either shows up in the other within a moment, because both are writing to the one file on disk.

The same is true of anything else that writes the file. A document changed by a tool, or by switching branches, updates in the tab you are looking at.

When the file has changed underneath an edit you are part-way through, your text is what gets written. This is the same rule your editor follows, and it means the honest way to use both at once is one at a time.

## What it will not do

It serves one folder, the one you started it in. A link that points outside that folder does not open, and neither does anything in a hidden folder such as `.git`. This is deliberate: the browser is being given a folder of your files, and the fence around it is the whole reason it is safe to do that.

It listens on this machine only. There is no option to put it on a network address, because a folder of your documents on a network is a different thing with different questions to answer, and this is not that.

It is one folder at a time per window. Run it again in a second terminal for a second folder and it takes the next free port.

## If it does not start

**The port is busy.** Sheaf tries the next port up, twenty times, before giving up. Use `--port` to pick one yourself.

**Nothing opens.** The address is printed either way. Paste it into a browser.

**The folder is somewhere else.** The command serves a folder on the machine it is running on. A folder open over a remote connection is not one of those.
