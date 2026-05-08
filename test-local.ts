// Test local : simule une review de migration sans passer par GitHub.
// Charge la clé depuis .env et appelle directement Claude.

import * as fs from "fs";
import * as path from "path";
import Anthropic from "@anthropic-ai/sdk";

// Chargement minimal du .env (pas besoin d'une lib pour ça)
function loadEnv(): void {
  const envPath = path.resolve(".env");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

interface ReviewResult {
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  summary: string;
  breakingChanges: string[];
  dataLossRisks: string[];
  rollbackStrategy: string;
  recommendedTests: string[];
}

const FAKE_MIGRATION = {
  filename: "prisma/migrations/20260508_drop_user_email/migration.sql",
  content: `-- Migration : retrait de la colonne email
ALTER TABLE "User" DROP COLUMN "email";

-- Ajout d'un nouveau champ obligatoire
ALTER TABLE "User" ADD COLUMN "username" TEXT NOT NULL DEFAULT '';

-- Index unique sur le nouveau champ
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");`,
};

async function main(): Promise<void> {
  loadEnv();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === "xxxxxx" || apiKey.startsWith("ta_cle")) {
    console.error("❌ ANTHROPIC_API_KEY manquante ou non remplacée dans .env");
    process.exit(1);
  }

  const anthropic = new Anthropic({ apiKey });

  const filesBlock = `### ${FAKE_MIGRATION.filename}\n\`\`\`sql\n${FAKE_MIGRATION.content}\n\`\`\``;

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

  console.log("→ Appel Claude en cours...\n");
  const start = Date.now();

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }],
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`← Réponse reçue en ${elapsed}s\n`);

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    console.error("❌ Réponse Claude vide.");
    process.exit(1);
  }

  const cleaned = textBlock.text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  let review: ReviewResult;
  try {
    review = JSON.parse(cleaned) as ReviewResult;
  } catch {
    console.error("❌ JSON invalide. Réponse brute :\n");
    console.error(textBlock.text);
    process.exit(1);
  }

  console.log("=== RÉSULTAT ===");
  console.log(`Niveau de risque : ${review.riskLevel}`);
  console.log(`Résumé : ${review.summary}\n`);
  console.log("Breaking changes :");
  review.breakingChanges.forEach((c) => console.log(`  - ${c}`));
  console.log("\nRisques de perte de données :");
  review.dataLossRisks.forEach((r) => console.log(`  - ${r}`));
  console.log("\nRollback :");
  console.log(review.rollbackStrategy);
  console.log("\nTests recommandés :");
  review.recommendedTests.forEach((t) => console.log(`  - ${t}`));

  console.log(`\nTokens utilisés : input=${response.usage.input_tokens}, output=${response.usage.output_tokens}`);
}

main().catch((err) => {
  console.error("❌ Erreur :", err);
  process.exit(1);
});
