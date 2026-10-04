# Loss Radar: fixed-budget audit pilot

This first increment extends Recall rather than launching another repository. It
estimates missed records in a **frozen pending-rejection population**; it does not
estimate end-to-end recall without labels for accepted decisions as well.

## Method and limits

1. Freeze the records, priority membership, budget, and randomly generated seed
   **before** looking at labels. Preserve the plan and its fingerprint.
2. Sample without replacement inside caller-defined priority and ordinary strata.
   Every non-empty stratum gets at least one review. Remaining capacity is assigned
   to the other stratum if a stratum saturates. This gives a hard review count and
   known inclusion probabilities, including high-confidence rejects.
3. Obtain an explicit human `miss: true|false` label for every selected id. Resolve
   ids in the authorized source system; plans contain neither text nor source ids.
   A replay flip, probability, or `recovered` status is not a human truth label.
4. Estimate the miss rate as `sum_h (N_h/N) * (misses_h/n_h)`, not the raw selected
   sample rate. Multiplying by N estimates the missed-record count.

The interval uses a conservative fixed-sample Hoeffding radius
`sqrt(log(2/delta)/2 * sum_h ((N_h/N)^2/n_h))`; census strata contribute zero.
It assumes uniform without-replacement sampling within independent strata and
correct, complete labels. Seeded hash ranking is a reproducible pseudorandom
implementation of that design. Repeated seed searches after observing labels,
optional stopping, label nonresponse, and extrapolation to future traffic violate
this protocol. This is **not** an anytime-valid or conformal certificate. Small
samples can produce wide intervals; zero observed misses is not zero risk.

The fingerprint detects accidental changes, not a malicious operator. The plan
must be retained in an access-controlled store. No estimate of monetary benefit
or causal improvement is invented. Stored record ids and fingerprints may still
be sensitive. CLI output is stdout; persist it only in an authorized location.

## Offline CLI

`jev-recall audit-plan store.jsonl --budget 20 --priority priority-ids.json`
prints a plan. `priority-ids.json` is an array of Recall record ids. Seed omission
generates and records a fresh cryptographic seed; `--seed` is for reproducibility.

`jev-recall audit-report plan.json --labels labels.json` accepts an array such as
`[{"recordId":"recall-id","miss":false}]`. Unknown, duplicate, or missing labels
fail instead of being silently counted as correct. No provider is called and no
production ticket is changed. `npm run demo:loss-radar` uses synthetic fixtures.

## Pilot acceptance (targets, not achieved results)

Start with one Zammad team, read-only exports, two prespecified error definitions
(misrouted and incorrectly closed), and a review budget agreed with its owner.
Compare the same budget with random-only audit. Measure error discovery and
interval width separately; oversampling does not necessarily reduce variance.
Then compare old/new policies on independent human-labeled cases, retaining
delayed outcomes and review time. No Zammad connector or live shadow deployment
is shipped in this increment.

Commercial gate: three pilot teams and one willing to pay. Technical gate:
reproducible benefit at equal review budget on independent data, with uncertainty
reported. Stop if review costs outweigh the demonstrated operational gain.
No customer has been contacted and no SOTA claim is made.

Research basis: [Active Testing, ICML 2021](https://arxiv.org/abs/2103.05331)
shows why selectively acquired evaluation labels require bias correction. This
implementation is a simpler fixed stratified design, not a reproduction of that
paper's acquisition algorithm.
