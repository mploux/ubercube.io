# UBERCUBE

FPS multijoueur en TypeScript, Three.js et Bun, dans un monde voxel constructible et destructible. En multijoueur, le serveur possède la simulation ; le navigateur envoie les commandes et affiche le résultat. Si le serveur est absent ou inaccessible, le mode solo exécute la même simulation dans le navigateur, sans bots ni sauvegarde.

Cette première version locale implémente la boucle complète : pseudo → équipement → partie → mort → nouvel équipement. Le Java de `../ubercube` reste une référence en lecture seule. Ses modèles, sons, police et textures réutilisés sont copiés dans `public/assets` avec leur licence ; voir [THIRD_PARTY.md](THIRD_PARTY.md).

## Lancer le jeu

Prérequis pour développer : Bun 1.3.11 ou compatible. Pour jouer : navigateur avec WebGL2, clavier/souris ou écran tactile.

```sh
bun install --frozen-lockfile
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

Aucun compte, aucune base de données, aucun service externe de jeu. Le pseudo est conservé localement dans le navigateur ; se reconnecter crée une nouvelle session et de nouveaux scores personnels.

Pour la mise en ligne avec client Vercel et serveur Bun permanent : [procédure de déploiement](docs/deployment.md).

## Commandes

| Action | Clavier / souris | Mobile |
|---|---|---|
| Déplacement | ZQSD sur AZERTY / WASD sur QWERTY | Joystick gauche |
| Regarder | Souris | Glisser à droite, ou glisser sur Tirer |
| Saut / course | Espace / Maj | Saut / pousser le joystick au bord |
| Tir / visée | Clic gauche / clic droit | Tirer / maintenir Viser |
| Changer d'arme ou d'outil | Molette | Flèches autour du nom de l'arme |
| Pelle : creuser / construire | Clic gauche / clic droit | Creuser / Bâtir |
| Grenade | Maintenir le clic gauche puis relâcher | Maintenir Lancer puis relâcher |
| Médecin | Clic gauche sur un autre joueur à portée | Soigner sur un autre joueur à portée |
| Scores / menu | Tab / Échap | Maintenir Score / Menu |
| Couper / rétablir le son | F1 | Menu → options → Audio |

Le menu reprend les composants Java : sensibilités normale et en visée, volume, neige, ombres et supersampling (SSAA). Les réglages sont appliqués immédiatement et conservés dans le navigateur. La vSync dépend du navigateur et ne peut pas être désactivée par la page. La partie continue pendant la pause. Le clavier/souris nécessite la capture du pointeur ; certains navigateurs intégrés refusent cette fonction. Les commandes tactiles fonctionnent sans cette API, en portrait et en paysage. Une interruption du geste, une rotation ou un passage en arrière-plan annule les actions en cours sans lancer une grenade involontairement.

Les ombres reposent sur quatre cascades Three.js de 4096 × 4096, dans les limites du GPU, avec une précision concentrée près du joueur et des contours sans flou. La projection est stabilisée pendant les déplacements et s'adapte au zoom ainsi qu'au format de la fenêtre. L'éclairage de chaque face dépend de son orientation vers le soleil ; les faces opposées restent à l'ombre ambiante. Ce réglage demande davantage de calcul et de mémoire GPU que les anciennes cartes 2048 × 2048.

Sur mobile, le rendu utilise des cascades de 2048 × 2048, une distance de 96 blocs par défaut (128 maximum) et un ratio de pixels plafonné à 1,5 avant SSAA. Le HUD est compact, les boutons et réglages s'adaptent aux petits écrans et aux encoches, en conservant la police et les composants originaux. Les performances sur téléphone physique restent à mesurer.

L'accueil conserve le panorama voxel animé. Le lobby utilise le fond original, la carte vue de dessus et les trois aperçus d'armes tournants ; cliquer sur Assault, Sniper ou Medic fait apparaître directement le joueur. Le HUD et la minicarte reprennent les dimensions, la police et les textures de référence. Les détails et limites de cette reprise figurent dans [docs/ui-reference.md](docs/ui-reference.md).

## Règles implémentées

- TDM : admission jusqu'à 100 joueurs par défaut, affectation à l'équipe la moins nombreuse, départ immédiat sans attendre d'autres joueurs.
- FFA : admission identique, sans équipe, classement par éliminations.
- Assaut : AK-47, grenades, pelle. Sniper : AWP, grenades, pelle. Médecin : soins, AK-47, grenades, pelle.
- Projectiles à vitesse finie, dégâts de tête, pose du canon et cadence décidés par le serveur. Balles jaunes du Java animées entre les snapshots, y compris les tirs qui touchent avant le prochain snapshot. Chargeurs renouvelés instantanément après passage sous zéro ; aucun rechargement temporisé ajouté.
- Maniement des cinq armes repris des updates Java à 60 Hz : positions et pivots OBJ, changement d'arme, inertie souris, balancement marche/course, recul, visée et zoom AWP. Cadences AK-47 de 8 ticks et AWP de 62 ticks ; pelle et soins par clic, grenade chargée puis lancée au relâchement. Le client anticipe l'animation et le son ; le serveur confirme les projectiles et leurs effets.
- Grenades avec charge, rebonds et dégâts radiaux ; modèle original visible dès le relâchement pour le tireur, avec prédiction visuelle et correction sur les confirmations serveur. Les grenades des autres joueurs conservent un tampon de 100 ms pour lisser les snapshots 20 Hz. Pelle, construction et résistance des blocs ; les dégâts partiels assombrissent les blocs.
- Tirs alliés et soins possibles sur l'autre équipe, conformément aux chemins actifs du Java. En TDM, une mort rapporte un point à l'équipe opposée à celle de la victime.
- Réapparition sur le terrain actuel, choix du kit après la mort, sons, effets, minicarte et tableau des scores.
- Réinitialisation du terrain, des projectiles et des scores entre les manches. Les anciens messages sont rejetés par leur identifiant de manche.

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
| `tests` | Autorité, collisions, terrain, cycle de vie et transport réel |

La simulation avance à 60 Hz ; les états sont diffusés à 20 Hz dans un format binaire. Les intentions, événements et mutations de terrain utilisent JSON. L'identité, le temps de simulation, les impacts, la vie et les ressources sont décidés par le serveur. Les tailles, fréquences, files d'entrée et buffers réseau sont bornés.

Le monde de base est déterministe à partir d'une graine. Un cache borné de colonnes compactes et les seules modifications du monde remplacent une allocation d'objets par voxel. Deux workers au maximum produisent les maillages avec fusion de faces compatibles et occlusion ambiante ; les travaux périmés sont ignorés après modification ou reset.

Un arrivant reçoit les différences par rapport au monde généré et rattrape les mutations survenues pendant ce transfert avant d'apparaître. La première version emploie une révision globale de terrain et diffuse les entités de toute la partie. Le découpage spatial des réplications et un niveau de détail lointain restent à développer pour les très grandes cartes.

## Vérifier et mesurer

```sh
bun run check
# Serveur démarré dans un autre terminal :
bun run loadtest --players=100 --seconds=30
```

`check` exécute TypeScript strict, les tests et la compilation du navigateur. Le test de charge utilise de vraies connexions WebSocket avec déplacements, tirs, grenades, construction, morts et réapparitions ; son rapport est écrit dans `.runtime/loadtest-latest.json`. Un autre serveur se cible avec `--url=ws://adresse:port/ws`.

