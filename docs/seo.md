# Référencement et partage

Le domaine canonique est `https://www.ubercube.io/`. Les métadonnées sont dans le HTML initial de `public/index.html` : titre et description, lien canonique, robots avec aperçu d'image large, favicon, Open Graph, Twitter Card, et JSON-LD `WebSite` / `VideoGame`. Le contenu de présentation est en anglais, comme la langue principale de la page. Aucune variante de langue ou page supplémentaire n'est déclarée artificiellement.

Le visuel de partage est la capture historique du README Java, conservée sans transformation dans `public/assets/social/ubercube-classic.png` : 1280 × 718, 360 887 octets. L'image est servie directement par Vercel et utilisée avec une description alternative dans les métadonnées et la présentation visible. La provenance et l'empreinte figurent dans [THIRD_PARTY.md](../THIRD_PARTY.md).

À la demande de Marc, le favicon référence désormais ce même PNG historique, à la place du cube SVG. Le fichier original est réutilisé sans recadrage ni génération d'image. Cette capture panoramique reste rectangulaire : son utilisation comme icône d'onglet ne garantit pas son éligibilité comme favicon dans les résultats Google, qui demandent un format carré. [Consignes Google pour les favicons](https://developers.google.com/search/docs/appearance/favicon-in-search).

L'accueil conserve le panorama, la police et le formulaire de connexion. Le lien « About the game » donne accès à une présentation HTML du gameplay, de l'équipement, du solo et des commandes, accompagnée de l'image chargée à la demande. « Play UBERCUBE » revient au formulaire. Cette présentation se masque avec l'accueil lorsque le joueur rejoint le lobby ou la partie.

`public/robots.txt` autorise l'exploration et référence `public/sitemap.xml`, qui contient uniquement l'accueil canonique. Ces fichiers et l'image sont copiés par le build existant. Le JSON-LD décrit les fonctionnalités réellement disponibles, sans notes, avis ou résultats enrichis inventés. Les formats suivent [Open Graph](https://ogp.me/), [Schema.org VideoGame](https://schema.org/VideoGame) et les [consignes Google sur le nom du site](https://developers.google.com/search/docs/appearance/site-names).

## Vérifications du 12 septembre 2026

- Build client, TypeScript et test existant `client-build.test.ts` réussis.
- HTML compilé identique au fichier public ; JSON-LD parsé, identifiants uniques, un H1, canonique unique, dimensions PNG conformes aux métadonnées, robots et XML du sitemap vérifiés.
- Accueil et présentation inspectés dans le navigateur, sur ordinateur et avec des viewports 390 × 844 / 844 × 390. Bouton de connexion accessible et aucun débordement horizontal visible.
- Présentation → retour au formulaire → pseudo → lobby → Assault → partie vérifiés localement, sans diagnostic JavaScript/WebGL. Le refus du verrouillage du pointeur dans le navigateur intégré reste la limite connue de la vérification du pilotage.

Publié sur Vercel : `dpl_EUvDHNgWmGJnSeFcaEuvLAvX1ok3`, READY, alias `www.ubercube.io`. La publication a comparé les sources au manifeste de la précédente version : seuls `public/index.html`, `src/client/styles.css`, `public/robots.txt`, `public/sitemap.xml` et le PNG historique ont changé. Aucun Git ni serveur Hetzner modifié.

Après publication, accueil, JavaScript, CSS, image, robots et sitemap répondent en HTTP 200. Le HTML et les trois nouveaux fichiers publics correspondent exactement aux fichiers locaux ; titre, description, canonique, Open Graph, Twitter et JSON-LD sont vérifiés dans la réponse initiale. Le navigateur public affiche le nouvel accueil avec le serveur disponible, sans diagnostic JavaScript/WebGL. Preuves locales : `.runtime/vercel-seo-release/verification.json`.

Le favicon historique a été publié ensuite dans `dpl_9hxuDs5v4KyzwypgEnX5PiPh5yRB`, READY sur `www.ubercube.io`. Seul `public/index.html` diffère du manifeste SEO ; les 79 autres fichiers sont identiques. Le build local réussit, le navigateur public référence le PNG et les réponses HTTP 200 du HTML et de l'image ont les empreintes locales attendues. Preuves : `.runtime/vercel-favicon-release/verification.json`.

Le classement et l'indexation effectifs ne sont pas mesurés par ces contrôles. Aucun compte Search Console ni soumission d'indexation n'a été configuré dans cette intervention.
