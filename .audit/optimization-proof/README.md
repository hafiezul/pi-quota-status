# Optimization proof

The [verification script](verify.mjs) passes 98,001 assertions against baseline `735af1e381258b7115df025361c79d748b9de88b`. The optimized source was clean at HEAD `8204e1b85f183758ba9d1b417a0a3adda9e94a8c` before this evidence was added. The script compares baseline Git source with working-tree source, and rejects an identical baseline ref or identical source.

[Actual output](results.txt) records the identities, assertions, operation counts, and fake-data footer. [Checks](checks.txt) records commands and final results. The [chart](operations.png) plots the observed counts. Its [generator](chart.py) reads results.txt and requires Python 3 with Pillow.

## Reproduce the evidence

From the repository root, with npm dependencies installed, run:

```sh
node .audit/optimization-proof/verify.mjs > .audit/optimization-proof/results.txt
python3 .audit/optimization-proof/chart.py
npm run typecheck
npm test
npm run check:fetch
git diff --check
```

Pass a full baseline commit as the script's first argument to override the pinned default. The script resolves the repository from its own location. It transpiles source into an OS temporary directory, skips declarations, and removes fixtures in a finally block. No external API calls occur.

## Coverage and limits

The differential cases cover metric rounding boundaries, non-finite values, seven units, dimension name ordering and normalization, empty names and dimensions, missing values, expired resets, five observation sources, three providers, and three models. Selectors and compact footers are compared at a fixed clock value of 2026-01-01T00:00:00Z with TZ UTC. Empty observation states are included.

Separate assertions verify lazy formatter construction and reuse for values below 100 and values at least 100. They also verify these baseline and optimized counts:

| Fixture | Baseline | Optimized |
| --- | ---: | ---: |
| Expiration getter reads, first match among 1000 dimensions | 1000 | 1 |
| Locale calls for 1000 USD metrics | 1000 | 0 |
| Adapter getter reads, provider selection | 1 | 0 |
| Adapter getter reads, subscription selection | 1 | 0 |
| Adapter getter reads, fallback selection | 1 | 1 |

The expiration getter measures reads of resetAt when all values are undefined. It does not establish behavior for every expiration distribution. The locale proxy counts calls to Number.prototype.toLocaleString, not internal ICU work. The adapter getter measures access to config.adapters, not adapter execution or network traffic. The constructor proxy measures Intl.NumberFormat construction, not internal allocations. The optimized module constructs zero formatters at import, one on first use of each numeric category, and reuses both.

These synthetic fixtures establish matching outputs for the enumerated cases and reduced counted operations. They do not measure elapsed time, production speed, live provider behavior, credentials, API compatibility, or integration inside a running Pi host.
