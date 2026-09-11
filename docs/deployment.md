# Déployer UBERCUBE

Le client statique peut être servi par Vercel et permet de jouer seul sans hébergement supplémentaire. Pour le multijoueur, la simulation reste dans un processus Bun permanent, sur une seule instance pour la première version. Le serveur conserve le monde en mémoire : son redémarrage termine les sessions et réinitialise le terrain. Les connexions et instances temporaires des Vercel Functions ne conviennent pas au monde partagé actuel.

## Serveur de partie

Installer les dépendances puis lancer `bun run start`, ou construire le `Dockerfile` fourni. L'image ne contient que le serveur et le code partagé ; elle ne sert pas l'interface du jeu. Exposer le port 3000 derrière un proxy HTTPS qui transmet les connexions WebSocket `/ws`. Conserver l'en-tête `Host` public. Exécuter une seule instance avec redémarrage automatique.

Variables du processus serveur, en remplaçant les domaines d'exemple :

```dotenv
MODE=tdm
HOST=0.0.0.0
PORT=3000
MAX_PLAYERS=100
ALLOWED_ORIGINS=https://ubercube.example,https://ubercube-project.vercel.app
```

`MODE=ffa` lance une partie chacun pour soi. Les autres réglages figurent dans `.env.example`. `ALLOWED_ORIGINS` contient des origines HTTP(S) exactes, sans chemin, identifiants ou joker. Les accès du même hôte et les clients non navigateur sans en-tête `Origin` restent compatibles. Ajouter explicitement chaque domaine de prévisualisation autorisé ; tous les sites `*.vercel.app` ne doivent pas pouvoir se connecter par défaut.

Le serveur doit répondre sur `https://game.example/health` et `https://game.example/api/status`, et accepter les WebSockets à `wss://game.example/ws`.

## Client Vercel

`vercel.json` configure le projet statique : installation `bun install --frozen-lockfile`, compilation `bun run build`, résultat `dist/client`.

Définir cette variable dans l'environnement Production du projet Vercel pour permettre aux joueurs de rejoindre le serveur :

```dotenv
PUBLIC_GAME_SERVER_URL=https://game.example
```

Cette adresse publique est intégrée au client lors de la compilation ; elle ne contient aucun secret. Une modification nécessite un nouveau build. Le client l'utilise à la fois pour l'état du serveur et la connexion WebSocket. Si elle manque sur Vercel, le build réussit et le bouton « Play solo » permet de jouer dans le navigateur. Aucune requête HTTP ou WebSocket de jeu n'est alors envoyée. Une adresse fournie invalide ou sans HTTPS fait toujours échouer le build.

Si le serveur configuré est inaccessible, le client propose également le solo ; un échec de connexion initial lance une partie solo automatiquement. Le mode solo exécute la même simulation dans un Web Worker, avec un seul joueur, sans bots ni sauvegarde. Quitter puis relancer crée un nouveau monde. Masquer l'onglet suspend la simulation solo. Une partie solo ne devient pas multijoueur lorsque le serveur revient : retourner à l'accueil pour le rejoindre.

En local, laisser la variable vide conserve `localhost:3000`. `.vercelignore` exclut les fichiers d'environnement et les données locales du transfert. Une publication depuis les fichiers locaux n'exige pas de modification du dépôt Git.

## Vérification après publication

Sans serveur configuré, vérifier pseudo → équipement → partie solo, puis les mouvements, tirs, grenades et modifications du terrain. Quitter et relancer doit réinitialiser le terrain. Avec un serveur multijoueur configuré, ouvrir le domaine de production dans deux navigateurs et rejoindre la même partie ; rejoindre après une destruction, puis vérifier une nouvelle manche. Contrôler HTTPS/WSS et l'absence d'erreur CORS. La page de production ne doit pas dépendre du serveur de développement du PC.

Le projet [ubercube-io](https://vercel.com/marcandr-plouxs-projects/ubercube-io) est relié à `mploux/ubercube.io` : un push sur `main` déclenche le déploiement de production. L'hébergement du serveur permanent reste à fournir pour activer le multijoueur. Docker n'est pas installé dans l'environnement de validation ; l'image doit être construite et testée sur l'hôte cible.
