---
name: architecture-to-code
description: Turn a markdown architecture doc or a diagram image into a Breakscale topology file (importable straight into the app) plus a runnable reference implementation of the system it describes. Use when the user hands you a written system design, an architecture doc, or a photo/screenshot of a diagram and wants a working example.
---

# Architecture to code

Breakscale (this repo) simulates the queueing behavior of a system a student
draws by hand. This skill goes the other direction: read a description of a
real (or imagined) system and produce two things from it — a topology the
simulator can load, and an actual runnable project implementing the same
shape.

Breakscale itself calls no network and holds no API key (see `SECURITY.md`);
this skill is why that's fine — the reading and writing happens here, in
Claude Code, not in the browser.

## 1. Read the input

- A `.md` file: read it as text.
- An image (`.png`/`.jpg`/`.webp`): read it directly with the `Read` tool,
  which renders it to you. Diagram conventions vary — read labels, arrow
  direction, and any legend before mapping shapes to components.

## 2. Analyze

Extract:

- Every named component and what it does.
- Every traffic path between components, and its direction.

Map each component to one of the 34 kinds in `NodeKind`
(`src/sim/types.ts:1`) — read that union rather than assuming it matches a
list you remember, since it can change. Real docs rarely use this project's
names for things ("Kafka", "Consul", "Stripe", not "streambroker",
"cache", "service") — `reference/vocabulary.md` is the lookup table from
common system-design and real-product terms to the kind that matches their
actual queueing behavior, and covers most of what shows up in a typical
architecture doc. Where a component still doesn't map cleanly (e.g. "the
write path" could be `queue` + `worker`, or a single `writebehind`), don't
silently pick one — carry the ambiguity into step 4. Where nothing fits at
all, even after checking the vocabulary reference, see the next step before
guessing.

Anything that only supervises other nodes rather than carrying requests
(an autoscaler watching a service, for instance) is a control relationship,
not a traffic path — see `SimEdge.control` in `src/sim/types.ts`.

## 3. When no existing kind fits

Most components that don't obviously match a kind still behave like one for
queueing purposes — `reference/vocabulary.md` covers the common cases
(external dependencies, service discovery, feature flags, and more) as an
approximation: closest existing kind, real name kept in the node's
`label` — free text, so nothing is lost. This covers the large majority of
"I don't see this in the list" cases, and matches the project's own bar for
a kind: `AGENTS.md` says a kind that behaves like another kind with
different defaults does not get added.

