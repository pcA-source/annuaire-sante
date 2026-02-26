# Annuaire Santé — Recherche de professionnels

Mini web app pour rechercher des professionnels de santé via l'API FHIR de l'Annuaire Santé (ANS).

## Architecture

```
Frontend (Cloudflare Pages)  →  Worker (Cloudflare Worker)  →  API FHIR Annuaire Santé
    src/index.html                  worker/index.js              gateway.api.esante.gouv.fr
```

## Setup

### 1. Obtenir une clé API
1. Créer un compte sur https://portal.api.esante.gouv.fr
2. Créer une application
3. Souscrire à "API Annuaire Santé en libre accès"
4. Récupérer la clé API (ESANTE-API-KEY)

### 2. Déployer le Worker
```bash
cd worker
# Remplacer PLACEHOLDER_KEY dans wrangler.toml
npx wrangler deploy
```

### 3. Déployer le Frontend
```bash
npx wrangler pages deploy src --project-name=annuaire-sante
```

### 4. Lier Worker + Pages
Configurer une route `/api/*` vers le worker dans le dashboard Cloudflare.

## Fonctionnalités
- 🔍 Recherche par nom, RPPS, ville, spécialité
- 📋 Copie de fiche en un clic
- 📊 Export CSV
- 📱 Responsive (mobile + desktop)
- 🔒 Clé API cachée côté serveur (Worker)
