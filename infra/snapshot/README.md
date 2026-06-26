# Daytona snapshot image

The base image every workspace sandbox is created from. Its **pinned digest** is
the reproducibility anchor (contract §1, plan §7).

## What it provides

`node`, `python3` + `pip`, `opencode`, and PDF/document tooling
(`poppler-utils` → `pdftotext`, `pypdf`, `pdfplumber`, `pandoc`). Plus the baked
[`AGENTS.md`](./AGENTS.md) that tells opencode how to keep automations
reproducible.

## Build, push, and pin (checklist C2)

Daytona creates sandboxes from a **snapshot** that references an image in a
registry. Build this image, push it, register it as a Daytona snapshot, then
record the resulting **digest** in `.env`.

```bash
# 1. Build (from this directory)
docker build -t <registry>/daytona-agentic-snapshot:1 .

# 2. Push to a registry Daytona can pull from
docker push <registry>/daytona-agentic-snapshot:1

# 3. Record the digest (the reproducibility anchor)
docker inspect --format='{{index .RepoDigests 0}}' \
  <registry>/daytona-agentic-snapshot:1

# 4. Register as a Daytona snapshot (CLI) and note its name
daytona snapshot create agentic-snapshot \
  --image <registry>/daytona-agentic-snapshot@sha256:<digest>
```

Then set in `.env`:

```
DAYTONA_SNAPSHOT=agentic-snapshot
DAYTONA_SNAPSHOT_DIGEST=sha256:<digest>
```

> Phase-0 spike S1 validates this end to end: create a sandbox from the snapshot,
> run `opencode serve` on :4096, reach it via the preview URL, and curl the SSE
> `/event` stream. Do that before relying on the server's workspace lifecycle.

## Alternatively: declarative image via the SDK

The server could also build this image with the Daytona SDK's `Image` builder
(`Image.base("node:22-bookworm").pipInstall(...)`). The Dockerfile here is the
source of truth for what must be present either way.
