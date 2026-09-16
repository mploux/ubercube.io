# Première qualification à 100 joueurs

Travail commencé le 15 septembre 2026 sur `feat/stable-100`. Cette page décrit les changements locaux et les critères de validation ; elle ne constitue pas une preuve de publication ni de capacité de production.

## Stabilité du transport

- Simulation 60 Hz et snapshots 20 Hz conservés. Chaque destinataire dispose du contrôle de son propre buffer : snapshots ignorés au-delà de 64 Kio, fermeture au-delà de 512 Kio. Les événements et mutations restent ordonnés et fiables tant que la connexion tient son budget.
- Dans Bun, les messages d'un tick sont envoyés dans un seul `ws.cork` par socket. La file transitoire est limitée à 1 024 messages et compte dans les 512 Kio. Les métriques comptent les envois réels et le temps de vidage fait partie du temps de tick. Les essais historiques avant le protocole 6 avaient mesuré un p99 supérieur à 25 ms à 50 joueurs avec des écritures natives isolées, puis inférieur à 3 ms au même palier avec ce regroupement ; ces valeurs ne qualifient pas le nouveau contrat.
- Une synchronisation initiale expirée ou trop coûteuse ferme proprement sa connexion. Elle ne reprend plus une nouvelle baseline sur une réplique partiellement modifiée, ce qui créait des blocs fantômes.
- Au plus 16 transferts simultanés de terrain modifié ; baseline limitée à 524 288 éditions, total des baselines distinctes retenues à 1 048 576 éditions. Les références partagées à une même baseline ne sont comptées qu'une fois.
- Chaque transfert garde au plus 32 768 éditions et 256 messages de rattrapage. Il expire après 30 secondes réelles. Le rattrapage traite jusqu'à quatre lots de 512 éditions par appel et termine dès que la file est vide, même si le terrain change chaque tick.
- Le terrain initial envoie un lot au hello, puis jusqu'à huit lots par tick avec contrôle du buffer entre lots. Un seul lot par tick remplissait les 256 messages de rattrapage avant la fin d'une baseline volumineuse ; les tests couvrent maintenant jusqu'à 524 288 éditions sous mutations continues.
- Les délais et fréquences utilisent une horloge monotone dans le serveur Bun. Le solo conserve son horloge de simulation. Le rattrapage de simulation reste limité à quatre ticks ; les retards supérieurs à 250 ms sont désormais comptabilisés intégralement.

Ces budgets bornent la mémoire des transferts, pas le nombre total de modifications de la manche. Au-delà du budget de baseline, les arrivées échouent proprement. Les règles de fin de manche restent un choix produit ; aucun reset forcé n'a été introduit.

## Admission et autorité

Avant l'upgrade WebSocket : au plus `MAX_PLAYERS + 16` connexions, 24 par IP par défaut, crédits d'ouverture de 2/s/IP et 20/s au total (pics initiaux 24/IP et 200). La table des IP est limitée à 4 096 entrées, avec expiration des entrées inactives après cinq minutes. Une fermeture libère sa place mais ne rembourse pas le crédit d'ouverture.

Les en-têtes `X-Forwarded-For` sont ignorés par défaut. `TRUST_PROXY=loopback` ne les accepte que depuis le proxy local ; seule la dernière adresse de la chaîne est utilisée. Les IPv4 et leurs formes IPv6 mappées sont normalisées. Pour ce mode, Bun doit écouter sur loopback et le proxy local doit fournir l'adresse réelle de son pair. Ce réglage devra être appliqué et vérifié lors d'une publication autorisée ; il n'a pas été changé sur la production.

Le délai sans hello reste cinq secondes et celui sans message trente secondes. Une session qui reste dans l'équipement sans apparaître libère sa place après deux minutes, même si elle envoie des pings. Une mort ou un reset ouvre une nouvelle période d'équipement. Les intentions restent validées et limitées côté serveur. La dispersion multijoueur utilise une source aléatoire serveur indépendante de la graine publique du terrain ; le solo et les tests restent reproductibles.

Les positions des joueurs sont encore diffusées globalement : ce jalon ne résout pas le wallhack. La sélection des informations visibles et la compensation de latence du combat nécessitent une étape dédiée. Les limites applicatives ne qualifient pas la protection de l'hébergement contre un DDoS.

## Contrat réseau