Only stop for a genuinely new `NodeKind` when a component's _simulation
behavior_ — a distinct failure mode or queueing shape, not just a different
name — would be misrepresented by every existing kind. This is rare, and
it's the one place in this skill serious enough to need an explicit
go-ahead of its own, separate from the topology draft confirmed in the next
step: adding a kind means editing `src/sim`, the app's pure simulation
core, which the project treats with real caution (`AGENTS.md`: "Never
modify `src/sim` to make a UI problem go away"). Explain in chat exactly
what behavior no existing kind captures, and wait for the user to say go
ahead before touching any code.

If they do, follow `AGENTS.md`'s "Adding a component" checklist (`NodeKind`
in `src/sim/types.ts`, config fields, a behaviour object, `defaultConfig`
entry and label, a `readoutFor` entry, a glossary entry, and a test proving
it behaves differently from every existing kind — step 7 is the bar). That
checklist has one gap worth knowing about: it doesn't mention `NODE_KINDS`
in `src/clipboard.ts`, a second, hand-maintained array (not derived from
the `NodeKind` type, which doesn't exist at runtime) that `isTopology()`
checks a node's kind against. Skip it and the new kind is accepted by the
type system but rejected by every untrusted-input path — file import,
share link, backup restore, clipboard paste — the moment anyone tries to
load it. Add the kind there too.

Run `bun run test`, `bun run lint` and `bun run build` afterward
(`AGENTS.md`, "Testing"), and treat this as a change worth a human
reviewing before it's relied on — it's an edit to the app's core, not a
generated scaffold, so don't fold it silently into an otherwise-unattended
run.

## 4. Draft, then confirm — before writing anything

Print in chat:

- The component → `NodeKind` mapping.
- The edges (who talks to whom, and which direction).
- Every place you guessed, resolved an ambiguity, or approximated a
  component with a kind that isn't quite it.

Ask the user to confirm or correct the draft. A misread here means every
service scaffolded in step 6 has the wrong shape, so this is the one step
worth pausing for — everything else in this skill can run unattended.

## 5. Author the topology

Build a `.breakscale` file at `generated/<slug>/topology.breakscale`, where
`<slug>` is a short hyphenated name for the system.

The two things this file must satisfy are defined in code, not restated
here, because a copy would drift from the real validator:

- The envelope shape: `DesignFile` in `src/designFile.ts`.
- The topology shape a node/edge must satisfy: `isTopology()` in
  `src/clipboard.ts`.

For each node's numeric `config`, don't invent values — this project's
stated discipline is that numbers are measured, never approximated
(`AGENTS.md`, "Correctness"). The safest way to get valid, in-character
defaults is to actually run the project's own code rather than hand-type
numbers that might not satisfy `isTopology`'s finite-number checks:

```ts
// scratch, run once with `bun run <file>`, then delete
import { makeNode } from './src/sim/presets';
// makeNode(kind, x, y, label?) returns a full SimNode with a unique id,
// the kind's default label, and defaultConfig(kind) — exactly the
// primitive the built-in presets are built from.
console.log(JSON.stringify(makeNode('service', 0, 0, 'API'), null, 2));
```

Call `makeNode` once per node (spacing `x`/`y` so nothing overlaps — canvas
position has no simulation effect, but an unreadable pile of overlapping
nodes is a bad first impression), assign `edges` between the resulting ids
with a `weight`, then wrap in the `DesignFile` envelope
(`app: 'breakscale', version: 1, savedAt: <ISO 8601>, name, topology`) and
write it to `generated/<slug>/topology.breakscale`. If a component's
behavior calls for a different capacity/service time than the kind's
default (e.g. "the database is the bottleneck"), adjust that field
afterward — never leave a config field at a value that isn't a finite
number.

## 6. Scaffold the reference implementation

For each node, look up its `NodeKind` in `reference/node-kind-stack.md` for
the default technology choice, then generate a real, runnable project under
`generated/<slug>/`:

- Source per service (a minimal but real implementation of what that
  component actually does — not a hello-world stub with the right name).
- A `docker-compose.yml` (or equivalent) wiring the pieces together per the
  edges in the topology.
- Mocks/stubs where standing up the real dependency isn't worth it for a
  reference example (call this out explicitly in the README, don't let it
  pass as the real thing silently).
- A dependency manifest/lockfile for whatever language(s) the doc implied,
  or a plain, common default (Node.js) if nothing in the input suggested
  one.
- A `README.md` with exact install, run, and validate commands — validate
  means something that actually exercises the system (a smoke test, a
  curl against a health check, whatever fits), not just "it starts".

Kinds that guard or shape another node's traffic rather than running as
their own process (breakers, rate limiters, bulkheads, load shedders) become
a library call or middleware inside the service they protect — see the
fallback rule at the bottom of `reference/node-kind-stack.md`.

## 7. Report back

Print, plainly:

- Where `topology.breakscale` landed.
- How to load it into Breakscale: open the app, Settings → Open a file (or
  drop the file on the canvas) — the app's existing, unmodified import path.
- The exact commands to install, run, and validate the generated project.
- If step 3 added a new `NodeKind`, say so explicitly and separately from
  the rest: which files in `src/sim` (and `src/clipboard.ts`) changed, and
  that it's a change to the app's core worth a human reviewing on its own,
  not something to wave through with the rest of the run.
