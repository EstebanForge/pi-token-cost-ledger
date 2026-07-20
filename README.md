# @estebanforge/pi-token-cost-ledger

Token & cost ledger for [Pi](https://github.com/earendil-works/pi-coding-agent). Captures every assistant message to a per-day JSONL ledger and exposes a `/usage` command with by-model and by-period breakdowns showing **both** real USD and API-equivalent USD.

## Why two dollar figures

On a flat coding plan the marginal cost/token is `$0` — useless for comparison. So alongside the provider's **real** cost, every report shows **api-equiv**: what the same tokens would cost pay-as-you-go on GLM's public API. That's the apples-to-apples axis vs Anthropic/OpenAI.

## Install

```
pi install npm:@estebanforge/pi-token-cost-ledger
```

## Usage

```
/usage                         today (default)
/usage today
/usage day [YYYY-MM-DD]        today, or a specific day
/usage week [N]                current ISO week; N = weeks ago
/usage month [YYYY-MM]         current month, or a specific one
/usage year [YYYY]             current year, or a specific one
/usage all                     full history
/usage model <name>            one model across all history, by month
```

Each report prints:

- **Total** — real $ · api-equiv $ · total tokens · calls
- **By model** — per-model breakdown
- **By period** — day or month subtotals (when the range spans more than one)

## How it works

- **Capture.** A `message_end` hook appends `{ts, provider, model, tokens, cost}` to `~/.pi/extensions-data/estebanforge/pi-token-cost-ledger/YYYY/MM/DD.jsonl`. Format is unchanged from the legacy ledger, so existing files are valid with zero migration.
- **Pricing.** api-equiv is computed at query time from current prices (reprice semantics — history always reflects the latest price file). A default `prices.json` ships with the extension; `~/.pi/extensions-data/estebanforge/pi-token-cost-ledger/prices.json` overrides it if present. See **Updating prices** below.
- **Multi-root.** Reads `~/.pi/extensions-data/estebanforge/pi-token-cost-ledger/roots.conf` (one path/line, `#` comments, first = primary write target). Disjoint ledgers (e.g. a construct sandbox) are unioned read-only; no dedup needed. Honors `PI_COST_LEDGER` / `PI_COST_LEDGERS` env overrides.
- **Cache convention.** `CACHE_CONV=separate` (default) treats `cacheRead` as a subset of input; `CACHE_CONV=included` treats input as the full prompt. Matches the old scripts.
- **Number format.** Controlled by the `token-cost-ledger-numbers` flag or `TOKEN_COST_LEDGER_NUMBERS` env:
  - `auto` (default) — detect from the terminal locale (`LC_ALL` > `LC_NUMERIC` > `LANG`) via `Intl.NumberFormat`. Respects each user's locale.
  - `comma` — Latin/European: `1.148,23` (dot thousands, comma decimal)
  - `dot` — Anglo: `1,148.23` (comma thousands, dot decimal)

  Set with `/token-cost-ledger comma` (in pi), `pi config set token-cost-ledger-numbers comma`, or per-session with `TOKEN_COST_LEDGER_NUMBERS=comma pi`. Run `/token-cost-ledger` bare to see current status.

## Commands

| Command | Description |
| --- | --- |
| `/usage [period]` | Query usage (today/day/week/month/year/all/model). See Usage above. |
| `/token-cost-ledger` | Show options status panel. |
| `/token-cost-ledger <auto\|comma\|dot>` | Set number format (persists + reloads). |

## Updating prices

The bundled `extensions/prices.json` holds canonical **first-party** rates per 1M tokens (input / cache-read / output), keyed by the exact model string pi logs. Source: [**models.dev**](https://models.dev) — an open-source database of AI model specs and pricing. Refresh from its catalog:

```bash
curl -sL https://models.dev/catalog.json -o /tmp/models-dev-catalog.json

# Extract canonical first-party pricing (zai, anthropic, minimax, google, openai)
jq -rc '.providers | to_entries[] | .key as $p
  | select($p|test("^(zai|anthropic|minimax|google|openai)$"))
  | .value.models // {} | to_entries[]
  | select(.value.cost != null)
  | {provider:$p, model:.key, cost:.value.cost, name:.value.name}' \
  /tmp/models-dev-catalog.json
```

Map catalog `{input, output, cache_read}` → this file's `{i, o, c}`. Keys MUST match the ledger's exact model string (case-sensitive — e.g. `MiniMax-M3`, not `minimax-m3`). Models with context-tier pricing use the **default tier** (<200K / <512K context); the over-tier rate is noted in `_tier_note`. After editing, no reload is needed — queries re-read the file each call.

models.dev alternatives: the catalog JSON (`catalog.json` / `models.json` / `providers.json`), the `@opencode-ai/models` npm SDK (typed snapshot for offline use), or TOML sources on GitHub.

## Data layout

```
~/.pi/extensions-data/estebanforge/pi-token-cost-ledger/
├── roots.conf          # ledger roots (optional; auto-detects host + construct)
├── prices.json         # GLM prices override (optional; bundled default otherwise)
├── 2026/07/22.jsonl    # one record per assistant message, append-only
└── 2026/07/23.jsonl
```

## License

MIT
