# Revue QA de feat/stable-100 — 16 septembre 2026

**Verdict : candidat refusé pour l'exigence « même expérience multijoueur, davantage de capacité ».** La réduction du trafic est réelle, mais deux régressions de présentation sont reproduites. Le budget CPU et l'endurance restent des conditions de validation distinctes.

## Périmètre et méthode

Comparaison avec `main` à `e596fef`, branche à `53bbb9f` : huit commits, les modifications locales déjà présentes et `tests/relevancy.test.ts` non committé. Le protocole effectivement testé est 7, format binaire 5. La revue couvre simulation, codecs, transport/admission, client, nouveaux tests et bancs de charge. Aucun fichier produit n'a été corrigé ; aucun commit, push ou déploiement.

Les preuves et scripts de reproduction sont dans `.runtime/qa-review-20260916/`. `source-hashes-before.json` identifie les sources, tests et outils testés ; la vérification des 140 empreintes ne trouve aucun changement pendant la revue. Les anciens résultats sont explicitement distingués des essais de cette revue.

## Anomalies reproduites

### P1 — une cible visible à l'AK gagne 50 ms de retard d'affichage

Dans `src/shared/game.ts:800`, une cible devant le joueur à plus de 50 unités passe à 10 Hz. `src/client/remote-players.ts:51` passe alors son tampon de présentation de 50 à 100 ms. Les collisions des tirs utilisent toujours la position autoritaire courante, sans compensation historique.

Reproduction A/B : cible marchant latéralement à 6 unités/s, 60 unités devant et 30 de côté, sans délai réseau. À X autoritaire = 70, `main` affiche 69,7 ; la branche affiche 69,4000015. Le rayon centré sur la cible affichée touche avec la présentation de `main` et manque avec celle de la branche, en appelant le vrai `GameServer.playerHit`. Cela isole la géométrie et le retard de présentation ; ce n'est pas une session humaine ni un test incluant la dispersion de l'arme.

Preuves : `client-latency-repro.ts`, `client-latency-repro.json`. Commande : `bun .runtime/qa-review-20260916/client-latency-repro.ts`.

**À résoudre avant acceptation :** préserver le délai de présentation antérieur. Réduire la cadence des cibles visibles constitue ici un compromis de gameplay, pas une optimisation transparente. La compression différentielle et la séparation public/propriétaire peuvent être conservées indépendamment de ce choix.

### P2 — la minicarte avance par sauts pour les alliés derrière

Les positions derrière la caméra, au-delà de cinq unités, passent à 5 Hz. `src/client/main.ts:616` fournit à la minicarte les positions brutes des snapshots, sans utiliser l'interpolation des personnages.

Reproduction avec un allié sprintant à 9 unités/s, vingt unités derrière : son marqueur avance de 5,4 pixels toutes les 200 ms, contre 1,35 pixel toutes les 50 ms auparavant. Le même script contient les positions et dates réellement reçues. Cette régression est visible même lorsque le personnage est hors écran.

### P1 — le banc de charge peut valider un serveur qui ignore les commandes

`scripts/loadtest.ts:264` et `:280` comptent les intentions émises pour déclarer que tous les clients jouent. Aucun critère ne vérifie la progression de `lastSeq` ni la présence des effets attendus.

Contre-exemple exécuté sur une instance locale de test : toutes les commandes `input` sont ignorées. Deux clients pendant trois secondes obtiennent néanmoins `ok: true` et tous les critères vrais : 364 frames supprimées, `lastSeq = 0`, aucun tir, aucune mort, aucune modification de terrain. L'égalité des terrains et la fermeture propre passent également puisqu'il ne se produit rien.

Preuves : `transport-false-positive.ts`, `transport-false-positive-evidence.json`. L'interception est limitée à cette reproduction, sans changement du serveur produit.

Les essais complémentaires de cette revue utilisent des copies locales du banc (`transport-observed-load.ts`, `transport-observed-qualify.ts`) qui observent les acquittements par connexion/manche et comptent les événements sur un seul témoin. Le générateur, les cadences et les critères existants sont conservés. Ces copies ne corrigent pas le banc durable du dépôt. Un acquittement ne prouve pas à lui seul la justesse d'un déplacement : la comparaison de simulation ci-dessous constitue une vérification indépendante.

## Changements de comportement qui ne sont pas des optimisations transparentes

- **Équipement : déconnexion après deux minutes**, même avec des pings réguliers (`src/shared/game.ts:703`). Reproduit à 120001 ms. Cela touche aussi un joueur mort qui tarde à choisir son kit.
- **Admission : 24 connexions au maximum par IP** par défaut. Refus de la 25e reproduit. Un réseau partagé peut donc être limité avant la capacité globale.
- **Arrivée sur terrain très modifié :** nouvelles limites de volume, concurrence et délai pouvant refuser une arrivée. Elles bornent les coûts ; elles ne garantissent pas que tout nouveau joueur pourra toujours rejoindre une manche longue.