Pour vérifier les shaders sur un GPU réel, lancer `bun scripts/visual-check.ts`, puis ouvrir `http://127.0.0.1:3011/`. Cette page locale de test vérifie les pixels du terrain, des particules, de la neige et des balles, le brouillard, les quatre cascades d'ombres, leurs raccords, le déplacement des ombres et leur activation. Elle charge aussi les cinq OBJ/MTL originaux, affiche leurs captures en repos/action/visée et contrôle les aperçus du lobby. Elle doit afficher « RÉSULTAT : SUCCÈS ». Arrêter le serveur de test avec Ctrl+C. Ces contrôles navigateur sont distincts de `bun run check`.

`/health` et `/api/status` exposent les temps de tick p50/p95/p99, les retards de simulation, les commandes en attente, la mémoire résidente et la population. Les percentiles portent sur les 1024 derniers ticks ; maximum et retards sont cumulés depuis le lancement.

Les résultats et leurs limites figurent dans [docs/validation.md](docs/validation.md). Un test local de bots ne remplace ni 100 navigateurs ni un essai Internet prolongé.

## Travaux restants

- Validation des sensations face au Java et essais avec plusieurs joueurs humains.
- Compensation de latence du combat : les tirs sont actuellement résolus au temps serveur, sans historique des joueurs et du terrain.
- Validation de charge prolongée sur machines distinctes et matériel cible, réseau dégradé, consommation GPU et grandes distances.
- Réplication spatiale, terrain lointain et adaptation des budgets selon les mesures.
- Mise en ligne avec HTTPS/WSS et supervision sur l'hébergement choisi.
- Effondrements et scaling horizontal ultérieurs. Une base de données seule ne distribue pas une simulation temps réel ; le choix entre plusieurs parties et une seule partie répartie reste ouvert.

Les notes de cadrage dans `docs/` décrivent également des mécanismes prévus qui ne sont pas encore tous réalisés ; ce README et la validation décrivent l'implémentation livrée.
