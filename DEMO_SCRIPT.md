# Script de démo — WAN Digital Twin (10 minutes)

Public : ingénieurs réseau. Prérequis : `verify.py` vert, Neo4j
Browser ouvert sur http://localhost:7474, Bloom disponible avec la perspective
`bloom/wan_perspective.json` importée (galerie de perspectives → Import) —
elle contient les search phrases et scene actions de chaque étape —, la carte
servie depuis `map/` (`python -m http.server 8000`).

Dans Bloom, chaque étape a son équivalent : phrases `backbone core`,
`blast radius de <routeur>`, `spof du reseau` / `ponts critiques`,
`double panne NYC`, `chemin de <ville> vers <ville>`, `incidents en cours` ;
clic droit sur un routeur → scene actions (simuler la panne, voisinage,
interfaces, BGP, déclarer/rétablir un incident P1).

**Alternative UI (`ui/`, `npm run dev`)** : les 6 étapes existent aussi comme
scenarii cliquables (onglet Scenarios), plus une 7e étape "Service Impact
Analysis" qui prolonge la panne double (étape 4) jusqu'à la couche Flow
(Intent/OperationalPath) — quel Service métier est impacté, pas seulement
quelle ville. Onglet Flow & Compliance : les 5 intents et la violation de
résidence des données (DXB→SGP, transit hors APAC). Chaque résultat est
adossé à une requête Cypher visible dans le tiroir d'audit.

---

## 1. Le réseau comme graphe (~1 min 30)

**Requête :** `cypher/demo/Q1_topology_overview.cypher` (les 3 instructions, une par une).

**À l'écran :** 44 routeurs répartis par région et par rôle, capacité par type
de lien, puis le schéma du graphe : `City`, `Router`, `Interface`, `Provider`,
les liens physiques (`LINK`), les sessions BGP et la couche dérivée
`CONNECTED_TO`. Dans Bloom, montrer la topologie complète en 2 secondes.

**Message :** votre WAN est déjà un graphe — CMDB, inventaire et supervision le
stockent en tables ; ici le modèle de données EST la topologie.

## 2. Blast radius d'une panne simple (~2 min)

**Requête :** `cypher/demo/Q2_blast_radius.cypher` avec
`:param failed => ['PAR-CORE-01']`.

**À l'écran :** une seule ligne — `JNB` (Johannesburg), routeur
`JNB-EDGE-01` orphelin. Basculer sur la carte Leaflet
(`python export_impact.py --failed PAR-CORE-01`) : Johannesburg en rouge,
les liens touchés en pointillés rouges.

**Message :** « quelles villes perdent le siège si ce châssis tombe ? » — une
requête, réponse en millisecondes, y compris pour les dépendances transitives.

## 3. Où sont vos SPOF ? (~1 min 30)

**Requête :** `cypher/demo/Q3_spof_articulation.cypher`.

**À l'écran :** points d'articulation = `PAR-CORE-01` ; pont (bridge) =
le lien `PAR-CORE-01 ↔ JNB-EDGE-01`. C'est un algorithme de théorie des
graphes (GDS), pas une liste entretenue à la main.

**Message :** le graphe calcule vos points de fragilité de façon exhaustive —
personne n'a besoin de « connaître » le réseau pour les trouver.

## 4. What-if : double panne (~2 min)

**Requête :** `cypher/demo/Q4_double_failure_whatif.cypher` avec
`:param failed => ['NYC-CORE-01','NYC-CORE-02']`, puis la variante qui énumère
toutes les paires de routeurs CORE critiques.

**À l'écran :** São Paulo isolée (les deux edges SAO ne remontent que sur la
paire core de New York). La variante liste ~13 paires critiques, par exemple
`FRA-CORE-01 + PAR-CORE-01` → 4 villes isolées.

**Message :** chaque équipement pris isolément est redondé, donc votre
supervision actuelle ne voit rien — c'est la *combinaison* qui isole un
continent. Le digital twin énumère ces combinaisons à froid, avant l'incident.

## 5. Diversité de chemins LON → SGP (~1 min 30)

**Requête :** `cypher/demo/Q5_resilience_paths.cypher` avec
`:param src => 'LON'` et `:param dst => 'SGP'`.

**À l'écran :** plus court chemin LON→FRA→SGP (~109 ms), puis les 3 routes
alternatives de Yen avec leurs latences (109 / 110 / 110 ms).

**Message :** la question « ai-je vraiment N chemins disjoints entre ces deux
places financières, et à quel coût de latence ? » se pose en une requête.

## 6. Incident P1 posé sur le graphe (~1 min 30)

**Requête :** `cypher/demo/Q6_incident_rca.cypher` (étapes 1 à 3).

**À l'écran :** l'incident `INC-2026-0001` (P1, HW_FAILURE) rattaché à
`PAR-CORE-01`, la liste des villes impactées (JNB), puis le sous-graphe
incident → routeur → voisins, à montrer dans Bloom.

**Message :** l'incident vit dans le même graphe que la topologie — la RCA et
l'analyse d'impact partagent le même modèle, pas trois outils à réconcilier.

*(Après la démo : exécuter le bloc « Reset » commenté en fin de Q6.)*

---

## Phase 2 (optionnelle) — des configs routeur brutes au graphe (~2 min)

1. Montrer une config brute dans le terminal :
   `head -40 batfish_snapshot/configs/as1border1.cfg`.
2. `python ingest_batfish.py` — Batfish parse les configs, Neo4j charge le
   résultat dans la base `batfish`, **même schéma** (aucun label inventé).
3. Dans Browser : `:use batfish`, puis relancer Q1 et Q3 **inchangées**.

**Message :** même schéma, mêmes requêtes — mais des données issues de vraies
configurations routeur via Batfish. Batfish calcule, Neo4j retient et répond.