Le code local utilise **protocole 7 / format binaire 5**. Les snapshots, mutations terrain et événements fréquents sont binaires ; les événements de mort, le registre des joueurs (`roster`), hello côté client, welcome, reset, erreur et pong restent JSON. Les événements conservent leurs coordonnées Float64 et les snapshots leur précision Float32. Les cadences des armes, dégâts et trajectoires sont inchangés.

Le registre fiable transmet identifiant, pseudo et équipe à l'arrivée, puis leurs changements et les départs. Il est borné aux joueurs actifs et conservé entre les manches ; une nouvelle connexion repart d'un registre vide. Il précède les snapshots qui utilisent ces identités, sans répéter les pseudos dans chaque mise à jour du mouvement.

Les enveloppes de snapshots restent à **20 Hz par connexion**. Les destinataires sont répartis entre trois phases du serveur à 60 Hz, choisies au hello selon le groupe le moins peuplé. Cela étale l'encodage sans ajouter de file ni différer les événements ; une phase vide ne construit aucun snapshot. Les arrivées, apparitions et resets conservent leur état immédiat. Le premier état est complet ; les suivants transmettent les champs modifiés, les entités ajoutées et les identifiants supprimés, avec retour à un état complet si celui-ci est plus petit. Les autres joueurs exposent position, vitesse horizontale, orientation, arme visible, visée, état vivant, scores et présence de grenades (`hasGrenades`). Santé, kit, munitions, nombre de grenades, acquittement d'input, état au sol et vitesse verticale restent dans l'état privé `owner`, destiné à la seule connexion concernée.

### Priorité des mouvements par destinataire

Le serveur calcule la cadence d'après les positions et orientations autoritaires. Les distances sont en unités du monde voxel ; elles ne définissent pas une nouvelle échelle physique du jeu.

| Situation de la cible | Cadence de mouvement |
|---|---:|
| Joueur local, ou observateur mort dont la caméra est détachée | 20 Hz |
| Distance au plus 5 unités, toutes directions | 20 Hz |
| Derrière la caméra au-delà de 5 unités | 5 Hz |
| Zone avant, distance au plus 50 unités | 20 Hz |
| Zone avant, au-delà de 50 unités | 10 Hz |
| Zone avant avec AWP équipée, même sans zoom et sans limite de distance | 20 Hz |

La zone avant conserve une marge de 15 degrés derrière le plan de la caméra, en tenant compte du yaw et du pitch. Elle est volontairement plus large que la lunette : une cible lointaine reste prioritaire pendant un déplacement du viseur. Une hausse de priorité force une mise à jour au prochain snapshot ; une baisse doit rester demandée pendant 12 ticks (200 ms). Les cadences réduites sont réparties entre les snapshots selon l'identifiant de la cible afin d'éviter un envoi groupé de tous les joueurs lents.

Chaque état public porte `sampleTick` (date réelle de sa capture) et `sampleInterval` (3, 6 ou 12 ticks). Un état non actualisé reste présent dans la référence avec sa date précédente ; il n'est ni supprimé ni présenté comme une nouvelle observation. Les changements d'arme, visée, vie, présence de grenades et scores forcent une capture fraîche sans attendre l'échéance de mouvement. Les corrections privées du propriétaire et les positions des projectiles restent à 20 Hz ; les événements et mutations terrain conservent leur diffusion actuelle.

Le client interpole séparément chaque personnage avec un historique borné à 40 échantillons et le tampon correspondant à sa cadence (50, 100 ou 200 ms, plus la gigue). L'horloge réseau utilise les ticks des 40 dernières enveloppes, pas l'âge des personnages retardés. Une promotion réduit progressivement le délai de présentation, avec une vitesse de lecture plafonnée à deux fois le temps réel : le passage de 5 à 20 Hz rattrape ainsi 150 ms de retard en environ 150 ms. Une baisse de fréquence peut brièvement tenir la pose pendant la constitution du tampon plus long. Mort, nouvelle génération de vie, téléportation, reset et départ ne sont pas interpolés avec l'ancien état. Le délai réseau reste observable lors d'un demi-tour brusque : la priorité ne peut pas fournir un état qui n'est pas encore arrivé.

Cette priorité de fréquence n'est pas un filtrage anti-wallhack : toutes les identités et les positions restent connues, à des cadences différentes. Elle ne filtre pas encore les tirs, sons, impacts ou explosions. À 100 joueurs regroupés dans la zone prioritaire, la réduction de trafic attendue est faible.

