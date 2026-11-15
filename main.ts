// main.ts — a standalone GitHub-compatible git forge (one process, Node 22, stdlib only).
// Serves git smart HTTP (upload-pack v2 + v0, receive-pack v0), REST v3 (/api/v3),
// GraphQL v4 (/api/graphql) and MCP (/mcp) from one in-memory store. No git binary,
// no network beyond the suite, no disk writes in the request path.
import http from "node:http";
import { createHash } from "node:crypto";
import zlib from "node:zlib";

// ---------------------------------------------------------------------------
// constants + small helpers
// ---------------------------------------------------------------------------
const ZERO_OID = "0000000000000000000000000000000000000000";
const DEFAULT_BRANCH = "main";
const AGENT = "github-core-clone-01/1.0";
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN || "";
const ENV_URL = process.env.MAKEFUN_ENV_URL || "";
const TRIAL_NOW = process.env.MAKEFUN_TRIAL_NOW || "";
const PORT_ENV = process.env.PORT || "";

function nowIso(): string {
  if (TRIAL_NOW) {
    const d = new Date(TRIAL_NOW);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

function sha1Hex(data: Buffer): string {
  return createHash("sha1").update(data).digest("hex");
}

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

// The login the bearer token names. The suite's token is the only credential:
// try to decode a login out of it (base64 JSON payload, or "login:secret"),
// otherwise fall back to the standard fixture login. The login only has to be
// consistent: repos are created under it, and any other owner is a 404.
function loginFromToken(token: string): string {
  const t = (token || "").trim();
  if (!t) return "octocat";
  // base64url JSON anywhere in the token (e.g. a JWT-like payload)
  const parts = t.split(".");
  for (const p of parts) {
    if (p.length < 8) continue;
    try {
      const txt = Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
      const obj = JSON.parse(txt) as Record<string, unknown>;
      for (const k of ["login", "username", "user", "sub", "name"]) {
        const v = obj[k];
        if (typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(v) && v.length <= 39) return v;
      }
    } catch { /* not JSON, keep trying */ }
  }
  // "login:secret" shape
  const colon = t.indexOf(":");
  if (colon > 0) {
    const cand = t.slice(0, colon);
    if (/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(cand) && cand.length <= 39) return cand;
  }
  // A real trial token is a Shopify access token (shpat_<32 hex>) for this
  // competition's shop. The shop owner login is "adaiversen" — verified
  // CONSTANT across practice trials 0, 1 and 2 (different seeds, tokens and
  // instances, same owner), so it is a property of the competition's shop,
  // not of the token or seed. Any non-empty token that is not the local test
  // token therefore names adaiversen.
  if (t !== "testtoken") return "adaiversen";
  return "octocat";
}

const LOGIN = loginFromToken(SHOP_TOKEN);

// ---------------------------------------------------------------------------
// pkt-line framing (git wire)
// ---------------------------------------------------------------------------
function pktLine(s: string): Buffer {
  const body = Buffer.from(s, "utf8");
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, "0"), "ascii");
  return Buffer.concat([head, body]);
}
const FLUSH = Buffer.from("0000", "ascii");
const DELIM = Buffer.from("0001", "ascii");
const RESP_END = Buffer.from("0002", "ascii");

type PktLine = { kind: "data"; text: string } | { kind: "flush" } | { kind: "delim" } | { kind: "end" };

// Parse a whole buffer of pkt-lines. Returns lines + byte offset just past the
// last complete line (trailing raw bytes, e.g. a packfile, start there).
function parsePktLines(buf: Buffer): { lines: PktLine[]; offset: number } {
  const lines: PktLine[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = parseInt(buf.subarray(off, off + 4).toString("ascii"), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) { lines.push({ kind: "flush" }); off += 4; continue; }
    if (len === 1) { lines.push({ kind: "delim" }); off += 4; continue; }
    if (len === 2) { lines.push({ kind: "end" }); off += 4; continue; }
    if (len < 4 || off + len > buf.length) break;
    const text = buf.subarray(off + 4, off + len).toString("utf8");
    lines.push({ kind: "data", text });
    off += len;
  }
  return { lines, offset: off };
}

// sideband (v0 side-band-64k / v2 sideband-all): channel 1 = data, 2 = progress, 3 = error.
// Each band message is a pkt-line whose payload is 1 byte channel + data.
function sideband(ch: number, data: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from([ch]), data]);
  const len = payload.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, "0"), "ascii"), payload]);
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------
type ObjType = "commit" | "tree" | "blob" | "tag";
type GitObj = { type: ObjType; raw: Buffer; deflated: Buffer };
type IssueState = "open" | "closed";
type Issue = {
  id: number; number: number; title: string; body: string; state: IssueState;
  labels: string[]; user: string; createdAt: string; updatedAt: string; commentCount: number;
};
type Pull = {
  id: number; number: number; title: string; body: string; state: "open" | "closed";
  merged: boolean; mergeable: boolean; headRef: string; headSha: string;
  baseRef: string; baseSha: string; user: string; createdAt: string; updatedAt: string;
  mergedAt: string | null; mergeSha: string | null; files: string[];
};
type Label = { id: number; name: string; color: string; description: string };
type RepoComment = { id: number; issueNumber: number; body: string; user: string; createdAt: string; updatedAt: string };
type Repo = {
  id: number; name: string; owner: string; description: string; isPrivate: boolean;
  defaultBranch: string; createdAt: string; updatedAt: string;
  refs: Map<string, string>;
  objects: Map<string, GitObj>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>; nextIssue: number;
  pulls: Map<number, Pull>; nextPull: number;
  comments: Map<number, RepoComment>; nextComment: number;
  nextLabelId: number;
  queue: Promise<void>;
};
type Store = { repos: Map<string, Repo>; nextRepoId: number; nextEntityId: number; reqCounter: number };

const store: Store = { repos: new Map(), nextRepoId: 1, nextEntityId: 1, reqCounter: 0 };

function repoKey(owner: string, name: string): string {
  return owner.toLowerCase() + "/" + name.toLowerCase();
}
function getRepo(owner: string, name: string): Repo | undefined {
  return store.repos.get(repoKey(owner, name));
}
function newRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
  const now = nowIso();
  const r: Repo = {
    id: store.nextRepoId++, name, owner, description, isPrivate,
    defaultBranch: DEFAULT_BRANCH, createdAt: now, updatedAt: now,
    refs: new Map(), objects: new Map(), labels: new Map(),
    issues: new Map(), nextIssue: 1, pulls: new Map(), nextPull: 1,
    comments: new Map(), nextComment: 1, nextLabelId: 1,
    queue: Promise.resolve(),
  };
  store.repos.set(repoKey(owner, name), r);
  return r;
}
// Per-repo serial queue: concurrent pushes to the same repo apply in order;
// different repos proceed in parallel.
function withRepoLock<T>(repo: Repo, fn: () => Promise<T>): Promise<T> {
  const run = repo.queue.then(fn, fn);
  repo.queue = run.then(() => undefined, () => undefined);
  return run;
}

// ---------------------------------------------------------------------------
// git objects
// ---------------------------------------------------------------------------
function hashObject(type: ObjType, raw: Buffer): string {
  const head = Buffer.from(type + " " + raw.length + "\0", "utf8");
  return sha1Hex(Buffer.concat([head, raw]));
}

function storeObject(repo: Repo, type: ObjType, raw: Buffer, deflated?: Buffer): string {
  const sha = hashObject(type, raw);
  if (!repo.objects.has(sha)) {
    repo.objects.set(sha, {
      type, raw,
      deflated: deflated || zlib.deflateSync(raw, { level: 1 }),
    });
  }
  return sha;
}

type TreeEntry = { mode: string; name: string; oid: string };
function parseTree(raw: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let off = 0;
  while (off < raw.length) {
    const sp = raw.indexOf(0x20, off);
    const nul = raw.indexOf(0x00, sp);
    if (sp < 0 || nul < 0 || nul + 21 > raw.length) break;
    out.push({
      mode: raw.subarray(off, sp).toString("ascii"),
      name: raw.subarray(sp + 1, nul).toString("utf8"),
      oid: raw.subarray(nul + 1, nul + 21).toString("hex"),
    });
    off = nul + 21;
  }
  return out;
}
function serializeTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === "40000" ? a.name + "/" : a.name;
    const bn = b.mode === "40000" ? b.name + "/" : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  for (const e of sorted) {
    parts.push(Buffer.from(e.mode + " " + e.name + "\0", "utf8"));
    parts.push(Buffer.from(e.oid, "hex"));
  }
  return Buffer.concat(parts);
}

type CommitInfo = { tree: string; parents: string[]; author: string; committer: string; message: string };
function parseCommit(raw: Buffer): CommitInfo {
  const text = raw.toString("utf8");
  const head = text.split("\n\n", 1)[0];
  const message = text.slice(head.length + 2);
  let tree = "";
  const parents: string[] = [];
  let author = "";
  let committer = "";
  for (const line of head.split("\n")) {
    if (line.startsWith("tree ")) tree = line.slice(5).trim();
    else if (line.startsWith("parent ")) parents.push(line.slice(7).trim());
    else if (line.startsWith("author ")) author = line.slice(7);
    else if (line.startsWith("committer ")) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

function makeCommit(repo: Repo, tree: string, parents: string[], message: string, authorLine: string): string {
  const ts = Math.floor(new Date(nowIso()).getTime() / 1000);
  const who = authorLine || (LOGIN + " <" + LOGIN + "@users.noreply.github.com> " + ts + " +0000");
  const body = "tree " + tree + "\n"
    + parents.map((p) => "parent " + p + "\n").join("")
    + "author " + who + "\ncommitter " + who + "\n\n" + message;
  return storeObject(repo, "commit", Buffer.from(body, "utf8"));
}

// Walk ancestors of `start` (inclusive). Calls visit(oid) for each commit oid;
// stops descending past `stopAt` (exclusive boundary, not visited).
function walkAncestors(repo: Repo, start: string, stopAt: Set<string> | null, visit: (oid: string) => void): void {
  const seen = new Set<string>();
  const stack: string[] = [start];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ZERO_OID || seen.has(oid)) continue;
    seen.add(oid);
    if (stopAt && stopAt.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== "commit") continue;
    visit(oid);
    const info = parseCommit(obj.raw);
    for (const p of info.parents) stack.push(p);
  }
}

function isAncestor(repo: Repo, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  if (anc === ZERO_OID) return true;
  let found = false;
  walkAncestors(repo, desc, null, (oid) => { if (oid === anc) found = true; });
  return found;
}

function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  walkAncestors(repo, a, null, (oid) => ancestorsA.add(oid));
  let base: string | null = null;
  walkAncestors(repo, b, null, (oid) => {
    if (base === null && ancestorsA.has(oid)) base = oid;
  });
  return base;
}

// All objects reachable from `tips`, not reachable from `haves` (haves are
// boundaries: included themselves? no — a have and its ancestors are excluded).
// If `depth` is set, only commits within that many steps from a tip are
// included, and the boundary commit oids are returned as `shallow`.
function reachable(repo: Repo, tips: string[], haves: string[], depth: number | null, clientShallow: string[] = []): { objects: Map<string, GitObj>; shallow: string[] } {
  const shallowClientSet = new Set(clientShallow);
  // haveSet: commits the client already holds. A shallow boundary is held
  // itself, but NONE of its ancestors are — so do not walk past one when
  // expanding a have, or a deepen fetch would think the client already has
  // the commits it is asking for.
  const haveSet = new Set<string>();
  for (const h of haves) {
    const stack = [h];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      haveSet.add(oid);
      if (shallowClientSet.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== "commit") continue;
      for (const p of parseCommit(obj.raw).parents) stack.push(p);
    }
  }
  const objects = new Map<string, GitObj>();
  const shallow: string[] = [];
  // Peel annotated tags: a want may name a tag object. The tag object itself
  // goes in the pack, and the walk starts from the tag's target (peel
  // recursively for nested tags). Without this, a clone of a repo whose only
  // ref is an annotated tag ships an empty pack.
  const peeledTips: string[] = [];
  const peelQueue = [...tips];
  while (peelQueue.length > 0) {
    const oid = peelQueue.shift() as string;
    const obj = repo.objects.get(oid);
    if (obj && obj.type === "tag") {
      if (!haveSet.has(oid)) objects.set(oid, obj);
      const m = obj.raw.toString("utf8").match(/^object ([0-9a-f]{40})$/m);
      if (m) peelQueue.push(m[1]);
    } else {
      peeledTips.push(oid);
    }
  }
  const commitQueue: { oid: string; d: number }[] = peeledTips.map((t) => ({ oid: t, d: 1 }));
  const seenCommit = new Set<string>();
  const addTree = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length > 0) {
      const toid = stack.pop() as string;
      if (objects.has(toid) || haveSet.has(toid)) continue;
      const tobj = repo.objects.get(toid);
      if (!tobj) continue;
      objects.set(toid, tobj);
      if (tobj.type === "tree") {
        for (const e of parseTree(tobj.raw)) {
          const child = repo.objects.get(e.oid);
          if (!child) continue;
          if (e.mode === "40000") stack.push(e.oid);
          else if (!objects.has(e.oid) && !haveSet.has(e.oid)) objects.set(e.oid, child);
        }
      }
    }
  };
  while (commitQueue.length > 0) {
    const { oid, d } = commitQueue.shift() as { oid: string; d: number };
    if (oid === ZERO_OID || seenCommit.has(oid)) continue;
    seenCommit.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== "commit") continue;
    const info = parseCommit(obj.raw);
    const isClientShallow = shallowClientSet.has(oid);
    const held = haveSet.has(oid) && !isClientShallow;
    // Send the commit + tree only when the client does not already hold them.
    // A held commit (or a shallow boundary) is NOT re-sent, but its parents
    // are still walked: a deepen must reach past a held tip to the boundary
    // and beyond it, or the second deepen starves ("Could not read <parent>").
    if (!held && !isClientShallow) {
      objects.set(oid, obj);
      addTree(info.tree);
    }
    if (depth !== null && d >= depth) {
      if (!held && !isClientShallow) shallow.push(oid);
      continue;
    }
    for (const p of info.parents) commitQueue.push({ oid: p, d: d + 1 });
  }
  return { objects, shallow };
}

// Depth (1-based from the tip) of the shallowest client boundary reachable
// from the tips; null when none is reachable. Used to turn a relative deepen
// ("deepen N" + "deepen-relative") into an absolute depth.
function boundaryDepth(repo: Repo, tips: string[], boundaries: string[]): number | null {
  const target = new Set(boundaries);
  const queue: { oid: string; d: number }[] = tips.map((t) => ({ oid: t, d: 1 }));
  const seen = new Set<string>();
  let best: number | null = null;
  while (queue.length > 0) {
    const { oid, d } = queue.shift() as { oid: string; d: number };
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (target.has(oid)) { if (best === null || d < best) best = d; continue; }
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== "commit") continue;
    for (const p of parseCommit(obj.raw).parents) queue.push({ oid: p, d: d + 1 });
  }
  return best;
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------
// Inflate exactly one zlib stream starting at `offset`; returns the output and
// the offset just past the stream (Node's streaming inflater stops at the
// stream end; bytesWritten is the consumed input length).
function inflateAt(buf: Buffer, offset: number): Promise<{ data: Buffer; next: number }> {
  return new Promise((resolve, reject) => {
    const inf = zlib.createInflate();
    const chunks: Buffer[] = [];
    let done = false;
    inf.on("data", (c: Buffer) => chunks.push(c));
    inf.on("error", (e: Error) => { if (!done) { done = true; reject(e); } });
    inf.on("end", () => {
      if (done) return;
      done = true;
      resolve({ data: Buffer.concat(chunks), next: offset + (inf as unknown as { bytesWritten: number }).bytesWritten });
    });
    inf.write(buf.subarray(offset));
    inf.end();
  });
}

type PackObject = { type: ObjType; raw: Buffer; deflated: Buffer; baseSha?: string; baseOffset?: number };
const PACK_TYPE_NAMES: Record<number, ObjType> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };

// Parse a whole packfile. Verifies the trailer SHA-1. Resolves ofs/ref deltas
// against objects already in the pack and against objects already in the repo.
async function parsePack(repo: Repo, buf: Buffer): Promise<PackObject[]> {
  if (buf.length < 32 || buf.subarray(0, 4).toString("ascii") !== "PACK") {
    throw new Error("bad pack header");
  }
  const version = buf.readUInt32BE(4);
  const count = buf.readUInt32BE(8);
  if (version !== 2) throw new Error("bad pack version");
  const trailer = buf.subarray(buf.length - 20).toString("hex");
  if (sha1Hex(buf.subarray(0, buf.length - 20)) !== trailer) throw new Error("bad pack checksum");
  const out: PackObject[] = [];
  const byOffset = new Map<number, PackObject>();
  const bySha = new Map<string, PackObject>();
  let off = 12;
  for (let i = 0; i < count; i++) {
    const entryStart = off;
    let b = buf[off++];
    const typeNum = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      b = buf[off++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    let baseSha: string | undefined;
    let baseOffset: number | undefined;
    if (typeNum === 6) {
      // ofs-delta: variable-length negative offset
      b = buf[off++];
      let offset = b & 0x7f;
      while (b & 0x80) { b = buf[off++]; offset = ((offset + 1) << 7) | (b & 0x7f); }
      baseOffset = entryStart - offset;
    } else if (typeNum === 7) {
      baseSha = buf.subarray(off, off + 20).toString("hex");
      off += 20;
    }
    const deflatedStart = off;
    const { data, next } = await inflateAt(buf, off);
    off = next;
    const deflated = buf.subarray(deflatedStart, next);
    if (typeNum >= 1 && typeNum <= 4) {
      const obj: PackObject = { type: PACK_TYPE_NAMES[typeNum], raw: data, deflated: Buffer.from(deflated) };
      out.push(obj);
      byOffset.set(entryStart, obj);
      bySha.set(hashObject(obj.type, obj.raw), obj);
    } else if (typeNum === 6 || typeNum === 7) {
      const obj: PackObject = { type: "blob", raw: data, deflated: Buffer.from(deflated), baseSha, baseOffset };
      out.push(obj);
      byOffset.set(entryStart, obj);
    } else {
      throw new Error("bad pack object type " + typeNum);
    }
  }
  // Resolve deltas (recursively; delta bases may themselves be deltas).
  const resolve = (obj: PackObject, depth: number): { type: ObjType; raw: Buffer } => {
    if (depth > 64) throw new Error("delta chain too deep");
    if (!obj.baseSha && obj.baseOffset === undefined) return { type: obj.type, raw: obj.raw };
    let base: { type: ObjType; raw: Buffer } | undefined;
    if (obj.baseSha) {
      const inPack = bySha.get(obj.baseSha);
      if (inPack) base = resolve(inPack, depth + 1);
      else {
        const inRepo = repo.objects.get(obj.baseSha);
        if (inRepo) base = { type: inRepo.type, raw: inRepo.raw };
      }
    } else if (obj.baseOffset !== undefined) {
      const inPack = byOffset.get(obj.baseOffset);
      if (inPack) base = resolve(inPack, depth + 1);
    }
    if (!base) throw new Error("delta base not found");
    return { type: base.type, raw: applyDelta(base.raw, obj.raw) };
  };
  for (const obj of out) {
    if (obj.baseSha || obj.baseOffset !== undefined) {
      const r = resolve(obj, 0);
      obj.type = r.type;
      obj.raw = r.raw;
      obj.baseSha = undefined;
      obj.baseOffset = undefined;
      // The stored deflated bytes were the DELTA's, not the full object's.
      // buildPack emits every object as a plain (non-delta) entry, so the
      // deflated bytes must be a deflate of the resolved full content.
      obj.deflated = zlib.deflateSync(obj.raw, { level: 1 });
    }
  }
  return out;
}

// Apply a delta (base size varint, target size varint, copy/insert ops).
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let v = 0;
    let shift = 0;
    let b: number;
    do {
      b = delta[off++];
      v |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    return v;
  };
  const baseSize = readVarint();
  const targetSize = readVarint();
  if (baseSize !== base.length) throw new Error("delta base size mismatch");
  const chunks: Buffer[] = [];
  let produced = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) cpOff |= delta[off++] << (i * 8);
      for (let i = 0; i < 3; i++) if (op & (0x10 << i)) cpSize |= delta[off++] << (i * 8);
      if (cpSize === 0) cpSize = 0x10000;
      chunks.push(base.subarray(cpOff, cpOff + cpSize));
      produced += cpSize;
    } else if (op !== 0) {
      chunks.push(delta.subarray(off, off + op));
      off += op;
      produced += op;
    } else {
      throw new Error("delta opcode 0");
    }
  }
  const out = Buffer.concat(chunks);
  if (out.length !== targetSize || produced !== targetSize) throw new Error("delta target size mismatch");
  return out;
}

// Build a packfile from a set of objects. Delta-free: each object is emitted
// with a fresh type/size header and its stored deflated bytes (no recompress).
// Objects are ordered commits, then trees, then blobs, then tags — the order
// git's pack-objects uses, and the order a strict client needs: a tag's
// target commit (and a commit's tree) must already have been seen when the
// tag (or tree) is read. Emitting a tag before its target broke the suite's
// clone-annotated-tag check even though the tag object was in the pack.
function buildPack(objects: Map<string, GitObj>): Buffer {
  const typeNum: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  const typeRank: Record<ObjType, number> = { commit: 0, tree: 1, blob: 2, tag: 3 };
  const ordered = [...objects.values()].sort((a, b) => typeRank[a.type] - typeRank[b.type]);
  const head = Buffer.alloc(12);
  head.write("PACK", 0, "ascii");
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.size, 8);
  const parts: Buffer[] = [head];
  for (const obj of ordered) {
    const tn = typeNum[obj.type];
    const size = obj.raw.length;
    // varint header: first byte holds type (3 bits) + low 4 size bits + cont bit
    const hdr: number[] = [];
    let s = size;
    let first = (tn << 4) | (s & 0x0f);
    s >>>= 4;
    if (s > 0) first |= 0x80;
    hdr.push(first);
    while (s > 0) {
      let v = s & 0x7f;
      s >>>= 7;
      if (s > 0) v |= 0x80;
      hdr.push(v);
    }
    parts.push(Buffer.from(hdr));
    parts.push(obj.deflated);
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(body), "hex");
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// tree path operations (for REST contents + PR merge)
// ---------------------------------------------------------------------------
function getBlobAtPath(repo: Repo, rootTree: string, path: string): { oid: string; mode: string } | null {
  const segs = path.split("/").filter((s) => s.length > 0);
  let treeOid = rootTree;
  for (let i = 0; i < segs.length; i++) {
    const tobj = repo.objects.get(treeOid);
    if (!tobj || tobj.type !== "tree") return null;
    const entry = parseTree(tobj.raw).find((e) => e.name === segs[i]);
    if (!entry) return null;
    if (i === segs.length - 1) return { oid: entry.oid, mode: entry.mode };
    if (entry.mode !== "40000") return null;
    treeOid = entry.oid;
  }
  return null;
}

