-- Bibliothèque de photos iconiques — schéma Supabase
-- À exécuter dans l'éditeur SQL de ton projet Supabase (SQL Editor > New query)
-- Ré-exécutable sans risque : tout est en "if not exists" / colonnes nullables.

create table if not exists photos (
  id uuid primary key default gen_random_uuid(),

  -- Provenance
  source_platform text not null default 'reddit',
  reddit_post_id text unique,           -- clé de dédup pour le scanner
  source_url text not null,             -- lien vers le post d'origine (crédit)
  image_url text not null,              -- lien direct vers l'image (hotlink, pas de rehost)
  subreddit text,
  title text,                           -- titre du post d'origine
  score int,                            -- upvotes au moment du scan
  num_comments int,
  posted_at timestamptz,                -- date de publication d'origine
  captured_at timestamptz not null default now(), -- date de détection par le scanner

  -- Curation (remplis par toi dans le dashboard)
  conflict_region text,                 -- ex: "Iran", "Soudan", "Gaza"
  description text,                     -- contexte, ce que la photo représente
  iconic_score smallint,                -- ta note perso 1-5, optionnel

  -- Statut — LE champ qui sépare "documenté" de "vendable"
  -- candidate       -> détecté par le scanner, pas encore trié
  -- rejected        -> pas retenu
  -- documented      -> retenu dans la bibliothèque (archive/sensibilisation), PAS en vente
  -- rights_pending  -> candidat pour Iconiques.org, droits en cours de clarification
  -- rights_cleared  -> droits confirmés, utilisable pour la vente de tirages
  status text not null default 'candidate'
    check (status in ('candidate','rejected','documented','rights_pending','rights_cleared')),

  -- Droits (à remplir avant tout passage en rights_cleared)
  photographer_name text,               -- photographe CONFIRMÉ à la main (fait foi)
  rights_notes text,                    -- contact, échanges, statut de la licence
  validated_at timestamptz
);

-- ---------------------------------------------------------------------------
-- Enrichissement automatique par la veille (voir reddit-scanner.mjs)
-- Ces colonnes sont des PISTES présumées, à vérifier — jamais la vérité.
-- Le champ curé "photographer_name" ci-dessus reste distinct et prioritaire.
-- ---------------------------------------------------------------------------
alter table photos add column if not exists credited_photographer text; -- meilleure hypothèse fusionnée
alter table photos add column if not exists credit_source text;         -- d'où vient l'hypothèse: exif|iptc|xmp|comment|title
alter table photos add column if not exists exif_artist text;           -- EXIF Artist / XMP dc:creator
alter table photos add column if not exists exif_copyright text;        -- EXIF Copyright
alter table photos add column if not exists exif_credit text;           -- IPTC Credit / XMP photoshop:Credit
alter table photos add column if not exists exif_caption text;          -- IPTC/XMP légende (contexte)
alter table photos add column if not exists camera_make text;
alter table photos add column if not exists camera_model text;
alter table photos add column if not exists capture_datetime timestamptz; -- EXIF DateTimeOriginal
alter table photos add column if not exists gps_lat double precision;
alter table photos add column if not exists gps_lon double precision;
alter table photos add column if not exists location_guess text;        -- IPTC City/Country ou piste commentaire
alter table photos add column if not exists source_links jsonb;         -- liens presse externes trouvés (array)
alter table photos add column if not exists agencies jsonb;             -- agences repérées (Reuters, AFP...) (array)
alter table photos add column if not exists enrichment jsonb;           -- dump brut (crédits candidats, exif complet)
alter table photos add column if not exists enriched_at timestamptz;    -- null = pas encore enrichi

create index if not exists photos_status_idx on photos (status);
create index if not exists photos_score_idx on photos (score desc);
create index if not exists photos_region_idx on photos (conflict_region);
create index if not exists photos_credited_idx on photos (credited_photographer);

-- RLS : à activer si le dashboard tourne avec la clé anon (recommandé)
alter table photos enable row level security;

-- Lecture publique (le dashboard doit pouvoir lister)
drop policy if exists "public read" on photos;
create policy "public read" on photos
  for select using (true);

-- Écriture publique via anon key — à restreindre si tu déploies l'URL largement.
-- Pour un usage perso avec URL non répertoriée, ça reste raisonnable (même logique
-- que tes autres outils GitHub Pages + Supabase).
drop policy if exists "public update" on photos;
create policy "public update" on photos
  for update using (true);

drop policy if exists "service insert" on photos;
create policy "service insert" on photos
  for insert with check (true);
