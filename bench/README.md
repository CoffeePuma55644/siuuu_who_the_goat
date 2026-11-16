# Banc d'essai

Prérequis : Docker, k6, Bun. Depuis la racine du dépôt.

```sh
bun bench/run.ts build                       # construit les 4 images (Rust : plusieurs minutes)
bun bench/run.ts smoke                       # équivalence fonctionnelle des 4 versions
bun bench/run.ts run                         # mesures par défaut (mixed, 10/100/500 VU, 5 essais de 8 s)
bun bench/run.ts run --runs 10 --scenarios get_one,post,mixed --levels 10,100,500   # plus complet
```

Sorties : `bench/results/results_<date>.csv` (une ligne par mesure) et `bench/results/raw/*.json` (résumé k6 de chaque essai).

## Protocole

- Un conteneur neuf par mesure : base SQLite fraîche (1000 tâches), `--cpus 2 --memory 2g` (modifiable).
- Warm-up de 3 s (scénario mixed, 10 VU) écarté, puis mesure de `--duration` secondes.
- Boucle fermée : chaque VU enchaîne les requêtes sans pause. Les VU sont une concurrence, pas un débit imposé.
- Ordre des technologies tiré au hasard à chaque palier, pour ne pas favoriser la première ou la dernière.
- CPU/RAM : `docker stats` échantillonné pendant la mesure. CPU% est relatif à 1 cœur (max 200 % avec 2 cœurs).
- k6 tourne sur l'hôte, donc il se partage la machine avec Docker. Cela borne les chiffres à haute charge : à écrire dans les limites.

## À déclarer dans le rapport

- SQLite : `bun:sqlite` (Bun), `rusqlite` bundled (Rust), `modernc.org/sqlite` pur Go sans CGO (Go). Les trois pilotes n'ont pas les mêmes performances ; ce n'est donc pas un pur test de langage.
- Une seule connexion par processus, WAL, `synchronous=NORMAL`.
- Validation manuelle dans les 4 versions (pas de validation native des frameworks).
- Rust : profil `release` par défaut ; Go : `go build` par défaut.
