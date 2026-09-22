# SPECTRE

Analyse de contenu par IA : page web rendue (navigateur headless), **texte collé** ou **document PDF/MD** → extraction → résumé ou réponse à une question.

Nom du projet : **SPECTRE** — « voir à travers » le contenu (rendu JavaScript inclus).

## Les 3 modes
| Mode | Entrée | Extraction |
|---|---|---|
| 🌐 Page web | URL | **Browserless** (Chromium headless, réseau Docker `apps`) — rend le JavaScript, puis texte du HTML |
| 📋 Texte collé | textarea | direct (idéal : copier-coller d'une page web, d'un article, d'un email) |
| 📄 Document | upload PDF/MD/TXT (≤ 20 Mo) | `pdftotext` (poppler) ou lecture directe |

Sans question : résumé en 5 points + « En bref : ». Avec question : réponse basée uniquement sur le contenu fourni.

## IA
- **OpenRouter** si `/etc/openrouter-key.txt` existe (root 600) — modèle configurable (`OPENROUTER_MODEL`, défaut `qwen/qwen-2.5-7b-instruct:free`). Réponse en 2-5 s au lieu de 50-80 s en Ollama CPU.
- **Fallback automatique : Ollama local** (`qwen2.5:3b`, réseau `apps`, `keep_alive: 0` → RAM déchargée après chaque réponse). Si OpenRouter échoue, bascule silencieuse + log.
- Le texte envoyé à l'IA est plafonné à **3 000 caractères (comme ÉCLAIREUR — prompt eval CPU)** (latence CPU + limite Cloudflare 100 s).

## Déploiement (VPS)
```bash
cd ~/projects/SPECTRE
sudo BROWSERLESS_TOKEN=$(grep BROWSERLESS_TOKEN ~/.env | cut -d= -f2) docker compose up -d --build
```
- Conteneur `spectre`, **127.0.0.1:8087**, réseau `apps` (accès browserless + ollama), mem_limit 512 m.
- Vhost Caddy `spectre.rennesdev.fr` (basic auth, credentials `/etc/caddy/spectre-auth.txt` root 600) — cert Let's Encrypt automatique dès que le **record DNS A** est créé (proxy orange).

## API
`POST /api/analyze`
```json
{"mode":"url","url":"https://…","question":null}
{"mode":"texte","texte":"…","question":"…"}
{"mode":"document","filename":"rapport.pdf","content":"<base64>","question":null}
```
Réponse : `{ok, source, chars, capped, answer, model, ms}` ou `{ok:false, error}`.

`GET /healthz` → `{ok:true}`.

## Tests réels (22/09)
- URL Wikipedia (Browserless + Ollama 3b) : résumé complet en ~76 s (OpenRouter : ~5 s attendus).
- Texte collé : analyse < 20 s.
- PDF multi-pages : texte extrait, analyse OK. MD : direct.
- Erreurs propres : URL invalide, fichier non supporté, texte vide.

## Limits assumées
- Lecture publique seule (pas de contournement de paywall/anti-bot).
- Pages très lourdes : Browserless a un délai de rendu — une erreur claire est renvoyée plutôt qu'un silence.
- 20 Mo max par document (limite raisonnable CPU pour pdftotext).