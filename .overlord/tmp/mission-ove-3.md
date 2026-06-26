# Overlord Mission: ove:3: Project plan

## Instructions
Use the Overlord skill. Follow the required protocol workflow.

## Objectives
1. [launching] We are building a service that lets non-technical users run agentic work in Daytona sandboxes. (this will include creating and running automation scripts) To start, we will run the server and frontend in a container locally, and later user a DB and backend cloud service. The user workflow is as follows

The user has a bunch of context files / knowledgebase that they want agents to operate on on their own computer (daytona). They upload the files through the react interface. They log into their ChatGPT in the Daytona sandbox via the frontend. (we need to figure out a smooth way of faciliating this via Oauth). 

We want to use opencode serve (this will stream chats between the Agent on Daytona and the react interface.) 

the daytona instance will also need certain nessesary packages for things like PDF parsing (Can define this more later) 

A database (outside daytona) will save the user's configuration and automation scripts.  We also might have artifacts which are. outputs of the user automation scripts (which run in Daytona) those are also supposed to be also stored on the server.  The automation opencode generates has to be reproduciable from the scratch on the new daytona instance (figure out how to). The react interface should let the user download the artifacts from the server. 

Write an MVP engineering plan for us to review.

## Recent Activity
- Runner started launching execution request.
- Runner claimed execution request.
- Queued claude (claude-opus-4-8) execution for a runner.

## Artifacts

Use `ovld protocol attach --mission-id <id>` before making changes, update during work, and ALWAYS deliver last.
Execution request: a5ee7bcb-c24f-4c18-a40c-4052ae7f991a
