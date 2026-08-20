# Ibid.

Ibid is a TypeScript Word add-in for reviewing EU-law citations in footnotes. It identifies CJEU/CURIA, EUR-Lex, and Commission references and presents the relevant official record in the task pane. It assists source inspection and does not assess legal correctness.

**Reviewing this for information security?** Start with [docs/DATA-FLOW.md](docs/DATA-FLOW.md). It states what leaves the workstation and what does not, records the weaknesses we would raise ourselves, and gives the command that checks each claim against this repository.

The name is styled **Ibid.** with the terminal period on branded surfaces — the add-in display name, the task-pane header, and page titles. Running prose and identifiers use bare `Ibid`, `@ibid/*`, and `IBID_*`.

## Documentation

| Document | What it covers |
| --- | --- |
| [docs/DATA-FLOW.md](docs/DATA-FLOW.md) | What crosses the wire and what stays on the machine, the points a reviewer should weigh, and a command to verify each claim. Written for an IT or information-security review. |
| [docs/HOSTING.md](docs/HOSTING.md) | Deploying the pane and API to a real HTTPS origin, generating the hosted manifest, and sideloading it into Word. |
| [docs/STATUS.md](docs/STATUS.md) | Current recognition and retrieval coverage, and the production hardening still outstanding. |
| [docs/HANDOFF.md](docs/HANDOFF.md) | Implementation detail, the log of what has been verified live, and a continuation checklist. |

## Workspace packages

- `addin/` Office.js task pane app
- `api/` optional backend for source normalization and retries
- `shared/` common types and utilities
- `docs/` security, hosting, and implementation documentation
- `samples/` fictional Word documents for manual checks

## Current state

The add-in reads Word footnotes, recognises common EU citations, normalises reliable references to CELEX, and retrieves a bounded EUR-Lex passage when available. CURIA and Commission citations use direct official-record adapters. See [docs/STATUS.md](docs/STATUS.md) for current coverage and deployment constraints.

## Requirements

- **Node 22 or later** to build and run.
- **Word 2302+, Office 2024, Word on the web, or Word for Mac 16.70+.** Footnote enumeration requires WordApi 1.5, which the manifest declares — so Word refuses to activate rather than loading a pane that would find nothing. Volume-licensed Office 2019 and 2021 cannot run Ibid at all; confirm the target build before evaluating.

## Development

Run `npm run dev` and sideload `addin/manifest.xml` in Word.

Word on the web needs nothing further. **Desktop Word needs a certificate it trusts**,
because the pane runs in an embedded browser that checks the operating system's trust
store — WebView2 checks Windows', WKWebView checks the Mac's — and neither has heard of the
self-signed certificate Vite generates. Desktop Word then refuses the pane where a browser
would offer a warning to click past, so it reads as a broken add-in rather than a
certificate problem. Issue a trusted one once:

```bash
npx office-addin-dev-certs install     # writes ~/.office-addin-dev-certs, trusts its CA
```

`addin/vite.config.ts` picks those files up automatically and falls back to the self-signed
certificate when they are absent, so this is optional until you need the desktop client. Do
not work around it by trusting the certificate Vite generates: that one also claims Code
Signing and Certificate Sign, which is far more authority than a throwaway localhost
certificate should be granted.

Developing on WSL against Word on Windows works — Windows reaches the dev server over
`localhost` — but the CA has to be installed on the *Windows* side, where WebView2 looks:

```bash
certutil.exe -user -addstore Root "$(wslpath -w ~/.office-addin-dev-certs/ca.crt)"
# undo: certutil.exe -user -delstore Root "Developer CA for Microsoft Office Add-ins"
```

Sideloading into Word for Windows reads from a **shared folder catalog**, not a local path,
and it lists what is in that folder at the time Word starts. `docs/HOSTING.md` has the
steps. If the add-in does not appear, check that the manifest is actually in the shared
folder and restart Word before looking anywhere else.

Run `npm run verify` to lint, type-check the tests, run the full test suite, and build. It is the single command that establishes the tree is sound.

Four sample documents sit in [samples/ibid-demo-docx/](samples/ibid-demo-docx/); their own README says what each is for. Three are constructed, covering detection, the collected citation patterns, and back-references — every identity in them is fictional and every authority public, so they can be used anywhere a client document could not. The fourth is a published Commission decision at full length, 645 footnotes, which is what the add-in actually meets; it is public but names real parties, so it is not a substitute for the fictional three.

The API defaults to port 4000. If it is already in use, start both the API and Vite proxy on another port with `IBID_API_PORT=4001 npm run dev`.

For implementation state, known blockers, and a concrete continuation checklist, see [docs/HANDOFF.md](docs/HANDOFF.md).