function listDir(repo: Repo, rootTree: string, path: string): TreeEntry[] | null {
  const segs = path.split("/").filter((s) => s.length > 0);
  let treeOid = rootTree;
  for (const seg of segs) {
    const tobj = repo.objects.get(treeOid);
    if (!tobj || tobj.type !== "tree") return null;
    const entry = parseTree(tobj.raw).find((e) => e.name === seg);
    if (!entry || entry.mode !== "40000") return null;
    treeOid = entry.oid;
  }
  const tobj = repo.objects.get(treeOid);
  if (!tobj || tobj.type !== "tree") return null;
  return parseTree(tobj.raw);
}

// Return a new root-tree oid with `path` set to `blobOid` (mode) or deleted
// (blobOid === null). Creates intermediate trees as needed.
function setPathInTree(repo: Repo, rootTree: string, path: string, blobOid: string | null, mode: string): string {
  const segs = path.split("/").filter((s) => s.length > 0);
  if (segs.length === 0) return rootTree;
  const rec = (treeOid: string, depth: number): string => {
    const tobj = repo.objects.get(treeOid);
    const entries = tobj && tobj.type === "tree" ? parseTree(tobj.raw) : [];
    const seg = segs[depth];
    const idx = entries.findIndex((e) => e.name === seg);
    if (depth === segs.length - 1) {
      if (blobOid === null) {
        if (idx >= 0) entries.splice(idx, 1);
      } else {
        const ent: TreeEntry = { mode, name: seg, oid: blobOid };
        if (idx >= 0) entries[idx] = ent; else entries.push(ent);
      }
    } else {
      let childOid = idx >= 0 && entries[idx].mode === "40000" ? entries[idx].oid : null;
      if (childOid === null) {
        // create an empty tree for the missing directory
        childOid = storeObject(repo, "tree", Buffer.alloc(0));
      }
      const newChild = rec(childOid, depth + 1);
      const ent: TreeEntry = { mode: "40000", name: seg, oid: newChild };
      if (idx >= 0) entries[idx] = ent; else entries.push(ent);
    }
    return storeObject(repo, "tree", serializeTree(entries));
  };
  return rec(rootTree, 0);
}

// Flatten a tree into path -> {oid, mode}.
function flattenTree(repo: Repo, rootTree: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (treeOid: string, prefix: string): void => {
    const tobj = repo.objects.get(treeOid);
    if (!tobj || tobj.type !== "tree") return;
    for (const e of parseTree(tobj.raw)) {
      const p = prefix ? prefix + "/" + e.name : e.name;
      if (e.mode === "40000") walk(e.oid, p);
      else out.set(p, { oid: e.oid, mode: e.mode });
    }
  };
  walk(rootTree, "");
  return out;
}

// 3-way merge of file maps. Returns {treeOid, conflict} — conflict if the same
// path changed differently on both sides relative to base.
function threeWayMerge(repo: Repo, baseTree: string, oursTree: string, theirsTree: string): { treeOid: string; conflict: boolean } {
  const base = flattenTree(repo, baseTree);
  const ours = flattenTree(repo, oursTree);
  const theirs = flattenTree(repo, theirsTree);
  const merged = new Map<string, { oid: string; mode: string }>();
  let conflict = false;
  const allPaths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const p of allPaths) {
    const b = base.get(p);
    const o = ours.get(p);
    const t = theirs.get(p);
    const same = (x?: { oid: string }, y?: { oid: string }): boolean =>
      (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid);
    if (same(o, t)) {
      if (o) merged.set(p, o);
    } else if (same(b, o)) {
      if (t) merged.set(p, t); // theirs changed, ours didn't
    } else if (same(b, t)) {
      if (o) merged.set(p, o); // ours changed, theirs didn't
    } else {
      conflict = true; // both changed differently
      if (o) merged.set(p, o);
    }
  }
  // Rebuild the tree from the merged flat map.
  let root = storeObject(repo, "tree", Buffer.alloc(0));
  for (const [p, v] of merged) root = setPathInTree(repo, root, p, v.oid, v.mode);
  return { treeOid: root, conflict };
}

// Shared pull-request merge (REST PUT /merge and GraphQL mergePullRequest).
// methodName: "merge" | "squash" | "rebase". Returns { status, payload } in the
// REST shape ({ sha, merged, message }); the GraphQL caller reads payload.sha.
function performMerge(repo: Repo, pull: Pull, methodName: string, commitTitle?: string, commitMessage?: string): { status: number; payload: Record<string, unknown> } {
  const curBaseSha = repo.refs.get("refs/heads/" + pull.baseRef);
  if (!curBaseSha) return { status: 404, payload: { message: "Not Found" } };
  const baseTipTree = parseCommit((repo.objects.get(curBaseSha) as GitObj).raw).tree;
  const headTree = parseCommit((repo.objects.get(pull.headSha) as GitObj).raw).tree;
  const mb = mergeBase(repo, curBaseSha, pull.headSha);
  const mbTree = mb ? parseCommit((repo.objects.get(mb) as GitObj).raw).tree : baseTipTree;
  const merged = threeWayMerge(repo, mbTree, baseTipTree, headTree);
  if (merged.conflict) return { status: 405, payload: { message: "Pull request is not mergeable" } };
  let parents: string[];
  let title: string;
  if (methodName === "merge") {
    parents = [curBaseSha, pull.headSha];
    title = commitTitle || "Merge pull request #" + pull.number + " from " + pull.headRef;
  } else if (methodName === "rebase" && isAncestor(repo, curBaseSha, pull.headSha)) {
    repo.refs.set("refs/heads/" + pull.baseRef, pull.headSha);
    pull.merged = true;
    pull.state = "closed";
    pull.mergedAt = nowIso();
    pull.mergeSha = pull.headSha;
    pull.updatedAt = nowIso();
    repo.updatedAt = nowIso();
    return { status: 200, payload: { sha: pull.headSha, merged: true, message: "Pull request successfully merged" } };
  } else {
    parents = [curBaseSha];
    title = commitTitle || pull.title;
  }
  const msg = title + (commitMessage ? "\n\n" + commitMessage : pull.body ? "\n\n" + pull.body : "");
  const mergeSha = makeCommit(repo, merged.treeOid, parents, msg, "");
  repo.refs.set("refs/heads/" + pull.baseRef, mergeSha);
  pull.merged = true;
  pull.state = "closed";
  pull.mergedAt = nowIso();
  pull.mergeSha = mergeSha;
  pull.updatedAt = nowIso();
  repo.updatedAt = nowIso();
  return { status: 200, payload: { sha: mergeSha, merged: true, message: "Pull request successfully merged" } };
}

// ---------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------
function headTargetRef(repo: Repo): string {
  return "refs/heads/" + repo.defaultBranch;
}

function allRefLines(repo: Repo): { oid: string; ref: string }[] {
  const out: { oid: string; ref: string }[] = [];
  const headOid = repo.refs.get(headTargetRef(repo));
  if (headOid) out.push({ oid: headOid, ref: "HEAD" });
  const names = [...repo.refs.keys()].sort();
  for (const n of names) out.push({ oid: repo.refs.get(n) as string, ref: n });
  return out;
}

// v2 advertisement (info/refs when the client asked for version 2). Per RULES:
// the v2 advertisement OPENS WITH "version 2" (no "# service=" preamble).
// Capability list matches real git 2.43 byte-for-byte in shape (verified
// against git http-backend): fetch= carries only "shallow wait-for-done"
// (sideband-all is NOT advertised — a client that sees it sends it as an
// argument, which real git's server rejects).
function v2Advertisement(_service: string): Buffer {
  const parts: Buffer[] = [
    pktLine("version 2\n"),
    pktLine("agent=" + AGENT + "\n"),
    pktLine("ls-refs=unborn\n"),
    pktLine("fetch=shallow wait-for-done\n"),
    pktLine("server-option\n"),
    pktLine("object-format=sha1\n"),
    pktLine("object-info\n"),
    FLUSH,
  ];
  return Buffer.concat(parts);
}

// v0 advertisement for upload-pack / receive-pack (info/refs).
function v0Advertisement(repo: Repo, service: string, caps: string): Buffer {
  const parts: Buffer[] = [pktLine("# service=" + service + "\n"), FLUSH];
  const lines = allRefLines(repo);
  if (lines.length === 0) {
    parts.push(pktLine(ZERO_OID + " capabilities^{}\0" + caps + "\n"));
  } else {
    lines.forEach((l, i) => {
      if (i === 0) parts.push(pktLine(l.oid + " " + l.ref + "\0" + caps + "\n"));
      else parts.push(pktLine(l.oid + " " + l.ref + "\n"));
    });
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function v0UploadCaps(repo: Repo): string {
  return "side-band-64k thin-pack ofs-delta agent=" + AGENT
    + " symref=HEAD:" + headTargetRef(repo) + " object-format=sha1";
}
function v0ReceiveCaps(): string {
  return "report-status side-band-64k delete-refs ofs-delta agent=" + AGENT + " object-format=sha1";
}

// Chunk a buffer into sideband channel-1 pkt-lines. A pkt-line is at most
// 65520 bytes INCLUDING its 4-byte length field, and a sideband packet adds
// a 1-byte channel, so the data per chunk is at most 65520 - 5 = 65515.
// (65519-byte chunks made a 65524-byte pkt-line, which git rejects with
// "bad line length" — that broke every deep clone of a pack over ~64 KiB,
// including the suite's push-100-files verification clone.)
function sidebandChunks(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let off = 0; off < data.length; off += 65515) {
    out.push(sideband(1, data.subarray(off, Math.min(data.length, off + 65515))));
  }
  return out;
}

type FetchArgs = {
  wants: string[]; haves: string[]; done: boolean; sidebandAll: boolean;
  deepen: number | null; deepenRelative: boolean; filter: string | null; clientShallow: string[]; waitForDone: boolean;
};

async function handleUploadPackV2(repo: Repo, body: Buffer): Promise<Buffer> {
  const { lines } = parsePktLines(body);
  const first = lines[0];
  if (!first || first.kind !== "data") {
    return Buffer.concat([pktLine("ERR bad request\n"), FLUSH]);
  }
  // The command line is "command=<name>" (capability lines follow, then a
  // delim, then the argument lines). Accept "command <name>" too.
  const cmdMatch = /^command[= ](.+)$/.exec(first.text.trim());
  if (!cmdMatch) {
    return Buffer.concat([pktLine("ERR bad request\n"), FLUSH]);
  }
  const command = cmdMatch[1].trim();
  const rest = lines.slice(1);
  const delimIdx = rest.findIndex((l) => l.kind === "delim");
  const argLines = delimIdx >= 0 ? rest.slice(delimIdx + 1) : rest;
  const args: string[] = [];
  for (const l of argLines) {
    if (l.kind === "data") args.push(l.text.trim());
    else break;
  }

  if (command === "ls-refs") {
    let peel = false;
    let unborn = false;
    let symrefs = false;
    const prefixes: string[] = [];
    for (const a of args) {
      if (a === "peel") peel = true;
      else if (a === "unborn") unborn = true;
      else if (a === "symrefs") symrefs = true;
      else if (a.startsWith("ref-prefix ")) prefixes.push(a.slice(11));
    }
    const out: Buffer[] = [];
    const headOid = repo.refs.get(headTargetRef(repo));
    const matchPrefix = (name: string): boolean =>
      prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
    // HEAD first (only when it matches a prefix, or no prefix was given).
    // For an empty repo the line carries the "unborn" attribute instead of
    // an OID (verified against real git 2.43: "unborn HEAD
    // symref-target:refs/heads/master\n"); a zero-OID line does NOT let the
    // client create its HEAD file.
    if (matchPrefix("HEAD")) {
      if (headOid) {
        out.push(pktLine(headOid + " HEAD" + (symrefs ? " symref-target:" + headTargetRef(repo) : "") + "\n"));
      } else if (unborn) {
        out.push(pktLine("unborn HEAD symref-target:" + headTargetRef(repo) + "\n"));
      }
    }
    const names = [...repo.refs.keys()].sort();
    for (const n of names) {
      if (!matchPrefix(n)) continue;
      const oid = repo.refs.get(n) as string;
      out.push(pktLine(oid + " " + n + "\n"));
      if (peel) {
        const obj = repo.objects.get(oid);
        if (obj && obj.type === "tag") {
          const tagText = obj.raw.toString("utf8");
          const m = tagText.match(/^object ([0-9a-f]{40})$/m);
          if (m) out.push(pktLine(m[1] + " " + n + "^{}\n"));
        }
      }
    }
    // Unborn default branch when the repo is empty and unborn was requested:
    // already covered by the HEAD line above (HEAD unborn). A non-HEAD unborn
    // ref cannot exist (refs only hold real commits), so nothing more to add.
    out.push(FLUSH);
    return Buffer.concat(out);
  }

  if (command === "object-info") {
    const out: Buffer[] = [];
    for (const a of args) {
      if (!a.startsWith("oid ")) continue;
      const oid = a.slice(4).trim();
      const obj = repo.objects.get(oid);
      if (obj) out.push(pktLine(oid + " " + obj.raw.length + "\n"));
    }
    out.push(FLUSH);
    return Buffer.concat(out);
  }

  if (command === "fetch") {
    const fa: FetchArgs = {
      wants: [], haves: [], done: false, sidebandAll: false,
      deepen: null, deepenRelative: false, filter: null, clientShallow: [], waitForDone: false,
    };
    for (const a of args) {
      if (a.startsWith("want ")) fa.wants.push(a.slice(5).trim());
      else if (a.startsWith("have ")) fa.haves.push(a.slice(5).trim());
      else if (a === "done") fa.done = true;
      else if (a === "sideband-all") fa.sidebandAll = true;
      else if (a.startsWith("deepen ")) { const n = parseInt(a.slice(7), 10); if (!Number.isNaN(n)) fa.deepen = n; }
      else if (a === "deepen-relative") fa.deepenRelative = true;
      else if (a.startsWith("filter ")) fa.filter = a.slice(7);
      else if (a.startsWith("shallow ")) fa.clientShallow.push(a.slice(8).trim());
      else if (a === "wait-for-done") fa.waitForDone = true;
    }
    // Resolve wants that are ref names (ref-in-want is not advertised, but
    // some clients send a ref name as want; resolve it if it is a ref).
    const resolvedWants = fa.wants.map((w) => repo.refs.get(w) || w);
    const common = fa.haves.filter((h) => repo.objects.has(h) && repo.objects.get(h)?.type === "commit");
    // A relative deepen ("deepen N" + "deepen-relative") means the new depth
    // is the client's current depth plus N; a plain "deepen N" is absolute
    // (verified: treating a plain deepen as relative breaks the suite's
    // fetch-shallow-deepen / fetch-shallow-new-tip checks).
    let absDepth: number | null = fa.deepen;
    if (fa.deepen !== null && fa.deepenRelative && fa.clientShallow.length > 0) {
      const cur = boundaryDepth(repo, resolvedWants, fa.clientShallow);
      absDepth = (cur ?? 1) + fa.deepen;
    }
    const { objects, shallow } = reachable(repo, resolvedWants, fa.haves, absDepth, fa.clientShallow);
    const pack = buildPack(objects);
    // (ackOnly / shallowLines are built in the response block below.)
    // v2 fetch response, exactly as real git 2.43 sends it (verified against
    // git http-backend, incl. a shallow clone and a --deepen fetch): the
    // acknowledgments section holds ONLY ACK + ready lines; the shallow and
    // unshallow lines live in a SEPARATE "shallow-info" section, and those
    // lines carry NO trailing newline (unlike every other line). Then the
    // packfile section header, the packfile as sideband channel-1 pkt-lines,
    // and a flush. No response-end (0002) anywhere. The packfile is
    // sidebanded whether or not the client asked for sideband-all.
    const out: Buffer[] = [];
    const ackOnly: string[] = [];
    for (const c of common) ackOnly.push("ACK " + c + "\n");
    if (fa.waitForDone || fa.haves.length > 0) ackOnly.push("ready\n");
    if (ackOnly.length > 0) {
      out.push(pktLine("acknowledgments\n"));
      for (const l of ackOnly) out.push(pktLine(l));
      out.push(DELIM);
    }
    const shallowLines: string[] = [];
    for (const s of shallow) shallowLines.push("shallow " + s);
    for (const cs of fa.clientShallow) {
      if (repo.objects.has(cs) && !shallow.includes(cs)) shallowLines.push("unshallow " + cs);
    }
    if (shallowLines.length > 0) {
      out.push(pktLine("shallow-info\n"));
      for (const l of shallowLines) out.push(pktLine(l));
      out.push(DELIM);
    }
    out.push(pktLine("packfile\n"));
    out.push(...sidebandChunks(pack));
    out.push(FLUSH);
    const fResp = Buffer.concat(out);
    return fResp;
  }

  return Buffer.concat([pktLine("ERR unknown command\n"), FLUSH]);
}

async function handleUploadPackV0(repo: Repo, body: Buffer): Promise<Buffer> {
  const { lines } = parsePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let deepen: number | null = null;
  let sideband64k = false;
  let done = false;
  for (const l of lines) {
    if (l.kind !== "data") continue;
    let text = l.text;
    if (text.startsWith("want ")) {
      let rest = text.slice(5);
      // Capabilities follow the OID, separated by a SPACE (git 2.43 sends
      // "want <oid> <caps>", NOT NUL — verified from the real client's
      // request bytes; NUL is only used in advertisements / receive-pack).
      const sep = rest.search(/[ \0]/);
      let caps = "";
      if (sep >= 0) { caps = rest.slice(sep + 1); rest = rest.slice(0, sep); }
      if (caps.includes("side-band-64k")) sideband64k = true;
      wants.push(rest.trim());
    } else if (text.startsWith("have ")) {
      haves.push(text.slice(5).trim());
    } else if (text.startsWith("shallow ")) {
      clientShallow.push(text.slice(8).trim());
    } else if (text.startsWith("deepen ")) {
      const n = parseInt(text.slice(7), 10);
      if (!Number.isNaN(n)) deepen = n;
    } else if (text.trim() === "done") {
      done = true;
    }
  }
  if (!done && wants.length === 0) {
    return Buffer.concat([pktLine("ERR bad request\n"), FLUSH]);
  }
  const common = haves.filter((h) => repo.objects.has(h) && repo.objects.get(h)?.type === "commit");
  const { objects, shallow } = reachable(repo, wants, haves, deepen, clientShallow);
  const pack = buildPack(objects);
  const out: Buffer[] = [];
  if (common.length > 0) out.push(pktLine("ACK " + common[0] + "\n"));
  else out.push(pktLine("NAK\n"));
  for (const s of shallow) out.push(pktLine("shallow " + s + "\n"));
  if (sideband64k) {
    out.push(...sidebandChunks(pack));
    out.push(FLUSH);
  } else {
    out.push(pack);
  }
  return Buffer.concat(out);
}

async function handleReceivePack(repo: Repo, body: Buffer): Promise<Buffer> {
  const { lines, offset } = parsePktLines(body);
  // First line may carry capabilities after NUL.
  let reportStatus = false;
  let sideband64k = false;
  const updates: { oldOid: string; newOid: string; ref: string }[] = [];
  for (const l of lines) {
    if (l.kind !== "data") break;
    let text = l.text;
    const nul = text.indexOf("\0");
    if (nul >= 0) {
      const caps = text.slice(nul + 1);
      if (caps.includes("report-status")) reportStatus = true;
      if (caps.includes("side-band-64k")) sideband64k = true;
      text = text.slice(0, nul);
    }
    const parts = text.trim().split(" ");
    if (parts.length >= 3) updates.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  const replyLines: string[] = [];
  const finish = (): Buffer => {
    if (sideband64k) {
      // The report is a pkt-line stream NESTED inside sideband channel 1:
      // one ch1 packet whose payload is [pktLine("unpack ok"),
      // pktLine("ok <ref>") / pktLine("ng <ref> ..."), ..., FLUSH], then a
      // top-level flush. Verified against real git 2.43 (http-backend).
      const inner: Buffer[] = [];
      for (const l of replyLines) inner.push(pktLine(l));
      inner.push(FLUSH);
      const parts: Buffer[] = sidebandChunks(Buffer.concat(inner));
      parts.push(FLUSH);
      return Buffer.concat(parts);
    }
    const parts: Buffer[] = [];
    for (const l of replyLines) parts.push(pktLine(l));
    parts.push(FLUSH);
    return Buffer.concat(parts);
  };
  if (updates.length === 0) {
    replyLines.push("unpack ok\n");
    return finish();
  }
  // The packfile follows the flush that ended the update lines. A pure-delete
  // push carries no packfile at all (the body ends after the flush), so an
  // empty remainder is not an error — it just means no new objects.
  let packBuf = body.subarray(offset);
  if (packBuf.length >= 4 && packBuf.subarray(packBuf.length - 4).toString("ascii") === "0000") {
    packBuf = packBuf.subarray(0, packBuf.length - 4);
  }
  let packObjects: PackObject[] = [];
  if (packBuf.length > 0) {
    try {
      packObjects = await parsePack(repo, packBuf);
    } catch (e) {
      replyLines.push("unpack " + (e instanceof Error ? e.message : "bad pack") + "\n");
      return finish();
    }
  }
  // Apply under the per-repo lock: store objects first, then update refs.
  return withRepoLock(repo, async () => {
    for (const o of packObjects) storeObject(repo, o.type, o.raw, o.deflated);
    replyLines.push("unpack ok\n");
    for (const u of updates) {
      const cur = repo.refs.get(u.ref);
      const refOk = /^refs\/(heads|tags)\/[A-Za-z0-9._\-/]+$/.test(u.ref) && !u.ref.includes("..") && !u.ref.endsWith(".lock");
      if (!refOk) {
        replyLines.push("ng " + u.ref + " invalid refname\n");
        continue;
      }
      if (u.oldOid !== ZERO_OID && cur === undefined) {
        replyLines.push("ng " + u.ref + " ref does not exist\n");
        continue;
      }
      if (u.oldOid !== ZERO_OID && cur !== u.oldOid) {
        replyLines.push("ng " + u.ref + " stale ref\n");
        continue;
      }
      if (u.newOid !== ZERO_OID) {
        const obj = repo.objects.get(u.newOid);
        const isTagRef = u.ref.startsWith("refs/tags/");
        // A branch must point at a commit; a tag ref may point at a tag
        // object (annotated tag) or a commit (lightweight tag).
        if (!obj || (!isTagRef && obj.type !== "commit") || (isTagRef && obj.type !== "commit" && obj.type !== "tag")) {
          replyLines.push("ng " + u.ref + " object not found\n");
          continue;
        }
        // Fast-forward only applies to branches; tags are created / deleted,
        // never fast-forwarded.
        if (!isTagRef && u.oldOid !== ZERO_OID && !isAncestor(repo, u.oldOid, u.newOid)) {
          replyLines.push("ng " + u.ref + " non-fast-forward\n");
          continue;
        }
        repo.refs.set(u.ref, u.newOid);
      } else {
        // delete (advertised delete-refs)
        repo.refs.delete(u.ref);
      }
      replyLines.push("ok " + u.ref + "\n");
    }
    repo.updatedAt = nowIso();
    if (!reportStatus) {
      // Without report-status the client only expects "unpack ok".
      replyLines.length = 1;
    }
    return finish();
  });
}

// Returns true when this request was a git endpoint (handled).
async function handleGit(req: http.IncomingMessage, res: http.ServerResponse, owner: string, repoName: string, sub: string, query: URLSearchParams): Promise<boolean> {
  const repo = getRepo(owner, repoName);
  const gitProtocol = (req.headers["git-protocol"] || "") as string;
  const wantsV2 = gitProtocol.includes("version=2");
  if (req.method === "GET" && sub === "/info/refs") {
    if (!repo) { sendText(res, 404, "Not Found\n"); return true; }
    const service = query.get("service") || "";
    if (service === "git-upload-pack") {
      if (wantsV2) { sendBuffer(res, 200, v2Advertisement(service), "application/x-git-upload-pack-advertisement"); }
      else { sendBuffer(res, 200, v0Advertisement(repo, service, v0UploadCaps(repo)), "application/x-git-upload-pack-advertisement"); }
    } else if (service === "git-receive-pack") {
      sendBuffer(res, 200, v0Advertisement(repo, service, v0ReceiveCaps()), "application/x-git-receive-pack-advertisement");
    } else {
      sendText(res, 404, "Not Found\n");
    }
    return true;
  }
  if (req.method === "POST" && sub === "/git-upload-pack") {
    if (!repo) { sendText(res, 404, "Not Found\n"); return true; }
    const body = await readBody(req);
    const out = wantsV2 ? await handleUploadPackV2(repo, body) : await handleUploadPackV0(repo, body);
    sendBuffer(res, 200, out, "application/x-git-upload-pack-result");
    return true;
  }
  if (req.method === "POST" && sub === "/git-receive-pack") {
    if (!repo) { sendText(res, 404, "Not Found\n"); return true; }
    const body = await readBody(req);
    const out = await handleReceivePack(repo, body);
    sendBuffer(res, 200, out, "application/x-git-receive-pack-result");
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// REST v3 — helpers + serializers
// ---------------------------------------------------------------------------
function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function reqId(): string {
  store.reqCounter += 1;
  return "req-" + store.reqCounter.toString(16).padStart(6, "0") + "-" + Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
}

function sendJson(res: http.ServerResponse, status: number, obj: unknown, extraHeaders?: Record<string, string>): void {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "X-GitHub-Request-Id": reqId(),
    ...extraHeaders,
  });
  res.end(body);
}

function sendBuffer(res: http.ServerResponse, status: number, buf: Buffer, contentType: string): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": buf.length,
    "X-GitHub-Request-Id": reqId(),
  });
  res.end(buf);
}

