#!/bin/bash
# Pas de "&" ici : le serveur Node lance déjà ce script en arrière-plan
# (spawn detached+unref). Ajouter un "&" ici en plus faisait terminer ce
# script (et sa session sudo) presque instantanément, tuant prématurément
# le vrai processus de mise à jour avant qu'il ait fini de télécharger —
# d'où les archives systématiquement "corrompues" via l'app.
/usr/local/bin/lumhub-updater.sh apply >> /var/log/lumhub-update.log 2>&1
