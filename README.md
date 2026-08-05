# Iconiques — scanner + salle de tri

Système en 3 pièces :

1. **`schema.sql`** — la table Supabase qui stocke les candidats et la bibliothèque.
2. **`reddit-scanner.mjs`** + **`.github/workflows/scan-reddit.yml`** — un scan automatique de subreddits toutes les 6h, qui pousse les posts image dépassant un seuil d'upvotes comme "candidats" **et enrichit chacun avec un maximum d'infos** (photographe présumé, lieu, date de prise de vue, source presse).
3. **`validation-dashboard.html`** — l'outil que tu utilises pour trier : garder / rejeter / marquer comme candidat à la vente (avec les champs droits/photographe **pré-remplis par la veille**).

Le champ `status` est la pièce centrale : un candidat détecté par le script ne devient jamais automatiquement "vendable". Il passe par `candidate` → `documented` (dans la bibliothèque, pas en vente) ou `rights_pending` (tu as identifié le potentiel et commencé à chercher le photographe/les droits) → `rights_cleared` (droits confirmés, seul statut qui devrait alimenter Iconiques.org côté vente).

## Enrichissement automatique (la veille récolte les métadonnées)

À chaque candidat retenu, le scanner essaie de récolter **avant même que tu tries** :

| Piste | D'où elle vient |
|---|---|
| Photographe présumé | EXIF `Artist` / IPTC `By-line`,`Credit` / XMP `dc:creator`,`photoshop:Credit`, sinon crédit repéré dans les commentaires (« Photo by… », « © … », « Credit: … ») |
| Copyright / crédit | EXIF `Copyright`, IPTC `Credit` |
| Lieu | GPS embarqué (→ lien carte OpenStreetMap dans le dashboard) ou ville/pays IPTC |
| Date de prise de vue | EXIF `DateTimeOriginal` |
| Appareil | EXIF `Make` / `Model` |
| Légende / contexte | IPTC/XMP caption |
| Agences citées | Reuters, AFP, AP, Getty, EPA… repérées dans le titre/commentaires |
| Sources presse | liens externes (hors reddit/imgur) trouvés dans les commentaires |

Ces pistes sont stockées dans des colonnes dédiées (`credited_photographer`, `gps_lat/lon`, `capture_datetime`, `source_links`, `agencies`, `enrichment` JSON brut, etc.) et affichées dans un bloc **« Pistes trouvées »** sur chaque carte à valider. Cliquer sur **« Candidat tirage »** ouvre un formulaire déjà **pré-rempli** (photographe, zone, notes) qu'il te reste à **vérifier et corriger**.

> ⚠️ **Tout est présumé.** L'EXIF est souvent supprimé par les CDN (Reddit réencode les images uploadées sur `i.redd.it`), et les crédits en commentaire sont une heuristique faillible. Le champ curé `photographer_name` (rempli à la main) reste distinct de `credited_photographer` (auto) et fait seul foi. Seules les photos passées manuellement en `rights_cleared` doivent alimenter la vente.