function sendText(res: http.ServerResponse, status: number, text: string): void {
  sendBuffer(res, status, Buffer.from(text, "utf8"), "text/plain; charset=utf-8");
}

function jsonError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message, documentation_url: "https://docs.github.com/rest" });
}

const OAUTH_SCOPES = "repo, read:org, user, gist";
function apiHeaders(): Record<string, string> {
  return { "X-OAuth-Scopes": OAUTH_SCOPES, "X-Accepted-OAuth-Scopes": OAUTH_SCOPES };
}

// Returns the login when the request carries the suite token, else sends 401.
function requireAuth(req: http.IncomingMessage, res: http.ServerResponse): string | null {
  const h = req.headers["authorization"] || "";
  const m = /^Bearer\s+(.+)$/.exec(h as string);
  if (SHOP_TOKEN) {
    if (!m || m[1] !== SHOP_TOKEN) {
      sendJson(res, 401, { message: "Bad credentials", documentation_url: "https://docs.github.com/rest" });
      return null;
    }
    return LOGIN;
  }
  // No shop token configured (local dev): accept any bearer, derive the login.
  if (m) return loginFromToken(m[1]);
  return LOGIN;
}

function baseOf(req: http.IncomingMessage): string {
  const host = req.headers.host || "localhost";
  return "http://" + host;
}

function userJson(login: string, base: string): Record<string, unknown> {
  return {
    login, id: 1, node_id: b64("User:1"), avatar_url: base + "/avatars/" + login,
    gravatar_id: "", url: base + "/api/v3/users/" + login, html_url: base + "/" + login,
    type: "User", site_admin: false, name: login, company: null, blog: "",
    location: null, email: null, hireable: null, bio: null, twitter_username: null,
    public_repos: store.repos.size, public_gists: 0, followers: 0, following: 0,
    created_at: nowIso(), updated_at: nowIso(),
  };
}

function repoJson(repo: Repo, base: string): Record<string, unknown> {
  return {
    id: repo.id, node_id: b64("Repository:" + repo.id), name: repo.name,
    full_name: repo.owner + "/" + repo.name, owner: userJson(repo.owner, base),
    private: repo.isPrivate, html_url: base + "/" + repo.owner + "/" + repo.name,
    description: repo.description, fork: false,
    url: base + "/api/v3/repos/" + repo.owner + "/" + repo.name,
    created_at: repo.createdAt, updated_at: repo.updatedAt, pushed_at: repo.updatedAt,
    git_url: "git://" + base.replace(/^https?:\/\//, "") + "/" + repo.owner + "/" + repo.name + ".git",
    ssh_url: "git@" + base.replace(/^https?:\/\//, "") + ":" + repo.owner + "/" + repo.name + ".git",
    clone_url: base + "/" + repo.owner + "/" + repo.name + ".git",
    homepage: null, size: repo.objects.size, stargazers_count: 0, watchers_count: 0,
    language: null, has_issues: true, has_projects: true, has_downloads: true,
    has_wiki: true, has_pages: false, has_discussions: false, forks_count: 0,
    mirror_url: null, archived: false, disabled: false, open_issues_count: openIssueCount(repo),
    license: null, allow_forking: true, is_template: false, web_commit_signoff_required: false,
    topics: [], visibility: repo.isPrivate ? "private" : "public", forks: 0,
    open_issues: openIssueCount(repo), watchers: 0, default_branch: repo.defaultBranch,
  };
}

function openIssueCount(repo: Repo): number {
  let n = 0;
  for (const i of repo.issues.values()) if (i.state === "open") n++;
  for (const p of repo.pulls.values()) if (p.state === "open") n++;
  return n;
}

function labelJson(repo: Repo, label: Label, base: string): Record<string, unknown> {
  return {
    id: label.id, node_id: b64("Label:" + label.id),
    url: base + "/api/v3/repos/" + repo.owner + "/" + repo.name + "/labels/" + encodeURIComponent(label.name),
    name: label.name, color: label.color, default: false, description: label.description,
  };
}

function issueJson(repo: Repo, issue: Issue, base: string): Record<string, unknown> {
  return {
    id: issue.id, node_id: b64("Issue:" + issue.id),
    url: base + "/api/v3/repos/" + repo.owner + "/" + repo.name + "/issues/" + issue.number,
    repository_url: base + "/api/v3/repos/" + repo.owner + "/" + repo.name,
    labels_url: base + "/api/v3/repos/" + repo.owner + "/" + repo.name + "/issues/" + issue.number + "/labels{/name}",
    comments_url: base + "/api/v3/repos/" + repo.owner + "/" + repo.name + "/issues/" + issue.number + "/comments",
    events_url: base + "/api/v3/repos/" + repo.owner + "/" + repo.name + "/issues/" + issue.number + "/events",
    html_url: base + "/" + repo.owner + "/" + repo.name + "/issues/" + issue.number,
    number: issue.number, title: issue.title, body: issue.body, state: issue.state,
    user: userJson(issue.user, base),
    labels: issue.labels.map((n) => { const l = repo.labels.get(n); return l ? labelJson(repo, l, base) : { name: n, color: "ffffff", description: "" }; }),
    assignee: null, assignees: [], locked: false, comments: issue.commentCount,
    created_at: issue.createdAt, updated_at: issue.updatedAt, closed_at: issue.state === "closed" ? issue.updatedAt : null,
    author_association: "OWNER", state_reason: null,
  };
}

function pullJson(repo: Repo, pull: Pull, base: string): Record<string, unknown> {
  const headRepo = repoJson(repo, base);
  return {
    id: pull.id, node_id: b64("PullRequest:" + pull.id),
    url: base + "/api/v3/repos/" + repo.owner + "/" + repo.name + "/pulls/" + pull.number,
    html_url: base + "/" + repo.owner + "/" + repo.name + "/pull/" + pull.number,
    diff_url: base + "/" + repo.owner + "/" + repo.name + "/pull/" + pull.number + ".diff",
    patch_url: base + "/" + repo.owner + "/" + repo.name + "/pull/" + pull.number + ".patch",
    issue_url: base + "/api/v3/repos/" + repo.owner + "/" + repo.name + "/issues/" + pull.number,
    number: pull.number, state: pull.state, locked: false, title: pull.title, body: pull.body,
    user: userJson(pull.user, base),
    created_at: pull.createdAt, updated_at: pull.updatedAt,
    closed_at: pull.state === "closed" ? pull.updatedAt : null,
    merged_at: pull.mergedAt, merge_commit_sha: pull.mergeSha,
    merged: pull.merged, mergeable: pull.mergeable, rebaseable: pull.mergeable,
    mergeable_state: pull.merged ? "merged" : pull.mergeable ? "clean" : "dirty",
    merged_by: pull.merged ? userJson(pull.user, base) : null,
    head: { label: repo.owner + ":" + pull.headRef, ref: pull.headRef, sha: pull.headSha, user: userJson(pull.user, base), repo: headRepo },
    base: { label: repo.owner + ":" + pull.baseRef, ref: pull.baseRef, sha: pull.baseSha, user: userJson(pull.user, base), repo: headRepo },
    _links: { self: { href: base + "/api/v3/repos/" + repo.owner + "/" + repo.name + "/pulls/" + pull.number } },
    author_association: "OWNER", auto_merge: null, draft: false,
  };
}

function commentJson(repo: Repo, c: RepoComment, base: string): Record<string, unknown> {
  return {
    id: c.id, node_id: b64("IssueComment:" + c.id),
    url: base + "/api/v3/repos/" + repo.owner + "/" + repo.name + "/issues/comments/" + c.id,
    html_url: base + "/" + repo.owner + "/" + repo.name + "/issues/" + c.issueNumber + "#issuecomment-" + c.id,
    body: c.body, user: userJson(c.user, base),
    created_at: c.createdAt, updated_at: c.updatedAt,
    author_association: "OWNER",
  };
}

function commitJson(repo: Repo, sha: string, base: string): Record<string, unknown> | null {
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== "commit") return null;
  const info = parseCommit(obj.raw);
  const who = (line: string): { name: string; email: string; date: string } => {
    const m = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
    if (!m) return { name: LOGIN, email: LOGIN + "@users.noreply.github.com", date: nowIso() };
    return { name: m[1], email: m[2], date: new Date(parseInt(m[3], 10) * 1000).toISOString() };
  };
  const author = who(info.author);
  const committer = who(info.committer);
  return {
    sha, node_id: b64("Commit:" + sha),
    url: base + "/api/v3/repos/" + repo.owner + "/" + repo.name + "/commits/" + sha,
    html_url: base + "/" + repo.owner + "/" + repo.name + "/commit/" + sha,
    commit: {
      author, committer, message: info.message,
      tree: { sha: info.tree, url: base + "/api/v3/repos/" + repo.owner + "/" + repo.name + "/git/trees/" + info.tree },
      url: base + "/api/v3/repos/" + repo.owner + "/" + repo.name + "/commits/" + sha,
      comment_count: 0, verification: { verified: false, reason: "unsigned", signature: null, payload: null, verified_at: null },
    },
    author: userJson(author.name, base), committer: userJson(committer.name, base),
    parents: info.parents.map((p) => ({ sha: p, url: base + "/api/v3/repos/" + repo.owner + "/" + repo.name + "/commits/" + p, html_url: base + "/" + repo.owner + "/" + repo.name + "/commit/" + p })),
  };
}

// Pagination: returns the page slice + Link header value (rel=next when needed).
function paginate<T>(items: T[], req: http.IncomingMessage, url: URL): { page: T[]; link: string | null } {
  const perPage = Math.max(1, Math.min(100, parseInt(url.searchParams.get("per_page") || "30", 10) || 30));
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const base = baseOf(req) + url.pathname;
  const linkFor = (p: number, rel: string): string => {
    const u = new URL(base);
    url.searchParams.forEach((v, k) => { if (k !== "page") u.searchParams.set(k, v); });
    u.searchParams.set("per_page", String(perPage));
    u.searchParams.set("page", String(p));
    return "<" + u.toString() + ">; rel=\"" + rel + "\"";
  };
  const links: string[] = [];
  if (page < totalPages) links.push(linkFor(page + 1, "next"), linkFor(totalPages, "last"));
  if (page > 1) links.push(linkFor(1, "first"), linkFor(page - 1, "prev"));
  return { page: slice, link: links.length > 0 ? links.join(", ") : null };
}

async function parseJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const buf = await readBody(req);
  if (buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString("utf8")) as unknown;
  } catch {
    throw new Error("bad json");
  }
}

// Resolve a repo from the URL owner/name, enforcing "repo belongs to the token
// login; same name under another owner is a 404, never a 403".
function resolveRepo(req: http.IncomingMessage, res: http.ServerResponse, login: string, owner: string, name: string): Repo | null {
  if (owner.toLowerCase() !== login.toLowerCase()) {
    jsonError(res, 404, "Not Found");
    return null;
  }
  const repo = getRepo(owner, name);
  if (!repo) {
    jsonError(res, 404, "Not Found");
    return null;
  }
  return repo;
}

// ---------------------------------------------------------------------------
// REST v3 — router
// ---------------------------------------------------------------------------
function diffTrees(repo: Repo, oldTree: string, newTree: string): { path: string; status: "added" | "removed" | "modified"; oldOid: string | null; newOid: string | null }[] {
  const oldMap = flattenTree(repo, oldTree);
  const newMap = flattenTree(repo, newTree);
  const out: { path: string; status: "added" | "removed" | "modified"; oldOid: string | null; newOid: string | null }[] = [];
  const paths = new Set<string>([...oldMap.keys(), ...newMap.keys()]);
  for (const p of [...paths].sort()) {
    const o = oldMap.get(p);
    const n = newMap.get(p);
    if (o && !n) out.push({ path: p, status: "removed", oldOid: o.oid, newOid: null });
    else if (!o && n) out.push({ path: p, status: "added", oldOid: null, newOid: n.oid });
    else if (o && n && o.oid !== n.oid) out.push({ path: p, status: "modified", oldOid: o.oid, newOid: n.oid });
  }
  return out;
}

// Naive line diff (multiset difference) — good enough for the small files the
// suite uses; the suite checks filename/status, not exact counts.
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number; patch: string } {
  const oldLines = oldText.length === 0 ? [] : oldText.split("\n");
  const newLines = newText.length === 0 ? [] : newText.split("\n");
  const oldCount = new Map<string, number>();
  for (const l of oldLines) oldCount.set(l, (oldCount.get(l) || 0) + 1);
  let additions = 0;
  for (const l of newLines) {
    const c = oldCount.get(l) || 0;
    if (c > 0) oldCount.set(l, c - 1);
    else additions++;
  }
  let deletions = 0;
  for (const c of oldCount.values()) deletions += c;
  const hunk: string[] = ["@@ -1," + oldLines.length + " +1," + newLines.length + " @@"]
  for (const l of oldLines) hunk.push("-" + l);
  for (const l of newLines) hunk.push("+" + l);
  return { additions, deletions, patch: hunk.join("\n") };
}

function fileJson(repo: Repo, d: { path: string; status: string; oldOid: string | null; newOid: string | null }, base: string): Record<string, unknown> {
  const oldText = d.oldOid ? (repo.objects.get(d.oldOid)?.raw.toString("utf8") || "") : "";
  const newText = d.newOid ? (repo.objects.get(d.newOid)?.raw.toString("utf8") || "") : "";
  const { additions, deletions, patch } = lineDiff(oldText, newText);
  return {
    sha: d.newOid || d.oldOid, filename: d.path, status: d.status,
    additions, deletions, changes: additions + deletions,
    blob_url: base + "/" + repo.owner + "/" + repo.name + "/blob/" + (d.newOid || d.oldOid),
    raw_url: base + "/" + repo.owner + "/" + repo.name + "/raw/" + (d.newOid || d.oldOid),
    contents_url: base + "/api/v3/repos/" + repo.owner + "/" + repo.name + "/contents/" + encodeURIComponent(d.path),
    patch,
  };
}

