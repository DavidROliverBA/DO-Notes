---
title: Boards
---
# Boards

A board is a whiteboard for your notes. You put notes on it as cards, alongside text, links and pictures, and join them with arrows. **A card is the note itself**, not a copy: change the note anywhere and every board it's on shows the change, and one note can sit on as many boards as you like.

Boards are saved as `.canvas` files, the [JSON Canvas](https://jsoncanvas.org) format that Obsidian and other Markdown editors use. A board from another editor opens here as it was, and a board made here opens there.

## Make a board

Press ⌘K and choose **New board**, then name it. A board appears in the file panel with a board icon, and opens like any note. To bring boards you already have, import the folder or `.zip` they're in (see [Import, export and GitHub](import-export.md)): each `.canvas` file becomes a board.

## Cards

The **+** button at the top left of a board adds:

- **Text**: a card you write on in Markdown. Double-click a text card, or select it and press Return, to change it; press Esc when you're done.
- **Note or board…**: an existing note, shown as a card with its text, or another board, shown as a small map of its cards.
- **New note…**: makes a note in the board's folder and puts it on the board.
- **Link…**: a card for a web address.
- **Group…**: a labelled frame. With cards selected, the group is drawn around them. Moving a group moves the cards inside it.

Click a note card's title to open the note, or a board card's title to open that board.

**Move around** a board by scrolling (two fingers on a trackpad), and zoom by pinching on the trackpad or holding ⌘ while you scroll. The button at the end of the board's toolbar fits the whole board on screen; on a laptop, the small map in the corner shows where you are, and you can drag in it.

Drag a card to move it, and drag its corners to resize it. Drag across empty space to select several cards. **Colour** gives the selected cards or arrows one of six colours, and **Arrange** brings them to the front, sends them to the back, or tidies them.

## Arrows

Hover over a card and drag from the dot in the middle of any side to another card to join them with an arrow. Double-click an arrow to label it.

You don't have to drag. Select a card and press the arrow button (or ⌘K → **Connect to…**), then pick the other card from the list. With an arrow selected, the swap button (or ⌘K → **Reverse the arrow**) turns it round so it points the other way; **Undo** turns it back.

**Arrows on this board**, the list button on the board (or in ⌘K), gives every arrow as a sentence, such as *Roof → comes before → Loft*. Choose one to select it and bring it into view, ready to label, reverse or remove. With a screen reader, this list is the way to read what the board joins up.

An arrow between two notes can become a **relationship**: select it and press the link button (or ⌘K → **Make the arrow a relationship…**). The [relationship builder](types.md) opens with the arrow's two notes, and its label as the kind (offered as a new kind if the collection hasn't got it). The note the arrow starts from gets a property linking to the other note, such as `comes-before: [[Loft]]`. That link then holds outside the board too: it shows on [type pages](types.md) and in the other note's links. The arrow stays on the board.

## Layouts

- **Tidy up** snaps the selected cards (or every card) to a grid and moves apart any that overlap.
- **Arrange the group**, with a group selected, lays its cards out in a grid and fits the group around them.
- **Mind map from here**, with one card selected, lays out everything joined to it by arrows as a map growing to the right.

Each layout is one step: **Undo** (⌘Z) puts the cards back.

## A note's boards

A note's side panel lists, under **On boards**, every board the note is on, and the arrows drawn to and from it there, with their labels. Click one to go to it.

## Together, offline and on the phone

- **Live:** several people can arrange the same board at once. You see where each person has selected, and moves to different cards all count.
- **Undo** (⌘Z, ⇧⌘Z for redo, or the buttons on the board) takes back your own changes, not other people's.
- **Offline:** a board you've opened is kept on the device, like a note, and your changes merge when you're back online.
- **On the iPhone:** drag with one finger on empty space to move around the board, and pinch to zoom. Touch a card to select it, or drag it to move it. The dots you draw arrows from show on every card.
- **History and Trash** work as for notes: a board's versions are in its ⋯ menu.

> [!note] What other editors keep
> DO Notes keeps everything another editor wrote into a `.canvas` file, including settings it doesn't use. A board's file is only rewritten when its cards or arrows change.
