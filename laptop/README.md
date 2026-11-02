# DO Notes on a laptop

DO Notes runs on your own computer as two containers: the app and its own Postgres database. You don't need a cloud account or a server, and an internet connection is optional once it's installed. Only your computer can reach this DO Notes, and your notes stay on the computer until you remove them.

This guide takes you from nothing to a working DO Notes, then covers backups, updates, connecting Claude, your iPhone, and common problems.

- [Before you start](#before-you-start)
- [Step 1: Install a container engine](#step-1-install-a-container-engine)
- [Step 2: Get DO Notes](#step-2-get-commonplace)
- [Step 3: Start DO Notes](#step-3-start-commonplace)
- [Step 4: Create your account](#step-4-create-your-account)
- [Step 5: Check it works](#step-5-check-it-works)
- [Using it day to day](#using-it-day-to-day)
- [Optional settings](#optional-settings)
- [Using it from your iPhone](#using-it-from-your-iphone)
- [Connecting Claude (MCP)](#connecting-claude-mcp)
- [Backups](#backups)
- [Updating](#updating)
- [Moving to another computer](#moving-to-another-computer)
- [Uninstalling](#uninstalling)
- [Command reference](#command-reference)
- [FAQ](#faq)
- [Troubleshooting](#troubleshooting)

## Before you start

**What you need:**

- **A computer:** a Mac (Apple Silicon or Intel), a Windows 10/11 PC, or Linux, with at least 8 GB of memory.
- **Disk space:** about 3 GB free. That covers the container engine plus the 1.2 GB of DO Notes images, and your notes grow from there.
- **Rights to install software:** you install a container engine once (Step 1). If your computer is managed by IT, you may need them to do this.
- **Internet for the install only**, if you build from source. If someone gives you a packaged kit (a `commonplace-laptop-….tar.gz` file), you don't need internet at all.

**Two ways to install:**

| | Build from source | Use a packaged kit |
|---|---|---|
| You start with | The DO Notes git repository | A `commonplace-laptop-arm64.tar.gz` or `commonplace-laptop-amd64.tar.gz` file |
| Internet | Needed for the first build | Not needed |
| Updating | `./commonplace.sh update` | Get a newer kit and run `./commonplace.sh load` |
| Best for | People who will update often | Locked-down or offline computers |

**Which kit?** Choose `arm64` for Apple Silicon Macs (M1 and later) and Arm Windows PCs. Choose `amd64` for Intel Macs and most Windows and Linux PCs. If you're not sure, see [the FAQ](#which-kit-do-i-need).

**Just want to try it?** The standalone file (`commonplace.html`, attached to each release) opens a folder of Markdown in the browser with nothing to install. This kit is the full app: accounts, history, live editing, search, websites, GitHub collections and AI.

## Step 1: Install a container engine

A container engine runs the two DO Notes containers. Install **one** of these. If you already have Docker Desktop or Rancher Desktop working, go to Step 2.

### Mac

1. Install **Docker Desktop** from <https://www.docker.com/products/docker-desktop/>. Pick the Apple Silicon or Intel download to match your Mac (Apple menu → About This Mac).
   - **At work?** Check the licence first: companies with 250 or more staff, or $10 million or more in revenue, need a paid Docker subscription. If you don't have one, install **Rancher Desktop** instead (free, <https://rancherdesktop.io>). In its first-run settings, choose the **dockerd (moby)** container engine.
2. Open it once and wait until it says it is running. A whale or ranch icon appears in the menu bar.
3. Open **Terminal** and check:

   ```bash
   docker compose version
   ```

   You should see a version number such as `Docker Compose version v2.29.0`.

### Windows

1. **Turn on WSL 2** (Windows Subsystem for Linux). Open **PowerShell as administrator** and run:

   ```powershell
   wsl --install
   ```

   Restart when asked. Ubuntu opens and asks you to choose a Linux user name and password; this is separate from your Windows login.
2. **Install Docker Desktop** (<https://www.docker.com/products/docker-desktop/>) and keep **Use WSL 2 based engine** ticked. Then go to **Settings → Resources → WSL integration** and switch on **Ubuntu**.
   - **At work?** The same licence rule applies as on the Mac. The free alternative is **Rancher Desktop** with the **dockerd (moby)** engine and WSL integration turned on for Ubuntu.
3. Open **Ubuntu** from the Start menu and check:

   ```bash
   docker compose version
   ```

Run every command in this guide in the **Ubuntu** window, not PowerShell. DO Notes opens in your normal Windows browser.

### Linux

1. Install Docker Engine and the compose plugin, following <https://docs.docker.com/engine/install/> for your distribution.
2. Let your user run Docker without `sudo`: `sudo usermod -aG docker $USER`, then log out and back in.
3. Check: `docker compose version`.

### Podman instead of Docker

Podman works too: you need `podman compose` working, and a `podman machine` running on Mac and Windows. `commonplace.sh` uses Podman automatically when Docker isn't installed, or you can set `COMMONPLACE_ENGINE=podman` (see [Optional settings](#optional-settings)).

## Step 2: Get DO Notes

### From source

You need `git`. Macs prompt you to install it the first time you use it; on Ubuntu or WSL, run `sudo apt install git`.

Clone DO Notes into a **plain folder that isn't synced to the cloud**:

```bash
mkdir -p ~/src && cd ~/src
git clone https://github.com/DavidROliverBA/commonplace-md.git commonplace
cd commonplace/laptop
```

> **Why not Documents or Desktop?** Those folders are often synced by iCloud Drive or OneDrive. The sync fetches files one at a time while Docker reads them, so the first build can take half an hour instead of a few minutes. On Windows, clone inside Ubuntu (`~/src`), not under `/mnt/c/…`, for the same reason.

### From a packaged kit

Put the kit file in a plain folder, then extract it:

```bash
mkdir -p ~/commonplace && cd ~/commonplace
tar -xzf ~/Downloads/commonplace-laptop-amd64.tar.gz      # use the name of your file
cd laptop
```

On Windows, copy the file into Ubuntu first. In the Ubuntu window, run `cp /mnt/c/Users/<you>/Downloads/commonplace-laptop-amd64.tar.gz ~/commonplace/`.

## Step 3: Start DO Notes

Make sure your container engine is running, then, from the `laptop` folder:

```bash
./commonplace.sh start
```

What happens:

1. **The first time only:**
   - It makes a `SECRETS_KEY` and saves it in `laptop/.env`. This key locks away the AI keys and GitHub tokens people add. Keep the file (see [Backups](#backups)).
   - **From source:** it builds the image, which takes 2 to 5 minutes.
   - **From a kit:** it loads the images from `images/commonplace-images.tar`, which takes about a minute.
2. It starts the database, then the app, and waits until both are healthy.
3. It prints the address, such as `DO Notes is running at http://localhost:8070`, and opens it in your browser.
4. On the first run, it also prints a **setup token**:

   ```text
   First run: create your (admin) account with this one-time setup token:
     weKqU68ZBrGboCP_RsXW-VMJ
   ```

Later starts take a few seconds.

> **Port 8070 already in use?** Run `echo COMMONPLACE_PORT=8071 >> .env`, then `./commonplace.sh start` again. DO Notes will be at <http://localhost:8071>.

## Step 4: Create your account

1. The browser tab that opened says "Welcome. The first account you create is the admin."
2. Enter your name, email address, a password of at least 8 characters, and the **setup token** from Step 3.
3. Select **Create account**. You're signed in, as the admin, with your first collection.

Lost the token before using it? Run `./commonplace.sh token` to see it again. The token works once; after that, DO Notes never asks for it.

**Keep your password safe.** There's no email on a laptop, so there are no reset links. If you forget it, use [`./commonplace.sh reset-password`](#i-forgot-my-password).

## Step 5: Check it works

1. Make a note, type a few lines and a `[[link]]` to another note.
2. Run `./commonplace.sh stop`, then `./commonplace.sh start`. Your note is still there.
3. Run `./commonplace.sh backup`. A file appears in `laptop/backups/`.

That's it. The **?** at the bottom of the file panel opens the built-in help. To bring notes in, use **Settings → This collection → Import markdown** with a zip of a Markdown folder.

## Using it day to day

- **Starting and stopping:** `./commonplace.sh start` and `./commonplace.sh stop`. Stopping keeps your notes.
- **After a restart:** DO Notes comes back on its own when the container engine starts, unless you stopped it with `./commonplace.sh stop`. Docker Desktop and Rancher Desktop can start when you log in; look for "Start when you sign in" in their settings.
- **Is it running?** Run `./commonplace.sh status`.
- **Bookmark** <http://localhost:8070>, or your own port. In Chrome or Edge you can also install it as an app (the install icon in the address bar), and it works offline like the iPhone app.

## Optional settings

Settings live in `laptop/.env`, which `start` made with your `SECRETS_KEY` in it. Add lines to it (`.env.example` lists them all), then run `./commonplace.sh start` to apply them.

| Setting | What it does |
|---|---|
| `COMMONPLACE_PORT=8071` | The port for the address in your browser. The default is 8070. |
| `COMMONPLACE_LISTEN=0.0.0.0` | Lets other devices on your network in, such as your iPhone. See [Using it from your iPhone](#using-it-from-your-iphone). |
| `COMMONPLACE_ENGINE=podman` | Uses Podman instead of Docker. |
| `EMBEDDING_PROVIDER=…` | Semantic search and related notes. `hash` (the default) works offline with no model; `relaxai` (with `RELAX_API_KEY`) or `voyage` (with `VOYAGE_API_KEY`) are better and need internet; `ollama` uses a local Ollama on this computer (`ollama pull mxbai-embed-large`). Notes re-embed by themselves when you switch. |
| `TIME_ZONE=Europe/London` | The time zone for times DO Notes writes into notes. |
| `DB_DISK_GB=20` | DO Notes refuses new notes and files once the database reaches 90% of this, so it can't fill your disk. `0` turns the check off. |
| `ALLOW_SIGNUP=true` | Lets anyone who can reach it make an account. Leave it off and invite people from **Settings → Admin**. |

**AI assistants** need no setting here: each person adds their own key in **Settings → AI assistants**. They need internet and an `https` provider (Anthropic, OpenAI, relaxAI and the like); a model running in Ollama on the same laptop isn't reachable from inside the container.

## Using it from your iPhone

By default only the laptop itself can reach DO Notes. To use it from your iPhone on the same Wi-Fi:

1. Run `echo COMMONPLACE_LISTEN=0.0.0.0 >> .env`, then `./commonplace.sh start`. It prints the address for other devices, such as `http://my-mac.local:8070`.
2. Open that address in Safari on the iPhone and sign in.
3. **Share → Add to Home Screen** makes it an app icon.

Know what this means first:

- **Anyone on that Wi-Fi can reach the sign-in page.** Do this on your home network, not on a café's or a hotel's.
- **The connection isn't encrypted** (plain `http`), so someone on the same network could read what passes. Again: home Wi-Fi only.
- **Offline doesn't work on the phone** over plain `http`: the phone needs a connection to the laptop. For encryption and offline, put it behind HTTPS, for example with [Tailscale Serve](https://tailscale.com/kb/1312/serve), and set `COOKIE_SECURE=true`.
- The iPhone only works while the laptop is awake and DO Notes is running.

To shut the door again, take the `COMMONPLACE_LISTEN` line out of `.env` and run `./commonplace.sh start`.

## Connecting Claude (MCP)

DO Notes has an MCP server at `/mcp`, so Claude Code and other agents can search, read and write your notes as you.

1. In DO Notes, open **Settings → Connections → Connect Claude**. It makes a personal token and shows the command to run, with the right address for this laptop. Copy it now: the token is shown only once.
2. Run the command. For Claude Code it looks like this:

   ```bash
   claude mcp add --transport http commonplace http://localhost:8070/mcp \
     --header "Authorization: Bearer cpm_…"
   ```

3. Ask Claude to "search my DO Notes notes for …" to check it works.

An agent has your roles: it can't see collections you can't, and nothing it does deletes. Revoke the token in the same screen at any time.

## Backups

Your notes live in a container volume called `commonplace-laptop-data`. Back it up regularly, and always before an update.

**Back up:**

```bash
./commonplace.sh backup
```

This writes `backups/commonplace-YYYYMMDD-HHMMSS.dump`, a complete copy of the database: every collection, note, attachment, version, account and website. Copy these files somewhere safe, such as a USB stick or a file share. The `backups` folder itself is on the same laptop.

**Also keep a copy of `laptop/.env`.** It holds your `SECRETS_KEY`. Without the same key, a restored backup still has every note, but people must enter their AI keys and GitHub tokens again.

**Restore:**

```bash
./commonplace.sh restore backups/commonplace-20261022-064722.dump
```

It asks before replacing anything. A restore puts back **everything** exactly as it was at the backup, including accounts and passwords.

**Plain Markdown:** **Export collection as .zip** (in `⌘K`, or **Settings → This collection**) gives you a folder of Markdown files and attachments that any Markdown editor opens. It's the way to take your notes somewhere else, and **Import markdown** brings a zip back into any DO Notes.

## Updating

**From source:**

```bash
./commonplace.sh update
```

This backs up first, pulls the latest code, rebuilds, and restarts. DO Notes updates its database by itself when it starts. If anything goes wrong, restore the backup it just made.

**From a kit:** put the new kit's `images/commonplace-images.tar` into your `laptop/images` folder, then run:

```bash
./commonplace.sh backup
./commonplace.sh load
./commonplace.sh start
```

## Moving to another computer

1. **Make a kit** on a computer that has the source:
   - `./commonplace.sh package` makes a kit for computers like this one.
   - `./commonplace.sh package linux/amd64` makes one for Intel and AMD computers, such as most Windows PCs, when you're on an Apple Silicon Mac.

   Either way you get `commonplace-laptop-<arch>.tar.gz`, about 250 MB, with everything inside. A kit never contains your notes or your `SECRETS_KEY`.
2. **Bring your notes** if you want them: run `./commonplace.sh backup` on the old computer, and copy the backup and `laptop/.env`.
3. On the new computer, follow Steps 1 and 2 with the kit. Before Step 3, put your old `.env` in the `laptop` folder in place of the kit's, and keep its `COMMONPLACE_IMAGE` line.
4. Run `./commonplace.sh start`, then `./commonplace.sh restore <file>`, and sign in with your old account. If you didn't bring notes, create a new account in Step 4.

## Uninstalling

```bash
./commonplace.sh remove
```

Type `delete` to confirm. This removes the DO Notes containers and **all its notes**. The `backups` folder and `.env` are kept. Then delete the `laptop` (or `commonplace`) folder, and uninstall the container engine if nothing else uses it.

## Command reference

Run these from the `laptop` folder:

| Command | What it does |
|---|---|
| `./commonplace.sh start` | Starts DO Notes, building or loading the image the first time, then opens it. Add `--no-open` to skip the browser. |
| `./commonplace.sh stop` | Stops it. Your notes are kept. |
| `./commonplace.sh status` | Shows the containers and whether DO Notes answers. |
| `./commonplace.sh logs` | Follows the app's log. Press Ctrl+C to leave. |
| `./commonplace.sh token` | Shows the first-run setup token while no account exists. |
| `./commonplace.sh reset-password <email>` | Gives that account a new random password, turns off two-step sign-in and "passkeys only", and signs it out everywhere. |
| `./commonplace.sh backup` | Saves the whole database to `backups/`. |
| `./commonplace.sh restore <file>` | Replaces everything with a backup, after asking. |
| `./commonplace.sh update` | Backs up, pulls the latest source, rebuilds and restarts. |
| `./commonplace.sh package [linux/amd64]` | Makes a kit for another computer. |
| `./commonplace.sh load` | Loads images from `images/commonplace-images.tar`. |
| `./commonplace.sh remove` | Deletes DO Notes and its notes. Backups are kept. |

If you can't run the script, plain compose works from the `laptop` folder: `docker compose up -d`, `docker compose stop`, `docker compose logs app`, `docker compose ps`. Set `SECRETS_KEY` in `.env` yourself first (any long random string, such as the output of `openssl rand -base64 32`).

## FAQ

### Is my data private?

Yes, as far as DO Notes is concerned:

- It accepts connections only from your own computer (`127.0.0.1`), unless you [let your iPhone in](#using-it-from-your-iphone).
- The database isn't reachable from outside its container at all.
- Nothing leaves your computer unless you use something that needs the internet: an AI assistant (your question and the notes it reads go to that provider), the assistant's web search (your search goes to Brave, with your own key), `relaxai` or `voyage` embeddings (note text goes to that provider), a GitHub collection, or a weblink (DO Notes fetches the page's title and picture).

Your notes are protected by your computer's own security, so use disk encryption (FileVault, BitLocker) and lock your screen. Backup files contain everything, including password hashes, so keep them somewhere equally safe.

### Does it work offline?

Yes. Writing, linking, search (with the default `hash` embeddings), queries, diagrams, the graph, history, copying and moving notes between your collections, and publishing all work without a network. The things in the list above need it.

What happens to those while you're offline:

- **AI assistants and web search** say they can't reach the provider. Ask again when you're back online.
- **A GitHub collection** keeps your changes and shows them as changes to send. If it sends automatically, it tries again every five minutes and sends once you're back online; it doesn't pause or lose anything. **Update** and pull requests wait until then.

### Can I publish a website from it?

Yes, **Settings → Website** works as it does on a server, but the site is at `http://localhost:8070/p/<name>/`, so only this computer can see it. To put it on the web, you need a server (see the main README: Render).

### Can colleagues use my laptop DO Notes?

Not directly: it only listens on your own computer, which keeps it private. To share notes:

- **Export** the collection as a .zip and send it; they **Import markdown** into their own.
- Use a **GitHub collection**: everyone's DO Notes (or any Markdown editor) works on the same repository.
- For a team, use a shared DO Notes on a server.

### I forgot my password

From the `laptop` folder, run:

```bash
./commonplace.sh reset-password you@example.com
```

It prints a new password. Sign in with it, then change it in **Settings → Account**.

### I lost the setup token

Run `./commonplace.sh token`. If it says no token is needed, someone already created the first account. Use `reset-password` with that account's email if you can't sign in.

### Which kit do I need?

- **Mac:** Apple menu → **About This Mac**. "Chip: Apple M…" means `arm64`; "Processor: Intel…" means `amd64`.
- **Windows:** **Settings → System → About → System type**. "x64-based processor" means `amd64`; "ARM-based processor" means `arm64`.
- **Linux:** run `uname -m`. `x86_64` means `amd64`; `aarch64` means `arm64`.

A kit for the wrong type still works under emulation, but slowly.

### Where are my notes stored?

In a container volume named `commonplace-laptop-data`, inside the container engine's disk image, not in the `laptop` folder. Removing the `laptop` folder doesn't delete them; `./commonplace.sh remove` does. Backups go to `laptop/backups/`.

A collection can also be kept in a folder of Markdown files on this computer, which other editors can open (Settings → This collection → Setup → **Keep in a folder on this Mac…**; see the in-app help, *Folders on your Mac*). Those folders live in `~/Commonplace`, which `./commonplace.sh start` creates. To use another place, set `COMMONPLACE_FOLDERS` in `.env` and restart. Don't point it at a folder iCloud Drive, Dropbox or OneDrive syncs. Folders aren't in the database backups: back them up as you do other files (Time Machine covers them).

### Can I see my web DO Notes here too?

Yes. In Settings → Connections → **Cloud library**, give its address and sign in; its collections join the menu under *In the cloud*, and notes move between the two with *Move to another collection…*. The Mac keeps a revocable sign-in, sealed with `SECRETS_KEY`; sign out in either place to end it.

### How much memory and disk does it use?

DO Notes and Postgres use a few hundred MB of memory together. The images take about 1.2 GB of disk; your notes start small and grow from there. The container engine itself uses 1 to 2 GB of memory while it runs; you can lower that in its settings.

### Will it slow my laptop down?

Not noticeably while it's idle. If you'd rather not leave it running, use `./commonplace.sh stop` when you're done; your notes are kept.

### Is this the same DO Notes as the server version?

Yes: the same image and features, with a local database. The differences are that only your computer can reach it, there's no daily off-site backup (use `./commonplace.sh backup`), and published websites stay on this computer.

## Troubleshooting

### `docker: command not found`, or `Cannot connect to the Docker daemon`

The container engine isn't installed or isn't running. Start Docker Desktop or Rancher Desktop and wait until it says it is running. On Windows, check that WSL integration is on for Ubuntu (Step 1).

### `./commonplace.sh: Permission denied`

Run `chmod +x commonplace.sh`, or run it as `bash commonplace.sh start`.

### `$'\r': command not found` (Windows)

The script got Windows line endings, usually because the repository was cloned in Windows rather than in Ubuntu. Clone again inside Ubuntu, or fix this copy with `sed -i 's/\r$//' commonplace.sh`.

### The first build sits on "transferring context" for minutes

The source is in a cloud-synced folder (iCloud Drive, OneDrive, Dropbox). Clone it to `~/src` instead (Step 2).

### The build fails downloading packages

The build needs internet, and behind a company proxy or TLS inspection it may fail. Set the proxy in Docker Desktop (**Settings → Resources → Proxies**), or ask someone to make a kit for you (`./commonplace.sh package`). A kit needs no internet.

### `port is already allocated` or `address already in use`

Something else is using port 8070. Run `echo COMMONPLACE_PORT=8071 >> .env`, then `./commonplace.sh start`.

### "DO Notes didn't answer"

Run `./commonplace.sh logs` and look at the last lines:

- **`ECONNREFUSED` to the database:** the database is still starting. Run `./commonplace.sh start` again.
- **`no space left on device`:** free some disk space, or raise the disk limit in the container engine's settings.

### "AI keys can't be read any more"

`SECRETS_KEY` in `laptop/.env` changed, or the file was lost. Put back the old `.env` if you have it; otherwise each person enters their AI key and GitHub token again.

### The browser shows an old version after an update

Reload with Ctrl+Shift+R (Cmd+Shift+R on a Mac).

### Rancher Desktop: `docker` works but `docker compose` doesn't

In Rancher Desktop's **Preferences → Container Engine**, choose **dockerd (moby)**, not containerd.

### Podman: `compose` isn't found

Install `podman-compose`: `pip install podman-compose`, or `brew install podman-compose` on a Mac. On Mac and Windows, check that `podman machine start` has run.

### Starting over completely

Back up anything you want to keep, then run `./commonplace.sh remove` followed by `./commonplace.sh start`. You'll get a new setup token and an empty DO Notes.