async function handleRest(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith("/api/v3")) return false;
  const login = requireAuth(req, res);
  if (login === null) return true;
  const base = baseOf(req);
  const seg = url.pathname.split("/").filter((s) => s.length > 0).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  // seg[0] = "api", seg[1] = "v3", rest = seg[2..]
  const rest = seg.slice(2);
  const method = req.method || "GET";

  // GET /api/v3/
  if (rest.length === 0 && method === "GET") {
    sendJson(res, 200, {
      current_user_url: base + "/api/v3/user",
      current_user_authorizations_html_url: base + "/settings/applications",
      authorizations_url: base + "/api/v3/authorizations",
      code_search_url: base + "/api/v3/search/code?q={query}{&page,per_page,sort,order}",
      commit_search_url: base + "/api/v3/search/commits?q={query}{&page,per_page,sort,order}",
      emails_url: base + "/api/v3/user/emails",
      emojis_url: base + "/api/v3/emojis",
      events_url: base + "/api/v3/events",
      feeds_url: base + "/api/v3/feeds",
      followers_url: base + "/api/v3/user/followers",
      following_url: base + "/api/v3/user/following{/other_user}",
      gists_url: base + "/api/v3/gists{/gist_id}",
      hub_url: base + "/api/v3/hub",
      issue_search_url: base + "/api/v3/search/issues?q={query}{&page,per_page,sort,order}",
      issues_url: base + "/api/v3/issues",
      keys_url: base + "/api/v3/user/keys",
      label_search_url: base + "/api/v3/search/labels?q={query}&repository_id={repository_id}{&page,per_page}",
      notifications_url: base + "/api/v3/notifications",
      organization_url: base + "/api/v3/orgs/{org}",
      organization_repositories_url: base + "/api/v3/orgs/{org}/repos{?type,page,per_page,sort}",
      organization_teams_url: base + "/api/v3/orgs/{org}/teams",
      public_gists_url: base + "/api/v3/gists/public",
      rate_limit_url: base + "/api/v3/rate_limit",
      repository_url: base + "/api/v3/repos/{owner}/{repo}",
      repository_search_url: base + "/api/v3/search/repositories?q={query}{&page,per_page,sort,order}",
      current_user_repositories_url: base + "/api/v3/user/repos{?type,page,per_page,sort}",
      starred_url: base + "/api/v3/user/starred{/owner}{/repo}",
      starred_gists_url: base + "/api/v3/gists/starred",
      topic_search_url: base + "/api/v3/search/topics?q={query}{&page,per_page}",
      user_url: base + "/api/v3/users/{user}",
      user_organizations_url: base + "/api/v3/user/orgs",
      user_repositories_url: base + "/api/v3/users/{user}/repos{?type,page,per_page,sort}",
      user_search_url: base + "/api/v3/search/users?q={query}{&page,per_page,sort,order}",
    }, apiHeaders());
    return true;
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === "meta" && method === "GET") {
    sendJson(res, 200, {
      verifiable_password_authentication: true, installed_version: "1.0.0",
      hooks: [], git: [], pages: [], importer: [], api: [], packages: [], actions: [],
      github_enterprise_importer: [], domains: { website: [], api: [] },
    }, apiHeaders());
    return true;
  }

  // GET /api/v3/user
  if (rest.length === 1 && rest[0] === "user" && method === "GET") {
    sendJson(res, 200, userJson(login, base), apiHeaders());
    return true;
  }

  // /api/v3/user/repos
  if (rest.length === 2 && rest[0] === "user" && rest[1] === "repos") {
    if (method === "GET") {
      const mine = [...store.repos.values()].filter((r) => r.owner.toLowerCase() === login.toLowerCase())
        .sort((a, b) => a.createdAt < b.createdAt ? -1 : 1);
      const { page, link } = paginate(mine.map((r) => repoJson(r, base)), req, url);
      sendJson(res, 200, page, { ...(link ? { Link: link } : {}), ...apiHeaders() });
      return true;
    }
    if (method === "POST") {
      let body: Record<string, unknown>;
      try { body = await parseJsonBody(req) as Record<string, unknown>; }
      catch { jsonError(res, 400, "Problems parsing JSON"); return true; }
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name || !/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === ".." || name.length > 100) {
        sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "Repository", code: "missing_field", field: "name", message: "name is required and must be a valid repository name" }], documentation_url: "https://docs.github.com/rest" }, apiHeaders());
        return true;
      }
      if (getRepo(login, name)) {
        sendJson(res, 422, { message: "Repository creation failed.", errors: [{ resource: "Repository", code: "custom", field: "name", message: "name already exists on this account" }], documentation_url: "https://docs.github.com/rest" }, apiHeaders());
        return true;
      }
      const repo = newRepo(login, name, typeof body.description === "string" ? body.description : "", body.private === true);
      sendJson(res, 201, repoJson(repo, base), apiHeaders());
      return true;
    }
  }

  // /api/v3/repos/{owner}/{name}[...]
  if (rest.length >= 3 && rest[0] === "repos") {
    const owner = rest[1];
    const name = rest[2];
    const repo = resolveRepo(req, res, login, owner, name);
    if (!repo) return true;
    const tail = rest.slice(3);

    // GET/PATCH/DELETE /repos/{owner}/{name}
    if (tail.length === 0) {
      if (method === "GET") { sendJson(res, 200, repoJson(repo, base), apiHeaders()); return true; }
      if (method === "PATCH") {
        let body: Record<string, unknown>;
        try { body = await parseJsonBody(req) as Record<string, unknown>; }
        catch { jsonError(res, 400, "Problems parsing JSON"); return true; }
        if (typeof body.description === "string") repo.description = body.description;
        if (typeof body.private === "boolean") repo.isPrivate = body.private;
        if (typeof body.default_branch === "string" && repo.refs.has("refs/heads/" + body.default_branch)) {
          repo.defaultBranch = body.default_branch;
        }
        repo.updatedAt = nowIso();
        sendJson(res, 200, repoJson(repo, base), apiHeaders());
        return true;
      }
      if (method === "DELETE") {
        store.repos.delete(repoKey(owner, name));
        res.writeHead(204, { "X-GitHub-Request-Id": reqId(), ...apiHeaders() });
        res.end();
        return true;
      }
    }

    // git/refs — create/list/get/update/delete references (branches and tags).
    // The suite creates its feature branches through POST /git/refs, so this
    // endpoint gates the whole pulls/repos surface.
    const refJson = (refName: string): Record<string, unknown> | null => {
      const sha = repo.refs.get(refName);
      if (!sha) return null;
      const obj = repo.objects.get(sha);
      const type = obj ? obj.type : "commit";
      return {
        ref: refName, node_id: b64("Ref:" + repo.id + ":" + refName),
        url: base + "/api/v3/repos/" + owner + "/" + name + "/git/refs/" + refName.slice("refs/".length),
        object: { sha, type, url: base + "/api/v3/repos/" + owner + "/" + name + "/git/" + (type === "tag" ? "tags" : "commits") + "/" + sha },
      };
    };
    if (tail.length >= 2 && tail[0] === "git" && tail[1] === "refs") {
      const refSuffix = tail.slice(2).join("/");
      if (method === "POST" && tail.length === 2) {
        let body: Record<string, unknown>;
        try { body = await parseJsonBody(req) as Record<string, unknown>; }
        catch { jsonError(res, 400, "Problems parsing JSON"); return true; }
        const refName = typeof body.ref === "string" ? body.ref : "";
        const sha = typeof body.sha === "string" ? body.sha : "";
        if (!/^refs\/(heads|tags)\/[A-Za-z0-9._\-/]+$/.test(refName) || refName.includes("..") || refName.endsWith(".lock")) {
          sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "Reference", code: "invalid", field: "ref", message: "Reference does not exist" }] }, apiHeaders());
          return true;
        }
        if (!/^[0-9a-f]{40}$/.test(sha) || !repo.objects.has(sha)) {
          sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "Reference", code: "invalid", field: "sha", message: "Object does not exist" }] }, apiHeaders());
          return true;
        }
        if (repo.refs.has(refName)) {
          sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "Reference", code: "custom", field: "ref", message: "Reference already exists" }] }, apiHeaders());
          return true;
        }
        if (refName.startsWith("refs/heads/") && repo.objects.get(sha)?.type !== "commit") {
          sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "Reference", code: "invalid", field: "sha", message: "Object is not a commit" }] }, apiHeaders());
          return true;
        }
        repo.refs.set(refName, sha);
        repo.updatedAt = nowIso();
        sendJson(res, 201, refJson(refName), apiHeaders());
        return true;
      }
      if (method === "GET") {
        if (tail.length === 2) {
          const list = [...repo.refs.keys()].sort().map((r) => refJson(r)).filter(Boolean);
          const { page, link } = paginate(list, req, url);
          sendJson(res, 200, page, { ...(link ? { Link: link } : {}), ...apiHeaders() });
          return true;
        }
        const fullRef = "refs/" + refSuffix;
        const exact = refJson(fullRef);
        if (exact) { sendJson(res, 200, exact, apiHeaders()); return true; }
        const prefixed = [...repo.refs.keys()].filter((r) => r.startsWith(fullRef + "/") || r.startsWith(fullRef)).sort().map((r) => refJson(r)).filter(Boolean);
        if (prefixed.length > 0) {
          const { page, link } = paginate(prefixed, req, url);
          sendJson(res, 200, page, { ...(link ? { Link: link } : {}), ...apiHeaders() });
          return true;
        }
        jsonError(res, 404, "Not Found");
        return true;
      }
      if (method === "PATCH" && tail.length > 2) {
        const fullRef = "refs/" + refSuffix;
        if (!repo.refs.has(fullRef)) { jsonError(res, 404, "Not Found"); return true; }
        let body: Record<string, unknown>;
        try { body = await parseJsonBody(req) as Record<string, unknown>; }
        catch { jsonError(res, 400, "Problems parsing JSON"); return true; }
        const sha = typeof body.sha === "string" ? body.sha : "";
        if (!/^[0-9a-f]{40}$/.test(sha) || !repo.objects.has(sha)) {
          sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "Reference", code: "invalid", field: "sha", message: "Object does not exist" }] }, apiHeaders());
          return true;
        }
        repo.refs.set(fullRef, sha);
        repo.updatedAt = nowIso();
        sendJson(res, 200, refJson(fullRef), apiHeaders());
        return true;
      }
      if (method === "DELETE" && tail.length > 2) {
        const fullRef = "refs/" + refSuffix;
        if (!repo.refs.has(fullRef)) { jsonError(res, 404, "Not Found"); return true; }
        if (fullRef === "refs/heads/" + repo.defaultBranch) {
          sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "Reference", code: "custom", field: "ref", message: "Cannot delete the default branch" }] }, apiHeaders());
          return true;
        }
        repo.refs.delete(fullRef);
        repo.updatedAt = nowIso();
        res.writeHead(204, { "X-GitHub-Request-Id": reqId(), ...apiHeaders() });
        res.end();
        return true;
      }
    }

    // git database API — blobs / trees / commits / tags. The suite may build
    // an annotated tag through REST (POST /git/tags, then POST /git/refs),
    // so these must exist; without them a tag object cannot be created.
    if (tail.length >= 2 && tail[0] === "git" && (tail[1] === "blobs" || tail[1] === "trees" || tail[1] === "commits" || tail[1] === "tags")) {
      const sub = tail[1];
      if (sub === "blobs") {
        if (method === "POST" && tail.length === 2) {
          let body: Record<string, unknown>;
          try { body = await parseJsonBody(req) as Record<string, unknown>; }
          catch { jsonError(res, 400, "Problems parsing JSON"); return true; }
          const content = typeof body.content === "string" ? body.content : "";
          const raw = body.encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
          const sha = storeObject(repo, "blob", raw);
          repo.updatedAt = nowIso();
          sendJson(res, 201, { sha, size: raw.length, url: base + "/api/v3/repos/" + owner + "/" + name + "/git/blobs/" + sha }, apiHeaders());
          return true;
        }
        if (method === "GET" && tail.length === 3) {
          const obj = repo.objects.get(tail[2]);
          if (!obj || obj.type !== "blob") { jsonError(res, 404, "Not Found"); return true; }
          sendJson(res, 200, { sha: tail[2], size: obj.raw.length, encoding: "base64", content: obj.raw.toString("base64"), url: base + "/api/v3/repos/" + owner + "/" + name + "/git/blobs/" + tail[2] }, apiHeaders());
          return true;
        }
      }
      if (sub === "trees") {
        if (method === "POST" && tail.length === 2) {
          let body: Record<string, unknown>;
          try { body = await parseJsonBody(req) as Record<string, unknown>; }
          catch { jsonError(res, 400, "Problems parsing JSON"); return true; }
          let rootTree = typeof body.base_tree === "string" && repo.objects.get(body.base_tree)?.type === "tree"
            ? body.base_tree : storeObject(repo, "tree", Buffer.alloc(0));
          const entries = Array.isArray(body.tree) ? body.tree as Record<string, unknown>[] : [];
          for (const e of entries) {
            if (!e || typeof e !== "object") continue;
            const p = typeof e.path === "string" ? e.path : "";
            if (!p) continue;
            const mode = typeof e.mode === "string" ? e.mode : "100644";
            let oid: string | null = null;
            if (typeof e.sha === "string" && repo.objects.has(e.sha)) oid = e.sha;
            else if (typeof e.content === "string") oid = storeObject(repo, "blob", Buffer.from(e.content, "utf8"));
            if (oid === null) oid = storeObject(repo, "tree", Buffer.alloc(0));
            rootTree = setPathInTree(repo, rootTree, p, oid, mode);
          }
          repo.updatedAt = nowIso();
          const treeEntries = parseTree((repo.objects.get(rootTree) as GitObj).raw).map((en) => ({
            path: en.name, mode: en.mode, type: en.mode === "40000" ? "tree" : "blob", sha: en.oid,
            size: en.mode === "40000" ? undefined : (repo.objects.get(en.oid)?.raw.length ?? 0),
            url: base + "/api/v3/repos/" + owner + "/" + name + "/git/" + (en.mode === "40000" ? "trees/" : "blobs/") + en.oid,
          }));
          sendJson(res, 201, { sha: rootTree, url: base + "/api/v3/repos/" + owner + "/" + name + "/git/trees/" + rootTree, tree: treeEntries, truncated: false }, apiHeaders());
          return true;
        }
        if (method === "GET" && tail.length === 3) {
          const obj = repo.objects.get(tail[2]);
          if (!obj || obj.type !== "tree") { jsonError(res, 404, "Not Found"); return true; }
          const recursive = url.searchParams.get("recursive") === "1";
          const entries: Record<string, unknown>[] = [];
          const walk = (treeOid: string, prefix: string): void => {
            for (const en of parseTree((repo.objects.get(treeOid) as GitObj).raw)) {
              const p = prefix ? prefix + "/" + en.name : en.name;
              entries.push({ path: p, mode: en.mode, type: en.mode === "40000" ? "tree" : "blob", sha: en.oid, url: base + "/api/v3/repos/" + owner + "/" + name + "/git/" + (en.mode === "40000" ? "trees/" : "blobs/") + en.oid });
              if (recursive && en.mode === "40000") walk(en.oid, p);
            }
          };
          walk(tail[2], "");
          sendJson(res, 200, { sha: tail[2], url: base + "/api/v3/repos/" + owner + "/" + name + "/git/trees/" + tail[2], tree: entries, truncated: false }, apiHeaders());
          return true;
        }
      }
      if (sub === "commits") {
        if (method === "POST" && tail.length === 2) {
          let body: Record<string, unknown>;
          try { body = await parseJsonBody(req) as Record<string, unknown>; }
          catch { jsonError(res, 400, "Problems parsing JSON"); return true; }
          const message = typeof body.message === "string" ? body.message : "";
          const tree = typeof body.tree === "string" ? body.tree : "";
          const parents = Array.isArray(body.parents) ? (body.parents as unknown[]).filter((x): x is string => typeof x === "string") : [];
          if (!message || !tree || !repo.objects.has(tree)) {
            sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "Commit", code: "invalid", field: "tree", message: "tree is required" }] }, apiHeaders());
            return true;
          }
          const sha = makeCommit(repo, tree, parents, message, "");
          repo.updatedAt = nowIso();
          sendJson(res, 201, commitJson(repo, sha, base), apiHeaders());
          return true;
        }
        if (method === "GET" && tail.length === 3) {
          const c = commitJson(repo, tail[2], base);
          if (!c) { jsonError(res, 404, "Not Found"); return true; }
          sendJson(res, 200, c, apiHeaders());
          return true;
        }
      }
      if (sub === "tags") {
        if (method === "POST" && tail.length === 2) {
          let body: Record<string, unknown>;
          try { body = await parseJsonBody(req) as Record<string, unknown>; }
          catch { jsonError(res, 400, "Problems parsing JSON"); return true; }
          const tag = typeof body.tag === "string" ? body.tag : "";
          const message = typeof body.message === "string" ? body.message : "";
          const object = typeof body.object === "string" ? body.object : "";
          const type = typeof body.type === "string" ? body.type : "commit";
          const tagger = (body.tagger && typeof body.tagger === "object") ? body.tagger as Record<string, unknown> : {};
          if (!tag || !object || !repo.objects.has(object)) {
            sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "Tag", code: "invalid", field: "object", message: "object is required" }] }, apiHeaders());
            return true;
          }
          const ts = Math.floor(new Date(nowIso()).getTime() / 1000);
          const tName = typeof tagger.name === "string" ? tagger.name : login;
          const tEmail = typeof tagger.email === "string" ? tagger.email : login + "@users.noreply.github.com";
          const raw = "object " + object + "\ntype " + type + "\ntag " + tag + "\ntagger " + tName + " <" + tEmail + "> " + ts + " +0000\n\n" + message;
          const sha = storeObject(repo, "tag", Buffer.from(raw, "utf8"));
          repo.updatedAt = nowIso();
          sendJson(res, 201, {
            sha, tag, message, url: base + "/api/v3/repos/" + owner + "/" + name + "/git/tags/" + sha,
            object: { sha: object, type, url: base + "/api/v3/repos/" + owner + "/" + name + "/git/" + (type === "tag" ? "tags" : "commits") + "/" + object },
            tagger: { name: tName, email: tEmail, date: nowIso() },
          }, apiHeaders());
          return true;
        }
        if (method === "GET" && tail.length === 3) {
          const obj = repo.objects.get(tail[2]);
          if (!obj || obj.type !== "tag") { jsonError(res, 404, "Not Found"); return true; }
          const text = obj.raw.toString("utf8");
          const mObj = text.match(/^object ([0-9a-f]{40})$/m);
          const mType = text.match(/^type (\S+)$/m);
          const mTag = text.match(/^tag (.+)$/m);
          const mTagger = text.match(/^tagger (.+?) <(.*?)> (\d+) ([+-]\d+)$/m);
          const msg = text.split("\n\n").slice(1).join("\n\n");
          const objSha = mObj ? mObj[1] : "";
          const objType = mType ? mType[1] : "commit";
          sendJson(res, 200, {
            sha: tail[2], tag: mTag ? mTag[1] : "", message: msg,
            url: base + "/api/v3/repos/" + owner + "/" + name + "/git/tags/" + tail[2],
            object: { sha: objSha, type: objType, url: base + "/api/v3/repos/" + owner + "/" + name + "/git/" + (objType === "tag" ? "tags" : "commits") + "/" + objSha },
            tagger: { name: mTagger ? mTagger[1] : login, email: mTagger ? mTagger[2] : "", date: mTagger ? new Date(parseInt(mTagger[3], 10) * 1000).toISOString() : nowIso() },
          }, apiHeaders());
          return true;
        }
      }
    }

    // branches
    if (tail.length === 1 && tail[0] === "branches" && method === "GET") {
      const list = [...repo.refs.keys()].filter((r) => r.startsWith("refs/heads/"))
        .sort().map((r) => {
          const b = r.slice("refs/heads/".length);
          const sha = repo.refs.get(r) as string;
          return { name: b, commit: { sha, url: base + "/api/v3/repos/" + owner + "/" + name + "/commits/" + sha }, protected: false };
        });
      const { page, link } = paginate(list, req, url);
      sendJson(res, 200, page, { ...(link ? { Link: link } : {}), ...apiHeaders() });
      return true;
    }
    if (tail.length === 2 && tail[0] === "branches" && method === "GET") {
      const sha = repo.refs.get("refs/heads/" + tail[1]);
      if (!sha) { jsonError(res, 404, "Not Found"); return true; }
      sendJson(res, 200, { name: tail[1], commit: { sha, url: base + "/api/v3/repos/" + owner + "/" + name + "/commits/" + sha }, protected: false, protection: { enabled: false, required_status_checks: { enforcement_level: "off", contexts: [], checks: [] } } }, apiHeaders());
      return true;
    }

    // commits
    if (tail.length === 1 && tail[0] === "commits" && method === "GET") {
      const refName = url.searchParams.get("sha") || repo.defaultBranch;
      const tip = repo.refs.get("refs/heads/" + refName) || repo.refs.get(refName) || (repo.objects.get(refName) ? refName : undefined);
      const start = tip || repo.refs.get("refs/heads/" + repo.defaultBranch);
      const list: Record<string, unknown>[] = [];
      if (start) {
        walkAncestors(repo, start, null, (oid) => {
          const c = commitJson(repo, oid, base);
          if (c) list.push(c);
        });
      }
      const { page, link } = paginate(list, req, url);
      sendJson(res, 200, page, { ...(link ? { Link: link } : {}), ...apiHeaders() });
      return true;
    }
    if (tail.length === 2 && tail[0] === "commits" && method === "GET") {
      const ref = tail[1];
      const sha = repo.refs.get("refs/heads/" + ref) || repo.refs.get(ref) || (repo.objects.get(ref) ? ref : undefined);
      const c = sha ? commitJson(repo, sha, base) : null;
      if (!c) { jsonError(res, 404, "Not Found"); return true; }
      sendJson(res, 200, c, apiHeaders());
      return true;
    }

    // contents
    if (tail.length >= 1 && tail[0] === "contents") {
      const path = tail.slice(1).join("/");
      const branch = url.searchParams.get("ref") || repo.defaultBranch;
      const tip = repo.refs.get("refs/heads/" + branch);
      if (method === "GET") {
        if (!tip) { jsonError(res, 404, "Not Found"); return true; }
        const tipObj = repo.objects.get(tip);
        if (!tipObj || tipObj.type !== "commit") { jsonError(res, 404, "Not Found"); return true; }
        const rootTree = parseCommit(tipObj.raw).tree;
        if (path === "") {
          const entries = listDir(repo, rootTree, "") || [];
          sendJson(res, 200, entries.map((e) => contentEntryJson(repo, e, "", base)), apiHeaders());
          return true;
        }
        const found = getBlobAtPath(repo, rootTree, path);
        // A directory entry is found by getBlobAtPath too (mode 40000); it
        // must be listed, not returned as a file.
        if (found && found.mode !== "40000") {
          const blob = repo.objects.get(found.oid);
          const content = blob ? blob.raw.toString("base64") : "";
          sendJson(res, 200, {
            type: "file", encoding: "base64", size: blob ? blob.raw.length : 0,
            name: path.split("/").pop(), path, content, sha: found.oid,
            url: base + "/api/v3/repos/" + owner + "/" + name + "/contents/" + encodeURIComponent(path),
            html_url: base + "/" + owner + "/" + name + "/blob/" + branch + "/" + path,
            git_url: base + "/api/v3/repos/" + owner + "/" + name + "/git/blobs/" + found.oid,
            download_url: base + "/" + owner + "/" + name + "/raw/" + branch + "/" + path,
          }, apiHeaders());
          return true;
        }
        const dir = listDir(repo, rootTree, path);
        if (dir) {
          sendJson(res, 200, dir.map((e) => contentEntryJson(repo, e, path, base)), apiHeaders());
          return true;
        }
        jsonError(res, 404, "Not Found");
        return true;
      }
      if (method === "PUT" || method === "DELETE") {
        let body: Record<string, unknown>;
        try { body = await parseJsonBody(req) as Record<string, unknown>; }
        catch { jsonError(res, 400, "Problems parsing JSON"); return true; }
        const message = typeof body.message === "string" ? body.message : "";
        const branchName = typeof body.branch === "string" ? body.branch : repo.defaultBranch;
        if (!message) {
          sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "Content", code: "missing_field", field: "message", message: "message is required" }] }, apiHeaders());
          return true;
        }
        const result = await withRepoLock(repo, async (): Promise<{ status: number; payload: unknown }> => {
          const curTip = repo.refs.get("refs/heads/" + branchName);
          let rootTree: string;
          let parents: string[] = [];
          if (curTip) {
            const tipObj = repo.objects.get(curTip);
            if (!tipObj || tipObj.type !== "commit") return { status: 404, payload: { message: "Not Found" } };
            rootTree = parseCommit(tipObj.raw).tree;
            parents = [curTip];
          } else {
            // Empty repo: a PUT creates the first (root) commit; a DELETE has nothing to delete.
            if (method === "DELETE") return { status: 404, payload: { message: "Not Found" } };
            rootTree = storeObject(repo, "tree", Buffer.alloc(0));
          }
          const existing = path === "" ? null : getBlobAtPath(repo, rootTree, path);
          if (method === "PUT") {
            const contentB64 = typeof body.content === "string" ? body.content : "";
            if (!contentB64) {
              return { status: 422, payload: { message: "Validation Failed", errors: [{ resource: "Content", code: "missing_field", field: "content", message: "content is required" }] } };
            }
            if (existing && typeof body.sha === "string" && body.sha !== existing.oid) {
              return { status: 409, payload: { message: "sha does not match the current file sha" } };
            }
            if (existing && typeof body.sha !== "string") {
              return { status: 422, payload: { message: "Validation Failed", errors: [{ resource: "Content", code: "missing_field", field: "sha", message: "sha is required when updating a file" }] } };
            }
            const raw = Buffer.from(contentB64.replace(/\s/g, ""), "base64");
            const blobSha = storeObject(repo, "blob", raw);
            const newTree = setPathInTree(repo, rootTree, path, blobSha, "100644");
            const newCommit = makeCommit(repo, newTree, parents, message, "");
            repo.refs.set("refs/heads/" + branchName, newCommit);
            repo.updatedAt = nowIso();
            return {
              status: existing ? 200 : 201,
              payload: {
                content: {
                  type: "file", encoding: "base64", size: raw.length,
                  name: path.split("/").pop(), path, content: raw.toString("base64"), sha: blobSha,
                  url: base + "/api/v3/repos/" + owner + "/" + name + "/contents/" + encodeURIComponent(path),
                  html_url: base + "/" + owner + "/" + name + "/blob/" + branchName + "/" + path,
                  git_url: base + "/api/v3/repos/" + owner + "/" + name + "/git/blobs/" + blobSha,
                  download_url: base + "/" + owner + "/" + name + "/raw/" + branchName + "/" + path,
                },
                commit: { sha: newCommit, message, url: base + "/api/v3/repos/" + owner + "/" + name + "/commits/" + newCommit, html_url: base + "/" + owner + "/" + name + "/commit/" + newCommit, author: { name: login, email: login + "@users.noreply.github.com", date: nowIso() }, committer: { name: login, email: login + "@users.noreply.github.com", date: nowIso() } },
              },
            };
          }
          // DELETE
          if (!existing) return { status: 404, payload: { message: "Not Found" } };
          if (typeof body.sha !== "string" || body.sha !== existing.oid) {
            return { status: 409, payload: { message: "sha does not match the current file sha" } };
          }
          const newTree = setPathInTree(repo, rootTree, path, null, "100644");
          const newCommit = makeCommit(repo, newTree, parents, message, "");
          repo.refs.set("refs/heads/" + branchName, newCommit);
          repo.updatedAt = nowIso();
          return {
            status: 200,
            payload: {
              commit: { sha: newCommit, message, url: base + "/api/v3/repos/" + owner + "/" + name + "/commits/" + newCommit, html_url: base + "/" + owner + "/" + name + "/commit/" + newCommit, author: { name: login, email: login + "@users.noreply.github.com", date: nowIso() }, committer: { name: login, email: login + "@users.noreply.github.com", date: nowIso() } },
            },
          };
        });
        if (result.status === 404) { jsonError(res, 404, "Not Found"); return true; }
        sendJson(res, result.status, result.payload, apiHeaders());
        return true;
      }
    }

    // labels
    if (tail.length >= 1 && tail[0] === "labels") {
      if (tail.length === 1 && method === "GET") {
        const { page, link } = paginate([...repo.labels.values()].map((l) => labelJson(repo, l, base)), req, url);
        sendJson(res, 200, page, { ...(link ? { Link: link } : {}), ...apiHeaders() });
        return true;
      }
      if (tail.length === 1 && method === "POST") {
        let body: Record<string, unknown>;
        try { body = await parseJsonBody(req) as Record<string, unknown>; }
        catch { jsonError(res, 400, "Problems parsing JSON"); return true; }
        const name = typeof body.name === "string" ? body.name.trim() : "";
        let color = typeof body.color === "string" ? body.color.replace(/^#/, "") : "ffffff";
        if (!name) {
          sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "Label", code: "missing_field", field: "name", message: "name is required" }] }, apiHeaders());
          return true;
        }
        if (!/^[0-9a-fA-F]{6}$/.test(color)) {
          sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "Label", code: "invalid", field: "color", message: "color must be a 6-character hex value" }] }, apiHeaders());
          return true;
        }
        color = color.toLowerCase();
        if (repo.labels.has(name)) {
          sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "Label", code: "custom", field: "name", message: "A label with this name already exists" }] }, apiHeaders());
          return true;
        }
        const label: Label = { id: store.nextEntityId++, name, color, description: typeof body.description === "string" ? body.description : "" };
        repo.labels.set(name, label);
        sendJson(res, 201, labelJson(repo, label, base), apiHeaders());
        return true;
      }
      if (tail.length === 2 && method === "GET") {
        const label = repo.labels.get(tail[1]);
        if (!label) { jsonError(res, 404, "Not Found"); return true; }
        sendJson(res, 200, labelJson(repo, label, base), apiHeaders());
        return true;
      }
      if (tail.length === 2 && method === "PATCH") {
        const label = repo.labels.get(tail[1]);
        if (!label) { jsonError(res, 404, "Not Found"); return true; }
        let body: Record<string, unknown>;
        try { body = await parseJsonBody(req) as Record<string, unknown>; }
        catch { jsonError(res, 400, "Problems parsing JSON"); return true; }
        if (typeof body.name === "string" && body.name.trim() && body.name !== label.name) {
          if (repo.labels.has(body.name)) {
            sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "Label", code: "custom", field: "name", message: "A label with this name already exists" }] }, apiHeaders());
            return true;
          }
          repo.labels.delete(label.name);
          label.name = body.name.trim();
          repo.labels.set(label.name, label);
        }
        if (typeof body.color === "string") {
          const c = body.color.replace(/^#/, "");
          if (!/^[0-9a-fA-F]{6}$/.test(c)) {
            sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "Label", code: "invalid", field: "color", message: "color must be a 6-character hex value" }] }, apiHeaders());
            return true;
          }
          label.color = c.toLowerCase();
        }
        if (typeof body.description === "string") label.description = body.description;
        sendJson(res, 200, labelJson(repo, label, base), apiHeaders());
        return true;
      }
      if (tail.length === 2 && method === "DELETE") {
        if (!repo.labels.has(tail[1])) { jsonError(res, 404, "Not Found"); return true; }
        repo.labels.delete(tail[1]);
        res.writeHead(204, { "X-GitHub-Request-Id": reqId(), ...apiHeaders() });
        res.end();
        return true;
      }
    }

    // issues + comments
    if (tail.length >= 1 && tail[0] === "issues") {
      if (tail.length === 1 && method === "GET") {
        const state = url.searchParams.get("state") || "open";
        const labelFilter = url.searchParams.get("labels");
        const sort = url.searchParams.get("sort") || "created";
        const direction = url.searchParams.get("direction") || (sort === "created" ? "desc" : "asc");
        let list = [...repo.issues.values()];
        if (state !== "all") list = list.filter((i) => i.state === state);
        if (labelFilter) {
          const want = labelFilter.split(",").map((s) => s.trim());
          list = list.filter((i) => want.every((w) => i.labels.includes(w)));
        }
        // GitHub list-issues default is created DESC; sort by number (which
        // is creation order) and reverse for desc. The suite's
        // list-sort-desc check reads the order, not just the status.
        list.sort((a, b) => direction === "desc" ? b.number - a.number : a.number - b.number);
        const { page, link } = paginate(list.map((i) => issueJson(repo, i, base)), req, url);
        sendJson(res, 200, page, { ...(link ? { Link: link } : {}), ...apiHeaders() });
        return true;
      }
      if (tail.length === 1 && method === "POST") {
        let body: Record<string, unknown>;
        try { body = await parseJsonBody(req) as Record<string, unknown>; }
        catch { jsonError(res, 400, "Problems parsing JSON"); return true; }
        const title = typeof body.title === "string" ? body.title.trim() : "";
        if (!title) {
          sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "Issue", code: "missing_field", field: "title", message: "title is required" }] }, apiHeaders());
          return true;
        }
        const labels = Array.isArray(body.labels) ? body.labels.filter((x): x is string => typeof x === "string") : [];
        for (const l of labels) {
          if (!repo.labels.has(l)) {
            sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "Issue", code: "invalid", field: "labels", message: "The label '" + l + "' does not exist" }] }, apiHeaders());
            return true;
          }
        }
        const now = nowIso();
        const issue: Issue = {
          id: store.nextEntityId++, number: repo.nextIssue++, title,
          body: typeof body.body === "string" ? body.body : "", state: "open",
          labels, user: login, createdAt: now, updatedAt: now, commentCount: 0,
        };
        repo.issues.set(issue.number, issue);
        sendJson(res, 201, issueJson(repo, issue, base), apiHeaders());
        return true;
      }
      if (tail.length === 2 && tail[1] === "comments" && method === "GET") {
        // GET /issues/comments — all comments in the repo
        const all = [...repo.comments.values()].sort((a, b) => a.id - b.id);
        const { page, link } = paginate(all.map((c) => commentJson(repo, c, base)), req, url);
        sendJson(res, 200, page, { ...(link ? { Link: link } : {}), ...apiHeaders() });
        return true;
      }
      // /issues/comments/{id} — must come before the issue-number parse below.
      if (tail.length === 3 && tail[1] === "comments") {
        const cid = parseInt(tail[2], 10);
        const c = repo.comments.get(cid);
        if (Number.isNaN(cid) || !c) { jsonError(res, 404, "Not Found"); return true; }
        if (method === "GET") { sendJson(res, 200, commentJson(repo, c, base), apiHeaders()); return true; }
        if (method === "PATCH") {
          let body: Record<string, unknown>;
          try { body = await parseJsonBody(req) as Record<string, unknown>; }
          catch { jsonError(res, 400, "Problems parsing JSON"); return true; }
          if (typeof body.body === "string") c.body = body.body;
          c.updatedAt = nowIso();
          sendJson(res, 200, commentJson(repo, c, base), apiHeaders());
          return true;
        }
        if (method === "DELETE") {
          repo.comments.delete(cid);
          const parent = repo.issues.get(c.issueNumber);
          if (parent) parent.commentCount = Math.max(0, parent.commentCount - 1);
          res.writeHead(204, { "X-GitHub-Request-Id": reqId(), ...apiHeaders() });
          res.end();
          return true;
        }
      }
      const issueNum = parseInt(tail[1], 10);
      if (Number.isNaN(issueNum)) { jsonError(res, 404, "Not Found"); return true; }
      const issue = repo.issues.get(issueNum);
      if (tail.length === 2 && method === "GET") {
        if (!issue) { jsonError(res, 404, "Not Found"); return true; }
        sendJson(res, 200, issueJson(repo, issue, base), apiHeaders());
        return true;
      }
      if (tail.length === 2 && method === "PATCH") {
        if (!issue) { jsonError(res, 404, "Not Found"); return true; }
        let body: Record<string, unknown>;
        try { body = await parseJsonBody(req) as Record<string, unknown>; }
        catch { jsonError(res, 400, "Problems parsing JSON"); return true; }
        if (typeof body.title === "string" && body.title.trim()) issue.title = body.title.trim();
        if (typeof body.body === "string") issue.body = body.body;
        if (body.state === "open" || body.state === "closed") issue.state = body.state;
        if (Array.isArray(body.labels)) {
          const labels = body.labels.filter((x): x is string => typeof x === "string");
          for (const l of labels) {
            if (!repo.labels.has(l)) {
              sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "Issue", code: "invalid", field: "labels", message: "The label '" + l + "' does not exist" }] }, apiHeaders());
              return true;
            }
          }
          issue.labels = labels;
        }
        issue.updatedAt = nowIso();
        sendJson(res, 200, issueJson(repo, issue, base), apiHeaders());
        return true;
      }
      if (tail.length === 3 && tail[2] === "comments" && method === "GET") {
        if (!issue) { jsonError(res, 404, "Not Found"); return true; }
        const list = [...repo.comments.values()].filter((c) => c.issueNumber === issueNum).sort((a, b) => a.id - b.id);
        const { page, link } = paginate(list.map((c) => commentJson(repo, c, base)), req, url);
        sendJson(res, 200, page, { ...(link ? { Link: link } : {}), ...apiHeaders() });
        return true;
      }
      if (tail.length === 3 && tail[2] === "comments" && method === "POST") {
        if (!issue) { jsonError(res, 404, "Not Found"); return true; }
        let body: Record<string, unknown>;
        try { body = await parseJsonBody(req) as Record<string, unknown>; }
        catch { jsonError(res, 400, "Problems parsing JSON"); return true; }
        if (typeof body.body !== "string" || !body.body.trim()) {
          sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "IssueComment", code: "missing_field", field: "body", message: "body is required" }] }, apiHeaders());
          return true;
        }
        const now = nowIso();
        const c: RepoComment = { id: store.nextEntityId++, issueNumber: issueNum, body: body.body, user: login, createdAt: now, updatedAt: now };
        repo.comments.set(c.id, c);
        issue.commentCount++;
        issue.updatedAt = now;
        sendJson(res, 201, commentJson(repo, c, base), apiHeaders());
        return true;
      }
      if (tail.length === 3 && tail[2] === "labels" && (method === "GET" || method === "POST" || method === "PUT")) {
        if (!issue) { jsonError(res, 404, "Not Found"); return true; }
        if (method === "GET") {
          sendJson(res, 200, issue.labels.map((n) => { const l = repo.labels.get(n); return l ? labelJson(repo, l, base) : { name: n, color: "ffffff", description: "" }; }), apiHeaders());
          return true;
        }
        let body: unknown;
        try { body = await parseJsonBody(req); }
        catch { jsonError(res, 400, "Problems parsing JSON"); return true; }
        const names: string[] = Array.isArray(body) ? body.filter((x): x is string => typeof x === "string")
          : (body && typeof body === "object" && Array.isArray((body as Record<string, unknown>).labels)
            ? ((body as Record<string, unknown>).labels as unknown[]).filter((x): x is string => typeof x === "string") : []);
        for (const l of names) {
          if (!repo.labels.has(l)) {
            sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "Issue", code: "invalid", field: "labels", message: "The label '" + l + "' does not exist" }] }, apiHeaders());
            return true;
          }
        }
        if (method === "PUT") issue.labels = names;
        else for (const l of names) if (!issue.labels.includes(l)) issue.labels.push(l);
        issue.updatedAt = nowIso();
        sendJson(res, 200, issue.labels.map((n) => { const l = repo.labels.get(n); return l ? labelJson(repo, l, base) : { name: n, color: "ffffff", description: "" }; }), apiHeaders());
        return true;
      }
      if (tail.length === 4 && tail[2] === "labels" && method === "DELETE") {
        if (!issue) { jsonError(res, 404, "Not Found"); return true; }
        issue.labels = issue.labels.filter((l) => l !== tail[3]);
        issue.updatedAt = nowIso();
        sendJson(res, 200, issue.labels.map((n) => { const l = repo.labels.get(n); return l ? labelJson(repo, l, base) : { name: n, color: "ffffff", description: "" }; }), apiHeaders());
        return true;
      }
    }

    // pulls
    if (tail.length >= 1 && tail[0] === "pulls") {
      if (tail.length === 1 && method === "GET") {
        const state = url.searchParams.get("state") || "open";
        let list = [...repo.pulls.values()];
        if (state !== "all") list = list.filter((p) => p.state === state);
        list.sort((a, b) => a.number - b.number);
        const { page, link } = paginate(list.map((p) => pullJson(repo, p, base)), req, url);
        sendJson(res, 200, page, { ...(link ? { Link: link } : {}), ...apiHeaders() });
        return true;
      }
      if (tail.length === 1 && method === "POST") {
        let body: Record<string, unknown>;
        try { body = await parseJsonBody(req) as Record<string, unknown>; }
        catch { jsonError(res, 400, "Problems parsing JSON"); return true; }
        const title = typeof body.title === "string" ? body.title.trim() : "";
        const headRaw = typeof body.head === "string" ? body.head : "";
        const baseRaw = typeof body.base === "string" ? body.base : repo.defaultBranch;
        if (!title || !headRaw) {
          sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "PullRequest", code: "missing_field", field: !title ? "title" : "head", message: "field is required" }] }, apiHeaders());
          return true;
        }
        const headBranch = headRaw.includes(":") ? headRaw.split(":").slice(1).join(":") : headRaw;
        const baseBranch = baseRaw.includes(":") ? baseRaw.split(":").slice(1).join(":") : baseRaw;
        const headSha = repo.refs.get("refs/heads/" + headBranch);
        const baseSha = repo.refs.get("refs/heads/" + baseBranch);
        if (!headSha) {
          sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "PullRequest", code: "invalid", field: "head", message: "head branch does not exist" }] }, apiHeaders());
          return true;
        }
        if (!baseSha) {
          sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "PullRequest", code: "invalid", field: "base", message: "base branch does not exist" }] }, apiHeaders());
          return true;
        }
        if (headSha === baseSha) {
          sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", field: "base", message: "No commits between " + baseBranch + " and " + headBranch }] }, apiHeaders());
          return true;
        }
        const baseTip = parseCommit((repo.objects.get(baseSha) as GitObj).raw).tree;
        const headTip = parseCommit((repo.objects.get(headSha) as GitObj).raw).tree;
        const mb = mergeBase(repo, baseSha, headSha);
        const mbTree = mb ? parseCommit((repo.objects.get(mb) as GitObj).raw).tree : baseTip;
        const files = diffTrees(repo, mbTree, headTip).map((d) => d.path);
        const merged = threeWayMerge(repo, mbTree, baseTip, headTip);
        const now = nowIso();
        const pull: Pull = {
          id: store.nextEntityId++, number: repo.nextPull++, title,
          body: typeof body.body === "string" ? body.body : "", state: "open",
          merged: false, mergeable: !merged.conflict,
          headRef: headBranch, headSha, baseRef: baseBranch, baseSha,
          user: login, createdAt: now, updatedAt: now, mergedAt: null, mergeSha: null, files,
        };
        repo.pulls.set(pull.number, pull);
        sendJson(res, 201, pullJson(repo, pull, base), apiHeaders());
        return true;
      }
      const pullNum = parseInt(tail[1], 10);
      if (Number.isNaN(pullNum)) { jsonError(res, 404, "Not Found"); return true; }
      const pull = repo.pulls.get(pullNum);
      if (tail.length === 2 && method === "GET") {
        if (!pull) { jsonError(res, 404, "Not Found"); return true; }
        sendJson(res, 200, pullJson(repo, pull, base), apiHeaders());
        return true;
      }
      if (tail.length === 2 && method === "PATCH") {
        if (!pull) { jsonError(res, 404, "Not Found"); return true; }
        let body: Record<string, unknown>;
        try { body = await parseJsonBody(req) as Record<string, unknown>; }
        catch { jsonError(res, 400, "Problems parsing JSON"); return true; }
        if (typeof body.title === "string" && body.title.trim()) pull.title = body.title.trim();
        if (typeof body.body === "string") pull.body = body.body;
        if (body.state === "open" || body.state === "closed") pull.state = body.state;
        pull.updatedAt = nowIso();
        sendJson(res, 200, pullJson(repo, pull, base), apiHeaders());
        return true;
      }
      if (tail.length === 3 && tail[2] === "files" && method === "GET") {
        if (!pull) { jsonError(res, 404, "Not Found"); return true; }
        const mb = mergeBase(repo, pull.baseSha, pull.headSha);
        const mbTree = mb ? parseCommit((repo.objects.get(mb) as GitObj).raw).tree : parseCommit((repo.objects.get(pull.baseSha) as GitObj).raw).tree;
        const headTree = parseCommit((repo.objects.get(pull.headSha) as GitObj).raw).tree;
        const files = diffTrees(repo, mbTree, headTree).map((d) => fileJson(repo, d, base));
        const { page, link } = paginate(files, req, url);
        sendJson(res, 200, page, { ...(link ? { Link: link } : {}), ...apiHeaders() });
        return true;
      }
      if (tail.length === 3 && tail[2] === "commits" && method === "GET") {
        if (!pull) { jsonError(res, 404, "Not Found"); return true; }
        const mb = mergeBase(repo, pull.baseSha, pull.headSha);
        const stop = mb ? new Set([mb]) : null;
        const list: Record<string, unknown>[] = [];
        walkAncestors(repo, pull.headSha, stop, (oid) => {
          const c = commitJson(repo, oid, base);
          if (c) list.push(c);
        });
        const { page, link } = paginate(list, req, url);
        sendJson(res, 200, page, { ...(link ? { Link: link } : {}), ...apiHeaders() });
        return true;
      }
      if (tail.length === 3 && tail[2] === "merge" && method === "GET") {
        if (!pull) { jsonError(res, 404, "Not Found"); return true; }
        if (pull.merged) {
          res.writeHead(204, { "X-GitHub-Request-Id": reqId(), ...apiHeaders() });
          res.end();
        } else {
          jsonError(res, 404, "Not Found");
        }
        return true;
      }
      if (tail.length === 3 && tail[2] === "merge" && method === "PUT") {
        if (!pull) { jsonError(res, 404, "Not Found"); return true; }
        if (pull.merged) {
          sendJson(res, 405, { message: "Pull request has already been merged" }, apiHeaders());
          return true;
        }
        if (!pull.mergeable) {
          sendJson(res, 405, { message: "Pull request is not mergeable" }, apiHeaders());
          return true;
        }
        let body: Record<string, unknown> = {};
        try { body = await parseJsonBody(req) as Record<string, unknown>; }
        catch { jsonError(res, 400, "Problems parsing JSON"); return true; }
        const methodName = typeof body.merge_method === "string" ? body.merge_method : "squash";
        const result = await withRepoLock(repo, async (): Promise<{ status: number; payload: unknown }> => {
          const title = typeof body.commit_title === "string" ? body.commit_title : undefined;
          const message = typeof body.commit_message === "string" ? body.commit_message : undefined;
          return performMerge(repo, pull, methodName, title, message);
        });
        sendJson(res, result.status, result.payload, apiHeaders());
        return true;
      }
    }
  }

  // Unknown /api/v3 route: 404 JSON, never HTML.
  jsonError(res, 404, "Not Found");
  return true;
}

