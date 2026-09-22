# UBERCUBE

FPS multijoueur en TypeScript, Three.js et Bun, dans un monde voxel constructible et destructible. En multijoueur, le serveur possède la simulation ; le navigateur envoie les commandes et affiche le résultat. Si le serveur est absent ou inaccessible, le mode solo exécute la même simulation dans le navigateur, sans bots ni sauvegarde.

La version publiée implémente la boucle complète : pseudo → équipement → partie → mort → nouvel équipement. Le Java de `../ubercube` reste une référence en lecture seule. Ses modèles, sons, police et textures réutilisés sont copiés dans `public/assets` avec leur licence ; voir [THIRD_PARTY.md](THIRD_PARTY.md).

Depuis la publication du 15 septembre 2026, les personnages tués deviennent des ragdolls avec impulsion au point d'impact, collisions avec le terrain destructible et durée de vie bornée. Voir [le fonctionnement et les limites](docs/player-reference.md#ragdolls).

L'AK-47 et l'AWP utilisent des tirs instantanés autoritaires, avec traces jaunes brèves et impulsions ragdoll conservées. Client et serveur ont été publiés ensemble avec le protocole 3 ; les grenades restent physiques. Voir [la preuve de publication](docs/deployment.md#publication-du-hitscan-et-des-ragdolls--15-septembre-2026).

Publié le 21 septembre 2026 : le bazooka RPG est disponible dans le kit assaut, après l'AK-47 à la molette, avec un modèle polygonal facetté créé dans le style de l'AK-47 et de l'AWP. Sa silhouette et sa palette approuvées sont conservées : l'ogive olive quitte désormais le lanceur au tir, la visée passe par sa lentille transparente avec le zoom AWP, et les autres joueurs le portent sur les avant-bras au repos puis sur l'épaule en visée. Sa roquette vole à 60 blocs/s et explose avec des dégâts légèrement inférieurs à ceux d'une grenade. Le médic conserve son sac de soins. Le client et le serveur sont publiés ensemble avec le protocole 4 ; voir [la preuve de publication](docs/deployment.md#publication-du-bazooka-assaut--21-septembre-2026). [Référence Java, modèle et comportement](docs/bazooka.md).

Publié le 21 septembre 2026 : death cam de 3 s puis kill cam de 3 s, sneak sur Maj, course sur Ctrl, réticules pour toutes les armes, dégâts de chute entre 6 et 20 blocs et auto-soin du médic au clic droit. Client et serveur sont publiés ensemble avec le protocole **6**. [Règles et limites du replay](docs/gameplay-client.md#ajouts-du-21-septembre-2026).

Ajustements locaux du 22 septembre, non publiés : pointeur conservé pendant les deux caméras et kill cam portée à 5 s, avec 2 s d'action après la mort. Sur ordinateur, entrer en jeu ou reprendre demande le plein écran et la capture clavier pour courir avec Ctrl tout en affichant les scores avec Tab. Échap libère les captures ; les raccourcis réservés restent possibles si le navigateur refuse ou ne prend pas en charge la capture clavier.

## Reprendre le projet

Nouveau développeur ou agent : lire [AGENTS.md](AGENTS.md), puis le [guide de démarrage](docs/agent-start.md). Il donne les points d'entrée du code, les décisions produit, les vérifications et les accès de publication sans dépendre d'un historique de discussion.

Le site est [www.ubercube.io](https://www.ubercube.io/), le serveur de partie [game.ubercube.io](https://game.ubercube.io/health). Client Vercel, serveur Bun permanent sur Hetzner, protocole 6. Le dernier état publié **enregistré** est dans [ops/production.json](ops/production.json) avec ses empreintes client/serveur ; il doit être revérifié avant une publication.

Chaque nouvelle publication Vercel doit provenir d'un **commit poussé sur GitHub**, normalement par le déploiement automatique de `main`. Terminer et tester le travail, créer des commits ciblés, puis pousser lorsqu'une publication est demandée. Vérifier ensuite le SHA réellement publié. Les anciennes publications depuis des fichiers locaux sont conservées comme faits historiques dans [docs/deployment.md](docs/deployment.md) ; elles ne constituent plus une procédure de publication.

## Lancer le jeu

Prérequis pour développer : Bun 1.3.11 ou compatible. Pour jouer : navigateur avec WebGL2, clavier/souris ou écran tactile.

```sh
bun install --frozen-lockfile
bun run doctor
bun run dev
```

Ouvrir `http://localhost:3000` dans Chrome, Firefox ou Edge. Le serveur accepte les connexions réseau locales par défaut. Pour écouter uniquement sur cette machine :

```sh
bun run dev --hostname=127.0.0.1
```

Le mode développement recompile le client lorsqu'un fichier change et relance le serveur lorsque son code change. Actualiser la page pour charger le nouveau client. Un redémarrage serveur termine la partie et efface les modifications du terrain.

Pour exécuter une compilation stable :

```sh
bun run build
bun run start --mode=tdm
# Ou une partie chacun pour soi :
bun run start --mode=ffa --port=3001
```

Aucun compte, aucune base de données, aucun service externe nécessaire pour développer ou jouer en local. Le pseudo est conservé localement dans le navigateur ; se reconnecter crée une nouvelle session et de nouveaux scores personnels. Le dépôt Java n'est pas requis pour compiler ou exécuter les tests ; il sert aux nouvelles comparaisons de référence.

Pour la mise en ligne avec client Vercel et serveur Bun permanent : [publication et rollback](docs/releasing.md). Préparer une release fige un commit dans un arbre de travail propre ; cette étape locale ne publie rien.

Avant une publication serveur, `bun run doctor --server` vérifie la connexion SSH et le script de déploiement privilégié sans redémarrer le jeu. Sur le poste de Marc, les agents du même compte Windows utilisent l'accès dédié configuré hors du dépôt ; aucun mot de passe issu d'une ancienne conversation n'est nécessaire.

```sh
bun run release:prepare --id=YYYYMMDD-HHMMSS
bun run release:vercel status
```

Le premier argument est un identifiant unique à remplacer par la date/heure choisie. Le développement autorise les inspections Git et les commits locaux nécessaires à la tâche ; une demande de publication autorise le push de la branche choisie et sa publication. Ne jamais réécrire un historique publié ni pousser en force sans demande explicite. Les accès GitHub, Vercel et SSH restent privés, hors du dépôt ; [AGENTS.md](AGENTS.md) précise les règles.

Les métadonnées de référencement, les aperçus de partage avec le visuel historique et le contenu de présentation sont décrits dans [docs/seo.md](docs/seo.md).

## Commandes

| Action | Clavier / souris | Mobile |
|---|---|---|
| Déplacement | ZQSD sur AZERTY / WASD sur QWERTY | Joystick gauche |
| Regarder | Souris | Glisser à droite, ou glisser sur Tirer |
| Saut / course | Espace / Ctrl | Saut / pousser le joystick au bord |
| Sneak, protection des bords | Maintenir Maj | Bouton Sneak pour activer/désactiver |
| Tir / visée | Clic gauche / clic droit | Maintenir et glisser sur Tirer, ou double appui maintenu à droite / appuyer sur Viser pour basculer |
| Changer d'arme ou d'outil | Molette | Flèches autour du nom de l'arme |
| Pelle : creuser / construire | Clic gauche / clic droit | Creuser / Bâtir |
| Grenade | Maintenir le clic gauche puis relâcher | Maintenir Lancer puis relâcher |
| Médecin | Clic gauche : autre joueur à portée ; clic droit : soi-même | Soigner / Se soigner |
| Scores / menu | Tab / Échap | Maintenir Score / Menu |
| Couper / rétablir le son | F1 | Menu → options → Audio |

Le menu reprend les composants Java : sensibilités normale et en visée, volume, neige, ombres et supersampling (SSAA). Les réglages sont appliqués immédiatement et conservés dans le navigateur. La vSync dépend du navigateur et ne peut pas être désactivée par la page. La partie continue pendant la pause. Le clavier/souris nécessite la capture du pointeur ; certains navigateurs intégrés refusent cette fonction. Les commandes tactiles fonctionnent sans cette API, en portrait et en paysage. Une interruption du geste, une rotation ou un passage en arrière-plan annule les actions en cours sans lancer une grenade involontairement.

Le gain audio global est divisé par 50. Le curseur démarre à 100 % pour une nouvelle préférence ; les réglages enregistrés sont conservés. Cette réduction s'applique à toute la plage du curseur.

Les ombres reposent sur quatre cascades Three.js de 4096 × 4096, dans les limites du GPU, avec une précision concentrée près du joueur et des contours sans flou. La projection est stabilisée pendant les déplacements et s'adapte au zoom ainsi qu'au format de la fenêtre. L'éclairage de chaque face dépend de son orientation vers le soleil ; les faces opposées restent à l'ombre ambiante. Ce réglage demande davantage de calcul et de mémoire GPU que les anciennes cartes 2048 × 2048.

Sur mobile, le rendu utilise des cascades de 2048 × 2048, une distance de 96 blocs par défaut (128 maximum) et un ratio de pixels plafonné à 1,5 avant SSAA. Le HUD est compact, les boutons et réglages s'adaptent aux petits écrans et aux encoches, en conservant la police et les composants originaux. Les performances sur téléphone physique restent à mesurer.

L'accueil conserve le panorama voxel animé. Le lobby utilise le fond original, la carte vue de dessus et les trois aperçus d'armes tournants ; cliquer sur Assault, Sniper ou Medic fait apparaître directement le joueur. Le HUD et la minicarte reprennent les dimensions, la police et les textures de référence. Les détails et limites de cette reprise figurent dans [docs/ui-reference.md](docs/ui-reference.md).

## Règles implémentées

- TDM : admission jusqu'à 100 joueurs par défaut, affectation à l'équipe la moins nombreuse, départ immédiat sans attendre d'autres joueurs.
- FFA : admission identique, sans équipe, classement par éliminations.
- Assaut : AK-47, bazooka, grenades, pelle. Sniper : AWP, grenades, pelle. Médecin : soins, AK-47, grenades, pelle.
- Bazooka : roquette physique à 60 blocs/s, fumée, cadence de 62 ticks et chargeur de 30 renouvelé après passage sous zéro. Un joueur ou bloc touché déclenche une explosion : 80 PV sur impact direct sans cumul, dégâts radiaux dégressifs jusqu'à 10 blocs, y compris sur le tireur, et destruction du terrain dans un rayon de 3,5 blocs. La grenade conserve son maximum de 100 PV et son rayon terrain de 4 blocs. L'ogive olive du modèle devient le projectile en vol et revient sur le tube après la cadence ; la visée utilise la lentille transparente et le zoom/réticule AWP. Le son AK du prototype est conservé.
- AK-47 et AWP : raycasts instantanés au tick serveur, arrêt au premier joueur ou bloc et traces jaunes cosmétiques de 60 ms. Portées maximales de 2 400 / 4 800 blocs, également bornées aux limites du monde. Pose du canon, dispersion, dégâts de tête et cadence restent décidés par le serveur. Chargeurs renouvelés instantanément après passage sous zéro ; aucun rechargement temporisé ajouté.
- Maniement des armes repris des updates Java à 60 Hz : positions et pivots OBJ, changement d'arme, inertie souris, balancement marche/course, recul, visée et zoom AWP. Cadences AK-47 de 8 ticks et AWP de 62 ticks ; pelle et soins par clic, grenade chargée puis lancée au relâchement. Le client anticipe l'animation et le son ; le serveur confirme les tirs et leurs effets.
- Personnages distants repris du renderer Java actif : dix volumes articulés, palette verte et peau, tête, marche/course et poses de visée, armes originales attachées aux mains et pseudos Riffic aux couleurs des équipes. Références et adaptations : [personnages Java](docs/player-reference.md).
- Grenades avec charge, rebonds et dégâts radiaux ; modèle original visible dès le relâchement pour le tireur, avec prédiction visuelle et correction sur les confirmations serveur. Les grenades des autres joueurs conservent un tampon de 100 ms pour lisser les snapshots 20 Hz. Pelle, construction et résistance des blocs ; les dégâts partiels assombrissent les blocs.
- Tirs alliés et soins possibles sur l'autre équipe, conformément aux chemins actifs du Java. En TDM, une mort rapporte un point à l'équipe opposée à celle de la victime.
- Sneak : marche à 3 blocs/s, priorité sur la course et protection des bords au sol. Sauter quitte volontairement le support ; un bloc détruit sous les pieds ne peut plus retenir le joueur. La hitbox conserve sa hauteur.
- Chutes : aucun dégât jusqu'à 6 blocs, puis `floor((hauteur − 6) × 100 / 14)` PV à l'atterrissage ; 13 blocs enlèvent 50 PV, 20 blocs ou davantage tue. Règles autoritaires communes avec le solo.
- Médic : sac sélectionné, clic droit pour récupérer 10 PV par appui, plafond 100. Le maintien ne répète pas les soins. Le clic gauche soigne toujours les autres joueurs à portée.
- Réapparition sur le terrain actuel : death cam de 3 s sur le corps, puis kill cam de 5 s dans la vue reconstruite du tueur, dont 2 s après la mort, avant le choix du kit (ajustement local non publié). Chute, suicide ou absence d'historique exploitable : death cam seule. Réticule pour chaque arme, y compris AK/AWP hors lunette ; la lunette garde son réticule spécifique.
- Réinitialisation du terrain, des projectiles et des scores entre les manches. Les anciens messages sont rejetés par leur identifiant de manche.
- Relief enneigé du générateur Java, chênes et grands chênes avec leurs branches et couronnes d'origine. Ruines historiques et hangars avec portes, fenêtres et intérieurs, entièrement destructibles. Les apparitions recherchent le sol praticable sous la végétation. Références, adaptations et validation : [génération du terrain](docs/terrain-generation.md).

Les règles et transformations des armes sont vérifiées contre le code Java ; la sensation des déplacements et le maniement en partie restent à comparer avec une session humaine du Java. Références, adaptations et limites : [référence gameplay](docs/gameplay-client.md).

## Configuration

Les arguments `--nom=valeur` prennent priorité sur les variables d'environnement. Bun peut charger un fichier `.env` local ; un modèle est fourni dans [.env.example](.env.example).

| Argument | Variable | Défaut |
|---|---|---|
| `--mode` | `MODE` | `tdm` (`tdm` ou `ffa`) |
| `--port` | `PORT` | `3000` |
| `--hostname` | `HOST` | `0.0.0.0` |
| `--max-players` | `MAX_PLAYERS` | `100` |
| `--seed` | `WORLD_SEED` | `12345` |
| `--size` | `WORLD_SIZE` | `256` blocs de côté |
| `--height` | `WORLD_HEIGHT` | `64` blocs |
| `--round-seconds` | `ROUND_SECONDS` | `0` (fin automatique désactivée) |

La taille accepte 64 à 2048 blocs, la hauteur 32 à 256, par multiples de 16. Ces bornes sont des validations de configuration, pas des garanties de performances. La distance affichée par défaut est de 160 blocs ; une préférence de distance enregistrée précédemment est conservée entre 64 et 256 blocs. Les maillages résidents sont bornés et générés progressivement.

Exemple d'une manche de test de cinq minutes :

```sh
bun run start --mode=tdm --round-seconds=300 --size=512
```

La durée définitive et une éventuelle limite de score restent des décisions produit ; la valeur zéro ne tranche pas ces règles.

## Architecture

| Dossier | Responsabilité |
|---|---|
| `src/server` | Exécution autoritaire multijoueur, transport Bun, fichiers statiques et métriques |
| `src/shared` | Simulation commune au serveur et au solo, admission, règles, données voxel, mouvement, protocole et codec binaire |
| `src/client` | Three.js, prédiction et réconciliation, interpolation, entrées, interface, sons et workers de terrain |
| `scripts` | Compilation, développement et clients de charge |
| `scripts/release`, `ops` | Préparation/publication, rollback, cibles et empreintes de production sans secrets |
| `tests` | Autorité, collisions, terrain, cycle de vie et transport réel |

La simulation avance à 60 Hz ; les états sont diffusés à 20 Hz dans un format binaire. Les intentions, événements et mutations de terrain utilisent JSON. L'identité, le temps de simulation, les impacts, la vie et les ressources sont décidés par le serveur. Les tailles, fréquences, files d'entrée et buffers réseau sont bornés.

Les intentions sont envoyées dès l'image qui les produit, sans attendre trois commandes. Après une pointe réseau, le serveur regroupe les intentions identiques déjà maintenues pour résorber le retard ; chaque appui, relâchement et changement d'arme conserve son ordre et son identifiant, avec une seule simulation par tick. Les personnages distants utilisent une interpolation sur les ticks serveur, avec environ 50 ms de tampon sur un réseau stable, augmenté selon la gigue observée. Une interruption réseau conserve la dernière position confirmée.

Le monde de base est déterministe à partir d'une graine. Un cache borné de colonnes compactes et les seules modifications du monde remplacent une allocation d'objets par voxel. Deux workers au maximum produisent les maillages avec fusion de faces compatibles et occlusion ambiante ; les travaux périmés sont ignorés après modification ou reset.

Un arrivant reçoit les différences par rapport au monde généré et rattrape les mutations survenues pendant ce transfert avant d'apparaître. La première version emploie une révision globale de terrain et diffuse les entités de toute la partie. Le découpage spatial des réplications et un niveau de détail lointain restent à développer pour les très grandes cartes.

## Vérifier et mesurer

```sh
bun run check
# Serveur démarré dans un autre terminal :
bun run loadtest --players=100 --seconds=30
```

`check` exécute TypeScript strict, les tests et la compilation du navigateur. Le test de charge utilise de vraies connexions WebSocket avec déplacements, tirs, grenades, construction, morts et réapparitions ; son rapport est écrit dans `.runtime/loadtest-latest.json`. Un autre serveur se cible avec `--url=ws://adresse:port/ws`.

Pour vérifier les shaders sur un GPU réel, lancer `bun scripts/visual-check.ts`, puis ouvrir `http://127.0.0.1:3011/`. Cette page locale de test vérifie les pixels du terrain, des particules, de la neige et des balles, le brouillard, les quatre cascades d'ombres, leurs raccords, le déplacement des ombres et leur activation. Elle charge aussi les six modèles, dont le bazooka polygonal en OBJ/MTL, affiche leurs captures en repos/action/visée et contrôle les aperçus du lobby. Elle doit afficher « RÉSULTAT : SUCCÈS ». Arrêter le serveur de test avec Ctrl+C. Ces contrôles navigateur sont distincts de `bun run check`.

`/health` et `/api/status` exposent les temps de tick p50/p95/p99, les retards de simulation, les commandes en attente, la mémoire résidente et la population. Les percentiles portent sur les 1024 derniers ticks ; maximum et retards sont cumulés depuis le lancement.

Les résultats et leurs limites figurent dans [docs/validation.md](docs/validation.md). Un test local de bots ne remplace ni 100 navigateurs ni un essai Internet prolongé.

## Travaux restants

- Validation des sensations face au Java et essais avec plusieurs joueurs humains.
- Compensation de latence du combat : les tirs sont actuellement résolus au temps serveur, sans historique des joueurs et du terrain.
- Validation de charge prolongée sur machines distinctes et matériel cible, réseau dégradé, consommation GPU et grandes distances.
- Réplication spatiale, terrain lointain et adaptation des budgets selon les mesures.
- Supervision et alertes prolongées sur l'hébergement déjà en ligne ; Vercel et HTTPS/WSS sur Hetzner sont opérationnels.
- Effondrements et scaling horizontal ultérieurs. Une base de données seule ne distribue pas une simulation temps réel ; le choix entre plusieurs parties et une seule partie répartie reste ouvert.

Les notes de cadrage dans `docs/` décrivent également des mécanismes prévus qui ne sont pas encore tous réalisés ; ce README et la validation décrivent l'implémentation livrée.