Ces choix sont documentés et peuvent être justifiés pour la stabilité, mais ils doivent être assumés comme changements de comportement.

Avant toute publication derrière Caddy, vérifier explicitement `TRUST_PROXY=loopback` et la transmission correcte de l'IP réelle. Avec le défaut `none` et le proxy local, toutes les connexions peuvent partager le plafond de 24. La configuration de production n'a pas été inspectée ni modifiée pendant cette revue.

## Vérifications réussies

- `bun run doctor` : environnement prêt, Bun 1.3.11.
- `bun run check` complet : **555 tests, 48 252 assertions, zéro échec**, TypeScript strict et build client de 11 fichiers. Le premier passage a rencontré 17 échecs `EPERM` de création de sous-processus ; le passage autorisé complet réussit sans désactiver de test. Preuve : `check-full.log`.
- **Comparaison déterministe de simulation avec main :** 16 joueurs, 3600 ticks en TDM puis 3600 en FFA, trois resets par mode. États complets des joueurs, projectiles, scores et révisions comparés à chaque tick ; terrain comparé toutes les secondes. Identiques, avec 5622 tirs, 103 morts et 3510 écritures de terrain observés. Toutes les classes participent. Preuves : `gameplay-parity.ts`, `.json`, `.log`. Le RNG est identique dans cette comparaison ; le serveur réseau utilise désormais une source indépendante pour la dispersion.
- **Reconstruction réseau aléatoire :** 4514 snapshots vérifiés, huit historiques indépendants, 28 joueurs, six manches, 286 omissions et 262 réparations complètes. Identités, champs privés, suppressions et projectiles comparés à un oracle ; aucun écart. Preuve : `replication-randomized.ts`.
- **GPU réel du navigateur : « RÉSULTAT : SUCCÈS »** pour terrain, ombres, traces hitscan, armes/canons, grenades, personnages, ragdolls et neige. Aucun avertissement/erreur console capturé.
- **Deux vrais clients navigateur :** pseudo → équipement → apparition Assault/Sniper, HUD 100 HP et 30/30 ou 5/5, terrain, arme et minicarte visibles. Smoke protocole 7 réussi avec vrais inputs acquittés, visée/annulation et départ. Après fermeture : zéro joueur/socket/octet en attente. Preuves : `browser-results.json`, `browser-health.json`, `browser-cleanup.json`.

Le navigateur intégré refuse la capture de souris. Le parcours et le rendu sont vérifiés ; les sensations à la souris, les téléphones physiques et le rendu de 100 navigateurs ne sont pas qualifiés.

## Mesures comparatives exécutées pendant cette revue

Deux essais successifs de 120 secondes, 100 bots, TDM, carte 256 × 256 × 64, sans reset ni délai ajouté, sur le Ryzen 7 5800X / 32 Gio local, Bun 1.3.11. Le serveur est un processus séparé ; aucun profilage ni autre banc de charge QA simultané.

La référence utilise les sources de `main` extraites sans checkout. Le même générateur de charge actuel sert aux deux versions : seuls le décodeur protocole 3 et la récupération de l'état propriétaire ont été adaptés pour `main`. Les intentions sont identiques dans leur génération, mais les combats ne sont pas un replay déterministe et la source aléatoire réseau a changé. Les résultats ne mesurent ni TCP/TLS/WebSocket ni le GPU.

| Mesure | main / protocole 3 | Branche / protocole 7 |
|---|---:|---:|
| Trafic descendant agrégé | 290,87 Mbit/s | **85,90 Mbit/s** |
| Dont snapshots | 119,10 Mbit/s | **28,31 Mbit/s** |
| Maximum des p99 serveur échantillonnés | **5,02 ms** | **8,47 ms** |
| RSS maximale échantillonnée | 240,82 Mio | 252,82 Mio |
| Activité des joueurs | 99,22 % | 99,03 % |
| Intentions/s/joueur actif | 59,93 | 59,94 |
| Inputs / ticks abandonnés | 0 / 0 | 0 / 0 |
| Terrain final identique au serveur, nettoyage | Oui | Oui |
| Critères du banc | Réussis | **Échec CPU : seuil < 8 ms** |

Le trafic baisse de **70,5 %** au total et de **76,2 %** pour les snapshots. En revanche, cet essai n'établit pas un gain CPU : le maximum des p99 augmente de 68,6 %. Il s'agit du maximum des percentiles sur fenêtres de 1024 ticks, et non du p99 de tous les ticks du run. Aucun critère n'a été assoupli.

Les compteurs montrent une activité comparable : environ 44053 / 44080 événements de tir et 1143 / 1256 morts, obtenus en divisant les livraisons par les 100 destinataires présents ; écritures terrain 202075 / 205598. Le défaut du critère `allClientsPlayed` n'est donc pas utilisé comme seule preuve d'activité.

