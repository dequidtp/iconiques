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
