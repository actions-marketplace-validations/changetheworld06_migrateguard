# MigrateGuard

> **AI-powered review of database migrations on every PR.**
> Like a senior DBA commenting your PR — in 1 click, no YAML config.

[![GitHub Action](https://img.shields.io/badge/GitHub%20Action-MigrateGuard-orange?logo=github)](https://github.com/marketplace/actions/migrateguard)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## What it does

Every time someone opens a PR with a database migration, MigrateGuard runs and posts a review comment with:

- 🟢🟡🟠🔴 **Risk level** (LOW / MEDIUM / HIGH / CRITICAL)
- ⚠️ **Breaking changes** detected
- 💀 **Data loss risks**
- 🔄 **Rollback strategy** (executable SQL)
- ✅ **Recommended tests** before merging

If the migration is `CRITICAL`, the check fails and blocks the merge.

## Example

A PR adds this migration:

```sql
ALTER TABLE "User" DROP COLUMN "username";
ALTER TABLE "User" ADD COLUMN "email" TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
```

MigrateGuard comments:

> 🔴 **MigrateGuard — Risque CRITICAL**
>
> Suppression de la colonne `username` et ajout d'une colonne `email NOT NULL` avec contrainte d'unicité. Perte de données irréversible.
>
> **Breaking changes:**
> - Tout code applicatif référençant `username` va crasher
> - L'index UNIQUE va échouer si plusieurs utilisateurs existent (tous auront `email = ''` par défaut)
>
> **Rollback strategy:**
> Si backup disponible : restaurer `User`, `DROP COLUMN email`, `DROP INDEX User_email_key`, `ADD COLUMN username`. Sans backup : perte définitive.

## Setup (2 minutes)

### 1. Add your Anthropic API key as a secret

```bash
gh secret set ANTHROPIC_API_KEY
```

Get a key at [console.anthropic.com](https://console.anthropic.com/settings/keys).

### 2. Add the workflow file

Create `.github/workflows/migrateguard.yml`:

```yaml
name: MigrateGuard
on:
  pull_request:
    paths:
      - 'prisma/migrations/**'
      - 'prisma/schema.prisma'

permissions:
  contents: read
  pull-requests: write

jobs:
  review-migration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: changetheworld06/migrateguard@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

That's it. Open a PR with a migration and watch the comment appear.

## Configuration

| Input | Required | Default | Description |
|---|---|---|---|
| `github-token` | ✅ | — | `${{ secrets.GITHUB_TOKEN }}` |
| `anthropic-api-key` | ✅ | — | Your Anthropic API key (stored as repo secret) |
| `model` | ❌ | `claude-sonnet-4-5-20250929` | Claude model to use |
| `migrations-path` | ❌ | `prisma/migrations` | Where to look for migration files |

## Why MigrateGuard vs Atlas?

[Atlas](https://atlasgo.io) is excellent for teams with a DBA who can write rule files and configure `atlas.hcl`. **MigrateGuard is for the rest of us.**

| | **MigrateGuard** | **Atlas** |
|---|---|---|
| Setup | 1 workflow file | `atlas.hcl` + rule config |
| Review style | Conversational, in plain language | Deterministic rule violations |
| Rollback strategy | Generated automatically | Manual |
| Best for | Solo devs, indie hackers, small teams | Teams with a dedicated DBA |
| Pricing | Free tier + $7/seat (coming soon) | Free OSS + Atlas Cloud paid |

Use Atlas if you want strict deterministic rules. Use MigrateGuard if you want a senior DBA reading your migration in plain English/French and explaining what's wrong.

## Cost

Each review costs ~$0.01 in Anthropic API tokens (you provide your own key). Typical solo dev project: a few PRs/month with migrations = pennies/month.

## Status

🚧 **Early version.** Currently supports Prisma migrations (`*.sql` files in `prisma/migrations/`). Drizzle, Knex, and raw SQL coming soon.

## Roadmap

- [x] Prisma migrations support (PostgreSQL focus)
- [ ] Drizzle migrations support
- [ ] Knex / Flyway / Liquibase support
- [ ] License key system (free tier 5 PRs/month, paid tier unlimited)
- [ ] Team analytics dashboard
- [ ] Auto-suggest expand-contract refactors

## Contributing

Issues and PRs welcome. This is an early product and feedback shapes the roadmap.

## License

MIT — see [LICENSE](LICENSE).

---

Built by [@changetheworld06](https://github.com/changetheworld06) in Nice, France 🇫🇷