Preuves : `ab-main.*`, `ab-branch.*`, `ab-summary.json`, `prepare-baseline.ts` dans le dossier QA.

### Réseau retardé, arrivées tardives et resets

**300 secondes, 100 bots, TDM carte 256, délai de 50 ±20 ms par sens, reset toutes les 90 s et reconnexion toutes les 30 s.** Le serveur produit est intact ; seule l'observation du banc côté client est renforcée. Résultat : neuf reconnexions, trois resets reçus par les 100 clients, progression des acquittements pour **les 109 connexions successives**, aucune connexion exemptée faute d'activité suffisante. Activité 97,97 %, 59,94 intentions/s/joueur actif.

Le témoin unique reçoit 100899 tirs AK, 4623 tirs AWP, 3475 lancers de grenade, 2902 explosions, 2839 morts et 1764 constructions. Il observe 524296 écritures de terrain pendant les différentes manches, dont 163061 mises à zéro. Les compteurs portent sur les événements et écritures reçus pendant la mesure, pas sur des blocs uniques.

**Aucune erreur applicative, aucun input/tick abandonné**, égalité finale SHA256 du terrain avec le serveur. Nettoyage serveur et proxy confirmé : zéro connexion, zéro octet différé, aucun débordement du proxy. RSS maximale 248,43 Mio. Le test échoue cependant au **seul critère CPU : maximum des p99 à 8,26 ms**, seuil strict < 8 ms. Trafic descendant 85,34 Mbit/s.

Preuves : `observed-latency.json`, `.jsonl`, `.qualification.json`, `.proxy.log`. Les options et le chemin du script sont dans les commandes enregistrées de la revue ; reproduction :

```sh
bun .runtime/qa-review-20260916/transport-observed-qualify.ts --players=100 --seconds=300 --mode=tdm --size=256 --round-seconds=90 --latency-ms=50 --jitter-ms=20 --reconnect-seconds=30 --warmup-seconds=15 --output=.runtime/qa-review-20260916/observed-latency-rerun.json
```

### Joueurs concentrés

**120 secondes, 100 bots, FFA carte 64, sans délai ajouté, reset toutes les 30 s.** Les quatorze critères du banc renforcé passent : quatre resets, trois reconnexions, progression des acquittements pour les 103 connexions successives. Activité 98,14 %, 59,90 intentions/s/joueur actif. Le témoin reçoit notamment 46501 événements de tir, 2020 morts, 405 constructions et 23521 écritures de terrain.

Maximum des p99 échantillonnés **6,55 ms**, sortie **67,09 Mbit/s**, RSS maximale **241,98 Mio**. Aucun input/tick abandonné ni erreur applicative. Terrain final identique au serveur et fermeture complète. Ce succès valide ce scénario court ; il ne remplace ni la correction des deux échecs CPU sur grande carte ni l'endurance.

Preuves : `observed-concentrated.json`, `.jsonl`, `.qualification.json`. Reproduction :

```sh
bun .runtime/qa-review-20260916/transport-observed-qualify.ts --players=100 --seconds=120 --mode=ffa --size=64 --round-seconds=30 --reconnect-seconds=30 --warmup-seconds=15 --output=.runtime/qa-review-20260916/observed-concentrated-rerun.json
```

## Endurance et limites

L'ancien essai du protocole 6 est relu dans les preuves existantes, **pas réexécuté ici** : `.runtime/stable-100/soak-scoped-8h.json` échoue après 12835,875 secondes, soit 3 h 34 min, à 1026,13 Mio de RSS pour un plafond de 1024. Il avait effectué 42 resets et 210 reconnexions. Sa cause reste ouverte ; cela n'établit pas à lui seul une fuite JavaScript ni une défaillance reproduite du protocole 7.

Des essais courts du protocole 7 ne remplacent pas une endurance réussie sans profileur. Une qualification ultérieure doit aussi couvrir le matériel serveur cible et un réseau réel ; les mesures locales ci-dessus ne constituent pas une capacité garantie de production. Une nouvelle tentative de huit heures n'a pas été engagée alors que les critères de présentation et de CPU échouent déjà.

## Conditions avant acceptation

1. Rétablir la présentation antérieure des cibles et de la minicarte. Pour respecter strictement le périmètre annoncé, conserver les gains de codec/deltas tout en revenant à la cadence de mouvement antérieure est la correction la plus directe à évaluer.
2. Intégrer au banc durable des contrôles d'acquittement et d'activité autoritaire, puis protéger les deux régressions de présentation par des tests comparatifs.
3. Résoudre le dépassement CPU et repasser les scénarios à 100 joueurs sans relever le seuil de 8 ms.
4. Fermer le sujet mémoire avec une endurance sans profileur, puis vérifier les conditions du serveur cible et du proxy avant une publication autorisée.
5. Faire valider explicitement les nouvelles limites visibles : durée dans l'équipement et admission par IP.
