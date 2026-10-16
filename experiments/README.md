# Experiments

Live A/B runs of this extension against a real server, described by one JSON file each:

```bash
node scripts/experiment.mjs experiments/incremental.json            # run
node scripts/experiment.mjs experiments/incremental.json --dry-run  # validate + show the plan
node scripts/experiment.mjs experiments/incremental.json --repeats 1  # override repeats
```

| key | meaning |
|---|---|
| `endpoint.provider`, `endpoint.model` | a provider/model from your `~/.pi/agent/models.json` |
| `endpoint.baseUrl`, `modelId` | optional: talk to one inference server directly (e.g. a vLLM engine port) under its served model name, so the run does not take a slot on a shared proxy/router |
| `endpoint.apiKeyEnv` / `apiKeyCommand` | where the key for `baseUrl` comes from — an env var name or a command that prints it. Never put a key in the file |
| `session.cycles` (>= 2), `rows`, `thinking`, `warmup`, `persist` | the scripted session: per cycle plant a fact, read three `rows`-line files (pushes the fact out of Pi's verbatim tail), compact; recall every fact at the end |
| `arms[]` | `{ name, config }`; `config` is overlaid on `pi-prefix-cache-compaction.json` for that arm, so any option can be tested |
| `repeats` | runs per arm, interleaved (A B A B …) so load drift on a shared box hits every arm alike; speed uses the median |
| `compare` | `{ baseline, candidate }` arm names for the speed check |
| `accept` | which checks gate the exit code (`viaExtension`, `incrementalWiring`, `noLostFacts`, `faster`; set one to `false` to report it without gating) and the `minTimeGainPct` / `minTokenGainPct` thresholds for `faster` |
| `output` | results file; default `experiments/results/<name>-<timestamp>.json` |

Speed is measured over compactions 2..N only: compaction 1 has no previous summary, so it is identical in every arm.
