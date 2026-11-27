# Measurement rules: the honesty framework for savings claims

Research context (PRD §6.25): token consumption varies enormously
between agents and more tokens do not automatically mean better
outcomes: which is exactly why the KPI is **successful task token
cost**, not raw minimization.

## The four categories

| Category | Meaning | Allowed phrasing |
| --- | --- | --- |
| **Measured** | Runtime/provider-supplied usage numbers compared across runs | "input tokens: 48,200 → 21,700 (usage fields, same task, same model)" |
| **Derived** | Reduction computed from known content with an explicit tokenizer or byte/char proxy | "context bytes read: 812KB → 96KB (−88%, byte counts from file sizes)" |
| **Estimated** | Counterfactual estimate, labeled and based on stated assumptions | "estimated ~40% fewer tokens (assumes median file 300 lines, based on 12 sampled reads)" |
| **Unknown** | Cannot honestly be measured | "savings unknown: no usage telemetry this session" |

**Never** print "saved 63% of tokens" without the category and its
evidence. An uncategorized percentage is a violation of this skill, not
a rounding choice.

## Metrics worth tracking (when the runtime exposes them)

- input tokens / output tokens / cache-read / cache-write;
- context bytes read (files opened, lines retrieved);
- command-output bytes before/after capping;
- tool calls per task; retries per task;
- **task success**: measure total cost including failed attempts, retries,
  tools and handoffs. A retry can still be net-cheaper; decide from totals
  and identical independent acceptance checks, not retry count alone.

## Baseline discipline

- Compare like with like: same task, same model, same data; state what
  differed.
- One-variable changes (cap the logs OR range-read, not both) when the
  goal is attribution; bundle when the goal is just "do the task
  cheaper": say which goal.
- Cache-prefix savings only count when the runtime actually caches,
  verify, don't assume.

## Where this skill's own budget applies

- Session handoffs and context compaction: load the smallest set of current,
  decision-relevant evidence.
- This suite's own SKILL.md files follow the Agent Skills 500-line structural
  limit, with conditional detail loaded from references.

## Cost per correct completion

For a fixed batch with the same independent acceptance checks, report
`sum(all attempt costs) / number of correctly completed tasks`. Include failed
tasks in the numerator; if zero tasks completed correctly, the ratio is undefined,
not zero. Keep tokens, currency, latency and bytes separate. Use provider usage
and actual applicable pricing for currency, including cache/tool charges where
known; incomplete fields mean total cost is unknown. Do not turn a byte proxy
into dollars. Report correctness and observed regression cases beside cost.

Reuse needs invalidation: bind summaries to source revision and relevant
configuration; refresh after edits, failed verification or a contradictory
observation. Output caps must preserve runner exit status and a path to complete
logs; a green `head` process cannot establish that its producer succeeded.
