# Hosting Ibid, and getting it onto the client's Word

An Office add-in is not native code. It is a web page that Word loads in an embedded
browser (WebView2 on Windows, WKWebView on Mac). "It works on my machine" therefore means
"the servers are on my machine" — and until this is hosted, they are. Cloning the repo
would leave the client needing Node, a terminal running `npm run dev` whenever they open
Word, and a certificate they cannot install without local administrator rights.

Hosting removes all of it. Once the pane and API are on a real HTTPS origin, they install
**nothing**: they load one manifest file and Word fetches everything else.

## What has to be true

| | Why |
| --- | --- |
| **HTTPS with a publicly trusted certificate** | Office refuses to load a task pane from an untrusted origin. A self-signed certificate works only on a machine where it has been installed into the trust store, which is what makes the current dev setup undeliverable. |
| **One origin for pane and API** | The pane calls `/api` relatively. Serving both from one origin keeps it same-origin, so CORS never enters into it. |
| **Word 2302+ / Office 2024 / Word on the web / Mac 16.70+** | Footnote enumeration is WordApi 1.5. The manifest declares it, so Word refuses to activate rather than loading a pane that finds nothing. **Volume-licensed Office 2019 and 2021 cannot run Ibid at all.** Worth confirming the client's build before anything else. |

## Two shapes, and which one you want

| | When | What it costs |
| --- | --- | --- |
| **One process** | Letting a client try it. Any free tier, or a tunnel from your own machine. | Nothing, and no proxy to configure. |
| **Proxy in front** | A host you control and intend to keep. | A VM, and a Caddyfile. |

They differ in one setting. `IBID_STATIC_DIR` makes the API serve the built pane as well as
answer `/api`, which is what a platform host needs, because a platform host gives you one
process, one port and nothing to configure a proxy in:

```bash
npm ci && npm run build
IBID_STATIC_DIR=./addin/dist IBID_BIND_HOST=0.0.0.0 \
IBID_USER_AGENT='Ibid/1.0 (+https://your-host; you@example.com)' \
  node api/server.mjs
```

That is the whole difference. The pane calls `/api/...` either way and does not have to know
which deployment it is in. See `api/README.md` for what the static server refuses to serve.

### Where it is actually hosted, and how to tell what is deployed

Today that platform host is **Render**, at `https://ibid.onrender.com`, built from the GitHub
repository: build `npm ci && npm run build`, start `IBID_STATIC_DIR=./addin/dist node
api/server.mjs`, with `IBID_BIND_HOST=0.0.0.0` so it binds the port Render gives it.

**A push is not a deployment, and the pane looks identical either way.** Whether the host
redeployed is not visible in Word, and a reviewer who cannot see a change concludes the feature
is missing rather than that the build is old. So the service names the build answering:

```bash
curl -s https://ibid.onrender.com/api/health
```

`{"status":"ok","commit":"…"}` — Render sets `RENDER_GIT_COMMIT` itself, and any other host can
set `IBID_COMMIT` at build time. Compare it with `git rev-parse HEAD`.

Where they differ the deployment is behind, and a push is not what tells you: on 24 November
2026 ten commits sat on `master` while the service went on serving a build from before them,
answering healthily the whole time. Three things to look at, in this order — whether the
service's **Auto-Deploy** is on, whether the branch it watches is the branch being pushed to,
and whether the recent builds **failed**, because a failed build leaves the last good deploy
running and that is indistinguishable from a deploy that never started. Render records none of
this on the commit: there were no GitHub deployment records and no commit statuses either, so
the service's own event log is the only place it shows.

The pane's own bundle is content-hashed, so the same question can be asked of it without
trusting any cache:

```bash
curl -s https://ibid.onrender.com/taskpane.html | grep -o 'main-[A-Za-z0-9_-]*\.js'
```

That filename changes with every change to the pane, and `addin/dist/assets/` holds the one a
local `npm run build` produces. Two different names mean two different builds.

After a redeploy to the same address, close and reopen the task pane. Nothing further is
needed, and in particular none of the add-in cache clearing a *changed* address requires below:
`taskpane.html` is served `cache-control: no-cache` (measured against the live service on 24
November 2026), so Word refetches it on every load, and the bundle's hashed name means the new
code comes with it. What has to happen is only that the page loads again at all.

