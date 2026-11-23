# Ridgeline lab

A synthetic local demo that answers the same prompt over the same fixture twice: once as
an A2UI v1.0 surface built only from the
[Basic catalog](../../catalogs/basic/v1/catalog.json), and once as Markdown. The two
answers sit side by side so you can compare them, and an evaluation harness checks and
grades both.

Every project, person, record ID, and date in the lab is invented. Nothing is written to
a real system: confirming an action only returns a message.

## Requirements

1. Node.js 22.12 or later.
2. Dependencies installed from the lab's lockfile. The lab is a standalone npm package
   (it has its own `package-lock.json` and is not a root Yarn workspace), so install it
   from this directory:

   ```sh
   cd samples/ridgeline-lab
   npm ci
   ```

3. Optional, for live generation: a Fireworks API key in `FIREWORKS_API_KEY`.
4. Optional, for live judging: a TypeSafe key in `TYPESAFE_API_KEY` (or `JEV_API_Key`).

## Run the lab

Everything runs on one port, `http://127.0.0.1:4174`. The JSON API and the web client
share it in both modes.

```sh
npm run dev
```

In dev mode, Vite runs as middleware inside the lab server. To run the built client
instead:

```sh
npm run build
npm start
```

`npm start` serves `dist/` from the same port and answers 503 until a build exists. Set
`RIDGELINE_PORT` to use another port. The server binds to `127.0.0.1`, accepts only
loopback `Host` headers, and requires a same-origin `Origin` on POST requests.

Stub mode replays each scenario's checked-in payload and needs no key. Live mode calls
the Fireworks model through `src/llm.ts` and never falls back to the stub; if the call
fails, the UI shows the error.

## Scenarios

| ID                | Product   | Mobile | What the answer shows                                           | User action     |
| ----------------- | --------- | ------ | --------------------------------------------------------------- | --------------- |
| `rfi-triage`      | Ridgeline | no     | RFIs grouped as overdue, upcoming, and closed                   | none            |
| `project-brief`   | Ridgeline | no     | Morning brief: schedule risk, latest log, counts, change orders | none            |
| `punch-proposal`  | Ridgeline | no     | Editable punch item draft from a walkthrough note               | `proposePunch`  |
| `daily-log`       | Ridgeline | yes    | Phone-width daily log draft with editable date and notes        | `draftDailyLog` |
| `decision-card`   | Cortex    | no     | One decision with decider, date, rationale, and citations       | none            |
| `meeting-actions` | LocalFlow | no     | Action items with owner and due date, plus unassigned items     | none            |

The mobile scenario renders the web surface in a 390 px panel. There is no React Native
renderer in this repository, and the lab does not add one.

## API

All responses are JSON. Errors have the shape `{"error": "..."}`.

1. `GET /api/scenarios` returns `{scenarios: [...]}` with each scenario's `id`, `title`,
   `product`, `description`, `prompt`, and `mobile`.
2. `POST /api/generate` with `{scenarioId, mode}` (`mode` is `stub` or `live`) returns
   `{messages, markdown, mode, model, repaired}`.
3. `POST /api/action` with `{scenarioId, event}` accepts a v1.0 renderer-to-agent action
   event. `proposePunch` (context `title`, `description`, `priority`) returns
   `confirmation_required` with a staged action `{id, token, expiresAt, arguments}`.
   `draftDailyLog` (context `logDate`, `notes`) returns `drafted`.
4. `POST /api/confirm` and `POST /api/cancel` with `{id, token}` resolve a staged action
   and return `confirmed` or `cancelled`. Staged actions expire after five minutes.

The client keeps the action token only in memory. The server stores a digest of it, and
the token never reaches logs or the model.

## Evaluation

The harness in `src/eval.ts` and `src/eval/` checks and grades both variants (A2UI and
Markdown) of every scenario.

### Offline run (default)

```sh
npm run eval
```

The offline run replays the recorded stub output, makes no network calls, and writes
`reports/eval-offline.json` and `reports/eval-offline.md`. These files are identical from
run to run. The command exits 1 if any deterministic check fails.

Offline judge grades come from [`src/eval/offline-grades.json`](src/eval/offline-grades.json).
They are hand-authored canned values, not model output. Each one is keyed to the SHA-256
of the exact evidence and rubric it was written for. If either hash changes, the report
shows `FIXTURE_STALE` instead of a grade, and a lane without an entry shows `NO_FIXTURE`.

### Live run

```sh
FIREWORKS_API_KEY=... TYPESAFE_API_KEY=... npm run eval -- --live
```

A live run generates each scenario with the Fireworks model, then grades the A2UI variant
and the Markdown variant in two separate judge calls. To grade the recorded stub output
with the live judge and skip Fireworks:

```sh
TYPESAFE_API_KEY=... npm run eval -- --live --judge-only
```

Live reports are written as `reports/eval-live-<UTC time>.json` and `.md`. If live
generation fails, or the agent returns anything other than live output, the lane reports
the error and is not judged. A missing judge key shows `MISSING_KEY`. Live grades are
never replaced with fixture grades.

### Flags

1. `--scenario <id>` runs only that scenario. Repeat it or pass a comma-separated list.
2. `--variant a2ui` or `--variant markdown` runs one variant.
3. `--checks-only` skips the judge.
4. `--judge-only` grades the recorded stub output without generating.
5. `--print-evidence` prints each lane's judge evidence and hashes.
6. `--out <dir>` writes reports somewhere other than `reports/`.

Runs that use `--scenario` or `--variant` add `-partial` to the report name.

### What the judge sees

