import * as core from "@actions/core";
import * as github from "@actions/github";
import Anthropic from "@anthropic-ai/sdk";

interface MigrationFile {
  filename: string;
  content: string;
}

interface ReviewResult {
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  summary: string;
  breakingChanges: string[];
  dataLossRisks: string[];
  rollbackStrategy: string;
  recommendedTests: string[];
}

interface LicenseCheck {
  allowed: boolean;
  plan: "free" | "pro" | "team";
  remaining?: number;
  reason?: string;
}

const DEFAULT_LICENSING_SERVER_URL = "https://migrateguard-server.gonin.workers.dev";

async function run(): Promise<void> {
  try {
    // ---- 1. Récupération des inputs ----
    const githubToken = core.getInput("github-token", { required: true });
    const anthropicApiKey = core.getInput("anthropic-api-key", { required: true });
    const model = core.getInput("model") || "claude-sonnet-4-5-20250929";
    const migrationsPath = core.getInput("migrations-path") || "prisma/migrations";
    const licensingServerUrl =
      core.getInput("licensing-server-url") || DEFAULT_LICENSING_SERVER_URL;

    const octokit = github.getOctokit(githubToken);
    const anthropic = new Anthropic({ apiKey: anthropicApiKey });
    const context = github.context;

    if (context.eventName !== "pull_request") {
      core.info("Pas un événement pull_request, on saute.");
      return;
    }

    const prNumber = context.payload.pull_request?.number;
    if (!prNumber) {
      core.setFailed("Numéro de PR introuvable dans le contexte.");
      return;
    }

    const { owner, repo } = context.repo;

    // ---- 2. Liste des fichiers changés dans la PR ----
    const { data: files } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });

    const migrationFiles: MigrationFile[] = [];
    for (const file of files) {
      const isMigration =
        file.filename.startsWith(migrationsPath) &&
        (file.filename.endsWith(".sql") ||
          file.filename.endsWith("migration.sql") ||
          file.filename.endsWith(".prisma"));

      if (!isMigration) continue;
      if (file.status === "removed") continue;

      // Récupération du contenu du fichier au commit head de la PR
      const { data: contentData } = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: file.filename,
        ref: context.payload.pull_request?.head.sha,
      });

      if ("content" in contentData && contentData.content) {
        const decoded = Buffer.from(contentData.content, "base64").toString("utf-8");
        migrationFiles.push({ filename: file.filename, content: decoded });
      }
    }

    if (migrationFiles.length === 0) {
      core.info("Aucun fichier de migration détecté dans cette PR.");
      return;
    }

    core.info(`${migrationFiles.length} fichier(s) de migration détecté(s).`);

    // ---- 3. Vérification de la licence (free tier 5 PR/mois, pro illimité) ----
    const license = await checkLicense(licensingServerUrl, owner, repo);

    if (!license.allowed) {
      core.info(`Limite atteinte pour ce repo (${license.reason}). Commentaire d'upgrade posté.`);
      const limitComment = formatLimitReachedComment();
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body: limitComment,
      });
      // On ne fail PAS le check : on laisse passer pour ne pas bloquer la CI sur un quota.
      return;
    }

    if (license.plan === "free" && typeof license.remaining === "number") {
      core.info(`Plan free : ${license.remaining} review(s) restante(s) ce mois-ci.`);
    }

    // ---- 4. Appel à Claude pour la review ----
    const review = await reviewMigrations(anthropic, model, migrationFiles);

    // ---- 5. Post du commentaire sur la PR ----
    const commentBody = formatReviewComment(review, migrationFiles, license);
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: commentBody,
    });

    core.info(`Review postée. Niveau de risque : ${review.riskLevel}`);

    if (review.riskLevel === "CRITICAL") {
      core.setFailed("Migration CRITICAL détectée. Voir le commentaire de la PR.");
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(`MigrateGuard a échoué : ${error.message}`);
    } else {
      core.setFailed("MigrateGuard a échoué pour une raison inconnue.");
    }
  }
}

