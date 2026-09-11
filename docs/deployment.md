# Déployer UBERCUBE

Le client statique peut être servi par Vercel. La simulation reste dans un processus Bun permanent, sur une seule instance pour la première version. Le serveur conserve le monde en mémoire : son redémarrage termine les sessions et réinitialise le terrain. Les connexions et instances temporaires des Vercel Functions ne conviennent pas au monde partagé actuel.

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

Définir cette variable dans l'environnement Production du projet Vercel avant de déployer :

```dotenv
PUBLIC_GAME_SERVER_URL=https://game.example
```

Cette adresse publique est intégrée au client lors de la compilation ; elle ne contient aucun secret. Une modification nécessite un nouveau build. Le client l'utilise à la fois pour l'état du serveur et la connexion WebSocket. Un build Vercel échoue explicitement si cette adresse manque ou n'utilise pas HTTPS, pour éviter de publier une interface qui cherche un serveur de jeu inexistant sur Vercel.

En local, laisser la variable vide conserve `localhost:3000`. `.vercelignore` exclut les fichiers d'environnement et les données locales du transfert. Une publication depuis les fichiers locaux n'exige pas de modification du dépôt Git.

## Vérification après publication

Ouvrir le domaine de production dans deux navigateurs, rejoindre la même partie et vérifier les mouvements, tirs, grenades et modifications du terrain. Rejoindre après une destruction, puis vérifier une nouvelle manche. Contrôler HTTPS/WSS et l'absence d'erreur CORS. La page de production ne doit pas dépendre du serveur de développement du PC.

Préparation locale effectuée le 11 septembre 2026. L'authentification Vercel est validée et le projet [ubercube-io](https://vercel.com/marcandr-plouxs-projects/ubercube-io) est créé avec les commandes de compilation ci-dessus. Aucun déploiement n'a encore été publié : l'hébergement du serveur permanent reste à fournir avant de définir `PUBLIC_GAME_SERVER_URL`. Docker n'est pas installé dans l'environnement de validation ; l'image doit être construite et testée sur l'hôte cible.
