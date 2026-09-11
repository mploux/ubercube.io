# UBERCUBE — règles de travail

## Autorité et périmètre

- Ne jamais toucher Git ni exécuter de commande Git sans demande explicite de Marc.
- Marc porte le produit. Le lead développeur porte les décisions techniques, le découpage, la coordination, l'intégration et la validation.
- Marc autorise explicitement une équipe de sous-agents pour ce projet. Déléguer des missions bornées et indépendantes, avec un responsable et des fichiers attribués ; le lead relit les résultats et résout les désaccords.
- Le Java dans `C:/Users/Marc/Documents/Dev/ubercube` est une référence en lecture seule. La nouvelle implémentation appartient à ce dépôt.
- Ne pas redemander une autorisation déjà donnée. Faire remonter les véritables décisions produit ; avancer sur les travaux indépendants pendant leur clarification.
- Ne pas publier, déployer sur une infrastructure externe ou envoyer de messages à des tiers sans autorisation adaptée.

## Principes, dans cet ordre

1. YAGNI : construire seulement ce qui est nécessaire au jalon courant.
2. KISS : préférer la simplicité qui résout correctement le problème.
3. DRY : réutiliser l'existant sans abstraction prématurée.
4. Encapsulation : respecter les responsabilités et les frontières.
5. Cause racine : comprendre et vérifier avant de corriger.

Comprendre le code et rechercher les mécanismes existants avant de modifier. Préserver les comportements hors périmètre. Ne pas ajouter de classe, helper, dépendance ou infrastructure sans besoin concret. Les commentaires expliquent brièvement une raison. Respecter les conventions établies et retirer les traces temporaires après diagnostic.

## Contraintes du jeu

- TypeScript, Three.js pour le client, Bun pour le serveur et l'outillage. Tailwind uniquement si utile à l'interface.
- Serveur autoritaire : les clients transmettent des intentions ; le serveur décide des déplacements, collisions, tirs, dégâts, modifications du monde et résultats.
- Identité attribuée côté serveur et liée à la session/connexion. Aucun compte ni base utilisateurs pour le premier périmètre.
- Parcours : pseudo, lobby d'équipement, partie. Arrivées en cours de partie jusqu'à la capacité configurée, initialement 100 joueurs.
- Mode choisi au lancement : TDM ou FFA. En TDM, chaque entrant est affecté à l'équipe la moins nombreuse. En FFA, il rejoint la partie sans équipe.
- Préserver le gameplay de référence, notamment construction et destruction. Effondrements reportés. Terrain réinitialisé entre manches.
- Distinguer comportement de gameplay, défaut du Java et hypothèse non vérifiée. Ne pas transformer silencieusement les balles en hitscan ni inventer un rechargement différent.
- Le type de scaling futur, les conditions de fin de manche et le matériel cible restent à préciser. Ne pas introduire de simulation distribuée ou de base de données pour anticiper ces réponses.

## Frontières retenues pour le premier socle

Un seul package Bun suffit au départ. `src/server` possède l'orchestration et l'état autoritaire ; `src/client` possède l'affichage, l'interface, les entrées et l'audio ; `src/shared` contient les seules règles, données voxel, simulations et définitions de protocole réellement partagées. Le code partagé ne dépend ni du DOM, ni de Three.js, ni des API Bun, ni des sockets.

Le terrain de collision est indépendant des maillages. Une manche et ses révisions de terrain doivent être identifiables afin d'écarter les messages périmés. Optimiser à partir de mesures RAM, CPU, GPU et réseau ; ne pas promettre une capacité infinie.

## Validation et communication

- Ajouter des tests qui protègent les règles, l'autorité ou les frontières réseau modifiées. Ne pas créer de tests qui ne font que recopier l'implémentation.
- Vérifier l'arrivée tardive pendant la destruction, les anciennes données après reset et les commandes invalides.
- Valider la cible de 100 joueurs avec une activité réelle simulée, y compris leur concentration au même endroit ; compter des connexions ne suffit pas.
- Distinguer lecture statique, tests automatisés, exécution multi-client et mesures de charge. Décrire ce qui a réellement été vérifié.
- Rapports courts : changement, raison, validation et limite restante. Ne pas présenter un document de conception comme une fonctionnalité implémentée.

Les décisions produit et les jalons sont suivis dans [README.md](README.md). Les notes spécialisées se trouvent dans `docs/`.