L'enrichissement s'appuie sur la lib [`exifr`](https://github.com/MikeKovarik/exifr) (déclarée dans `package.json`) pour lire EXIF/IPTC/XMP — d'où le step `npm install` dans le workflow.

## 1. Créer le projet Supabase

1. Sur [supabase.com](https://supabase.com), crée un projet (ou réutilise celui d'un de tes autres outils si tu préfères tout centraliser — dans ce cas, garde quand même une table dédiée `photos`).
2. Va dans **SQL Editor** → colle le contenu de `schema.sql` → Run. Le script est **ré-exécutable** : tu peux le relancer après une mise à jour, il ajoute les nouvelles colonnes sans rien casser.
3. Récupère dans **Project Settings → API** :
   - `Project URL` → `SUPABASE_URL`
   - `anon public` key → pour le dashboard
   - `service_role` key → pour le scanner (ne jamais l'exposer côté client)

## 2. Créer une app Reddit (pour le scanner)

1. Va sur [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) → **create another app**.
2. Type : **script**.
3. Redirect URI : `http://localhost` (obligatoire même si non utilisé pour ce flux).
4. Une fois créée, tu obtiens :
   - le **client ID** (sous le nom de l'app)
   - le **secret**

Le scanner utilise le grant `client_credentials` (accès "userless" en lecture seule) — pas besoin de mot de passe ni de compte dédié. Si la création d'app est bloquée ou lente côté Reddit (ça arrive), retente plus tard ou depuis un autre navigateur.

## 3. Configurer GitHub Actions

Dans le repo GitHub qui contient ce projet : **Settings → Secrets and variables → Actions → New repository secret**, ajoute :

- `REDDIT_CLIENT_ID`
- `REDDIT_CLIENT_SECRET`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY` (la clé **service_role**, pas l'anon)

Le workflow `.github/workflows/scan-reddit.yml` tourne toutes les 6h automatiquement, et peut aussi être lancé à la main depuis l'onglet **Actions** du repo (bouton "Run workflow"). Il fait un `npm install` (pour `exifr`) avant de lancer le scan.

Avant de pousser le code, édite `reddit-scanner.mjs` :
- remplace `CHANGE_ME` dans `USER_AGENT` par ton pseudo Reddit,
- ajuste la liste `SUBREDDITS` et `MIN_SCORE` selon ce que tu veux capter.

## 4. Configurer le dashboard

Dans `validation-dashboard.html`, remplace :

```js
const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR-ANON-KEY';
```

par tes vraies valeurs (clé **anon**, pas service_role — celle-ci ne doit jamais apparaître dans du code client). Déploie ensuite ce fichier sur GitHub Pages comme tes autres outils.

⚠️ Le dashboard utilise la clé anon avec droits d'écriture (via les policies RLS de `schema.sql`) pour que le tri fonctionne sans backend supplémentaire. Comme pour tes autres outils, la protection repose sur une URL non répertoriée plutôt qu'une vraie authentification — c'est un compromis raisonnable pour un usage perso, mais évite de partager le lien du dashboard largement.

## Sur le sujet des droits

Une photo qui devient virale reste soumise au droit d'auteur de la personne qui l'a prise — souvent difficile à identifier sur du contenu grassroots/anonyme. L'enrichissement automatique te donne un **point de départ** (photographe présumé, agence, source), mais le statut `rights_pending` est là pour matérialiser le vrai travail : une fois que tu as retrouvé/contacté le photographe et obtenu un accord clair (même simple : autorisation écrite, pourcentage convenu), tu bascules en `rights_cleared` via le bouton dans l'onglet "Prêt tirage". Seules les photos à ce statut devraient nourrir la vente sur Iconiques.org — tout le reste reste une bibliothèque de documentation.

## Limites connues

- Reddit uniquement pour l'instant. Twitter/X n'a plus d'API abordable pour ce genre d'usage — pour l'instant, il faudra soumettre ces photos manuellement (on peut ajouter un petit formulaire de soumission manuelle dans le dashboard si besoin).
- **EXIF/IPTC souvent absent** : les plateformes (dont Reddit sur `i.redd.it`) réencodent les images et suppriment les métadonnées. Quand c'est le cas, le scanner retombe sur les crédits en commentaire — moins fiable. D'où l'insistance sur « présumé / à vérifier ».
- **Reverse image search non automatisé** : l'origine réelle d'une photo (article de presse, agence) se trouve souvent via une recherche image inversée, qui n'a pas d'API gratuite. Le dashboard propose un lien **Google Lens** en un clic sur chaque carte pour le faire à la main.
- Le seuil `MIN_SCORE` et la liste de subreddits sont volontairement simples — à affiner une fois que tu vois le volume et la pertinence des candidats remontés.
- Pas de détection d'image dupliquée entre plateformes (une même photo qui circule sur plusieurs subreddits sous des posts différents créera plusieurs candidats) — gérable manuellement au tri pour l'instant.

---

# Indice RP (Public Relations) — brique indépendante

Une seconde brique, autonome, qui **suit la « good public relations » d'entreprises cotées** et en sort **un chiffre par jour, comme un indice boursier** (pour tracer des variations, faire des moyennes, comparer). Elle réutilise la même mécanique que la veille photo (scanner `.mjs` sur GitHub Actions → Supabase → dashboard statique) mais sur des tables séparées.

Trois pièces :

1. **`schema-pr.sql`** — les tables `companies`, `pr_articles` et `pr_index_snapshots`.
2. **`pr-scanner.mjs`** + **`.github/workflows/scan-pr.yml`** — un calcul quotidien qui, pour chaque entreprise suivie, récolte les titres d'articles récents (Google News RSS, gratuit, sans clé), les classe positifs/négatifs/neutres, repère les interviews du PDG dans la presse cible, et enregistre **un point d'indice par jour**.
3. **`pr-dashboard.html`** — le tableau de bord : indice courant + variation, mini-courbe d'historique, barre positif/négatif, ratio, interviews du PDG mises en avant.

## Comment l'indice est calculé

Sur une **fenêtre glissante de 90 jours**, pour chaque entreprise :

- On compte les titres **positifs (P)**, **négatifs (N)** et **neutres (Z)** (analyse lexicale du titre, FR + EN, avec gestion basique de la négation — voir `scoreSentiment` dans `pr-scanner.mjs`).
- **Balance de sentiment** : `balance = (P − N) / (P + N + 5)`, comprise entre −1 et +1. Le `+5` est un lissage qui évite qu'un seul article fasse basculer l'indice quand le volume est faible.
- **Bonus interviews** : chaque **interview/entretien du PDG dans un média cible** (Investir, Les Échos, Financial Times, Le Monde, Bloomberg, Reuters, Challenges, La Tribune, Le Figaro) ajoute des points, **dégressifs avec l'ancienneté** (une interview d'hier pèse plus qu'une d'il y a 3 mois), plafonnés à +18. La liste exacte est la constante `TIER1_SOURCES` en haut de `pr-scanner.mjs`.
- **Indice** : `100 + 40 × balance + bonus`.
  - **~100** = presse neutre ;
  - **> 100** = bonne presse (jusqu'à ~158 avec forte couverture positive + interviews) ;
  - **< 100** = mauvaise presse (plancher ~60).

Le ratio positif/négatif brut que tu voulais (`P / N`) est aussi stocké tel quel dans chaque snapshot (`ratio_pos_neg`).

Chaque run écrit **un point par entreprise et par jour** dans `pr_index_snapshots` — c'est cet historique que le dashboard trace, et sur lequel tu peux faire moyennes et variations.

## Mise en route

1. **Supabase** : dans le SQL Editor, exécute `schema-pr.sql` (ré-exécutable, il coexiste avec la table `photos`).
2. **Déclare tes entreprises** : le plus simple pour démarrer — exécute **`seed-cac40.sql`** qui insère d'un coup **les 40 valeurs du CAC 40** (nom, PDG, ticker). ⚠️ Les PDG bougent (changements récents chez Stellantis, Schneider, Renault, Kering, Vinci…) : `ceo_name` sert à détecter les interviews, corrige-le si un dirigeant a changé. Tu peux ensuite ajouter/retirer des lignes à la main dans la table `companies` (un exemple `insert` commenté est aussi en bas de `schema-pr.sql`). Champs clés :
   - `name` — nom affiché ;
   - `ceo_name` (+ `ceo_aliases`) — sert à repérer les interviews du PDG ;
   - `news_query` (facultatif) — requête Google News personnalisée pour désambiguïser (ex. « Orange » l'opérateur vs le fruit) ;
   - `active` — passe à `false` pour suspendre une entreprise.
3. **GitHub Actions** : les secrets `SUPABASE_URL` et `SUPABASE_SERVICE_KEY` (les mêmes que la veille photo) suffisent. Le workflow `scan-pr.yml` tourne une fois par jour et peut être lancé à la main (bouton *Run workflow*).
4. **Dashboard** : dans `pr-dashboard.html`, renseigne `SUPABASE_URL` / `SUPABASE_ANON_KEY` (clé **anon**), puis déploie-le sur GitHub Pages comme les autres. Il est **en lecture seule** (aucune écriture depuis le navigateur).

## Limites connues

- **Sentiment lexical, pas sémantique** : le score repose sur des mots-clés, pas sur une vraie compréhension. L'ironie, le second degré et les tournures ambiguës passent à travers. C'est un **signal agrégé** fiable sur le volume, pas un verdict article par article. `scoreSentiment` est isolée et exportée : on peut la remplacer par un appel LLM plus tard sans toucher au reste du pipeline.
- **« Longue » interview non vérifiable depuis le flux** : Google News RSS ne donne que le titre, pas la longueur de l'article (et Les Échos / Investir / FT / Le Monde sont derrière des paywalls). Le scanner flague donc une **interview du PDG dans un média cible** (nom du PDG + marqueur « interview/entretien » + source tier-1) sans pouvoir garantir la longueur. À affiner si besoin.
- **Dépendance à Google News RSS** : flux gratuit mais non officiel ; le nom du média vient du flux et peut être imparfait. La liste des médias « tier-1 » (`TIER1_SOURCES`) et le lexique sont en haut de `pr-scanner.mjs`, faciles à enrichir.
- **Fenêtre et pondérations** (`WINDOW_DAYS`, `SMOOTHING`, `SENTIMENT_SPAN`, `INTERVIEW_POINTS`…) sont des constantes en tête de `pr-scanner.mjs` — à calibrer une fois que tu vois les premiers indices.
