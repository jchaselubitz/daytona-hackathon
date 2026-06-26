# Overlord Mission: ove:3: Project plan

## Instructions
Use the Overlord skill. Follow the required protocol workflow.

## Objectives
1. [complete] We are building a service that lets non-technical users run agentic work in Daytona sandboxes. (this will include creating and running automation scripts) To start, we will run the server and frontend in a container locally, and later user a DB and backend cloud service. The user workflow is as follows

The user has a bunch of context files / knowledgebase that they want agents to operate on on their own computer (daytona). They upload the files through the react interface. They log into their ChatGPT in the Daytona sandbox via the frontend. (we need to figure out a smooth way of faciliating this via Oauth). 

We want to use opencode serve (this will stream chats between the Agent on Daytona and the react interface.) 

the daytona instance will also need certain nessesary packages for things like PDF parsing (Can define this more later) 

A database (outside daytona) will save the user's configuration and automation scripts.  We also might have artifacts which are. outputs of the user automation scripts (which run in Daytona) those are also supposed to be also stored on the server.  The automation opencode generates has to be reproduciable from the scratch on the new daytona instance (figure out how to). The react interface should let the user download the artifacts from the server. 

Write an MVP engineering plan for us to review.
2. [complete] Ok we like this plan. add an execution checklist with steps that an agent can use to build this out. We are going to divide up this work, so we need a code contract to work from.  Also, create an env example file so we know. use docker compose.
3. [launching] Execute @docs/execution-checklist.md

## Recent Activity
- Runner started launching execution request.
- Runner claimed execution request.
- Queued claude (claude-opus-4-8) execution for a runner.
- Runner opened the agent launch command.
- Runner started launching execution request.
- Runner claimed execution request.
- Queued claude (claude-opus-4-8) execution for a runner.
- Next objective is waiting for approval: New objective
- Wrote MVP engineering plan at docs/mvp-engineering-plan.md. Resolves the brief's open items: ChatGPT login via opencode codex headless device-code OAuth (with API-key fallback), chat streaming via opencode serve SSE relayed to React over WebSocket, baked-in PDF tooling via a pinned Daytona snapshot, Postgres schema for config/scripts/artifacts, artifact collection+download, and a concrete reproducibility model (pinned snapshot digest + automation bundle manifest + canonical knowledgebase copies). Includes MVP scope cuts, risks/spikes, hackathon milestones, and open questions. No code; no commit per instructions.
- Greenfield repo confirmed (empty). Grounded key assumptions via docs: opencode serve API/SSE, Daytona snapshot+volume SDK, opencode headless device-code OAuth for ChatGPT. Now writing docs/mvp-engineering-plan.md.
- Attached. Reviewing repo state, then drafting MVP engineering plan for the Daytona agentic-workflows service.
- Runner opened the agent launch command.
- Runner started launching execution request.
- Runner claimed execution request.
- Queued claude (claude-opus-4-8) execution for a runner.

## Artifacts

Use `ovld protocol attach --mission-id <id>` before making changes, update during work, and ALWAYS deliver last.
Execution request: 2724c384-53ba-46f0-a775-198215ef151f
