# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Pamungkas343/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Pamungkas343/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node.js process: git smart HTTP (upload-pack v2, receive-pack v0), REST v3, GraphQL v4, and MCP, all from one in-memory store. No git binary, no network beyond the suite, no dependencies — Node 22 stdlib only.

## Run it

```sh
node main.ts
```

The server binds an ephemeral port (port 0), registers it by POSTing `{"port": n}` to `$MAKEFUN_ENV_URL/register`, then long-polls `GET $MAKEFUN_ENV_URL/done` and exits 0 when done. Without `MAKEFUN_ENV_URL` it runs standalone (port from `PORT` or 3000) for local development. Authentication is `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; the login is derived from the token. All timestamps come from `MAKEFUN_TRIAL_NOW` when set.

## What it serves

- **Git smart HTTP** at `/{owner}/{repo}.git`: upload-pack v2 (`ls-refs`, `fetch`, `object-info`) and receive-pack v0 (report-status, side-band-64k, delete-refs, per-ref fast-forward). Packfiles are built delta-free from stored deflated object bytes; shallow clones and deepens follow real git's `shallow-info` section format.
- **REST v3** at `/api/v3`: repositories, branches, commits, contents, labels, issues, comments, pull requests (create/merge with squash), and the git database API (`/git/refs`, `/git/blobs`, `/git/trees`, `/git/commits`, `/git/tags`). Every reply is JSON with a non-empty `X-GitHub-Request-Id`; unknown routes are 404 JSON, malformed JSON is 400.
- **GraphQL v4** at `/api/graphql`: full introspection (`Issue`, `PullRequest`, `Repository`, `SearchType` with `ISSUE`), `repository.issues` with `orderBy`/`states`, `createPullRequest`/`mergePullRequest`, `node(id:)` with inline fragments, and batched multi-document bodies.
- **MCP** at `/mcp`: JSON-RPC 2.0 Streamable HTTP (2026-07-28 revision and 2025-11-25 handshake), six tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`) sharing the same store as REST.

---

<sub>Entered on [make.fun](https://make.fun/?ref=&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