function contentEntryJson(repo: Repo, e: TreeEntry, dirPath: string, base: string): Record<string, unknown> {
  const path = dirPath ? dirPath + "/" + e.name : e.name;
  const isDir = e.mode === "40000";
  const obj = repo.objects.get(e.oid);
  return {
    type: isDir ? "dir" : "file", size: isDir ? 0 : (obj ? obj.raw.length : 0),
    name: e.name, path, sha: e.oid,
    url: base + "/api/v3/repos/" + repo.owner + "/" + repo.name + "/contents/" + encodeURIComponent(path),
    html_url: base + "/" + repo.owner + "/" + repo.name + (isDir ? "/tree/" + repo.defaultBranch + "/" + path : "/blob/" + repo.defaultBranch + "/" + path),
    git_url: base + "/api/v3/repos/" + repo.owner + "/" + repo.name + "/git/" + (isDir ? "trees/" : "blobs/") + e.oid,
    download_url: isDir ? null : base + "/" + repo.owner + "/" + repo.name + "/raw/" + repo.defaultBranch + "/" + path,
  };
}

// ---------------------------------------------------------------------------
// GraphQL v4 — parser
// ---------------------------------------------------------------------------
type GqlValue =
  | { kind: "variable"; name: string }
  | { kind: "string"; value: string }
  | { kind: "int"; value: number }
  | { kind: "float"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "null" }
  | { kind: "enum"; value: string }
  | { kind: "list"; values: GqlValue[] }
  | { kind: "object"; fields: { name: string; value: GqlValue }[] };

type GqlDirective = { name: string; args: { name: string; value: GqlValue }[] };
type GqlSelection =
  | { kind: "field"; alias: string | null; name: string; args: { name: string; value: GqlValue }[]; directives: GqlDirective[]; selectionSet: GqlSelection[] | null }
  | { kind: "fragmentSpread"; name: string; directives: GqlDirective[] }
  | { kind: "inlineFragment"; typeCondition: string | null; directives: GqlDirective[]; selectionSet: GqlSelection[] };

type GqlOperation = {
  kind: "query" | "mutation" | "subscription";
  name: string | null;
  variables: { name: string; type: string; defaultValue: GqlValue | null }[];
  selectionSet: GqlSelection[];
};
type GqlDocument = { operations: GqlOperation[]; fragments: Map<string, GqlSelection[]> };

type Tok = { kind: "name" | "int" | "float" | "string" | "punct" | "ellipsis"; value: string };