Les positions des grenades restent publiques. Leurs corrections de vitesse dans `projectileVelocities` ne sont envoyées qu'à leur propriétaire ; l'événement de lancement conserve sa vitesse initiale ponctuelle. La séquence d'input des événements de tir est également réservée au tireur. Une mort transmet seulement l'état nécessaire au corps visuel, le point d'impact et l'impulsion : aucune santé, aucun kit, aucune réserve de munitions ni séquence privée.

L'échéance de manche est un tick fixe `roundEndTick` (ou `null`), à partir duquel le client calcule le temps restant. Elle remplace le décompte flottant modifié à chaque snapshot.

| Champs | Transmission en fonctionnement normal | Destinataires |
|---|---|---|
| `id`, `name`, `team` du registre | Découverte, changement ou départ ; `id` sert ensuite de référence | Tous |
| `position`, `velocity.x/z`, `yaw`, `pitch` | Champs modifiés à 5, 10 ou 20 Hz selon priorité ; capture forcée lors d'une transition publique critique | Tous, sélection par destinataire |
| `sampleTick`, `sampleInterval` | Date de capture et cadence du mouvement ; conservées quand la cible n'est pas actualisée | Tous, sélection par destinataire |
| `weapon`, `aiming`, `alive`, `hasGrenades` | Transition, dans le prochain snapshot | Tous |
| `kills`, `deaths` | Changement/reset, dans le prochain snapshot ; `deaths` identifie aussi la génération de vie | Tous |
| `lastSeq`, `velocity.y` du joueur | Champs modifiés avec la correction à 20 Hz | Propriétaire |
| `kit`, `health`, `ammo`, `grenades`, `grounded` | Changement/reset, dans le prochain snapshot | Propriétaire |
| Projectile : `id`, `owner`, `weapon` | Création puis référence/suppression ; propriétaire et arme restent constants | Tous |
| Projectile : `position` | Champs modifiés, au plus 20 Hz | Tous |
| Projectile : `velocity` | Composantes modifiées, au plus 20 Hz | Lanceur |
| `scores`, `roundEndTick` | Changement/reset ; le client calcule le décompte | Tous |

Les événements de mort restent immédiats et indépendants du snapshot suivant. Les états complets d'arrivée ou de réparation retransmettent les valeurs publiques et privées nécessaires, même inchangées ; ils réutilisent les identités du registre. Aucun canal supplémentaire à cadence différente n'est ajouté pour les transitions : les masques différentiels évitent de répéter les valeurs constantes dans le flux existant.

Un identifiant de snapshot distinct du tick désigne chaque référence. Le serveur capture une représentation publique immuable puis sélectionne les états actualisés par destinataire ; le cas entièrement prioritaire partage encore son encodage entre les connexions ayant la même référence. L'état privé est ajouté séparément. Chaque connexion conserve ses dernières références publique et privée acceptées par la file ordonnée ; aucune référence n'avance après un abandon. Arrivée, reset et reprise après saturation envoient un état complet frais. Le reset invalide les références et priorités, conserve le registre fiable et réinitialise tous les joueurs avant d'envoyer le premier état de la nouvelle manche. Le décodeur est propre à chaque connexion et reconstruit les états sans modifier ceux déjà utilisés par l'interpolation. Une référence incompatible provoque une erreur explicite et une reconnexion.

Un état complet n'est encodé qu'au besoin ; sa taille exacte, calculée lors de la validation des champs, suffit pour comparer le coût du delta. Les destinataires partagent les identifiants et leur index ; seuls les tableaux de références aux champs sélectionnés diffèrent. Les octets des changements publics, identifiant compris, sont partagés par couple d'échantillons immuables du même joueur, dans un cache propre à chaque capture et limité à 100 entrées par joueur. Ces entrées ne contiennent aucune ancienne frame. Les octets des projectiles sont partagés par couple de références. Le paquet personnalisé assemble directement les sections publique et privée dans un seul buffer ; les données privées restent propres au destinataire. Au plus trois variantes de cadence partagent une capture ; les autres caches utilisent des clés faibles.

Une publication devra coordonner client et serveur. Les manifests `ops/` décrivent toujours la dernière production enregistrée, en protocole 3 ; ils ne sont pas actualisés par ces essais locaux.

## Qualification

Les mesures des protocoles précédents sont historiques. L'essai d'endurance du protocole 5 a été interrompu volontairement pour une évolution du contrat après **2 606,233 secondes mesurées**, soit environ **43,4 minutes**. L'arrêt et le nettoyage ont été confirmés (`clean: true`, zéro connexion restante dans le proxy). Cet essai ne valide ni huit heures d'endurance ni les protocoles suivants. Les résultats datés, leurs preuves et leurs limites sont suivis dans [validation.md](validation.md) ; un essai court réussi ne remplace pas la qualification d'endurance du protocole 7.

