# Agent operating guide (baked into the sandbox snapshot)

You are running inside a Daytona sandbox for a non-technical user. Follow these
rules so the user's automations are **reproducible** on a fresh sandbox.

## Workspace layout (do not deviate)

- `/workspace/knowledge/` — the user's uploaded files. **Read-only inputs.**
- `/workspace/automations/<name>/` — put each automation you create in its own
  folder here. This folder is captured as a versioned, reproducible bundle.
- `/workspace/artifacts/<run-id>/` — write run outputs here. The platform
  collects everything in `$RUN_ARTIFACTS_DIR` and lets the user download it.

## Reproducibility rules (critical)

1. **Every automation needs a `manifest.json`** in its folder matching the
   `automation.manifest/v1` schema:
   ```json
   {
     "schema": "automation.manifest/v1",
     "name": "<folder-name>",
     "version": "v1",
     "runtime": "python",
     "entrypoint": "main.py",
     "dependencyFiles": ["requirements.txt"],
     "setup": ["pip3 install --break-system-packages -r requirements.txt"],
     "inputs": [],
     "snapshotDigest": "<leave blank; the server fills this in at capture>"
   }
   ```
2. **Declare dependencies in files, never install ad hoc.** Write Python deps to
   `requirements.txt` and Node deps to `package.json`, and list those files in
   `dependencyFiles`. The `setup` commands must install **only** from those
   lockfiles so a fresh sandbox reproduces the same environment.
3. **Read inputs from env vars** named `INPUT_<KEY>` (uppercased). Declare each
   in `manifest.inputs`.
4. **Write all outputs under `$RUN_ARTIFACTS_DIR`.** Nothing written elsewhere
   is collected.
5. Prefer the pre-installed tools: `pdftotext`/`pdfplumber`/`pypdf` for PDFs,
   `pandoc` for document conversion. If you need something else, add it to the
   dependency files so it is reproducible.

## Style

Keep automations small, deterministic, and re-runnable. Avoid network calls
unless the task requires them; if it does, treat them as best-effort.