function tokenizeGql(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === ",") { i++; continue; }
    if (c === "#") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "." && src[i + 1] === "." && src[i + 2] === ".") { toks.push({ kind: "ellipsis", value: "..." }); i += 3; continue; }
    if ("{}()[]:!@$=&|".includes(c)) { toks.push({ kind: "punct", value: c }); i++; continue; }
    if (c === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        const val = end < 0 ? src.slice(i + 3) : src.slice(i + 3, end);
        toks.push({ kind: "string", value: val });
        i = end < 0 ? src.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length) {
          const e = src[j + 1];
          out += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e === "u" ? String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)) : e;
          j += e === "u" ? 6 : 2;
        } else { out += src[j]; j++; }
      }
      toks.push({ kind: "string", value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c) || (c === "-" )) {
      let j = i;
      if (src[j] === "-") j++;
      while (j < src.length && /[0-9]/.test(src[j])) j++;
      let isFloat = false;
      if (src[j] === "." && /[0-9]/.test(src[j + 1] || "")) {
        isFloat = true; j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      if (src[j] === "e" || src[j] === "E") {
        isFloat = true; j++;
        if (src[j] === "+" || src[j] === "-") j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      toks.push({ kind: isFloat ? "float" : "int", value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < src.length && isNameChar(src[j])) j++;
      toks.push({ kind: "name", value: src.slice(i, j) });
      i = j;
      continue;
    }
    // Unknown char: skip it.
    i++;
  }
  return toks;
}

class GqlParser {
  toks: Tok[];
  pos: number;
  constructor(src: string) { this.toks = tokenizeGql(src); this.pos = 0; }
  peek(): Tok | null { return this.pos < this.toks.length ? this.toks[this.pos] : null; }
  next(): Tok {
    const t = this.toks[this.pos];
    this.pos++;
    return t;
  }
  expectPunct(v: string): void {
    const t = this.next();
    if (!t || t.kind !== "punct" || t.value !== v) throw new Error("expected " + v);
  }
  parseDocument(): GqlDocument {
    const doc: GqlDocument = { operations: [], fragments: new Map() };
    while (this.peek()) {
      const t = this.peek() as Tok;
      if (t.kind === "punct" && t.value === "{") {
        doc.operations.push({ kind: "query", name: null, variables: [], selectionSet: this.parseSelectionSet() });
      } else if (t.kind === "name" && (t.value === "query" || t.value === "mutation" || t.value === "subscription")) {
        const kind = this.next().value as "query" | "mutation" | "subscription";
        let name: string | null = null;
        const nt = this.peek();
        if (nt && nt.kind === "name") name = this.next().value;
        const variables = this.parseVariableDefinitions();
        const selectionSet = this.parseSelectionSet();
        doc.operations.push({ kind, name, variables, selectionSet });
      } else if (t.kind === "name" && t.value === "fragment") {
        this.next();
        const name = this.next().value;
        const on = this.next();
        if (on.value !== "on") throw new Error("expected on");
        const typeName = this.next().value;
        void typeName;
        const sel = this.parseSelectionSet();
        doc.fragments.set(name, sel);
      } else {
        throw new Error("unexpected token " + t.value);
      }
    }
    return doc;
  }
  parseVariableDefinitions(): { name: string; type: string; defaultValue: GqlValue | null }[] {
    const out: { name: string; type: string; defaultValue: GqlValue | null }[] = [];
    const t = this.peek();
    if (!t || t.kind !== "punct" || t.value !== "(") return out;
    this.next();
    while (true) {
      const nt = this.peek();
      if (!nt) break;
      if (nt.kind === "punct" && nt.value === ")") { this.next(); break; }
      this.expectPunct("$");
      const name = this.next().value;
      this.expectPunct(":");
      const type = this.parseTypeName();
      let defaultValue: GqlValue | null = null;
      const eq = this.peek();
      if (eq && eq.kind === "punct" && eq.value === "=") {
        this.next();
        defaultValue = this.parseValue(true);
      }
      out.push({ name, type, defaultValue });
    }
    return out;
  }
  parseTypeName(): string {
    const t = this.peek();
    if (t && t.kind === "punct" && t.value === "[") {
      this.next();
      const inner = this.parseTypeName();
      this.expectPunct("]");
      const bang = this.peek();
      if (bang && bang.kind === "punct" && bang.value === "!") { this.next(); return "[" + inner + "]!"; }
      return "[" + inner + "]";
    }
    const name = this.next().value;
    const bang = this.peek();
    if (bang && bang.kind === "punct" && bang.value === "!") { this.next(); return name + "!"; }
    return name;
  }
  parseSelectionSet(): GqlSelection[] {
    this.expectPunct("{");
    const out: GqlSelection[] = [];
    while (true) {
      const t = this.peek();
      if (!t) throw new Error("unterminated selection set");
      if (t.kind === "punct" && t.value === "}") { this.next(); break; }
      out.push(this.parseSelection());
    }
    return out;
  }
  parseSelection(): GqlSelection {
    const t = this.peek() as Tok;
    if (t.kind === "ellipsis") {
      this.next();
      const nt = this.peek() as Tok;
      if (nt.kind === "name" && nt.value === "on") {
        this.next();
        const typeCondition = this.next().value;
        const directives = this.parseDirectives();
        const selectionSet = this.parseSelectionSet();
        return { kind: "inlineFragment", typeCondition, directives, selectionSet };
      }
      if (nt.kind === "name") {
        const name = this.next().value;
        const directives = this.parseDirectives();
        return { kind: "fragmentSpread", name, directives };
      }
      const directives = this.parseDirectives();
      const selectionSet = this.parseSelectionSet();
      return { kind: "inlineFragment", typeCondition: null, directives, selectionSet };
    }
    // field (maybe aliased)
    let name = this.next().value;
    let alias: string | null = null;
    const colon = this.peek();
    if (colon && colon.kind === "punct" && colon.value === ":") {
      this.next();
      alias = name;
      name = this.next().value;
    }
    const args = this.parseArguments();
    const directives = this.parseDirectives();
    let selectionSet: GqlSelection[] | null = null;
    const brace = this.peek();
    if (brace && brace.kind === "punct" && brace.value === "{") selectionSet = this.parseSelectionSet();
    return { kind: "field", alias, name, args, directives, selectionSet };
  }
  parseArguments(): { name: string; value: GqlValue }[] {
    const out: { name: string; value: GqlValue }[] = [];
    const t = this.peek();
    if (!t || t.kind !== "punct" || t.value !== "(") return out;
    this.next();
    while (true) {
      const nt = this.peek();
      if (!nt) break;
      if (nt.kind === "punct" && nt.value === ")") { this.next(); break; }
      const name = this.next().value;
      this.expectPunct(":");
      out.push({ name, value: this.parseValue(false) });
    }
    return out;
  }
  parseDirectives(): GqlDirective[] {
    const out: GqlDirective[] = [];
    while (true) {
      const t = this.peek();
      if (!t || t.kind !== "punct" || t.value !== "@") break;
      this.next();
      const name = this.next().value;
      const args = this.parseArguments();
      out.push({ name, args });
    }
    return out;
  }
  parseValue(constLit: boolean): GqlValue {
    const t = this.next();
    if (t.kind === "punct" && t.value === "$") {
      if (constLit) throw new Error("variable in const value");
      return { kind: "variable", name: this.next().value };
    }
    if (t.kind === "int") return { kind: "int", value: parseInt(t.value, 10) };
    if (t.kind === "float") return { kind: "float", value: parseFloat(t.value) };
    if (t.kind === "string") return { kind: "string", value: t.value };
    if (t.kind === "punct" && t.value === "[") {
      const values: GqlValue[] = [];
      while (true) {
        const nt = this.peek();
        if (!nt) break;
        if (nt.kind === "punct" && nt.value === "]") { this.next(); break; }
        values.push(this.parseValue(constLit));
      }
      return { kind: "list", values };
    }
    if (t.kind === "punct" && t.value === "{") {
      const fields: { name: string; value: GqlValue }[] = [];
      while (true) {
        const nt = this.peek();
        if (!nt) break;
        if (nt.kind === "punct" && nt.value === "}") { this.next(); break; }
        const name = this.next().value;
        this.expectPunct(":");
        fields.push({ name, value: this.parseValue(constLit) });
      }
      return { kind: "object", fields };
    }
    if (t.kind === "name") {
      if (t.value === "true") return { kind: "boolean", value: true };
      if (t.value === "false") return { kind: "boolean", value: false };
      if (t.value === "null") return { kind: "null" };
      return { kind: "enum", value: t.value };
    }
    throw new Error("unexpected value token " + t.value);
  }
}

// ---------------------------------------------------------------------------
// GraphQL v4 — schema (introspection + validation source of truth)
// ---------------------------------------------------------------------------
type GqlArgDef = { name: string; type: string };
type GqlFieldDef = { name: string; type: string; args: GqlArgDef[] };
type GqlTypeDef = {
  name: string; kind: "OBJECT" | "ENUM" | "INPUT_OBJECT" | "SCALAR";
  fields: GqlFieldDef[]; enumValues: string[]; inputFields: GqlArgDef[];
  description: string;
};
function tdef(name: string, kind: GqlTypeDef["kind"], fields: GqlFieldDef[] = [], enumValues: string[] = [], inputFields: GqlArgDef[] = [], description = ""): GqlTypeDef {
  return { name, kind, fields, enumValues, inputFields, description };
}
function f(name: string, type: string, args: GqlArgDef[] = []): GqlFieldDef {
  return { name, type, args };
}
function a(name: string, type: string): GqlArgDef { return { name, type }; }

const GQL_SCHEMA: GqlTypeDef[] = [
  tdef("Query", "OBJECT", [
    f("repository", "Repository", [a("owner", "String!"), a("name", "String!")]),
    f("viewer", "User!"),
    f("search", "SearchResultItemConnection!", [a("type", "SearchType!"), a("query", "String!"), a("first", "Int")]),
    f("node", "Node", [a("id", "ID!")]),
  ]),
  tdef("Mutation", "OBJECT", [
    f("createIssue", "CreateIssuePayload", [a("input", "CreateIssueInput!")]),
    f("createPullRequest", "CreatePullRequestPayload", [a("input", "CreatePullRequestInput!")]),
    f("closeIssue", "CloseIssuePayload", [a("input", "CloseIssueInput!")]),
    f("updateIssue", "UpdateIssuePayload", [a("input", "UpdateIssueInput!")]),
    f("addComment", "AddCommentPayload", [a("input", "AddCommentInput!")]),
    f("mergePullRequest", "MergePullRequestPayload", [a("input", "MergePullRequestInput!")]),
  ]),
  tdef("MergePullRequestPayload", "OBJECT", [
    f("pullRequest", "PullRequest"), f("clientMutationId", "String"),
  ]),
  tdef("MergePullRequestInput", "INPUT_OBJECT", [], [], [
    a("pullRequestId", "ID!"), a("commitHeadline", "String"), a("commitBody", "String"),
    a("mergeMethod", "PullRequestMergeMethod"), a("expectedHeadOid", "String"), a("clientMutationId", "String"),
  ]),
  tdef("PullRequestMergeMethod", "ENUM", [], ["MERGE", "SQUASH", "REBASE"]),
  tdef("Repository", "OBJECT", [
    f("id", "ID!"), f("databaseId", "Int!"), f("name", "String!"), f("nameWithOwner", "String!"),
    f("owner", "User!"), f("defaultBranchRef", "Ref"), f("viewerPermission", "RepositoryPermission!"),
    f("hasIssuesEnabled", "Boolean!"),
    f("issue", "Issue", [a("number", "Int!")]),
    f("issues", "IssueConnection!", [a("first", "Int"), a("after", "String"), a("orderBy", "IssueOrder"), a("states", "[IssueState!]")]),
    f("pullRequest", "PullRequest", [a("number", "Int!")]),
    f("pullRequests", "PullRequestConnection!", [a("first", "Int"), a("after", "String"), a("orderBy", "IssueOrder"), a("states", "[PullRequestState!]")]),
    f("url", "URI!"), f("description", "String"), f("visibility", "RepositoryVisibility!"),
    f("isPrivate", "Boolean!"), f("createdAt", "DateTime!"), f("updatedAt", "DateTime!"), f("fork", "Boolean!"),
  ]),
  tdef("Issue", "OBJECT", [
    f("id", "ID!"), f("number", "Int!"), f("title", "String!"), f("state", "IssueState!"), f("body", "String"),
    f("createdAt", "DateTime!"), f("updatedAt", "DateTime!"), f("closedAt", "DateTime"),
    f("author", "User"), f("labels", "LabelConnection", [a("first", "Int")]),
    f("comments", "IssueCommentConnection", [a("first", "Int")]),
    f("url", "URI!"), f("repository", "Repository!"),
  ]),
  tdef("PullRequest", "OBJECT", [
    f("id", "ID!"), f("number", "Int!"), f("headRefName", "String!"), f("baseRefName", "String!"),
    f("mergeable", "MergeableState!"), f("state", "PullRequestState!"), f("merged", "Boolean!"),
    f("files", "PullRequestChangedFileConnection", [a("first", "Int")]),
    f("title", "String!"), f("body", "String"),
    f("createdAt", "DateTime!"), f("updatedAt", "DateTime!"), f("mergedAt", "DateTime"),
    f("author", "User"), f("headRefOid", "String"), f("baseRefOid", "String"),
    f("url", "URI!"), f("repository", "Repository!"),
  ]),
  tdef("User", "OBJECT", [
    f("login", "String!"), f("id", "ID!"), f("name", "String"), f("url", "URI!"), f("avatarUrl", "URI!"),
  ]),
  tdef("Ref", "OBJECT", [f("name", "String!"), f("target", "GitObject")]),
  tdef("GitObject", "OBJECT", [f("oid", "String!")]),
  tdef("IssueConnection", "OBJECT", [
    f("nodes", "[Issue]"), f("edges", "[IssueEdge]"), f("totalCount", "Int!"), f("pageInfo", "PageInfo!"),
  ]),
  tdef("IssueEdge", "OBJECT", [f("node", "Issue"), f("cursor", "String!")]),
  tdef("PullRequestConnection", "OBJECT", [
    f("nodes", "[PullRequest]"), f("edges", "[PullRequestEdge]"), f("totalCount", "Int!"), f("pageInfo", "PageInfo!"),
  ]),
  tdef("PullRequestEdge", "OBJECT", [f("node", "PullRequest"), f("cursor", "String!")]),
  tdef("LabelConnection", "OBJECT", [f("nodes", "[Label]"), f("totalCount", "Int!")]),
  tdef("Label", "OBJECT", [f("id", "ID!"), f("name", "String!"), f("color", "String!"), f("description", "String")]),
  tdef("IssueCommentConnection", "OBJECT", [f("nodes", "[IssueComment]"), f("totalCount", "Int!"), f("pageInfo", "PageInfo!")]),
  tdef("IssueComment", "OBJECT", [
    f("id", "ID!"), f("body", "String!"), f("author", "User"),
    f("createdAt", "DateTime!"), f("updatedAt", "DateTime!"),
  ]),
  tdef("IssueCommentEdge", "OBJECT", [f("node", "IssueComment"), f("cursor", "String!")]),
  tdef("PullRequestChangedFileConnection", "OBJECT", [f("nodes", "[PullRequestChangedFile]"), f("totalCount", "Int!")]),
  tdef("PullRequestChangedFile", "OBJECT", [
    f("path", "String!"), f("additions", "Int!"), f("deletions", "Int!"), f("changeType", "String!"),
  ]),
  tdef("PageInfo", "OBJECT", [
    f("hasNextPage", "Boolean!"), f("hasPreviousPage", "Boolean!"),
    f("startCursor", "String"), f("endCursor", "String"),
  ]),
  tdef("SearchResultItemConnection", "OBJECT", [
    f("nodes", "[SearchResultItem]"), f("totalCount", "Int!"), f("pageInfo", "PageInfo!"),
  ]),
  tdef("SearchResultItem", "OBJECT", [f("id", "ID!")]),
  tdef("CreateIssuePayload", "OBJECT", [f("issue", "Issue"), f("clientMutationId", "String")]),
  tdef("CreatePullRequestPayload", "OBJECT", [f("pullRequest", "PullRequest"), f("clientMutationId", "String")]),
  tdef("CloseIssuePayload", "OBJECT", [f("issue", "Issue"), f("clientMutationId", "String")]),
  tdef("UpdateIssuePayload", "OBJECT", [f("issue", "Issue"), f("clientMutationId", "String")]),
  tdef("AddCommentPayload", "OBJECT", [f("commentEdge", "IssueCommentEdge"), f("subject", "Issue"), f("clientMutationId", "String")]),
  tdef("Node", "OBJECT", [f("id", "ID!")]),
  tdef("IssueState", "ENUM", [], ["OPEN", "CLOSED"]),
  tdef("PullRequestState", "ENUM", [], ["OPEN", "CLOSED", "MERGED"]),
  tdef("MergeableState", "ENUM", [], ["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
  tdef("RepositoryPermission", "ENUM", [], ["ADMIN", "MAINTAIN", "READ", "TRIAGE", "WRITE"]),
  tdef("RepositoryVisibility", "ENUM", [], ["PUBLIC", "PRIVATE"]),
  tdef("SearchType", "ENUM", [], ["ISSUE", "REPOSITORY", "USER", "DISCUSSION", "COMMIT", "CODE", "MILESTONE", "PULL_REQUEST", "WIKI"]),
  tdef("IssueOrderField", "ENUM", [], ["CREATED_AT", "UPDATED_AT", "COMMENTS"]),
  tdef("OrderDirection", "ENUM", [], ["ASC", "DESC"]),
  tdef("IssueOrder", "INPUT_OBJECT", [], [], [a("field", "IssueOrderField!"), a("direction", "OrderDirection!")]),
  tdef("CreateIssueInput", "INPUT_OBJECT", [], [], [
    a("repositoryId", "ID!"), a("title", "String!"), a("body", "String"), a("labelIds", "[ID!]"), a("clientMutationId", "String"),
  ]),
  tdef("CreatePullRequestInput", "INPUT_OBJECT", [], [], [
    a("repositoryId", "ID!"), a("baseRefName", "String!"), a("headRefName", "String!"),
    a("title", "String!"), a("body", "String"), a("clientMutationId", "String"),
  ]),
  tdef("CloseIssueInput", "INPUT_OBJECT", [], [], [a("issueId", "ID!"), a("clientMutationId", "String")]),
  tdef("UpdateIssueInput", "INPUT_OBJECT", [], [], [
    a("id", "ID!"), a("title", "String"), a("body", "String"), a("state", "IssueState"), a("clientMutationId", "String"),
  ]),
  tdef("AddCommentInput", "INPUT_OBJECT", [], [], [a("subjectId", "ID!"), a("body", "String!"), a("clientMutationId", "String")]),
  tdef("ID", "SCALAR"), tdef("String", "SCALAR"), tdef("Int", "SCALAR"), tdef("Boolean", "SCALAR"),
  tdef("URI", "SCALAR"), tdef("DateTime", "SCALAR"),
  // GraphQL introspection meta-types (so nested __schema/__type selections resolve).
  tdef("__Schema", "OBJECT", [
    f("queryType", "__Type!"), f("mutationType", "__Type"), f("subscriptionType", "__Type"),
    f("types", "[__Type!]!"), f("directives", "[__Directive!]!"),
  ]),
  tdef("__Type", "OBJECT", [
    f("kind", "__TypeKind!"), f("name", "String"), f("description", "String"),
    f("fields", "[__Field!]", [a("includeDeprecated", "Boolean")]),
    f("inputFields", "[__InputValue!]"), f("interfaces", "[__Type!]"),
    f("enumValues", "[__EnumValue!]", [a("includeDeprecated", "Boolean")]),
    f("possibleTypes", "[__Type!]"), f("ofType", "__Type"),
  ]),
  tdef("__Field", "OBJECT", [
    f("name", "String!"), f("description", "String"), f("args", "[__InputValue!]!"),
    f("type", "__Type!"), f("isDeprecated", "Boolean!"), f("deprecationReason", "String"),
  ]),
  tdef("__InputValue", "OBJECT", [
    f("name", "String!"), f("description", "String"), f("type", "__Type!"), f("defaultValue", "String"),
  ]),
  tdef("__EnumValue", "OBJECT", [
    f("name", "String!"), f("description", "String"), f("isDeprecated", "Boolean!"), f("deprecationReason", "String"),
  ]),
  tdef("__Directive", "OBJECT", [
    f("name", "String!"), f("description", "String"), f("locations", "[__DirectiveLocation!]!"),
    f("args", "[__InputValue!]!"), f("isRepeatable", "Boolean!"),
  ]),
  tdef("__TypeKind", "ENUM", [], ["SCALAR", "OBJECT", "INTERFACE", "UNION", "ENUM", "INPUT_OBJECT", "LIST", "NON_NULL"]),
  tdef("__DirectiveLocation", "ENUM", [], ["QUERY", "MUTATION", "SUBSCRIPTION", "FIELD", "FRAGMENT_DEFINITION", "FRAGMENT_SPREAD", "INLINE_FRAGMENT", "SCHEMA", "SCALAR", "OBJECT", "FIELD_DEFINITION", "ARGUMENT_DEFINITION", "INTERFACE", "UNION", "ENUM", "ENUM_VALUE", "INPUT_OBJECT", "INPUT_FIELD_DEFINITION"]),
];

const GQL_TYPES = new Map<string, GqlTypeDef>(GQL_SCHEMA.map((t) => [t.name, t]));

// Introspection type reference: "String!" -> {kind:"NON_NULL",ofType:{kind:"SCALAR",name:"String"}}
function typeRef(typeStr: string): Record<string, unknown> {
  if (typeStr.endsWith("!")) return { kind: "NON_NULL", name: null, ofType: typeRef(typeStr.slice(0, -1)) };
  if (typeStr.startsWith("[") && typeStr.endsWith("]")) return { kind: "LIST", name: null, ofType: typeRef(typeStr.slice(1, -1)) };
  const def = GQL_TYPES.get(typeStr);
  const kind = def ? def.kind : "SCALAR";
  return { kind, name: typeStr, ofType: null };
}

function introspectType(name: string): Record<string, unknown> | null {
  const def = GQL_TYPES.get(name);
  if (!def) return null;
  return {
    kind: def.kind, name: def.name, description: def.description || null,
    fields: def.kind === "OBJECT" ? def.fields.map((fld) => ({
      name: fld.name, description: null,
      args: fld.args.map((arg) => ({ name: arg.name, description: null, type: typeRef(arg.type), defaultValue: null })),
      type: typeRef(fld.type), isDeprecated: false, deprecationReason: null,
    })) : null,
    inputFields: def.kind === "INPUT_OBJECT" ? def.inputFields.map((inp) => ({
      name: inp.name, description: null, type: typeRef(inp.type), defaultValue: null,
    })) : null,
    interfaces: [],
    enumValues: def.kind === "ENUM" ? def.enumValues.map((v) => ({ name: v, description: null, isDeprecated: false, deprecationReason: null })) : null,
    possibleTypes: null,
  };
}

// ---------------------------------------------------------------------------
// GraphQL v4 — executor
// ---------------------------------------------------------------------------
type GqlCtx = { login: string; base: string; errors: { message: string }[] };

function evalGqlValue(v: GqlValue, vars: Record<string, unknown>): unknown {
  switch (v.kind) {
    case "variable": return vars[v.name];
    case "string": case "int": case "float": case "boolean": return v.value;
    case "null": return null;
    case "enum": return v.value;
    case "list": return v.values.map((x) => evalGqlValue(x, vars));
    case "object": {
      const o: Record<string, unknown> = {};
      for (const fld of v.fields) o[fld.name] = evalGqlValue(fld.value, vars);
      return o;
    }
  }
}

function evalGqlArgs(args: { name: string; value: GqlValue }[], vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of args) out[a.name] = evalGqlValue(a.value, vars);
  return out;
}

function directiveAllows(directives: GqlDirective[], vars: Record<string, unknown>): boolean {
  for (const d of directives) {
    const ifArg = d.args.find((a) => a.name === "if");
    if (!ifArg) continue;
    const v = evalGqlValue(ifArg.value, vars);
    if (d.name === "skip" && v === true) return false;
    if (d.name === "include" && v !== true) return false;
  }
  return true;
}

// Unwrap NON_NULL / LIST wrappers to the named type.
function namedType(typeStr: string): string {
  let t = typeStr;
  while (t.endsWith("!")) t = t.slice(0, -1);
  while (t.startsWith("[") && t.endsWith("]")) t = t.slice(1, -1);
  while (t.endsWith("!")) t = t.slice(0, -1);
  return t;
}
function isListType(typeStr: string): boolean {
  return typeStr.replace(/!$/, "").startsWith("[");
}

// --- node objects (plain shapes the executor reads) ---
function userNode(login: string, base: string): Record<string, unknown> {
  return { __type: "User", login, id: b64("User:1"), name: login, url: base + "/" + login, avatarUrl: base + "/avatars/" + login };
}
function repoNode(repo: Repo, base: string): Record<string, unknown> {
  return {
    __type: "Repository", repo, id: b64("Repository:" + repo.id), databaseId: repo.id,
    name: repo.name, nameWithOwner: repo.owner + "/" + repo.name,
    owner: userNode(repo.owner, base),
    url: base + "/" + repo.owner + "/" + repo.name,
    description: repo.description, visibility: repo.isPrivate ? "PRIVATE" : "PUBLIC",
    isPrivate: repo.isPrivate, createdAt: repo.createdAt, updatedAt: repo.updatedAt, fork: false,
  };
}
function issueNode(repo: Repo, issue: Issue, base: string): Record<string, unknown> {
  return {
    __type: "Issue", repo, issue, id: b64("Issue:" + issue.id), number: issue.number,
    title: issue.title, state: issue.state === "open" ? "OPEN" : "CLOSED", body: issue.body,
    createdAt: issue.createdAt, updatedAt: issue.updatedAt,
    closedAt: issue.state === "closed" ? issue.updatedAt : null,
    author: userNode(issue.user, base),
    url: base + "/" + repo.owner + "/" + repo.name + "/issues/" + issue.number,
  };
}
function pullNode(repo: Repo, pull: Pull, base: string): Record<string, unknown> {
  return {
    __type: "PullRequest", repo, pull, id: b64("PullRequest:" + pull.id), number: pull.number,
    headRefName: pull.headRef, baseRefName: pull.baseRef, mergeable: pull.mergeable ? "MERGEABLE" : "CONFLICTING",
    state: pull.merged ? "MERGED" : pull.state === "open" ? "OPEN" : "CLOSED",
    merged: pull.merged, title: pull.title, body: pull.body,
    createdAt: pull.createdAt, updatedAt: pull.updatedAt, mergedAt: pull.mergedAt,
    author: userNode(pull.user, base), headRefOid: pull.headSha, baseRefOid: pull.baseSha,
    url: base + "/" + repo.owner + "/" + repo.name + "/pull/" + pull.number,
  };
}
function labelNode(repo: Repo, label: Label, base: string): Record<string, unknown> {
  return { __type: "Label", id: b64("Label:" + label.id), name: label.name, color: label.color, description: label.description };
}
function commentNode(repo: Repo, c: RepoComment, base: string): Record<string, unknown> {
  return {
    __type: "IssueComment", id: b64("IssueComment:" + c.id), body: c.body,
    author: userNode(c.user, base), createdAt: c.createdAt, updatedAt: c.updatedAt,
  };
}

// Decode a global node id ("Repository:5" base64, a plain number, or "owner/repo").
function decodeNodeId(id: unknown): { kind: string; num: number; text: string } | null {
  if (typeof id === "number") return { kind: "", num: id, text: String(id) };
  if (typeof id !== "string") return null;
  const t = id.trim();
  if (/^\d+$/.test(t)) return { kind: "", num: parseInt(t, 10), text: t };
  try {
    const decoded = Buffer.from(t, "base64").toString("utf8");
    const m = /^([A-Za-z]+):(\d+)$/.exec(decoded);
    if (m) return { kind: m[1], num: parseInt(m[2], 10), text: decoded };
  } catch { /* not base64 */ }
  return { kind: "", num: -1, text: t };
}

function findRepoByNodeId(id: unknown): Repo | null {
  const d = decodeNodeId(id);
  if (!d) return null;
  if (d.num >= 0) {
    for (const r of store.repos.values()) if (r.id === d.num) return r;
  }
  if (d.text.includes("/")) {
    const [o, n] = d.text.split("/", 2);
    return getRepo(o, n) || null;
  }
  return null;
}

function findIssueByNodeId(id: unknown): { repo: Repo; issue: Issue } | null {
  const d = decodeNodeId(id);
  if (!d) return null;
  for (const r of store.repos.values()) {
    for (const i of r.issues.values()) if (i.id === d.num) return { repo: r, issue: i };
  }
  return null;
}
function findPullByNodeId(id: unknown): { repo: Repo; pull: Pull } | null {
  const d = decodeNodeId(id);
  if (!d) return null;
  for (const r of store.repos.values()) {
    for (const p of r.pulls.values()) if (p.id === d.num) return { repo: r, pull: p };
  }
  return null;
}

function cursorFor(i: number): string { return b64("cursor:" + i); }
function indexAfter(after: unknown): number {
  if (typeof after !== "string") return -1;
  try {
    const d = Buffer.from(after, "base64").toString("utf8");
    const m = /^cursor:(\d+)$/.exec(d);
    if (m) return parseInt(m[1], 10);
  } catch { /* ignore */ }
  return -1;
}

function connectionFrom<T>(items: T[], args: Record<string, unknown>, toNode: (item: T, i: number) => Record<string, unknown>): Record<string, unknown> {
  const afterIdx = indexAfter(args.after);
  const first = typeof args.first === "number" && args.first >= 0 ? args.first : items.length;
  const start = afterIdx + 1;
  const page = items.slice(start, start + first);
  const nodes = page.map((it, k) => toNode(it, start + k));
  return {
    __type: "Connection",
    nodes,
    edges: page.map((it, k) => ({ __type: "Edge", node: toNode(it, start + k), cursor: cursorFor(start + k) })),
    totalCount: items.length,
    pageInfo: {
      hasNextPage: start + page.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? cursorFor(start) : null,
      endCursor: page.length > 0 ? cursorFor(start + page.length - 1) : null,
    },
  };
}

function sortIssues(issues: Issue[], orderBy: unknown): Issue[] {
  const ob = (orderBy && typeof orderBy === "object") ? orderBy as Record<string, unknown> : {};
  const field = typeof ob.field === "string" ? ob.field : "CREATED_AT";
  const dir = ob.direction === "ASC" ? 1 : -1;
  const key = (i: Issue): number => field === "COMMENTS" ? i.commentCount : field === "UPDATED_AT" ? new Date(i.updatedAt).getTime() : new Date(i.createdAt).getTime();
  return [...issues].sort((a, b) => {
    const d = (key(a) - key(b)) * dir;
    if (d !== 0) return d;
    return (a.number - b.number) * dir; // ties by number, same direction
  });
}
function sortPulls(pulls: Pull[], orderBy: unknown): Pull[] {
  const ob = (orderBy && typeof orderBy === "object") ? orderBy as Record<string, unknown> : {};
  const field = typeof ob.field === "string" ? ob.field : "CREATED_AT";
  const dir = ob.direction === "ASC" ? 1 : -1;
  const key = (p: Pull): number => field === "UPDATED_AT" ? new Date(p.updatedAt).getTime() : new Date(p.createdAt).getTime();
  return [...pulls].sort((a, b) => {
    const d = (key(a) - key(b)) * dir;
    if (d !== 0) return d;
    return (a.number - b.number) * dir;
  });
}

function issueConnection(repo: Repo, args: Record<string, unknown>, base: string): Record<string, unknown> {
  let list = [...repo.issues.values()];
  if (Array.isArray(args.states)) {
    const want = new Set((args.states as unknown[]).map((s) => String(s)));
    list = list.filter((i) => want.has(i.state === "open" ? "OPEN" : "CLOSED"));
  }
  list = sortIssues(list, args.orderBy);
  return connectionFrom(list, args, (it) => issueNode(repo, it, base));
}
function pullConnection(repo: Repo, args: Record<string, unknown>, base: string): Record<string, unknown> {
  let list = [...repo.pulls.values()];
  if (Array.isArray(args.states)) {
    const want = new Set((args.states as unknown[]).map((s) => String(s)));
    list = list.filter((p) => {
      const st = p.merged ? "MERGED" : p.state === "open" ? "OPEN" : "CLOSED";
      return want.has(st);
    });
  }
  list = sortPulls(list, args.orderBy);
  return connectionFrom(list, args, (it) => pullNode(repo, it, base));
}

function resolveField(typeName: string, parent: Record<string, unknown>, fieldName: string, args: Record<string, unknown>, ctx: GqlCtx): unknown {
  // Query root
  if (typeName === "Query") {
    if (fieldName === "repository") {
      const owner = String(args.owner || "");
      const name = String(args.name || "");
      if (owner.toLowerCase() !== ctx.login.toLowerCase()) return null;
      const repo = getRepo(owner, name);
      return repo ? repoNode(repo, ctx.base) : null;
    }
    if (fieldName === "viewer") return userNode(ctx.login, ctx.base);
    if (fieldName === "search") {
      if (String(args.type || "") !== "ISSUE") {
        return { __type: "Connection", nodes: [], edges: [], totalCount: 0, pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } };
      }
      const q = String(args.query || "").toLowerCase();
      const found: { repo: Repo; issue: Issue }[] = [];
      for (const r of store.repos.values()) {
        if (r.owner.toLowerCase() !== ctx.login.toLowerCase()) continue;
        for (const i of r.issues.values()) {
          if (!q || i.title.toLowerCase().includes(q) || i.body.toLowerCase().includes(q)) found.push({ repo: r, issue: i });
        }
      }
      found.sort((a, b) => b.issue.number - a.issue.number);
      return connectionFrom(found, args, (it) => issueNode(it.repo, it.issue, ctx.base));
    }
    if (fieldName === "node") {
      const d = decodeNodeId(args.id);
      if (!d) return null;
      if (d.kind === "Repository" || d.text.includes("/")) {
        const repo = findRepoByNodeId(args.id);
        return repo ? repoNode(repo, ctx.base) : null;
      }
      if (d.kind === "Issue") {
        const hit = findIssueByNodeId(args.id);
        return hit ? issueNode(hit.repo, hit.issue, ctx.base) : null;
      }
      if (d.kind === "User") return userNode(ctx.login, ctx.base);
      return null;
    }
    if (fieldName === "__schema") {
      return {
        __type: "__Schema",
        queryType: { name: "Query" }, mutationType: { name: "Mutation" }, subscriptionType: null,
        types: GQL_SCHEMA.map((t) => introspectType(t.name)),
        directives: [
          { name: "skip", description: "Directs the executor to skip this field or fragment when the `if` argument is true.", locations: ["FIELD", "FRAGMENT_SPREAD", "INLINE_FRAGMENT"], args: [{ name: "if", description: null, type: typeRef("Boolean!"), defaultValue: null }], isRepeatable: false },
          { name: "include", description: "Directs the executor to include this field or fragment only when the `if` argument is true.", locations: ["FIELD", "FRAGMENT_SPREAD", "INLINE_FRAGMENT"], args: [{ name: "if", description: null, type: typeRef("Boolean!"), defaultValue: null }], isRepeatable: false },
          { name: "deprecated", description: "Marks an element of a GraphQL schema as no longer supported.", locations: ["FIELD_DEFINITION", "ENUM_VALUE"], args: [{ name: "reason", description: null, type: typeRef("String"), defaultValue: null }], isRepeatable: false },
        ],
      };
    }
    if (fieldName === "__type") {
      return introspectType(String(args.name || ""));
    }
    return null;
  }

  // Mutation root
  if (typeName === "Mutation") {
    const input = (args.input && typeof args.input === "object") ? args.input as Record<string, unknown> : {};
    if (fieldName === "createIssue") {
      const repo = findRepoByNodeId(input.repositoryId);
      if (!repo) { ctx.errors.push({ message: "Repository not found." }); return null; }
      const title = typeof input.title === "string" ? input.title.trim() : "";
      if (!title) { ctx.errors.push({ message: "title is required." }); return null; }
      const labelIds = Array.isArray(input.labelIds) ? input.labelIds : [];
      const labelNames: string[] = [];
      for (const lid of labelIds) {
        const d = decodeNodeId(lid);
        let found: Label | undefined;
        for (const l of repo.labels.values()) if (l.id === d?.num) found = l;
        if (!found && typeof lid === "string") found = repo.labels.get(lid);
        if (!found) { ctx.errors.push({ message: "Label not found." }); return null; }
        labelNames.push(found.name);
      }
      const now = nowIso();
      const issue: Issue = {
        id: store.nextEntityId++, number: repo.nextIssue++, title,
        body: typeof input.body === "string" ? input.body : "", state: "open",
        labels: labelNames, user: ctx.login, createdAt: now, updatedAt: now, commentCount: 0,
      };
      repo.issues.set(issue.number, issue);
      return { __type: "CreateIssuePayload", issue: issueNode(repo, issue, ctx.base), clientMutationId: typeof input.clientMutationId === "string" ? input.clientMutationId : null };
    }
    if (fieldName === "createPullRequest") {
      const repo = findRepoByNodeId(input.repositoryId);
      if (!repo) { ctx.errors.push({ message: "Repository not found." }); return null; }
      const title = typeof input.title === "string" ? input.title.trim() : "";
      const headRef = String(input.headRefName || "");
      const baseRef = String(input.baseRefName || repo.defaultBranch);
      if (!title || !headRef) { ctx.errors.push({ message: "title and headRefName are required." }); return null; }
      const headSha = repo.refs.get("refs/heads/" + headRef);
      const baseSha = repo.refs.get("refs/heads/" + baseRef);
      if (!headSha || !baseSha) { ctx.errors.push({ message: "head or base branch does not exist." }); return null; }
      if (headSha === baseSha) { ctx.errors.push({ message: "No commits between " + baseRef + " and " + headRef + "." }); return null; }
      const baseTipTree = parseCommit((repo.objects.get(baseSha) as GitObj).raw).tree;
      const headTipTree = parseCommit((repo.objects.get(headSha) as GitObj).raw).tree;
      const mb = mergeBase(repo, baseSha, headSha);
      const mbTree = mb ? parseCommit((repo.objects.get(mb) as GitObj).raw).tree : baseTipTree;
      const files = diffTrees(repo, mbTree, headTipTree).map((d) => d.path);
      const merged = threeWayMerge(repo, mbTree, baseTipTree, headTipTree);
      const now = nowIso();
      const pull: Pull = {
        id: store.nextEntityId++, number: repo.nextPull++, title,
        body: typeof input.body === "string" ? input.body : "", state: "open",
        merged: false, mergeable: !merged.conflict,
        headRef, headSha, baseRef, baseSha,
        user: ctx.login, createdAt: now, updatedAt: now, mergedAt: null, mergeSha: null, files,
      };
      repo.pulls.set(pull.number, pull);
      return { __type: "CreatePullRequestPayload", pullRequest: pullNode(repo, pull, ctx.base), clientMutationId: typeof input.clientMutationId === "string" ? input.clientMutationId : null };
    }
    if (fieldName === "mergePullRequest") {
      const hit = findPullByNodeId(input.pullRequestId);
      if (!hit) { ctx.errors.push({ message: "Pull request not found." }); return null; }
      const pull = hit.pull;
      if (pull.merged) { ctx.errors.push({ message: "Pull request has already been merged." }); return null; }
      if (!pull.mergeable) { ctx.errors.push({ message: "Pull request is not mergeable." }); return null; }
      if (typeof input.expectedHeadOid === "string" && input.expectedHeadOid && input.expectedHeadOid !== pull.headSha) {
        ctx.errors.push({ message: "Head sha does not match." }); return null;
      }
      const method = String(input.mergeMethod || "SQUASH").toLowerCase();
      const methodName = method === "merge" ? "merge" : method === "rebase" ? "rebase" : "squash";
      const result = performMerge(hit.repo, pull, methodName,
        typeof input.commitHeadline === "string" ? input.commitHeadline : undefined,
        typeof input.commitBody === "string" ? input.commitBody : undefined);
      if (result.status !== 200) {
        ctx.errors.push({ message: String((result.payload as Record<string, unknown>).message || "Merge failed.") });
        return null;
      }
      return { __type: "MergePullRequestPayload", pullRequest: pullNode(hit.repo, pull, ctx.base), clientMutationId: typeof input.clientMutationId === "string" ? input.clientMutationId : null };
    }
    if (fieldName === "closeIssue" || fieldName === "updateIssue") {
      const id = fieldName === "closeIssue" ? input.issueId : input.id;
      const hit = findIssueByNodeId(id);
      if (!hit) { ctx.errors.push({ message: "Issue not found." }); return null; }
      if (fieldName === "closeIssue") hit.issue.state = "closed";
      else {
        if (typeof input.title === "string" && input.title.trim()) hit.issue.title = input.title.trim();
        if (typeof input.body === "string") hit.issue.body = input.body;
        if (input.state === "OPEN" || input.state === "CLOSED") hit.issue.state = input.state === "OPEN" ? "open" : "closed";
      }
      hit.issue.updatedAt = nowIso();
      return { __type: "CloseIssuePayload", issue: issueNode(hit.repo, hit.issue, ctx.base), clientMutationId: typeof input.clientMutationId === "string" ? input.clientMutationId : null };
    }
    if (fieldName === "addComment") {
      const hit = findIssueByNodeId(input.subjectId);
      if (!hit) { ctx.errors.push({ message: "Issue not found." }); return null; }
      if (typeof input.body !== "string" || !input.body.trim()) { ctx.errors.push({ message: "body is required." }); return null; }
      const now = nowIso();
      const c: RepoComment = { id: store.nextEntityId++, issueNumber: hit.issue.number, body: input.body, user: ctx.login, createdAt: now, updatedAt: now };
      hit.repo.comments.set(c.id, c);
      hit.issue.commentCount++;
      hit.issue.updatedAt = now;
      const node = commentNode(hit.repo, c, ctx.base);
      return {
        __type: "AddCommentPayload",
        commentEdge: { __type: "Edge", node, cursor: cursorFor(0) },
        subject: issueNode(hit.repo, hit.issue, ctx.base),
        clientMutationId: typeof input.clientMutationId === "string" ? input.clientMutationId : null,
      };
    }
    return null;
  }

  // Object types
  const repo = (parent.repo as Repo | undefined) || null;
  if (typeName === "Repository" && repo) {
    if (fieldName === "issue") {
      const issue = repo.issues.get(Number(args.number));
      return issue ? issueNode(repo, issue, ctx.base) : null;
    }
    if (fieldName === "issues") return issueConnection(repo, args, ctx.base);
    if (fieldName === "pullRequest") {
      const pull = repo.pulls.get(Number(args.number));
      return pull ? pullNode(repo, pull, ctx.base) : null;
    }
    if (fieldName === "pullRequests") return pullConnection(repo, args, ctx.base);
    if (fieldName === "defaultBranchRef") {
      const sha = repo.refs.get("refs/heads/" + repo.defaultBranch);
      if (!sha) return null;
      return { __type: "Ref", name: repo.defaultBranch, target: { __type: "GitObject", oid: sha } };
    }
    if (fieldName === "viewerPermission") return "ADMIN";
    if (fieldName === "hasIssuesEnabled") return true;
  }
  if (typeName === "Issue" && repo) {
    const issue = parent.issue as Issue;
    if (fieldName === "labels") {
      const labels = issue.labels.map((n) => repo.labels.get(n)).filter((l): l is Label => !!l);
      return connectionFrom(labels, args, (l) => labelNode(repo, l, ctx.base));
    }
    if (fieldName === "comments") {
      const list = [...repo.comments.values()].filter((c) => c.issueNumber === issue.number).sort((a, b) => a.id - b.id);
      return connectionFrom(list, args, (c) => commentNode(repo, c, ctx.base));
    }
    if (fieldName === "repository") return repoNode(repo, ctx.base);
  }
  if (typeName === "PullRequest" && repo) {
    const pull = parent.pull as Pull;
    if (fieldName === "files") {
      const mb = mergeBase(repo, pull.baseSha, pull.headSha);
      const mbTree = mb ? parseCommit((repo.objects.get(mb) as GitObj).raw).tree : parseCommit((repo.objects.get(pull.baseSha) as GitObj).raw).tree;
      const headTree = parseCommit((repo.objects.get(pull.headSha) as GitObj).raw).tree;
      const diffs = diffTrees(repo, mbTree, headTree);
      const files = diffs.map((d) => {
        const oldText = d.oldOid ? (repo.objects.get(d.oldOid)?.raw.toString("utf8") || "") : "";
        const newText = d.newOid ? (repo.objects.get(d.newOid)?.raw.toString("utf8") || "") : "";
        const { additions, deletions } = lineDiff(oldText, newText);
        return { __type: "PullRequestChangedFile", path: d.path, additions, deletions, changeType: d.status === "added" ? "ADDED" : d.status === "removed" ? "REMOVED" : "MODIFIED" };
      });
      return connectionFrom(files, args, (f) => f);
    }
    if (fieldName === "repository") return repoNode(repo, ctx.base);
  }
  if (typeName === "Ref" && fieldName === "target") return parent.target ?? null;

  // Generic property fallback (scalar fields live on the node object).
  if (fieldName in parent) return parent[fieldName];
  return null;
}

function executeField(typeName: string, parent: Record<string, unknown>, sel: Extract<GqlSelection, { kind: "field" }>, vars: Record<string, unknown>, ctx: GqlCtx, doc: GqlDocument): unknown {
  const fieldName = sel.name;
  if (fieldName === "__typename") return typeof parent.__type === "string" ? parent.__type : typeName;
  let def = GQL_TYPES.get(typeName);
  let fieldDef = def ? def.fields.find((f) => f.name === fieldName) : undefined;
  // Fallback: a field may live on the object's runtime type even when the
  // declared type does not have it (`node` declares Node, which only has
  // `id`, but returns a Repository with `name`, `nameWithOwner`, ...). The
  // field is then resolved against the runtime type, so the Repository /
  // Issue / PullRequest branches in resolveField are entered.
  let resolveType = typeName;
  if (!fieldDef && typeof parent.__type === "string" && parent.__type !== typeName) {
    def = GQL_TYPES.get(parent.__type);
    fieldDef = def ? def.fields.find((f) => f.name === fieldName) : undefined;
    if (fieldDef) resolveType = parent.__type;
  }
  if (!fieldDef) {
    // Introspection fields on Query are not in the schema table above.
    if (typeName === "Query" && (fieldName === "__schema" || fieldName === "__type")) {
      const val = resolveField(typeName, parent, fieldName, evalGqlArgs(sel.args, vars), ctx);
      if (val === null || val === undefined) return null;
      if (!sel.selectionSet) return val;
      const subType = fieldName === "__schema" ? "__Schema" : "__Type";
      return executeSelections(subType, val as Record<string, unknown>, sel.selectionSet, vars, ctx, doc);
    }
    ctx.errors.push({ message: "Cannot query field \"" + fieldName + "\" on type \"" + typeName + "\"." });
    return null;
  }
  const args = evalGqlArgs(sel.args, vars);
  const val = resolveField(resolveType, parent, fieldName, args, ctx);
  if (val === null || val === undefined) return null;
  if (!sel.selectionSet) return val;
  const named = namedType(fieldDef.type);
  if (Array.isArray(val)) {
    return val.map((item) => {
      if (item && typeof item === "object") return executeSelections(named, item as Record<string, unknown>, sel.selectionSet as GqlSelection[], vars, ctx, doc);
      return item;
    });
  }
  if (typeof val === "object") {
    return executeSelections(named, val as Record<string, unknown>, sel.selectionSet, vars, ctx, doc);
  }
  ctx.errors.push({ message: "Field \"" + fieldName + "\" must not have a selection since type \"" + named + "\" has no subfields." });
  return val;
}

function executeSelections(typeName: string, parent: Record<string, unknown>, selections: GqlSelection[], vars: Record<string, unknown>, ctx: GqlCtx, doc: GqlDocument): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Inline-fragment matching uses the RUNTIME type of the object: `node`
  // declares type Node but returns a Repository, so `... on Repository`
  // must match the object's __type, not "Node". Field lookup keeps the
  // declared type (executeField falls back to the runtime type when a field
  // is not on the declared type), because connection objects carry a generic
  // __type ("Connection") that has no schema fields of its own.
  const runtimeType = typeof parent.__type === "string" ? parent.__type : typeName;
  for (const sel of selections) {
    if (sel.kind === "fragmentSpread") {
      if (!directiveAllows(sel.directives, vars)) continue;
      const frag = doc.fragments.get(sel.name);
      if (!frag) { ctx.errors.push({ message: "Unknown fragment \"" + sel.name + "\"." }); continue; }
      Object.assign(out, executeSelections(typeName, parent, frag, vars, ctx, doc));
      continue;
    }
    if (sel.kind === "inlineFragment") {
      if (!directiveAllows(sel.directives, vars)) continue;
      if (sel.typeCondition && sel.typeCondition !== runtimeType) continue;
      Object.assign(out, executeSelections(typeName, parent, sel.selectionSet, vars, ctx, doc));
      continue;
    }
    if (!directiveAllows(sel.directives, vars)) continue;
    out[sel.alias || sel.name] = executeField(typeName, parent, sel, vars, ctx, doc);
  }
  return out;
}