The judge sees only what a user can see. For the A2UI variant, the harness applies the
messages in order, walks each surface from `root`, resolves `@path` bindings, template
children, and Basic catalog formatting functions, and writes one line per visible
element. Inputs show their label and current value, side-by-side Row children share one
line separated by `|`, and buttons show their label and the labels of the inputs they
submit. Components that are not reachable from `root`, data model values that nothing
binds to, surface IDs, action names, and literal action context values are left out. For
the Markdown variant, HTML comments, raw tags, and link targets are removed.

Both variants are graded with the scenario's frozen rubric (4 to 8 single yes/no
questions) and the same fixed evidence scope text.

### Deterministic checks

These checks gate the run:

1. `messages-valid`: the lab validator accepts the v1.0 messages (A2UI only).
2. `render-clean`: every reachable component renders and every binding resolves (A2UI
   only).
3. `non-empty`: the variant shows some text.
4. `facts-present`: each scenario fact value appears in the visible text. The report lists
   the line numbers and, for A2UI, the component IDs where each value appears.
5. `record-field-mismatch`: a missing ID is replaced by another ID of the same type, or a
   field labeled with a fact's name shows a different date.
6. `no-fabricated-ids`: every record ID (such as `RFI-031` or `SRC-ADR-0042`) is in the
   scenario's fixture, facts, or prompt.
7. `dates-valid` and `no-fabricated-dates`: every date that names a year is a real
   calendar date and is in the fixture. A fixture mention without a year, such as
   "December 1st", counts for each year the fixture already names.
8. `output-present`: generation produced output.

`no-unreachable-components` is reported as a warning and does not fail the run. These
checks trace record values; they do not prove that free prose is correct.

### Grades and uncertainty

Each question gets p(yes). Confidence is `|2p - 1|`, and answers with confidence below 0.5
are marked untrusted. p of at least 0.8 is PASS, at most 0.2 is FAIL, and anything between
is UNPROVEN. Each lane also reports a Wilson 95% interval on its PASS share; questions
are not independent samples, so treat the interval as indicative. Grades are advisory
and never change the exit code.

### Live judge cost controls

1. The judge uses exactly `jev-1.14.0` through the `@typesafe-ai/sdk` client, with retries
   disabled and SDK logging off. A response from any other model is reported as
   `MODEL_UNAVAILABLE`.
2. Before each call, the harness reserves the worst-case cost: 65,536 tokens at $0.042 per
   million input tokens (2,753 micro-USD), with output priced at zero. Reservations are
   never refunded.
3. Reservations add up in `~/.ridgeline-jev/budget-<first 12 hex of the key's SHA-256>-<UTC
date>.json` under a lock file. The cap is $5 per key per UTC day, shared with the
   Ridgeline Jev harness. Set `JEV_LEDGER_DIR` to use another directory.
4. Evidence over 20,000 characters, requests that could pass the token bound, and
   evidence that looks like it holds a credential are not sent.

A full live run makes at most 12 judge calls and reserves at most about $0.033.

### Recording canned grades

1. Run `npm run eval -- --checks-only --print-evidence` and read each lane's evidence.
2. For each lane, add an entry to `src/eval/offline-grades.json` with the printed
   `evidence_sha256`, the lane's `rubric_sha256` (printed by a run without
   `--checks-only`, or computed with `rubricHash` in `src/eval/judge.ts`), and a p(yes)
   for every rubric question.
3. Run `npm test`. The recorded-scenario test fails if any lane is not graded.

Never copy a live grade into the fixture file as if it were canned, and never write a
canned grade into a live report.

## Tests and build

```sh
npm test
npm run typecheck
npm run build
npm run format:check
```

`npm test` runs `tsx --test test/*.test.ts` with `node:test`. The evaluation tests
(`test/eval-*.test.ts`) use fake transports and temporary ledger directories, so they make
no network calls and never touch `~/.ridgeline-jev`.

## Guardrails

1. All data is synthetic. Confirming or drafting an action never writes a record.
2. Payloads use only the v1.0 Basic catalog. The lab does not add custom components.
3. There is no React Native renderer. The mobile scenario is a phone-width web panel.
4. Live generation never falls back to stub output, and the evaluation never presents
   stub output or fixture grades as live results.
5. Action tokens stay in client memory and are not logged or sent to a model.
6. Reports are written to `reports/`, which is ignored by git. They contain no keys; the
   ledger stores only a key fingerprint.

## Opportunities

1. Grade evidence captured from the rendered React DOM, so the judge sees exactly what the
   browser shows, including Basic catalog functions that the text renderer does not
   format.
2. Calibrate the judge on these rubrics against human labels before using live grades to
   compare variants.
3. Check year-less dates in output (for example "Dec 4") against the fixture.
4. Keep the "submits" label for a button placed inside a Row; the text renderer drops it
   there today.
5. Add scenarios where the two variants are expected to differ, such as long tables or
   multi-step forms.

### Product rollout

The lab is not connected to any of these products, and this section describes proposals,
not existing integrations. It lists one possible order for trying the lab's patterns in
each product, starting with read-only surfaces.

1. Ridgeline: first, send the `rfi-triage` surface as read-only content through the
   assistant events the product already emits, with no actions. Then add the
   `punch-proposal` flow, with the `proposePunch` action routed to Ridgeline's existing
   confirmation endpoints so that a person still confirms each punch item before it is
   written. On mobile, the surface stays a phone-width web view as in `daily-log`; this
   plan does not include a native React Native renderer.
2. Cortex: render decision cards like `decision-card`, with each citation carrying a
   source ID. The host app, not the agent, resolves each ID to a link the user is
   allowed to open, so the model never writes URLs.
3. LocalFlow: show meeting action items like `meeting-actions` for review, and let the
   user edit owners and due dates. Nothing is exported to a task tool until the user
   approves the list.
