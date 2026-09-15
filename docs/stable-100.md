# Première qualification à 100 joueurs

Travail commencé le 15 septembre 2026 sur `feat/stable-100`. Cette page décrit les changements locaux et les critères de validation ; elle ne constitue pas une preuve de publication ni de capacité de production.

## Stabilité du transport

- Simulation 60 Hz et snapshots 20 Hz conservés. Chaque destinataire dispose du contrôle de son propre buffer : snapshots ignorés au-delà de 64 Kio, fermeture au-delà de 512 Kio. Les événements et mutations restent ordonnés et fiables tant que la connexion tient son budget.
- Dans Bun, les messages d'un tick sont envoyés dans un seul `ws.cork` par socket. La file transitoire est limitée à 1 024 messages et compte dans les 512 Kio. Les métriques comptent les envois réels et le temps de vidage fait partie du temps de tick. Cela évite les écritures natives isolées qui avaient porté le p99 échantillonné au-delà de 25 ms à 50 joueurs ; le même palier passe ensuite sous 3 ms dans les essais locaux.
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

Le code local utilise **protocole 4 / format binaire 2**. Les snapshots, mutations terrain et événements fréquents sont binaires ; les événements de mort, hello côté client, welcome, reset, erreur et pong restent JSON. Les événements conservent leurs coordonnées Float64 et les snapshots leur précision Float32. Aucune modification des cadences, dégâts ou trajectoires.

Les snapshots sont autonomes, avec entiers compacts exacts et omission des flottants `+0`. Un client dont un snapshot a été ignoré peut décoder le suivant sans état de compression à resynchroniser.

Une publication devra coordonner client et serveur. Les manifests `ops/` décrivent toujours la dernière production enregistrée, en protocole 3 ; ils ne sont pas actualisés par ces essais locaux.

## Qualification

`bun run qualify:local` lance le serveur dans un processus Bun séparé, écoute uniquement sur `127.0.0.1` et utilise une exception d'admission explicite pour les bots locaux. Le parent inspecte le terrain autoritaire par IPC privé après drainage ; aucun endpoint de debug n'est ajouté au jeu.

Chaque client valide l'ordre des manches et révisions. Deux répliques voxel indépendantes comparent le terrain à révision égale. À la fin, les actions sont neutralisées, les commandes et grenades sont drainées, puis l'empreinte SHA256 du terrain du témoin est comparée au serveur. Les rapports `.json`, leur journal `.jsonl` et la preuve `.qualification.json` vont dans `.runtime/`.

Critères : population demandée, activité d'au moins 80 %, au moins 55 intentions par seconde de joueur actif, aucune erreur applicative, aucun input/tick abandonné, p99 serveur échantillonné inférieur à 8 ms, convergence finale et nettoyage des connexions. Le p99 porte sur les fenêtres de 1 024 ticks ; le banc conserve son maximum échantillonné. Les octets applicatifs excluent TCP/TLS/WebSocket.

La tenue prolongée sur le matériel cible, Internet et des navigateurs reste distincte d'un essai de bots sur une machine locale.

Le runner accepte `--latency-ms=50 --jitter-ms=20` : un proxy TCP Node.js local retarde chaque sens de 50 ms avec une variation de ±20 ms, en conservant l'ordre des octets. Il borne les fragments retardés à 1 Mio par sens, 64 Mio cumulés et 256 connexions ; les buffers de flux ont aussi un seuil de 64 Kio. Cela simule délai et gigue, sans simuler perte de paquets ni débit limité. Node.js 22.19 est utilisé parce qu'une troncature de données retardées après demi-fermeture TCP a été reproduite avec Bun 1.3.11. Cette différence concerne le proxy de test ; elle ne démontre pas une troncature des messages du serveur WebSocket du jeu.

`--cpu-profile` active le profileur du seul processus serveur et écrit `.runtime/stable-100/server-profile.md`. Utiliser une exécution séparée pour le diagnostic : un profil n'est pas la preuve de performance de référence.