**A trial has a confidentiality choice in it that a deployment does not.** No text from the
client's document ever reaches the server — that is structural, and `DATA-FLOW.md` is
written for their IT to check it. But the *lookups* name the authorities their document
cites, which is metadata about it. Served from your own machine through a tunnel, nobody
else sees those. Served from a third-party free tier, that provider does. For a first look
at a client's own document, the tunnel is the honest default.

## Deploy

Any small VM will do — the API is a single Node process and the pane is static files.

```bash
npm ci
npm run build                      # shared -> api -> addin (addin/dist is the pane)
IBID_USER_AGENT='Ibid/1.0 (+https://your-host; you@example.com)' \
IBID_ALLOWED_ORIGIN='https://ibid.example.com' \
  node api/server.mjs              # listens on 127.0.0.1:4000
```

Put a TLS-terminating proxy in front. Caddy is the least work, because it obtains and
renews the certificate itself:

```caddy
ibid.example.com {
    handle /api/* {
        uri strip_prefix /api
        reverse_proxy 127.0.0.1:4000
    }
    handle {
        root * /srv/ibid/addin/dist
        file_server
    }
}
```

Keep the API bound to `127.0.0.1`. It has no authentication of its own; the proxy is what
should be reachable.

## Build the manifest

The manifest is the one artefact carrying an absolute origin, in ten places. Generate it
rather than hand-editing:

```bash
npm run manifest -w addin -- https://ibid.example.com --out ./ibid-manifest.xml
npx office-addin-manifest validate ./ibid-manifest.xml
```

Add `--id <guid>` if anyone needs the dev and hosted add-ins installed side by side. Office
keys an add-in by its `<Id>`, so two manifests sharing one are a single add-in to Word and
the second silently replaces the first.

Send the client that one file. Nothing else.

## Sideloading, for the client

**Word on the web — much the easiest, start here.** Open a document at office.com, then
**Home > Add-ins > More Settings > Upload My Add-in > Browse** to `ibid-manifest.xml`,
then **Upload**. The manifest lives in browser local storage, so clearing the cache or
switching browser means uploading it again.

**Word for Windows desktop.** Requires a folder shared over the network, even locally:

1. Right-click a folder, **Properties > Sharing > Share**, add yourself with Read/Write,
   and note the full network path (`\\MACHINE\Folder`).
2. Put `ibid-manifest.xml` in it.
3. Word: **File > Options > Trust Center > Trust Center Settings > Trusted Add-in
   Catalogs**. Paste the network path into **Catalog Url**, **Add catalog**, tick
   **Show in Menu**, **OK**.
4. Restart Word.
5. **Home > Add-ins > Advanced > SHARED FOLDER**, select **Ibid.**, **Add**.

**Word for Mac.** Copy the manifest to
`~/Library/Containers/com.microsoft.Word/Data/Documents/wef` (create it if absent) and
restart Word.

Either way the add-in appears on the **Home** tab as **Ibid. > Review citations**.

**A trial address that changes reaches desktop Word late.** `npm run trial` mints a new
tunnel address whenever it is restarted, and writes it into a new manifest under the same
`<Id>` and `<Version>`. Word on the web takes the new file at its next upload. Desktop Word
keeps the add-in it already loaded in a cache of its own, keyed by that `<Id>`, so the client
replaces the file in the shared folder (or `wef`), restarts Word, and — if the old address
still opens — clears that cache. Keeping the machine awake for the length of the trial avoids
all of it.

Sideloading may be disabled by policy on a firm-managed machine. That is a control working
as intended, not an obstacle to route around — and a client document should never be opened
on an unmanaged device in order to try a tool out. Two routes stay open instead: evaluate
against the fictional sample documents in `samples/ibid-demo-docx/`, which exercise every
recognition path without touching client material; or ask IT to enable sideloading for a
single account. Firm-wide use goes through a centralized deployment in the Microsoft 365
admin center — a conversation, not a build step. `DATA-FLOW.md` is written for it.