`bun run qualify:local` lance le serveur dans un processus Bun séparé, écoute uniquement sur `127.0.0.1` et utilise une exception d'admission explicite pour les bots locaux. Le parent inspecte le terrain autoritaire par IPC privé après drainage ; aucun endpoint de debug n'est ajouté au jeu.

Chaque client valide l'ordre des manches et révisions. Deux répliques voxel indépendantes comparent le terrain à révision égale. À la fin, les actions sont neutralisées, les commandes et grenades sont drainées, puis l'empreinte SHA256 du terrain du témoin est comparée au serveur. Les rapports `.json`, leur journal `.jsonl` et la preuve `.qualification.json` vont dans `.runtime/`.

Critères : population demandée, activité d'au moins 80 %, au moins 55 intentions par seconde de joueur actif, aucune erreur applicative, aucun input/tick abandonné, p99 serveur échantillonné inférieur à 8 ms, convergence finale et nettoyage des connexions. Le p99 porte sur les fenêtres de 1 024 ticks ; le banc conserve son maximum échantillonné. Les octets applicatifs excluent TCP/TLS/WebSocket.

Le banc impose aussi un budget RSS serveur de **1 024 Mio** par défaut, configurable avec `--max-server-rss-mib` (`0` désactive ce contrôle). Un dépassement enregistré fait échouer l'essai et ferme ses connexions, même si la mémoire redescend ensuite. C'est un critère du banc, pas une politique de redémarrage du jeu. Respecter ce plafond pendant un essai court ne prouve pas l'absence d'une croissance sur plusieurs heures ; comparer aussi les relevés après chaque reset et les statistiques du tas.

La tenue prolongée sur le matériel cible, Internet et des navigateurs reste distincte d'un essai de bots sur une machine locale.

Le runner accepte `--latency-ms=50 --jitter-ms=20` : un proxy TCP Node.js local retarde chaque sens de 50 ms avec une variation de ±20 ms, en conservant l'ordre des octets. Il borne les fragments retardés à 1 Mio par sens, 64 Mio cumulés et 256 connexions ; les buffers de flux ont aussi un seuil de 64 Kio. Cela simule délai et gigue, sans simuler perte de paquets ni débit limité. Node.js 22.19 est utilisé parce qu'une troncature de données retardées après demi-fermeture TCP a été reproduite avec Bun 1.3.11. Cette différence concerne le proxy de test ; elle ne démontre pas une troncature des messages du serveur WebSocket du jeu.

`--cpu-profile` active le profileur du seul processus serveur et écrit `.runtime/stable-100/server-profile.md`. Utiliser une exécution séparée pour le diagnostic : un profil n'est pas la preuve de performance de référence.

`--memory-profile` écrit `<rapport>.memory.jsonl` dans `.runtime/`, avec les statistiques mémoire du seul processus serveur au démarrage, toutes les 60 secondes et à la fin. Les champs ordinaires de `/health` distinguent déjà `rss`, `heapUsed`, `heapTotal`, `external` et `arrayBuffers`, ainsi que les sockets de transport et les octets/messages de la file transitoire. Ce sont des valeurs instantanées ; une file vide au relevé ne prouve pas qu'elle est toujours vide.

Le profil mémoire est un **diagnostic distinct de la qualification d'endurance**, signalé par `diagnostic: true` dans la preuve finale. Aucun appel explicite au GC n'est ajouté. Toutefois, dans [Bun 1.3.11](https://github.com/oven-sh/bun/blob/af24e281ebacd6ac77c0f14b4206599cf4ae1c9f/src/bun.js/modules/BunJSCModule.h#L221-L295), `heapStats()` peut lancer une collecte complète si la taille du tas vaut zéro ; les comptages suivants parcourent le tas et reconstruisent des listes libres de l'allocateur. Certains compteurs reflètent la dernière collecte. Le profil peut donc perturber les temps et l'allocation : un plateau observé avec cette option doit être confirmé sans profilage.

Pour arrêter proprement un essai, créer le fichier `<output>.stop` : avec `--output=.runtime/qualification-100.json`, il s'agit de `.runtime/qualification-100.json.stop`. Le runner le vérifie une fois par seconde, interrompt les bots, ferme les connexions et conserve les rapports avec un résultat d'échec/interruption. Un fichier déjà présent interrompt aussi le prochain essai utilisant ce nom ; le retirer avant une relance volontaire.
