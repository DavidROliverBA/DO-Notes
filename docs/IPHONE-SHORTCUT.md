# Share to DO Notes from the iPhone

Safari on the iPhone can't let a web app receive shares (WebKit bug 194593), so DO Notes
uses an Apple Shortcut instead. Once it's set up, **Save to DO Notes** appears in the share
sheet of every app. Links, text and photos are added as to-dos at the end of a note (`Inbox` by
default), so you can file them later. A shared web page also becomes a **Weblink** note of its
own, with the page's title, summary, site and picture, and the inbox to-do links to it; sharing the
same page again finds that note rather than making another. The DO Notes iPhone app (`ios/`) has a share extension of its
own and needs none of this; the Shortcut is for a phone without the app.

## 1. Make a token

In DO Notes go to **Settings → Connections → Share from iPhone**. Choose the collection and the note, name the
phone, and press **Create token**. Keep that screen open: it shows the **address** and the
**Authorization** line, each with a Copy button, and the token is shown only this once.

A capture token can add to that one note and do nothing else. It stops working if you revoke it
or lose edit rights to the collection. It goes in a request header, never in the address.

## 2. Build the Shortcut

On the iPhone, open **Shortcuts** and tap **+**.

1. Tap the name at the top and call it **Save to DO Notes**.
2. Tap **ⓘ** (the info button), turn on **Show in Share Sheet**, and tap **Done**.
3. Add the action **Get Images from Input**, with *Shortcut Input* as its input.
4. Add **Get URLs from Input**, also on *Shortcut Input*.
5. Add **Get Contents of URL**:
   - **URL**: paste the address (`https://…/api/capture`).
   - Tap **›** to show more.
   - **Method**: POST.
   - **Headers**: add one. Key `Authorization`; value: paste the line that starts `Bearer cpc_`.
   - **Request Body**: Form. Add three fields:
     | Key | Type | Value |
     |---|---|---|
     | `item` | Text | *Shortcut Input* |
     | `url` | Text | *URLs* |
     | `photo` | File | *Images* |
6. Add **Get Dictionary Value**: get *Value* for `message` in *Contents of URL*.
7. Add **Show Notification** with *Dictionary Value*.

Optional: at the top, under **If there's no input**, choose **Get Clipboard**. Then running the
Shortcut from the home screen, or with Back Tap, saves whatever you last copied.

## 3. Try it

Share a web page from Safari and choose **Save to DO Notes**. A notification should say
*Saved it to Inbox*. Then share a photo, and some text from Notes.

What lands in the note:

```markdown
- [ ] [How to tile a kitchen](https://example.com/guides/tiling) · 11 Oct 09:15
- [ ] Ring the electrician · 11 Oct 09:20
  about the hob
- [ ] ![[attachments/IMG_0042.jpg]] · 11 Oct 09:31
```

Photos are converted on the server: HEIC becomes JPEG (Chrome can't show HEIC), and a large
photo is shrunk to 2048 px on its longest side and turned the right way up. A photo too big to
convert safely on the server (over 25 megapixels as HEIC, or 16 as JPEG) is kept as it is.

## If it doesn't work

| The notification says | What to do |
|---|---|
| *Add your capture token as an Authorization: Bearer header* | The header is missing or misspelt. Its key must be exactly `Authorization`, and its value must start with `Bearer `. |
| *This capture token isn't valid…* | It was revoked or mistyped. Make a new one in Settings → Connections and paste it again. |
| *Nothing to save* | The share had nothing DO Notes understands, for example a contact card. |
| Nothing at all, or an error from Shortcuts | Check the address ends in `/api/capture` and the Method is POST. |

A web page's title isn't sent, so a shared link is labelled by its address (`bbc.co.uk/news`).
Rename it in the note if you like.

Built and tested against the server's API; the Shortcuts steps are written from Apple's actions
and should be checked on a real phone. Anything that differs belongs in this file.