async function checkLicense(
  serverUrl: string,
  owner: string,
  repo: string
): Promise<LicenseCheck> {
  // Stratégie "fail open" : si le serveur est inaccessible, on autorise la review
  // pour ne pas pénaliser les utilisateurs en cas d'incident.
  try {
    const url = `${serverUrl.replace(/\/+$/, "")}/check?owner=${encodeURIComponent(
      owner
    )}&repo=${encodeURIComponent(repo)}`;

    const response = await fetch(url, {
      method: "GET",
      headers: { "user-agent": "migrateguard-action" },
      // Timeout court : on ne veut pas faire attendre la CI si le serveur traîne.
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      core.warning(
        `Licensing server a répondu ${response.status}. Fail open : la review continue.`
      );
      return { allowed: true, plan: "free" };
    }

    const data = (await response.json()) as LicenseCheck;
    return data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    core.warning(`Licensing server inaccessible (${msg}). Fail open : la review continue.`);
    return { allowed: true, plan: "free" };
  }
}

async function reviewMigrations(
  anthropic: Anthropic,
  model: string,
  files: MigrationFile[]
): Promise<ReviewResult> {
  const filesBlock = files
    .map((f) => `### ${f.filename}\n\`\`\`sql\n${f.content}\n\`\`\``)
    .join("\n\n");

  const prompt = `Tu es un DBA senior qui review une PR contenant des migrations de base de données.

Voici les fichiers de migration :

${filesBlock}

Analyse ces migrations et réponds UNIQUEMENT avec un objet JSON valide (sans markdown, sans \`\`\`, sans préambule) au format suivant :

{
  "riskLevel": "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
  "summary": "Résumé en 1-2 phrases du contenu de la migration",
  "breakingChanges": ["liste des breaking changes détectés, vide si aucun"],
  "dataLossRisks": ["liste des risques de perte de données, vide si aucun"],
  "rollbackStrategy": "Stratégie de rollback en SQL ou en prose",
  "recommendedTests": ["liste de 2-4 tests à écrire avant de merger"]
}

Critères de niveau de risque :
- LOW : ajout de table, ajout de colonne nullable, ajout d'index non bloquant
- MEDIUM : ajout de colonne NOT NULL avec default, modification de type compatible, contrainte ajoutée sur petite table
- HIGH : DROP COLUMN avec données, modification de type incompatible, contrainte sur grande table peuplée, rename de colonne sans alias
- CRITICAL : DROP TABLE avec données, perte de données irrécupérable sans backup, migration non transactionnelle qui bloque la prod

Réponds en français. Sois direct, précis, et propose un rollback exécutable.`;

  const response = await anthropic.messages.create({
    model,
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Réponse Claude vide ou inattendue.");
  }

  // Parse JSON robuste : enlève d'éventuels backticks markdown
  const cleaned = textBlock.text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned) as ReviewResult;
  } catch (err) {
    throw new Error(
      `Impossible de parser la réponse Claude en JSON. Réponse brute :\n${textBlock.text}`
    );
  }
}

function formatReviewComment(
  review: ReviewResult,
  files: MigrationFile[],
  license: LicenseCheck
): string {
  const riskEmoji = {
    LOW: "🟢",
    MEDIUM: "🟡",
    HIGH: "🟠",
    CRITICAL: "🔴",
  }[review.riskLevel];

  const fileList = files.map((f) => `- \`${f.filename}\``).join("\n");

  const breakingSection =
    review.breakingChanges.length > 0
      ? `### ⚠️ Breaking changes\n${review.breakingChanges.map((c) => `- ${c}`).join("\n")}\n`
      : "";

  const dataLossSection =
    review.dataLossRisks.length > 0
      ? `### 💀 Risques de perte de données\n${review.dataLossRisks.map((r) => `- ${r}`).join("\n")}\n`
      : "";

  const testsSection =
    review.recommendedTests.length > 0
      ? `### ✅ Tests recommandés avant merge\n${review.recommendedTests.map((t) => `- ${t}`).join("\n")}\n`
      : "";

  // Footer plan : visible uniquement sur le plan free pour pousser à l'upgrade en douceur.
  const planFooter =
    license.plan === "free" && typeof license.remaining === "number"
      ? `\n*Plan free : ${license.remaining} review(s) restante(s) ce mois-ci. [Passer au plan Pro](https://github.com/marketplace/actions/migrateguard) pour des reviews illimitées.*\n`
      : "";

  return `## ${riskEmoji} MigrateGuard — Risque ${review.riskLevel}

${review.summary}

**Fichiers analysés :**
${fileList}

${breakingSection}${dataLossSection}### 🔄 Stratégie de rollback
\`\`\`
${review.rollbackStrategy}
\`\`\`

${testsSection}
---
*Powered by [MigrateGuard](https://github.com/marketplace/actions/migrateguard) · review automatique IA des migrations DB*${planFooter}`;
}

function formatLimitReachedComment(): string {
  return `## ⏸️ MigrateGuard — Limite du plan free atteinte

Tu as utilisé tes **5 reviews gratuites** ce mois-ci sur ce repo.

La review de cette PR n'a pas été effectuée. Pour des reviews illimitées :

👉 **[Passer au plan Pro sur le GitHub Marketplace](https://github.com/marketplace/actions/migrateguard)** ($7/seat/mois)

Le compteur se réinitialise automatiquement le 1er du mois prochain.

---
*Powered by [MigrateGuard](https://github.com/marketplace/actions/migrateguard) · review automatique IA des migrations DB*`;
}

run();