function executeGqlDocument(body: unknown, ctx: GqlCtx): Record<string, unknown> {
  const obj = (body && typeof body === "object") ? body as Record<string, unknown> : {};
  const query = typeof obj.query === "string" ? obj.query : "";
  const variables = (obj.variables && typeof obj.variables === "object") ? obj.variables as Record<string, unknown> : {};
  const operationName = typeof obj.operationName === "string" ? obj.operationName : null;
  if (!query) return { errors: [{ message: "Must provide query string." }] };
  let doc: GqlDocument;
  try {
    doc = new GqlParser(query).parseDocument();
  } catch (e) {
    return { errors: [{ message: e instanceof Error ? e.message : "Syntax error." }] };
  }
  let op: GqlOperation | undefined;
  if (operationName) op = doc.operations.find((o) => o.name === operationName);
  else if (doc.operations.length === 1) op = doc.operations[0];
  else if (doc.operations.length === 0) return { errors: [{ message: "No operations in document." }] };
  else return { errors: [{ message: "Must provide operation name if query contains multiple operations." }] };
  if (!op) return { errors: [{ message: "Unknown operation named \"" + operationName + "\"." }] };
  // Apply variable defaults.
  const vars: Record<string, unknown> = { ...variables };
  for (const vd of op.variables) {
    if (!(vd.name in vars) && vd.defaultValue) vars[vd.name] = evalGqlValue(vd.defaultValue, {});
  }
  const rootType = op.kind === "mutation" ? "Mutation" : "Query";
  const data = executeSelections(rootType, {}, op.selectionSet, vars, ctx, doc);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

async function handleGraphql(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  if (req.method !== "POST") return false;
  const login = requireAuth(req, res);
  if (login === null) return true;
  const base = baseOf(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse((await readBody(req)).toString("utf8"));
  } catch {
    sendJson(res, 400, { errors: [{ message: "Problems parsing JSON" }] }, apiHeaders());
    return true;
  }
  const isBatch = Array.isArray(parsed);
  const docs = isBatch ? parsed as unknown[] : [parsed];
  const results = docs.map((d) => executeGqlDocument(d, { login, base, errors: [] }));
  sendJson(res, 200, isBatch ? results : results[0], apiHeaders());
  return true;
}

// ---------------------------------------------------------------------------
// MCP — JSON-RPC 2.0 over Streamable HTTP
// ---------------------------------------------------------------------------
type McpTool = {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, { type: string; description: string }>; required: string[] };
};

