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

Sideloading may be disabled by policy on a firm-managed machine. That is a control working
as intended, not an obstacle to route around — and a client document should never be opened
on an unmanaged device in order to try a tool out. Two routes stay open instead: evaluate
against the fictional sample documents in `samples/ibid-demo-docx/`, which exercise every
recognition path without touching client material; or ask IT to enable sideloading for a
single account. Firm-wide use goes through a centralized deployment in the Microsoft 365
admin center — a conversation, not a build step. `DATA-FLOW.md` is written for it.
