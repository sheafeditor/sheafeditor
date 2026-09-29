---
title: In a browser
summary: Serve a folder on your own machine and edit its Markdown in a browser tab, for apps that cannot load an editor of their own.
order: 50
---

# In a browser

You can serve a folder from your own machine and open its documents in a browser tab, running the same editor as the one in your editor window. Reach for it when an application shows you a Markdown file with no way to edit it properly: a chat window, a file pane, anything that cannot load an extension.

Documentation that lives beside the code is only worth keeping there if you can read it where you are working. Anything that can open a link can open your documents this way. Nothing leaves your machine: the address works on this computer and nowhere else.

## Open a folder in a browser

1. In your editor, run **Sheaf: Open This Folder in a Browser** from the Command Palette. Sheaf serves the folder you have open.
2. Sheaf offers you the address, with a button to open it and a button to copy it. Open it here, or copy it to open somewhere else.
3. The address opens a list of every Markdown file in the folder, and every `.txt`. Pick one and it opens in Sheaf.

## Stop serving the folder

Run **Sheaf: Stop Serving to the Browser** from the Command Palette. It also stops on its own when you close your editor window.

## Edit a document in the tab

Type as you would in your editor. Everything works the same way: the toolbar, the slash menu, the right-click menu, tables as a grid, callouts, typeset maths, the table of contents.

- Typing writes to the file. There is no save button and nothing to press, in the same way there is nothing to press in your editor.
- Links between documents open the document they point at, and a link to a heading scrolls to it.
- Images pasted or dropped into a document are written into an `assets` folder beside it and linked from there, which is where they go in your editor too.
- The folder's settings are read from the project, so a document looks the same in a tab as it does in your editor window.
- The table of contents is the one setting that behaves differently. The toolbar button turns it on for that tab only, and writes no setting into the project you have checked in.

## Work in a tab and your editor at once

Open the same file in a browser tab and in your editor. A change in either shows up in the other within a moment, because both are writing to the one file on disk.

The same is true of anything else that writes the file. A document changed by a tool, or by switching branches, updates in the tab you are looking at.

When the file has changed underneath an edit you are part-way through, your text is what gets written. This is the same rule your editor follows, and it means the honest way to use both at once is one at a time.

When a write does take something you had just typed, the tab tells you at the bottom of the page, quoting what went, with an Undo button. The write is on the undo stack either way, so Cmd+Z (Ctrl+Z on Windows and Linux) brings your version back whether or not you use the button. A write that leaves your work alone says nothing.

## Fix a server that does not start

- **The port is busy.** Sheaf tries the next port up, twenty times, before giving up. Close whatever is holding those ports, or stop serving from another window, and run the command again.
- **Nothing opens.** The address is printed either way. Paste it into a browser.
- **The folder is somewhere else.** The command serves a folder on the machine it is running on. A folder open over a remote connection is not one of those.

## Good to know

- It serves one folder, the one you started it in. A link that points outside that folder does not open, and neither does anything in a hidden folder such as `.git`. This is deliberate: the browser is being given a folder of your files, and the fence around it is the whole reason it is safe to do that.
- It listens on this machine only. There is no option to put it on a network address, because a folder of your documents on a network is a different thing with different questions to answer.
- It is one folder at a time per window. Run the command in a second editor window for a second folder, and it takes the next free port.
- There is no `sheaf` command to run in a terminal yet. Installing the extension does not put one on your path. A package called `sheaf` on npm is somebody else's and has nothing to do with this project, so do not install it expecting this.