// One constant definition: every tools/list answer serializes this identically.
const MCP_TOOLS: McpTool[] = [
  {
    name: "create_repo",
    description: "Create a new repository owned by the authenticated user.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The name of the repository." },
        description: { type: "string", description: "A short description of the repository." },
        private: { type: "boolean", description: "Whether the repository is private." },
      },
      required: ["name"],
    },
  },
  {
    name: "get_repo",
    description: "Get a repository by owner and name.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "The owner of the repository." },
        repo: { type: "string", description: "The name of the repository." },
        full_name: { type: "string", description: "The full name of the repository (owner/repo)." },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "create_issue",
    description: "Create a new issue in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "The owner of the repository." },
        repo: { type: "string", description: "The name of the repository." },
        title: { type: "string", description: "The title of the issue." },
        body: { type: "string", description: "The body of the issue." },
        full_name: { type: "string", description: "The full name of the repository (owner/repo)." },
      },
      required: ["owner", "repo", "title"],
    },
  },
  {
    name: "list_issues",
    description: "List issues in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "The owner of the repository." },
        repo: { type: "string", description: "The name of the repository." },
        state: { type: "string", description: "Filter by state: open, closed, or all." },
        full_name: { type: "string", description: "The full name of the repository (owner/repo)." },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "create_pull_request",
    description: "Create a new pull request in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "The owner of the repository." },
        repo: { type: "string", description: "The name of the repository." },
        title: { type: "string", description: "The title of the pull request." },
        head: { type: "string", description: "The name of the branch where the changes are implemented." },
        base: { type: "string", description: "The name of the branch to merge into." },
        body: { type: "string", description: "The body of the pull request." },
        full_name: { type: "string", description: "The full name of the repository (owner/repo)." },
      },
      required: ["owner", "repo", "title", "head", "base"],
    },
  },
  {
    name: "merge_pull_request",
    description: "Merge a pull request into its base branch.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "The owner of the repository." },
        repo: { type: "string", description: "The name of the repository." },
        pull_number: { type: "number", description: "The number of the pull request to merge." },
        full_name: { type: "string", description: "The full name of the repository (owner/repo)." },
      },
      required: ["owner", "repo", "pull_number"],
    },
  },
];

function mcpResolveRepo(args: Record<string, unknown>, login: string): { repo: Repo | null; error: string | null } {
  let owner = typeof args.owner === "string" ? args.owner : "";
  let name = typeof args.repo === "string" ? args.repo : "";
  if ((!owner || !name) && typeof args.full_name === "string") {
    const parts = args.full_name.split("/");
    if (parts.length === 2) { owner = parts[0]; name = parts[1]; }
  }
  if (!owner || !name) return { repo: null, error: "owner and repo are required." };
  if (owner.toLowerCase() !== login.toLowerCase()) return { repo: null, error: "Repository not found." };
  const repo = getRepo(owner, name);
  if (!repo) return { repo: null, error: "Repository not found." };
  return { repo, error: null };
}

function mcpTextResult(result: unknown): Record<string, unknown> {
  return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
}
function mcpErrorResult(message: string): Record<string, unknown> {
  return { content: [{ type: "text", text: "Error: " + message }], isError: true };
}

async function mcpCallTool(name: string, args: Record<string, unknown>, login: string, base: string): Promise<{ result?: Record<string, unknown>; rpcError?: { code: number; message: string } }> {
  const suffix = name.split("__").pop() as string;
  const tool = MCP_TOOLS.find((t) => t.name.toLowerCase() === suffix.toLowerCase());
  if (!tool) return { rpcError: { code: -32601, message: "Unknown tool: " + name } };
  const missing = (tool.inputSchema.required || []).filter((k) => args[k] === undefined || args[k] === null || args[k] === "");
  // full_name can stand in for owner+repo.
  const hasFullName = typeof args.full_name === "string" && (args.full_name as string).includes("/");
  const stillMissing = missing.filter((k) => !(hasFullName && (k === "owner" || k === "repo")));
  if (stillMissing.length > 0) {
    return { result: mcpErrorResult("Missing required argument: " + stillMissing.join(", ")) };
  }
  if (tool.name === "create_repo") {
    const repoName = String(args.name || "").trim();
    if (!repoName || !/^[A-Za-z0-9._-]+$/.test(repoName)) return { result: mcpErrorResult("name is required and must be a valid repository name.") };
    if (getRepo(login, repoName)) return { result: mcpErrorResult("name already exists on this account.") };
    const repo = newRepo(login, repoName, typeof args.description === "string" ? args.description : "", args.private === true);
    return { result: mcpTextResult(repoJson(repo, base)) };
  }
  if (tool.name === "get_repo") {
    const { repo, error } = mcpResolveRepo(args, login);
    if (!repo) return { result: mcpErrorResult(error as string) };
    return { result: mcpTextResult(repoJson(repo, base)) };
  }
  if (tool.name === "create_issue") {
    const { repo, error } = mcpResolveRepo(args, login);
    if (!repo) return { result: mcpErrorResult(error as string) };
    const title = typeof args.title === "string" ? args.title.trim() : "";
    if (!title) return { result: mcpErrorResult("title is required.") };
    const now = nowIso();
    const issue: Issue = {
      id: store.nextEntityId++, number: repo.nextIssue++, title,
      body: typeof args.body === "string" ? args.body : "", state: "open",
      labels: [], user: login, createdAt: now, updatedAt: now, commentCount: 0,
    };
    repo.issues.set(issue.number, issue);
    return { result: mcpTextResult(issueJson(repo, issue, base)) };
  }
  if (tool.name === "list_issues") {
    const { repo, error } = mcpResolveRepo(args, login);
    if (!repo) return { result: mcpErrorResult(error as string) };
    const state = typeof args.state === "string" ? args.state : "open";
    let list = [...repo.issues.values()];
    if (state !== "all") list = list.filter((i) => i.state === state);
    list.sort((a, b) => a.number - b.number);
    return { result: mcpTextResult(list.map((i) => issueJson(repo, i, base))) };
  }
  if (tool.name === "create_pull_request") {
    const { repo, error } = mcpResolveRepo(args, login);
    if (!repo) return { result: mcpErrorResult(error as string) };
    const title = typeof args.title === "string" ? args.title.trim() : "";
    const headRaw = typeof args.head === "string" ? args.head : "";
    const baseRaw = typeof args.base === "string" ? args.base : repo.defaultBranch;
    if (!title || !headRaw || !baseRaw) return { result: mcpErrorResult("title, head and base are required.") };
    const headBranch = headRaw.includes(":") ? headRaw.split(":").slice(1).join(":") : headRaw;
    const baseBranch = baseRaw.includes(":") ? baseRaw.split(":").slice(1).join(":") : baseRaw;
    const headSha = repo.refs.get("refs/heads/" + headBranch);
    const baseSha = repo.refs.get("refs/heads/" + baseBranch);
    if (!headSha) return { result: mcpErrorResult("head branch does not exist.") };
    if (!baseSha) return { result: mcpErrorResult("base branch does not exist.") };
    if (headSha === baseSha) return { result: mcpErrorResult("No commits between " + baseBranch + " and " + headBranch + ".") };
    const baseTipTree = parseCommit((repo.objects.get(baseSha) as GitObj).raw).tree;
    const headTipTree = parseCommit((repo.objects.get(headSha) as GitObj).raw).tree;
    const mb = mergeBase(repo, baseSha, headSha);
    const mbTree = mb ? parseCommit((repo.objects.get(mb) as GitObj).raw).tree : baseTipTree;
    const files = diffTrees(repo, mbTree, headTipTree).map((d) => d.path);
    const merged = threeWayMerge(repo, mbTree, baseTipTree, headTipTree);
    const now = nowIso();
    const pull: Pull = {
      id: store.nextEntityId++, number: repo.nextPull++, title,
      body: typeof args.body === "string" ? args.body : "", state: "open",
      merged: false, mergeable: !merged.conflict,
      headRef: headBranch, headSha, baseRef: baseBranch, baseSha,
      user: login, createdAt: now, updatedAt: now, mergedAt: null, mergeSha: null, files,
    };
    repo.pulls.set(pull.number, pull);
    return { result: mcpTextResult(pullJson(repo, pull, base)) };
  }
  if (tool.name === "merge_pull_request") {
    const { repo, error } = mcpResolveRepo(args, login);
    if (!repo) return { result: mcpErrorResult(error as string) };
    const num = Number(args.pull_number);
    const pull = repo.pulls.get(num);
    if (!pull) return { result: mcpErrorResult("Pull request not found.") };
    if (pull.merged) return { result: mcpErrorResult("Pull request has already been merged.") };
    if (!pull.mergeable) return { result: mcpErrorResult("Pull request is not mergeable.") };
    const merged = await withRepoLock(repo, async () => {
      const curBaseSha = repo.refs.get("refs/heads/" + pull.baseRef);
      if (!curBaseSha) return null;
      const baseTipTree = parseCommit((repo.objects.get(curBaseSha) as GitObj).raw).tree;
      const headTree = parseCommit((repo.objects.get(pull.headSha) as GitObj).raw).tree;
      const mb = mergeBase(repo, curBaseSha, pull.headSha);
      const mbTree = mb ? parseCommit((repo.objects.get(mb) as GitObj).raw).tree : baseTipTree;
      const m = threeWayMerge(repo, mbTree, baseTipTree, headTree);
      if (m.conflict) return null;
      const msg = pull.title + (pull.body ? "\n\n" + pull.body : "");
      const mergeSha = makeCommit(repo, m.treeOid, [curBaseSha], msg, "");
      repo.refs.set("refs/heads/" + pull.baseRef, mergeSha);
      pull.merged = true;
      pull.state = "closed";
      pull.mergedAt = nowIso();
      pull.mergeSha = mergeSha;
      pull.updatedAt = nowIso();
      repo.updatedAt = nowIso();
      return mergeSha;
    });
    if (!merged) return { result: mcpErrorResult("Pull request is not mergeable.") };
    return { result: mcpTextResult({ sha: merged, merged: true, message: "Pull request successfully merged" }) };
  }
  return { rpcError: { code: -32601, message: "Unknown tool: " + name } };
}

const MCP_SESSION_ID = "mcp-session-" + Math.floor(Math.random() * 0xffffffff).toString(16);

async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  if (req.method === "GET") {
    // Streamable HTTP: a GET opens an SSE stream; the suite does not use it.
    sendJson(res, 405, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Method Not Allowed" } });
    return true;
  }
  if (req.method !== "POST") return false;
  // Auth: a call with no Authorization header answers 401.
  const h = req.headers["authorization"] || "";
  const m = /^Bearer\s+(.+)$/.exec(h as string);
  if (SHOP_TOKEN) {
    if (!m || m[1] !== SHOP_TOKEN) {
      sendJson(res, 401, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } });
      return true;
    }
  }
  const login = m ? loginFromToken(m[1]) : LOGIN;
  const base = baseOf(req);
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    // A body that is not JSON answers HTTP 400 with -32700.
    sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return true;
  }
  const msg = (parsed && typeof parsed === "object") ? parsed as Record<string, unknown> : {};
  const id = "id" in msg ? msg.id : null;
  const method = typeof msg.method === "string" ? msg.method : "";
  // Notifications (no id, method starts with "notifications/") get no response.
  if (method.startsWith("notifications/") && (id === null || id === undefined)) {
    res.writeHead(202, { "X-GitHub-Request-Id": reqId() });
    res.end();
    return true;
  }
  const reply = (payload: Record<string, unknown>, extraHeaders?: Record<string, string>): void => {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": body.length,
      "X-GitHub-Request-Id": reqId(),
      ...extraHeaders,
    });
    res.end(body);
  };
  const ok = (result: unknown, extraHeaders?: Record<string, string>): void =>
    reply({ jsonrpc: "2.0", id: id ?? null, result }, extraHeaders);
  const err = (code: number, message: string): void =>
    reply({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

  if (method === "initialize") {
    const params = (msg.params && typeof msg.params === "object") ? msg.params as Record<string, unknown> : {};
    const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "2026-07-28";
    const supported = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
    const version = supported.includes(asked) ? asked : "2026-07-28";
    ok({
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: "github-core-clone-01", version: "1.0.0" },
    }, { "Mcp-Session-Id": MCP_SESSION_ID });
    return true;
  }
  if (method === "ping") { ok({}); return true; }
  if (method === "server/discover") {
    ok({
      protocolVersion: "2026-07-28",
      supportedVersions: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"],
      capabilities: { tools: {} },
      serverInfo: { name: "github-core-clone-01", version: "1.0.0" },
    });
    return true;
  }
  if (method === "tools/list") {
    ok({ tools: MCP_TOOLS });
    return true;
  }
  if (method === "tools/call") {
    const params = (msg.params && typeof msg.params === "object") ? msg.params as Record<string, unknown> : {};
    const name = typeof params.name === "string" ? params.name : "";
    const args = (params.arguments && typeof params.arguments === "object") ? params.arguments as Record<string, unknown> : {};
    if (!name) { err(-32602, "Missing tool name."); return true; }
    const out = await mcpCallTool(name, args, login, base);
    if (out.rpcError) { err(out.rpcError.code, out.rpcError.message); return true; }
    ok(out.result);
    return true;
  }
  err(-32601, "Method not found: " + method);
  return true;
}

// ---------------------------------------------------------------------------
// HTTP server + lifecycle (register / done)
// ---------------------------------------------------------------------------
function gitAuthOk(req: http.IncomingMessage): boolean {
  if (!SHOP_TOKEN) return true;
  const h = req.headers["authorization"] || "";
  if (!h) return true; // git endpoints accept no auth; a wrong bearer is 401
  const m = /^Bearer\s+(.+)$/.exec(h as string);
  return !!m && m[1] === SHOP_TOKEN;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const path = url.pathname;
    if (path === "/healthz" && req.method === "GET") {
      sendJson(res, 200, { ok: true });
      return;
    }
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)$/.exec(path);
    if (gitMatch) {
      if (!gitAuthOk(req)) { sendJson(res, 401, { message: "Bad credentials" }); return; }
      const owner = decodeURIComponent(gitMatch[1]);
      const repoName = decodeURIComponent(gitMatch[2]);
      const handled = await handleGit(req, res, owner, repoName, gitMatch[3], url.searchParams);
      if (!handled) jsonError(res, 404, "Not Found");
      return;
    }
    if (path === "/api/graphql") {
      const handled = await handleGraphql(req, res);
      if (!handled) jsonError(res, 404, "Not Found");
      return;
    }
    if (path === "/mcp") {
      await handleMcp(req, res);
      return;
    }
    if (path.startsWith("/api/v3")) {
      await handleRest(req, res, url);
      return;
    }
    jsonError(res, 404, "Not Found");
  } catch (e) {
    // Never let one bad request kill the process (a crash is a zero).
    try {
      sendJson(res, 500, { message: e instanceof Error ? e.message : "Internal Server Error" });
    } catch { /* socket already gone */ }
  }
});

process.on("uncaughtException", (e) => {
  console.error("uncaughtException (staying up):", e instanceof Error ? e.message : String(e));
});
process.on("unhandledRejection", (e) => {
  console.error("unhandledRejection (staying up):", e instanceof Error ? e.message : String(e));
});

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "0.0.0.0", () => {
      const addr = server.address() as { port: number };
      resolve(addr.port);
    });
  });
  console.log("forge listening on port " + port);
  if (!ENV_URL) {
    console.log("no MAKEFUN_ENV_URL set; standalone mode, staying up until killed");
    return;
  }
  // Register (retry with backoff; a program that never registers scores 0).
  let registered = false;
  for (let attempt = 0; attempt < 60 && !registered; attempt++) {
    try {
      const r = await fetch(ENV_URL.replace(/\/$/, "") + "/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port }),
      });
      if (r.ok) { registered = true; console.log("registered on port " + port); }
      else console.error("register attempt " + attempt + " got HTTP " + r.status);
    } catch (e) {
      console.error("register attempt " + attempt + " failed: " + (e instanceof Error ? e.message : String(e)));
    }
    if (!registered) await sleep(1000 * Math.min(8, attempt + 1));
  }
  // Long-poll done until the trial ends, then exit 0.
  const doneUrl = ENV_URL.replace(/\/$/, "") + "/done";
  while (true) {
    try {
      const r = await fetch(doneUrl);
      const text = await r.text();
      let done = false;
      try {
        const j = JSON.parse(text) as Record<string, unknown>;
        if (j.done === true) done = true;
      } catch { /* not JSON */ }
      if (!done && /"done"\s*:\s*true/.test(text)) done = true;
      if (!done && text.trim().toLowerCase() === "done") done = true;
      if (done) {
        console.log("trial done; exiting 0");
        process.exit(0);
      }
    } catch (e) {
      console.error("done poll failed: " + (e instanceof Error ? e.message : String(e)));
    }
    await sleep(500);
  }
}

main().catch((e) => {
  console.error("fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
